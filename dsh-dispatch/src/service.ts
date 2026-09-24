/**
 * 派发编排服务(P1 执行内核)。
 * 落实 §2.2 启动十步、§2.5 慢操作不入锁、§7.4 取消流程(P0 修订:静止确认)、
 * §7.6 预算、§7.1-7.2 重启对账、§5.2 工具摄取幂等、§9.4 执行槽
 * (v2 修订:全局并发上限可配,跨工作区并行,重叠工作区互斥)。
 *
 * 状态真相在 store(reducer 归约);service 只决定副作用与事件顺序。
 */
import { randomBytes } from 'node:crypto';
import { DispatchStore, idemKey, idemNodeKey } from './store.js';
import type { RuntimeAdapter, RuntimeEvent, SponsorHandle } from './runtime.js';
import type { FinalizeResult, TargetAdapter, TargetRef } from './adapters/target.js';
import { reduceDispatch } from './reducer.js';
import type { DispatchEvent, DispatchRecord, EvidenceRef, ServiceErrorCode, WorkerReport, WritebackState } from './types.js';
import { ServiceError, attemptActive } from './types.js';
import { buildPrompt, payloadHash, PROTOCOL_VERSION, sha256, TOOL_POLICY_VERSION } from './prompt.js';
import { childToolFilter, gateWorkerCall, type PolicyConfig } from './policy.js';
import { workerListDir, workerReadFile, workerWriteReport } from './workerfs.js';

export interface StartRequestInput {
  actorScope?: string;
  idempotencyKey: string;
  targetType: string;
  projectId: string;
  nodeId: string;
  ws: string;
  model?: string;
  toolAllow?: string[];
  agentProfile?: { id: string; name: string; instructions: string; revision: number; toolAllow: string[] };
  /** 追加上下文(小队交接包):拼进快照 nodeDetail,进入子代理提示词。 */
  extraContext?: string;
}

export interface StartResult {
  dispatchId: string;
  phase: DispatchRecord['phase'];
  replay: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function normalizeEvidence(input: unknown): EvidenceRef[] {
  if (!Array.isArray(input)) return [];
  const kinds = new Set<EvidenceRef['kind']>(['log', 'artifact', 'metric', 'command', 'code_change']);
  return input.slice(0, 50).flatMap((value): EvidenceRef[] => {
    if (typeof value === 'string') {
      const ref = value.trim().slice(0, 2000);
      return ref ? [{ kind: 'artifact', ref }] : [];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (!kinds.has(item.kind as EvidenceRef['kind']) || typeof item.ref !== 'string' || !item.ref.trim()) return [];
    return [{ kind: item.kind as EvidenceRef['kind'], ref: item.ref.trim().slice(0, 2000),
      ...(typeof item.summary === 'string' ? { summary: item.summary.slice(0, 2000) } : {}) }];
  });
}

function rid(prefix: string): string {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

function canonicalRoot(ws: string): string {
  return ws.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/** 工作区重叠判定(并发前提:不能只比较字符串相等——父子目录同样会互相写脏,
 * 任一方落在对方之内即互斥。入参须先过 canonicalRoot)。 */
function rootsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function assertValidWs(ws: string): string {
  if (!ws || typeof ws !== 'string') throw new ServiceError('VALIDATION', '缺少工作区路径', 422);
  const norm = ws.replaceAll('\\', '/');
  if (!/^[a-zA-Z]:\/.+/.test(norm) && !norm.startsWith('//')) {
    throw new ServiceError('VALIDATION', '工作区必须是绝对路径', 422);
  }
  if (norm.split('/').includes('..')) throw new ServiceError('VALIDATION', '工作区路径不得包含 ..', 422);
  return ws;
}

export interface ServiceDeps {
  store: DispatchStore;
  runtime: RuntimeAdapter;
  target: TargetAdapter;
  config: PolicyConfig & { maxWallMs: number };
  log?: (msg: string) => void;
}

/** §8.3:按阶段与回写状态给出允许操作;客户端不得自行推断。 */
export function allowedActions(d: DispatchRecord): string[] {
  if (d.phase === 'finished') {
    return ['pending', 'error'].includes(d.writeback.state) ? ['view', 'reconcile'] : ['view'];
  }
  const acts = ['view'];
  if (['preparing', 'starting', 'queued', 'running', 'settling'].includes(d.phase)) acts.push('cancel');
  acts.push('takeover');
  if (['reconciling', 'cancelling'].includes(d.phase)) acts.push('reconcile', 'resolve');
  return acts;
}

export class DispatchService {
  private store: DispatchStore;
  private runtime: RuntimeAdapter;
  private target: TargetAdapter;
  private config: ServiceDeps['config'];
  private log: (msg: string) => void;
  private startCtrls = new Map<string, AbortController>();
  private budgetTimers = new Map<string, NodeJS.Timeout>();
  private unsubEvents: () => void;
  private stopped = false;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.target = deps.target;
    this.config = deps.config;
    this.log = deps.log ?? (() => undefined);
    this.unsubEvents = this.runtime.onEvent((ev) => this.onRuntimeEvent(ev));
  }

  dispose(): void {
    this.stopped = true;
    this.unsubEvents();
    for (const t of this.budgetTimers.values()) clearTimeout(t);
    this.budgetTimers.clear();
  }

  /* ================= 归约入口(锁内归约+持久化) ================= */

  private async apply(id: string, ev: DispatchEvent): Promise<DispatchRecord> {
    if (this.stopped) throw new ServiceError('WRONG_STATE', '服务已停机', 409);
    return this.store.mutate(() => {
      const root = this.store.snapshot();
      if (!root) throw new ServiceError('STORE_READONLY', this.store.fault.reason ?? 'store 未初始化', 503);
      const rec = root.dispatches[id];
      if (!rec) throw new ServiceError('NOT_FOUND', `派发 ${id} 不存在`, 404);
      const next = reduceDispatch(rec, ev);
      root.dispatches[id] = next;
      if (next.phase === 'finished') {
        this.clearTimers(id);
        // §5.6:终态即挂起回写(reducer 已置 pending);异步 finalize,失败由对账补偿
        void this.processWriteback(id).catch((e) => this.log(`回写处理失败(${id}):${String(e)}`));
      }
      return next;
    });
  }

  private clearTimers(id: string): void {
    const t = this.budgetTimers.get(id);
    if (t) clearTimeout(t);
    this.budgetTimers.delete(id);
    this.startCtrls.delete(id);
  }

  /* ================= 启动(§2.2 十步) ================= */

  async start(raw: StartRequestInput): Promise<StartResult> {
    if (raw.targetType !== 'traj_node' && raw.targetType !== 'workbench_task') throw new ServiceError('VALIDATION', `未知 targetType=${raw.targetType}`, 422);
    const actorScope = (raw.actorScope ?? 'local').replace(/\s+/g, '');
    const ws = assertValidWs(raw.ws);
    const model = raw.model ?? this.config.defaultModel;
    if (!this.config.allowedModels.includes(model)) {
      throw new ServiceError('VALIDATION', `模型 ${model} 不在允许列表 ${this.config.allowedModels.join(', ')}`, 422);
    }
    if (!raw.idempotencyKey || typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length > 200) {
      throw new ServiceError('VALIDATION', 'idempotencyKey 必填(≤200 字符)', 422);
    }
    const key = idemKey(actorScope, raw.idempotencyKey);
    const hash = payloadHash({ targetType: raw.targetType, projectId: raw.projectId, nodeId: raw.nodeId, ws, model });

    // 步骤 1:幂等快查(传输重试,T10)
    const pre = this.store.findByIdempotency(actorScope, raw.idempotencyKey);
    if (pre) {
      if (pre.payloadHash !== hash) throw new ServiceError('IDEMPOTENCY_CONFLICT', '同幂等键不同请求', 409);
      const rec = this.store.get(pre.dispatchId);
      return { dispatchId: pre.dispatchId, phase: rec?.phase ?? 'reconciling', replay: true };
    }

    // 步骤 2:读取任务(锁外;指纹由目标侧单侧计算并随 read 返回,P2 修订)
    const root0 = canonicalRoot(ws);
    const ref: TargetRef = { projectId: raw.projectId, nodeId: raw.nodeId, workspaceId: root0, canonicalRoot: root0,
      targetType: raw.targetType as 'traj_node' | 'workbench_task' };
    const read = await this.target.readTask(ref);
    if (!read) throw new ServiceError('NOT_FOUND', `目标任务 ${raw.projectId}/${raw.nodeId} 不存在`, 404);
    const { fingerprint } = read;
    // 小队交接包:拼进详情区,随快照进入下一步提示词(prompt.ts 渲染 nodeDetail)
    const snapshot = raw.extraContext
      ? { ...read.snapshot, nodeDetail: `${read.snapshot.nodeDetail ?? ''}

${raw.extraContext.slice(0, 4000)}`.trim() }
      : read.snapshot;
    if (JSON.stringify(snapshot).length > this.config.maxPromptBytes) {
      throw new ServiceError('VALIDATION', '任务快照超出容量上限,拒绝而非静默截断', 413);
    }

    // 步骤 3:生成身份
    const dispatchId = rid('d_');
    const childSessionId = rid('dc_');

    // 步骤 4:临界区——复查幂等/占用/容量,原子保存 preparing + 预留
    const created = await this.store.mutate(() => {
      const root = this.store.snapshot();
      if (!root) throw new ServiceError('STORE_READONLY', 'store 只读', 503);
      const again = root.idempotency[key];
      if (again) {
        if (again.payloadHash !== hash) throw new ServiceError('IDEMPOTENCY_CONFLICT', '同幂等键不同请求', 409);
        return { replayId: again.dispatchId };
      }
      const occ = this.store.occupancy();
      if (occ.nodeKeys.has(idemNodeKey(raw.projectId, raw.nodeId))) {
        throw new ServiceError('NODE_OCCUPIED', '该节点已有进行中的派发', 409);
      }
      if (occ.workspaceRoots.has(root0)
        || [...occ.workspaceRoots].some((r) => rootsOverlap(r, root0))) {
        throw new ServiceError('WORKSPACE_OCCUPIED', '该工作区(或其父/子目录)已有进行中的派发', 409);
      }
      const cap = Math.max(1, this.config.maxConcurrentDispatches || 1);
      if (occ.activeAttempts >= cap) {
        throw new ServiceError('CAPACITY_EXCEEDED', `全局并发已达上限(${cap});不同工作区的任务可并行,重叠工作区互斥`, 409);
      }
      const now = Date.now();
      const [modelProvider, modelName] = model.split('/');
      const rec: DispatchRecord = {
        schemaVersion: raw.targetType === 'workbench_task' ? 3 : 2,
        revision: 0,
        id: dispatchId,
        request: { actorScope, idempotencyKey: raw.idempotencyKey, payloadHash: hash },
        targetType: raw.targetType as 'traj_node' | 'workbench_task',
        targetRef: ref,
        source: { taskFingerprint: fingerprint, snapshot, protocolVersion: PROTOCOL_VERSION },
        runtime: {
          sponsorSessionId: '',
          childSessionId,
          observedRuns: [],
          quiescence: 'unconfirmed',
        },
        ownership: { state: 'pending', workerWrites: 'disabled' },
        reservation: { targetHeld: true, workspaceHeld: true, executionSlotHeld: true },
        startIntent: { mayHaveExecuted: false },
        phase: 'preparing',
        writeback: { operationId: `${dispatchId}:finalize`, state: 'not_ready', attempts: 0 },
        createdAt: now,
        limits: { maxWallMs: this.config.maxWallMs },
        effectiveConfig: {
          provider: 'spawn',
          modelProvider: modelProvider ?? '',
          model: modelName ?? model,
          toolPolicyVersion: TOOL_POLICY_VERSION,
          ...(raw.agentProfile ? { agentProfile: raw.agentProfile } : {}),
        },
        audit: [{ at: now, type: 'created', actor: actorScope, detail: `node=${raw.nodeId}` }],
      };
      root.dispatches[dispatchId] = rec;
      root.idempotency[key] = { dispatchId, payloadHash: hash };
      return { replayId: null as string | null };
    });
    if (created.replayId) {
      const rec = this.store.get(created.replayId);
      return { dispatchId: created.replayId, phase: rec?.phase ?? 'reconciling', replay: true };
    }

    // 步骤 5:条件领取(锁外;幂等按 dispatchId)
    let claim: Awaited<ReturnType<TargetAdapter['claim']>>;
    try {
      claim = await this.target.claim({ dispatchId, childSessionId, ref, expectedFingerprint: fingerprint });
    } catch (e) {
      await this.apply(dispatchId, { type: 'claim-conflict', at: Date.now(), detail: String(e) });
      throw new ServiceError('INTERNAL', `领取调用失败:${String(e)}`, 500);
    }
    if (!claim.ok) {
      await this.apply(dispatchId, { type: 'claim-conflict', at: Date.now(), detail: claim.detail });
      const status = claim.code === 'NOT_FOUND' ? 404 : 409;
      const codeMap: Record<string, ServiceErrorCode> = {
        NODE_OCCUPIED: 'NODE_OCCUPIED',
        TASK_CHANGED: 'WRONG_STATE',
        SUPERSEDED: 'WRONG_STATE',
        NOT_FOUND: 'NOT_FOUND',
      };
      throw new ServiceError(codeMap[claim.code] ?? 'INTERNAL', claim.detail, status);
    }
    await this.apply(dispatchId, { type: 'claim-ok', at: Date.now(), epoch: claim.epoch, taskFingerprint: claim.taskFingerprint });

    // 步骤 6:sponsor(P0 修订:必须显式模型路由)
    let sponsor: SponsorHandle;
    try {
      sponsor = await this.runtime.ensureSponsor(ws, this.config.defaultModel.split('/')[0], this.config.defaultModel.split('/')[1] ?? '');
    } catch (e) {
      await this.apply(dispatchId, { type: 'claim-conflict', at: Date.now(), detail: `sponsor 不可用:${String(e)}` });
      throw new ServiceError('DEPENDENCY_MISSING', `sponsor 不可用:${String(e)}`, 503);
    }
    await this.store.mutate(() => {
      const root = this.store.snapshot();
      const rec = root?.dispatches[dispatchId];
      if (rec) rec.runtime.sponsorSessionId = sponsor.sessionId;
    });

    // 步骤 7:组装并保存实际 prompt(尺寸先于副作用边界校验)
    const promptText = buildPrompt({
      snapshot,
      dispatchId,
      workspaceRoot: ws,
      budgetMinutes: this.config.maxWallMs / 60000,
      agentInstructions: raw.agentProfile?.instructions,
    });
    if (Buffer.byteLength(promptText, 'utf8') > this.config.maxPromptBytes) {
      await this.apply(dispatchId, { type: 'claim-conflict', at: Date.now(), detail: '任务提示词超出容量上限' });
      throw new ServiceError('VALIDATION', '任务提示词超出容量上限', 413);
    }

    // 步骤 8:临界区——复查未取消/未接管/领取有效,持久化 start-intent
    const filter = childToolFilter(raw.toolAllow);
    const intentRec = await this.store.mutate(() => {
      const root = this.store.snapshot();
      const rec = root?.dispatches[dispatchId];
      if (!rec) throw new ServiceError('INTERNAL', '记录消失', 500);
      rec.source.promptText = promptText;
      rec.source.promptHash = sha256(promptText);
      return rec;
    });
    if (intentRec.phase !== 'preparing' || intentRec.ownership.state !== 'owned') {
      throw new ServiceError('WRONG_STATE', `领取后状态异常:phase=${intentRec.phase} ownership=${intentRec.ownership.state}`, 409);
    }
    await this.apply(dispatchId, { type: 'start-intent', at: Date.now() });

    // 步骤 9:锁外启动——先落 mayHaveExecuted,再跨副作用边界(六约束 1/3)
    const ctrl = new AbortController();
    this.startCtrls.set(dispatchId, ctrl);
    this.watchBudget(dispatchId);
    let accepted: { childId: string; messageId: string };
    try {
      accepted = await this.runtime.startContinuable(
        {
          label: `dispatch:${raw.nodeId}`,
          childId: childSessionId,
          prompt: promptText,
          sponsor,
          modelProvider: intentRec.effectiveConfig.modelProvider,
          model: intentRec.effectiveConfig.model,
          maxDepth: 1,
          toolAllow: filter.allow,
        },
        ctrl.signal,
      );
    } catch (e) {
      // P0 实测:startContinuable 拒绝即完整回滚 → 可按未启动失败收尾(§2.3)
      await this.apply(dispatchId, { type: 'start-rejected', at: Date.now(), detail: String((e as Error)?.message ?? e) });
      this.clearTimers(dispatchId);
      throw new ServiceError('INTERNAL', `子代理启动被拒绝:${String((e as Error)?.message ?? e)}`, 500);
    }
    if (accepted.childId !== childSessionId) {
      await this.apply(dispatchId, { type: 'reconcile-unresolved', at: Date.now(), detail: `运行时返回了非预留 childId` });
      throw new ServiceError('INTERNAL', '运行时未尊重预留 childId,进入待核验', 500);
    }
    // 步骤 10:接受回执只补 messageId;回执不倒退阶段(T05)
    const after = await this.apply(dispatchId, { type: 'start-accepted', at: Date.now(), childId: childSessionId, messageId: accepted.messageId });
    return { dispatchId, phase: after.phase, replay: false };
  }

  /* ================= 取消 / 接管(§7.4 + P0 静止确认) ================= */

  async cancel(id: string, by = 'user', reason = ''): Promise<{ accepted: boolean; phase: DispatchRecord['phase']; late?: boolean }> {
    const rec = this.store.get(id);
    if (!rec) throw new ServiceError('NOT_FOUND', `派发 ${id} 不存在`, 404);
    const next = await this.apply(id, { type: 'cancel-requested', at: Date.now(), by, reason });
    if (next.phase === 'finished') {
      return { accepted: true, phase: next.phase, late: true };
    }
    // §5.5:普通取消只关执行者写入,宿主保留 claim 用于条件收尾
    void this.target.revoke({ dispatchId: id, ref: rec?.targetRef, mode: 'worker_only' }).catch((e) => this.log(`worker_only 撤权失败(${id}):${String(e)}`));
    await this.stopAttempt(id);
    void this.pursueQuiescence(id);
    const now = this.store.get(id);
    return { accepted: true, phase: now?.phase ?? next.phase };
  }

  async takeover(id: string, actor: string, reason = ''): Promise<{ accepted: boolean; phase: DispatchRecord['phase'] }> {
    const rec = this.store.get(id);
    if (!rec) throw new ServiceError('NOT_FOUND', `派发 ${id} 不存在`, 404);
    const next = await this.apply(id, { type: 'takeover', at: Date.now(), actor, reason });
    // §5.5:接管废整个目标所有权(迟到的宿主回写也不会覆盖人工)
    await this.target.revoke({ dispatchId: id, mode: 'takeover' }).catch((e) => this.log(`revoke 失败:${String(e)}`));
    if (next.phase !== 'finished') {
      await this.stopAttempt(id);
      void this.pursueQuiescence(id);
    }
    const now = this.store.get(id);
    return { accepted: true, phase: now?.phase ?? next.phase };
  }

  /** §7.4:先持久化意图(已由调用方 apply),再中断;starting 未接受则打信号。 */
  private async stopAttempt(id: string): Promise<void> {
    const rec = this.store.get(id);
    if (!rec || !attemptActive(rec)) return;
    if (rec.runtime.messageId && rec.runtime.sponsorSessionId) {
      try {
        this.runtime.interruptByParent(rec.runtime.childSessionId, rec.runtime.sponsorSessionId);
      } catch (e) {
        this.log(`interrupt 失败(${id}):${String(e)}——继续静止观察`);
      }
    } else if (rec.startIntent.mayHaveExecuted) {
      const ctrl = this.startCtrls.get(id);
      ctrl?.abort(); // 接受前取消:signal 归 caller(P0 类型语义)
    }
  }

  /**
   * 静止追求(P0 发现 4 的落地):观察 end 事件 + 活动非 running + drain 尝试,
   * 三者合成静止证据后才允许取消收尾;超时保持 cancelling,不释放占用。
   */
  async pursueQuiescence(id: string, timeoutMs = 90_000): Promise<void> {
    try {
      await this.pursueQuiescenceInner(id, timeoutMs);
    } catch (e) {
      this.log(`静止追求中止(${id}):${String(e)}`);
    }
  }

  private async pursueQuiescenceInner(id: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let interrupted = false;
    while (Date.now() < deadline && !this.stopped) {
      const rec = this.store.get(id);
      if (!rec || rec.phase === 'finished') return;
      if (!rec.startIntent.mayHaveExecuted) {
        await this.apply(id, { type: 'quiescence-confirmed', at: Date.now(), evidence: 'never-started' });
        return;
      }
      if (!rec.runtime.messageId) {
        // 启动意图已落但未见接受回执:副作用边界外未知 → 交由对账/操作员
        await this.apply(id, { type: 'reconcile-unresolved', at: Date.now(), detail: '取消时启动回执未知' });
        return;
      }
      const activeRuns = rec.runtime.observedRuns.filter((r) => !r.observedEndAt);
      if (activeRuns.length > 0) {
        await sleep(800);
        continue;
      }
      if (!interrupted) {
        await this.stopAttempt(id);
        interrupted = true;
        await sleep(300);
        continue;
      }
      try {
        const sponsor = await this.runtime.ensureSponsor(
          rec.targetRef.canonicalRoot,
          rec.effectiveConfig.modelProvider,
          rec.effectiveConfig.model,
        );
        void sponsor;
        const children = await this.runtime.listChildren(rec.runtime.sponsorSessionId);
        const me = children.find((c) => c.id === rec.runtime.childSessionId);
        const activity = me?.activity ?? 'absent';
        if (activity === 'running') {
          await sleep(800);
          continue;
        }
        let drainEvidence = 'no-drain-needed';
        if (me) {
          try {
            const s = await this.runtime.ensureSponsor(rec.targetRef.canonicalRoot, rec.effectiveConfig.modelProvider, rec.effectiveConfig.model);
            await this.runtime.drainContinuableChildren(s, [rec.runtime.childSessionId]);
            drainEvidence = 'drain-ok';
          } catch (e) {
            drainEvidence = `drain-failed:${String((e as Error)?.message ?? e).slice(0, 80)}`;
          }
        }
        await this.apply(id, {
          type: 'quiescence-confirmed',
          at: Date.now(),
          evidence: `activity=${activity};${drainEvidence}`,
        });
        return;
      } catch (e) {
        // §7.3:查询失败=无法确认,继续轮询;窗口耗尽后保持 cancelling/待核验
        this.log(`静止观察暂不可用(${id}):${String(e)}`);
        await sleep(1200);
      }
    }
    const rec = this.store.get(id);
    if (rec && rec.phase !== 'finished') {
      await this.apply(id, { type: 'reconcile-unresolved', at: Date.now(), detail: '静止确认窗口超时,保持占用待核验' });
    }
  }

  /* ================= 工具摄取(§5.2) ================= */

  async ingestProgress(
    childSessionId: string,
    input: { sequence: number; summary: string; metrics?: unknown; evidence?: unknown[] },
  ): Promise<{ ok: true }> {
    const gate = gateWorkerCall((c) => this.store.findByChildSessionId(c), childSessionId, 'progress');
    if (!gate.ok) {
      if (gate.dispatch) {
        await this.apply(gate.dispatch.id, { type: 'late-report-quarantined', at: Date.now(), detail: `progress 拒绝(${gate.code})` });
      }
      const status = gate.code === 'NO_DISPATCH' ? 403 : 409;
      const code = gate.code === 'NO_DISPATCH' ? 'UNAUTHORIZED_WORKER' : gate.code === 'WRONG_PHASE' ? 'WRONG_STATE' : gate.code;
      throw new ServiceError(code as ServiceErrorCode, gate.detail, status);
    }
    const id = gate.dispatch.id;
    const seq = Math.floor(Number(input.sequence));
    if (!(seq >= 0)) throw new ServiceError('VALIDATION', 'sequence 必须是非负整数', 422);
    if (!input.summary || typeof input.summary !== 'string') throw new ServiceError('VALIDATION', 'summary 必填', 422);
    const op = await this.target.progress({
      dispatchId: id,
      ref: gate.dispatch.targetRef,
      operationId: `${id}:progress:${seq}`,
      title: input.summary.slice(0, 200),
      payload: { metrics: input.metrics ?? null, evidence: input.evidence ?? null },
      metrics: input.metrics ?? null,
    });
    if (!op.ok) throw new ServiceError('REPORT_CONFLICT', `台账写入被拒:${op.detail}`, 409);
    await this.apply(id, { type: 'progress', at: Date.now(), sequence: seq, fromChild: childSessionId });
    return { ok: true };
  }

  async ingestReport(
    childSessionId: string,
    input: { outcome: string; summary: string; evidence?: unknown[]; nextHint?: string },
  ): Promise<{ receivedAt: number; replay?: boolean }> {
    const d = this.store.findByChildSessionId(childSessionId);
    if (!d) {
      throw new ServiceError('UNAUTHORIZED_WORKER', `childSessionId=${childSessionId} 不属于任何派发`, 403);
    }
    if (!['done', 'failed', 'blocked'].includes(input.outcome)) {
      throw new ServiceError('VALIDATION', `outcome 必须是 done/failed/blocked,收到 ${input.outcome}`, 422);
    }
    if (!input.summary || typeof input.summary !== 'string' || input.summary.length > 20_000) {
      throw new ServiceError('VALIDATION', 'summary 必填(≤20000 字符)', 422);
    }
    const hash = sha256(JSON.stringify({ outcome: input.outcome, summary: input.summary, evidence: input.evidence ?? null, nextHint: input.nextHint ?? null }));
    if (d.report) {
      // §5.2:同内容重发返回原回执、不同内容冲突——该判定先于一切门控
      //(执行者重试自己的最终报告是合法路径,不得被 worker_only 封闭拦下)
      if (d.report.hash === hash) return { receivedAt: d.report.receivedAt, replay: true };
      throw new ServiceError('REPORT_CONFLICT', '已有最终报告;不同内容的第二次最终报告不覆盖第一份', 409);
    }
    // 首份报告才走门控(撤权/封闭/阶段);迟到调用同时进入隔离审计
    const gate = gateWorkerCall((c) => this.store.findByChildSessionId(c), childSessionId, 'report');
    if (!gate.ok) {
      await this.apply(d.id, { type: 'late-report-quarantined', at: Date.now(), detail: `report 拒绝(${gate.code})` });
      const status = gate.code === 'NO_DISPATCH' ? 403 : 409;
      const code = gate.code === 'NO_DISPATCH' ? 'UNAUTHORIZED_WORKER' : gate.code === 'WRONG_PHASE' ? 'WRONG_STATE' : gate.code;
      throw new ServiceError(code as ServiceErrorCode, gate.detail, status);
    }
    const activeRun = d.runtime.observedRuns.find((r) => !r.observedEndAt);
    const report: WorkerReport = {
      hash,
      submittedByChildSessionId: childSessionId,
      runId: activeRun?.runId,
      runAssociation: activeRun ? 'verified' : 'unresolved',
      outcome: input.outcome as 'done' | 'failed' | 'blocked',
      summary: input.summary.slice(0, 2000),
      evidence: normalizeEvidence(input.evidence),
      nextHint: input.nextHint?.slice(0, 500),
      receivedAt: Date.now(),
    };
    const next = await this.apply(d.id, { type: 'report', at: Date.now(), fromChild: childSessionId, report });
    // §5.2:报告持久化即 worker_only 封闭目标侧新增任务性写入(宿主保留 claim 收尾)
    void this.target.revoke({ dispatchId: d.id, ref: d.targetRef, mode: 'worker_only' }).catch((e) => this.log(`worker_only 撤权失败(${d.id}):${String(e)}`));
    return { receivedAt: report.receivedAt };
  }

  /* ================= 执行者受控文件面(P3,§0.3/§9.2) ================= */

  /** 文件面门控:与 progress 同级(queued/running 且 workerWrites=enabled);每次调用重查,不缓存授权。 */
  private gateFileOp(childSessionId: string): DispatchRecord {
    const gate = gateWorkerCall((c) => this.store.findByChildSessionId(c), childSessionId, 'progress');
    if (!gate.ok) {
      if (gate.dispatch) {
        void this.apply(gate.dispatch.id, { type: 'late-report-quarantined', at: Date.now(), detail: `文件面调用拒绝(${gate.code})` }).catch(() => undefined);
      }
      const status = gate.code === 'NO_DISPATCH' ? 403 : 409;
      const code = gate.code === 'NO_DISPATCH' ? 'UNAUTHORIZED_WORKER' : gate.code === 'WRONG_PHASE' ? 'WRONG_STATE' : gate.code;
      throw new ServiceError(code as ServiceErrorCode, gate.detail, status);
    }
    return gate.dispatch;
  }

  workerReadFile(childSessionId: string, target: string): { ok: boolean; path?: string; size?: number; truncated?: boolean; binary?: boolean; content?: string; error?: string } {
    const d = this.gateFileOp(childSessionId);
    const r = workerReadFile(d.targetRef.canonicalRoot, target);
    this.log(`[dispatch] read_file ${d.id} ${r.path}${r.error ? ` → ${r.error}` : ` (${r.size}B)`}`);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, path: r.path, size: r.size, truncated: r.truncated, binary: r.binary, content: r.content };
  }

  workerListDir(childSessionId: string, target: string): { ok: boolean; path?: string; entries?: Array<{ name: string; isDir: boolean; size: number }>; error?: string } {
    const d = this.gateFileOp(childSessionId);
    const r = workerListDir(d.targetRef.canonicalRoot, target);
    this.log(`[dispatch] list_dir ${d.id} ${r.path} → ${r.entries.length} 项${r.error ? `(${r.error})` : ''}`);
    if (r.error && r.entries.length === 0) return { ok: false, error: r.error };
    return { ok: true, path: r.path, entries: r.entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size })) };
  }

  workerWriteReport(childSessionId: string, filename: string, content: string): { ok: boolean; path?: string; bytes?: number; error?: string } {
    const d = this.gateFileOp(childSessionId);
    const r = workerWriteReport(d.targetRef.canonicalRoot, d.id, filename, content);
    this.log(`[dispatch] write_report ${d.id} ${filename} → ${r.error ?? `${r.bytes}B`}`);
    return r.error ? { ok: false, error: r.error } : { ok: true, path: r.path, bytes: r.bytes };
  }

  /* ================= 运行事件 / 预算 ================= */

  private onRuntimeEvent(ev: RuntimeEvent): void {
    const d = this.store.findByChildSessionId(ev.childId);
    if (!d) return; // 探针子代理等非派发 child
    if (ev.kind === 'run-started') {
      void this.apply(d.id, { type: 'run-started', at: ev.at, runId: ev.runId }).catch((e) => this.log(String(e)));
    } else {
      void this.apply(d.id, { type: 'run-ended', at: ev.at, runId: ev.runId, stopReason: ev.stopReason })
        .then((next) => {
          // aborted / 取消路径需要静止确认(P0 发现 4)
          if (next.phase === 'cancelling' || next.phase === 'settling') {
            void this.pursueQuiescence(d.id);
          }
        })
        .catch((e) => this.log(String(e)));
    }
  }

  private watchBudget(id: string): void {
    const rec = this.store.get(id);
    if (!rec) return;
    const elapsed = Date.now() - rec.createdAt;
    const remain = Math.max(0, rec.limits.maxWallMs - elapsed);
    const t = setTimeout(() => {
      void (async () => {
        const r = this.store.get(id);
        if (!r || r.phase === 'finished') return;
        await this.apply(id, { type: 'budget-exceeded', at: Date.now(), kind: 'wall-clock' });
        await this.stopAttempt(id);
        void this.pursueQuiescence(id);
      })();
    }, remain);
    t.unref?.();
    this.budgetTimers.set(id, t);
  }

  /* ================= 对账(§7.1-7.3)与人工核验(§7.7) ================= */

  /** 启动/手动触发;不重放业务任务、不为探活发新 prompt(六约束 3)。 */
  async reconcileOnce(): Promise<{ scanned: number; notes: string[] }> {
    const notes: string[] = [];
    const unfinished = this.store.all().filter((d) => d.phase !== 'finished');
    for (const d0 of unfinished) {
      const d = this.store.get(d0.id);
      if (!d || d.phase === 'finished') continue;
      // 1. 撤权意图优先:cancel/takeover 已在记录中,workerWrites 已随归约关闭
      if (d.phase === 'preparing') {
        // 可证未跨越副作用边界 → 按未启动失败收尾(§2.3)
        await this.apply(d.id, { type: 'cancel-requested', at: Date.now(), by: 'reconciler', reason: '恢复:未见启动意图' });
        await this.apply(d.id, { type: 'quiescence-confirmed', at: Date.now(), evidence: 'never-started' });
        notes.push(`${d.id}: preparing→未启动收尾`);
        continue;
      }
      if (d.phase === 'settling') {
        const lastRun = d.runtime.observedRuns[d.runtime.observedRuns.length - 1];
        if (lastRun?.observedEndAt) {
          // 证据齐全但崩溃于结算前:重放同一 end(幂等)触发结算
          await this.apply(d.id, { type: 'run-ended', at: Date.now(), runId: lastRun.runId, stopReason: lastRun.observedEndAt.stopReason });
          notes.push(`${d.id}: settling→重放终局证据`);
          continue;
        }
        if (d.cancel?.effective) {
          void this.pursueQuiescence(d.id);
          notes.push(`${d.id}: settling→静止追求`);
          continue;
        }
        // 有报告无终止证据(§7.3:不能猜)→ 待核验,交操作员 resolve
        await this.apply(d.id, { type: 'reconcile-unresolved', at: Date.now(), detail: 'settle 中无终止证据' });
        notes.push(`${d.id}: settling→reconciling(无终止证据)`);
        continue;
      }
      if (['starting', 'queued', 'running', 'cancelling'].includes(d.phase)) {
        try {
          const children = await this.runtime.listChildren(d.runtime.sponsorSessionId || 'unknown');
          const me = children.find((c) => c.id === d.runtime.childSessionId);
          const activeRuns = d.runtime.observedRuns.filter((r) => !r.observedEndAt);
          if (activeRuns.length > 0) {
            notes.push(`${d.id}: 存在未终止运行周期,保持 ${d.phase}`);
            continue;
          }
          if (!me) {
            if (d.phase === 'starting' && !d.runtime.messageId) {
              // T09:预留 childId 定位;不创建第二个执行者;证据不足 → 待核验
              await this.apply(d.id, { type: 'reconcile-unresolved', at: Date.now(), detail: '启动意图已落但 child 不在目录,无法证明回滚' });
              notes.push(`${d.id}: starting→reconciling(child 缺席)`);
            } else {
              await this.apply(d.id, { type: 'reconcile-unresolved', at: Date.now(), detail: 'child 暂不在目录(§7.3:不能据此认定停止)' });
              notes.push(`${d.id}: →reconciling(child 缺席)`);
            }
            continue;
          }
          if (me.activity === 'running') {
            notes.push(`${d.id}: 目录活跃,保持 ${d.phase}(等待事件)`);
            continue;
          }
          if (d.phase === 'cancelling') {
            void this.pursueQuiescence(d.id);
            notes.push(`${d.id}: cancelling→静止追求`);
          } else {
            await this.apply(d.id, { type: 'reconcile-unresolved', at: Date.now(), detail: `目录 inactive 但无终止事件(§7.3)` });
            notes.push(`${d.id}: →reconciling(inactive 无事件)`);
          }
        } catch (e) {
          // T23:查询失败=无法确认 → 待核验,保留占用
          await this.apply(d.id, { type: 'reconcile-unresolved', at: Date.now(), detail: `目录查询失败:${String(e).slice(0, 120)}` });
          notes.push(`${d.id}: →reconciling(查询失败)`);
        }
      }
    }
    // §5.6 补偿:重试待回写(幂等状态同步,不重跑模型)
    for (const d of this.store.all()) {
      if (d.phase === 'finished' && ['pending', 'error'].includes(d.writeback.state)
        && d.writeback.attempts < DispatchService.WRITEBACK_MAX_ATTEMPTS) {
        await this.processWriteback(d.id);
        notes.push(`${d.id}: 回写补偿→${d.writeback.state}`);
      }
    }
    return { scanned: unfinished.length, notes };
  }

  /** §7.7 人工核验:操作员确认停止后收尾;界面须区分 operator_confirmed。 */
  async resolve(id: string, operator: string, evidence: string): Promise<{ phase: DispatchRecord['phase'] }> {
    const rec = this.store.get(id);
    if (!rec) throw new ServiceError('NOT_FOUND', `派发 ${id} 不存在`, 404);
    if (rec.phase === 'finished') return { phase: rec.phase };
    const next = await this.apply(id, { type: 'quiescence-confirmed', at: Date.now(), evidence: `operator:${operator};${evidence}`, operator: true });
    return { phase: next.phase };
  }

  /* ================= 待回写与补偿(§5.6) ================= */

  private static readonly WRITEBACK_MAX_ATTEMPTS = 8;

  /**
   * 终态后的条件终写:以 operationId=dispatchId:finalize 幂等调用目标;
   * 补偿只重做幂等状态同步,**绝不重新调用模型、不重复实验、不重复追加台账**。
   * 节点状态映射由目标侧按其自身 schema 完成(done→done;blocked/failed→可重审;aborted 不回退)。
   */
  async processWriteback(id: string): Promise<void> {
    if (this.stopped) return;
    const rec = this.store.get(id);
    if (!rec || rec.phase !== 'finished' || !rec.result) return;
    if (!['pending', 'error'].includes(rec.writeback.state)) return;
    if (rec.writeback.attempts >= DispatchService.WRITEBACK_MAX_ATTEMPTS) return;
    let outcome: FinalizeResult;
    try {
      outcome = await this.target.finalize({
        dispatchId: id,
        ref: rec.targetRef,
        operationId: rec.writeback.operationId,
        outcome: rec.result.kind,
        summary: `${rec.result.reasonCode}:${rec.result.summary}`,
        reasonCode: rec.result.reasonCode,
      });
    } catch (e) {
      await this.bumpWriteback(id, 'error', String((e as Error)?.message ?? e).slice(0, 160));
      return;
    }
    if (outcome.ok) {
      await this.bumpWriteback(id, 'applied', `receipt@${outcome.receipt?.appliedAt ?? '?'}`);
    } else if (outcome.code === 'NOT_FOUND') {
      await this.bumpWriteback(id, 'skipped_deleted', outcome.detail);
    } else if (outcome.code === 'SUPERSEDED') {
      await this.bumpWriteback(id, 'skipped_superseded', outcome.detail);
    } else {
      await this.bumpWriteback(id, 'error', outcome.detail.slice(0, 160));
    }
  }

  private async bumpWriteback(id: string, state: WritebackState, note: string): Promise<void> {
    if (this.stopped) return;
    await this.store.mutate(() => {
      const root = this.store.snapshot();
      const rec = root?.dispatches[id];
      if (!rec) return;
      rec.writeback.state = state;
      rec.writeback.attempts += 1;
      if (state === 'error') rec.writeback.lastErrorCode = note;
      rec.audit.push({ at: Date.now(), type: `writeback-${state}`, actor: 'writeback', detail: note.slice(0, 140) });
    });
  }

  /** 测试/操作员入口:立即处理全部待回写(幂等,可重复调用)。 */
  async drainWritebacks(): Promise<void> {
    for (const d of this.store.all()) {
      if (d.phase === 'finished' && ['pending', 'error'].includes(d.writeback.state)) {
        await this.processWriteback(d.id);
      }
    }
  }

  /* ================= 查询 ================= */

  status(id: string): DispatchRecord {
    const rec = this.store.get(id);
    if (!rec) throw new ServiceError('NOT_FOUND', `派发 ${id} 不存在`, 404);
    return rec;
  }

  /** 容量与占用(客户端展示/自动化调度用;跨工作区并行语义)。 */
  concurrency(): { active: number; max: number } {
    const max = Math.max(1, this.config.maxConcurrentDispatches || 1);
    return { active: this.store.occupancy().activeAttempts, max };
  }

  /** 容量查询:全局并发是否还有空位。 */
  hasCapacity(): boolean {
    const { active, max } = this.concurrency();
    return active < max;
  }

  /** §8.3:可否操作由服务端判定,客户端只按此渲染按钮。 */
  list(ws?: string): Array<Record<string, unknown>> {    const root = ws ? canonicalRoot(ws) : null;
    return this.store.all()
      .filter((d) => !root || d.targetRef.canonicalRoot === root)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({
        id: d.id,
        targetType: d.targetType,
        phase: d.phase,
        node: { projectId: d.targetRef.projectId, nodeId: d.targetRef.nodeId },
        ws: d.targetRef.canonicalRoot,
        title: d.source.snapshot.nodeTitle,
        result: d.result ? `${d.result.kind}/${d.result.reasonCode}` : null,
        writebackState: d.writeback.state,
        hasReport: !!d.report,
        createdAt: d.createdAt,
        endedAt: d.endedAt ?? null,
        allowedActions: allowedActions(d),
      }));
  }
}
