/**
 * 目标适配层(P2):派发目标的读取与原子条件写。
 * 契约镜像 DISPATCH-DESIGN-REVISED.md §5.4 四动作(claim/progress/finalize/revoke),
 * HTTP trajectory 适配器按同一接口接入,服务层不感知后端。
 *
 * P2 修订:任务语义指纹由**目标侧单侧计算**并随 read 返回——dispatch 不自算,
 * claim 时原样带回、目标在临界区内重算比对,两端不存在算法漂移。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskSnapshot } from '../types.js';
import { ServiceError } from '../types.js';

export type TargetRef = { projectId: string; nodeId: string; workspaceId: string; canonicalRoot: string; targetType?: 'traj_node' | 'workbench_task' };

export type ClaimFailureCode = 'NODE_OCCUPIED' | 'TASK_CHANGED' | 'NOT_FOUND' | 'SUPERSEDED';

export type ClaimResult =
  | { ok: true; epoch: number; taskFingerprint: string }
  | { ok: false; code: ClaimFailureCode; detail: string };

export interface FinalizeResult {
  ok: boolean;
  /** SUPERSEDED=接管/条件变更(回写记 skipped_superseded);NOT_FOUND=节点已删(skipped_deleted) */
  code?: 'SUPERSEDED' | 'NOT_FOUND' | 'CONFLICT' | 'WRITES_DISABLED';
  detail: string;
  receipt?: { operationId: string; appliedAt: number };
}

export interface TargetAdapter {
  readonly kind: 'memory' | 'trajectory-http' | 'workbench' | 'routed';
  readTask(ref: TargetRef): Promise<{ snapshot: TaskSnapshot; fingerprint: string } | null>;
  /** 幂等:同 dispatchId 重复领取返回原 epoch/指纹(领取回执丢失恢复,T07)。 */
  claim(input: { dispatchId: string; childSessionId: string; ref: TargetRef; expectedFingerprint: string }): Promise<ClaimResult>;
  /** 台账条件追加:worker 写权限校验 + operationId 幂等(同 opId 同内容=重放,不同内容=冲突)。 */
  progress(input: { dispatchId: string; ref: TargetRef; operationId: string; title: string; payload?: unknown; metrics?: unknown }): Promise<{ ok: boolean; detail: string }>;
  /** 条件终写:结论+状态+最终台账一次原子提交;operationId 幂等重发返回原回执(T21)。 */
  finalize(input: {
    dispatchId: string;
    ref: TargetRef;
    operationId: string;
    outcome: 'done' | 'failed' | 'blocked' | 'aborted';
    summary: string;
    reasonCode: string;
  }): Promise<FinalizeResult>;
  /** 两级撤权:worker_only 关执行者写入保留宿主收尾 claim;takeover 废整个所有权(§5.5)。 */
  revoke(input: { dispatchId: string; ref?: TargetRef; mode: 'worker_only' | 'takeover' }): Promise<{ ok: boolean; detail: string }>;
}

/** 任务语义指纹(内存后端专用;trajectory 后端的指纹由 /traj/dispatch-op read 单侧提供)。 */
export function taskFingerprint(task: TaskSnapshot): string {
  const semantic = {
    projectId: task.projectId,
    nodeId: task.nodeId,
    nodeTitle: task.nodeTitle,
    nodeKind: task.nodeKind ?? '',
    nodeDetail: task.nodeDetail ?? '',
    goalText: task.goalText ?? '',
    goalVersion: task.goalVersion ?? 0,
    hypothesisText: task.hypothesisText ?? '',
    contract: task.contract ?? {},
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

/* ================= 内存实现(契约原型 + 测试后端) ================= */

interface MemoryNode {
  task: TaskSnapshot;
  fingerprint: string;
  owner: { dispatchId: string; childSessionId: string; epoch: number } | null;
  workerWrites: boolean;
  /** 执行自身产生的台账——指纹刻意排除,避免执行者写进度导致任务自失效。 */
  entries: Array<{ operationId: string; title: string; data?: unknown; at: number }>;
  conclusion?: { outcome: string; summary: string; at: number };
}

interface FinalizeReceiptRecord { operationId: string; appliedAt: number }

export class InMemoryTargetAdapter implements TargetAdapter {
  readonly kind = 'memory' as const;
  private nodes = new Map<string, MemoryNode>();
  private finalizeReceipts = new Map<string, FinalizeReceiptRecord>();
  private epochCounter = 0;
  /** 故障注入(测试):下一次 finalize 抛错(模拟回写暂时不可用,T22)。 */
  failNextFinalize: string | null = null;

  /** 测试装配:注册/更新任务节点(更新指纹变化 → 旧所有权失效,§5.5)。 */
  upsertNode(task: TaskSnapshot): void {
    const key = this.keyOf(task.projectId, task.nodeId);
    const existing = this.nodes.get(key);
    const fp = taskFingerprint(task);
    if (existing) {
      existing.task = task;
      if (existing.fingerprint !== fp) {
        existing.owner = null;
        existing.workerWrites = false;
      }
      existing.fingerprint = fp;
      return;
    }
    this.nodes.set(key, { task, fingerprint: fp, owner: null, workerWrites: false, entries: [] });
  }

  /** 测试装配:人工编辑(即使指纹未变也令旧 claim 失效——接管语义,§5.5)。 */
  humanEdit(projectId: string, nodeId: string, patch: Partial<TaskSnapshot>): void {
    const n = this.nodes.get(this.keyOf(projectId, nodeId));
    if (!n) return;
    Object.assign(n.task, patch);
    const fp = taskFingerprint(n.task);
    n.owner = null;
    n.workerWrites = false;
    n.fingerprint = fp;
  }

  /** 测试装配:删除节点(T20:finalize → NOT_FOUND → skipped_deleted)。 */
  removeNode(projectId: string, nodeId: string): void {
    this.nodes.delete(this.keyOf(projectId, nodeId));
  }

  /** 测试观察。 */
  ownerOf(projectId: string, nodeId: string): MemoryNode['owner'] {
    return this.nodes.get(this.keyOf(projectId, nodeId))?.owner ?? null;
  }
  entriesOf(projectId: string, nodeId: string): number {
    return this.nodes.get(this.keyOf(projectId, nodeId))?.entries.length ?? 0;
  }
  conclusionOf(projectId: string, nodeId: string): MemoryNode['conclusion'] {
    return this.nodes.get(this.keyOf(projectId, nodeId))?.conclusion;
  }

  private keyOf(projectId: string, nodeId: string): string {
    return `${projectId}/${nodeId}`;
  }

  private findOwned(dispatchId: string): MemoryNode | null {
    for (const n of this.nodes.values()) {
      if (n.owner?.dispatchId === dispatchId) return n;
    }
    return null;
  }
  private findAny(dispatchId: string): MemoryNode | null {
    const owned = this.findOwned(dispatchId);
    if (owned) return owned;
    for (const n of this.nodes.values()) {
      if (n.entries.some((e) => e.operationId.startsWith(`${dispatchId}:`))) return n;
    }
    return null;
  }

  async readTask(ref: TargetRef): Promise<{ snapshot: TaskSnapshot; fingerprint: string } | null> {
    const n = this.nodes.get(this.keyOf(ref.projectId, ref.nodeId));
    if (!n) return null;
    return { snapshot: structuredClone(n.task), fingerprint: n.fingerprint };
  }

  async claim(input: { dispatchId: string; childSessionId: string; ref: TargetRef; expectedFingerprint: string }): Promise<ClaimResult> {
    const key = this.keyOf(input.ref.projectId, input.ref.nodeId);
    const n = this.nodes.get(key);
    if (!n) return { ok: false, code: 'NOT_FOUND', detail: `节点 ${key} 不存在` };
    if (n.owner) {
      if (n.owner.dispatchId === input.dispatchId) {
        return { ok: true, epoch: n.owner.epoch, taskFingerprint: n.fingerprint };
      }
      return { ok: false, code: 'NODE_OCCUPIED', detail: `节点已被派发 ${n.owner.dispatchId} 领取(epoch=${n.owner.epoch})` };
    }
    if (n.fingerprint !== input.expectedFingerprint) {
      return { ok: false, code: 'TASK_CHANGED', detail: '任务语义指纹已变化,请重新读取任务' };
    }
    const epoch = ++this.epochCounter;
    n.owner = { dispatchId: input.dispatchId, childSessionId: input.childSessionId, epoch };
    n.workerWrites = true;
    return { ok: true, epoch, taskFingerprint: n.fingerprint };
  }

  async progress(input: { dispatchId: string; operationId: string; title: string; payload?: unknown; metrics?: unknown }): Promise<{ ok: boolean; detail: string }> {
    const n = this.findOwned(input.dispatchId);
    if (!n) return { ok: false, detail: '无本派发的有效领取' };
    if (!n.workerWrites) return { ok: false, detail: '执行者写入已封闭(worker_only)' };
    const dup = n.entries.find((e) => e.operationId === input.operationId);
    if (dup) {
      const same = dup.title === input.title && JSON.stringify(dup.data) === JSON.stringify(input.payload ?? null);
      return same ? { ok: true, detail: '幂等重放' } : { ok: false, detail: '同 operationId 不同内容,冲突' };
    }
    n.entries.push({ operationId: input.operationId, title: input.title, data: input.payload, at: Date.now() });
    return { ok: true, detail: '已追加' };
  }

  async finalize(input: {
    dispatchId: string; operationId: string; outcome: 'done' | 'failed' | 'blocked' | 'aborted';
    summary: string; reasonCode: string;
  }): Promise<FinalizeResult> {
    if (this.failNextFinalize) {
      const msg = this.failNextFinalize;
      this.failNextFinalize = null;
      throw new Error(msg);
    }
    const prev = this.finalizeReceipts.get(input.operationId);
    if (prev) return { ok: true, detail: '幂等重放(原回执)', receipt: prev };
    const n = this.findAny(input.dispatchId);
    if (!n) return { ok: false, code: 'NOT_FOUND', detail: '节点不存在(已删除?)' };
    if (!n.owner) return { ok: false, code: 'SUPERSEDED', detail: '所有权已被接管/释放,拒绝终写' };
    n.entries.push({ operationId: `${input.operationId}:entry`, title: `派发终局:${input.outcome}(${input.reasonCode})`, data: { outcome: input.outcome, summary: input.summary }, at: Date.now() });
    n.conclusion = { outcome: input.outcome, summary: input.summary, at: Date.now() };
    n.workerWrites = false;
    n.owner = null;
    const receipt = { operationId: input.operationId, appliedAt: Date.now() };
    this.finalizeReceipts.set(input.operationId, receipt);
    return { ok: true, detail: '已终写', receipt };
  }

  async revoke(input: { dispatchId: string; mode: 'worker_only' | 'takeover' }): Promise<{ ok: boolean; detail: string }> {
    for (const n of this.nodes.values()) {
      if (n.owner?.dispatchId !== input.dispatchId) continue;
      if (input.mode === 'takeover') {
        n.owner = null;
        n.workerWrites = false;
        return { ok: true, detail: '所有权已撤销(takeover)' };
      }
      n.workerWrites = false;
      return { ok: true, detail: '执行者写入已封闭(worker_only)' };
    }
    return { ok: true, detail: '无在册所有权(视为已撤)' };
  }
}

/* ================= HTTP trajectory 适配器(§5.4 契约) ================= */

function serviceToken(): string | null {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  try {
    const t = readFileSync(join(home, '.dispatch-service-token'), 'utf8').trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

interface TrajTaskPayload {
  projectId: string;
  nodeId: string;
  workspaceKey: string;
  goal: { text: string; version: number } | null;
  hypothesis: { id: string; text: string; status: string; track: string } | null;
  node: { title: string; kind: string; status: string; detail: string; tags: string[]; refs: Record<string, string> };
  entriesCount: number;
  fingerprint: string;
}

interface TrajOpResponse {
  ok: boolean;
  epoch?: number;
  fingerprint?: string;
  code?: string;
  detail?: string;
  error?: string;
  receipt?: { operationId: string; appliedAt: number };
  task?: TrajTaskPayload;
}

export class HttpTrajectoryAdapter implements TargetAdapter {
  readonly kind = 'trajectory-http' as const;

  constructor(private base: string) {}

  private async op(body: Record<string, unknown>, timeoutMs = 15_000): Promise<TrajOpResponse> {
    const token = serviceToken();
    if (!token) {
      throw new ServiceError('DEPENDENCY_MISSING', '服务身份 token 不可读($DSH_HOME/.dispatch-service-token);trajectory 未装或未启动?', 503);
    }
    const res = await fetch(`${this.base}/traj/dispatch-op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dispatch-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as TrajOpResponse;
    if (res.status === 403) {
      throw new ServiceError('DEPENDENCY_MISSING', `dispatch-op 服务身份被拒(${json.error ?? res.status})`, 503);
    }
    return json;
  }

  async readTask(ref: TargetRef): Promise<{ snapshot: TaskSnapshot; fingerprint: string } | null> {
    const r = await this.op({ action: 'read', projectId: ref.projectId, nodeId: ref.nodeId });
    if (!r.ok || !r.task) return null;
    const t = r.task;
    return {
      fingerprint: t.fingerprint,
      snapshot: {
        source: 'trajectory',
        projectId: t.projectId,
        nodeId: t.nodeId,
        nodeTitle: t.node.title,
        nodeKind: t.node.kind,
        nodeDetail: t.node.detail || undefined,
        goalText: t.goal?.text,
        goalVersion: t.goal?.version,
        hypothesisText: t.hypothesis?.text,
        entriesCount: t.entriesCount,
      },
    };
  }

  async claim(input: { dispatchId: string; childSessionId: string; ref: TargetRef; expectedFingerprint: string }): Promise<ClaimResult> {
    const r = await this.op({
      action: 'claim',
      dispatchId: input.dispatchId,
      childSessionId: input.childSessionId,
      projectId: input.ref.projectId,
      nodeId: input.ref.nodeId,
      expectedFingerprint: input.expectedFingerprint,
    });
    return r.ok
      ? { ok: true, epoch: r.epoch ?? 0, taskFingerprint: r.fingerprint ?? '' }
      : { ok: false, code: (r.code as ClaimFailureCode) ?? 'TASK_CHANGED', detail: r.detail ?? r.error ?? '领取被拒' };
  }

  async progress(input: { dispatchId: string; ref: TargetRef; operationId: string; title: string; payload?: unknown; metrics?: unknown }): Promise<{ ok: boolean; detail: string }> {
    const r = await this.op({
      action: 'progress',
      dispatchId: input.dispatchId,
      projectId: input.ref.projectId,
      nodeId: input.ref.nodeId,
      operationId: input.operationId,
      title: input.title,
      payload: input.payload ?? null,
      metrics: input.metrics ?? null,
    });
    return { ok: r.ok, detail: r.detail ?? r.error ?? '' };
  }

  async finalize(input: {
    dispatchId: string; ref: TargetRef; operationId: string;
    outcome: 'done' | 'failed' | 'blocked' | 'aborted'; summary: string; reasonCode: string;
  }): Promise<FinalizeResult> {
    const r = await this.op({
      action: 'finalize',
      dispatchId: input.dispatchId,
      projectId: input.ref.projectId,
      nodeId: input.ref.nodeId,
      operationId: input.operationId,
      outcome: input.outcome,
      summary: input.summary,
      reasonCode: input.reasonCode,
    });
    return { ok: r.ok, code: r.code as FinalizeResult['code'], detail: r.detail ?? r.error ?? '', receipt: r.receipt };
  }

  async revoke(input: { dispatchId: string; ref?: TargetRef; mode: 'worker_only' | 'takeover' }): Promise<{ ok: boolean; detail: string }> {
    const r = await this.op({
      action: 'revoke',
      dispatchId: input.dispatchId,
      projectId: input.ref?.projectId ?? '',
      nodeId: input.ref?.nodeId ?? '',
      mode: input.mode,
    });
    return { ok: r.ok, detail: r.detail ?? r.error ?? '' };
  }
}
