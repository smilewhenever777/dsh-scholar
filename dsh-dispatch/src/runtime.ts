/**
 * 运行时适配层(P1):对 ctx.subagents / ctx.agents 的薄封装 + 测试用 MockRuntime。
 * 语义全部来自 P0 实测(docs/runtime-capabilities.md):
 *  - startContinuable 拒绝 = 完整回滚(可作为"未启动"证明)
 *  - interruptByParent 受理 ≠ 停止;未开始的 inbox 工作 park 保留,后续消息可恢复
 *  - 队列静止确认需要 end 观察 + drain 尝试
 *  - sponsor 工厂创建必须显式 agentOptions(无默认模型路由)
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { ServiceError } from './types.js';

export interface SponsorHandle {
  sessionId: string;
  agent: Agent;
  via: 'create' | 'get-live' | 'resume';
}

export interface StartChildSpec {
  label: string;
  childId: string;
  prompt: string;
  sponsor: SponsorHandle;
  modelProvider: string;
  model: string;
  maxDepth: number;
  toolAllow?: string[];
}

export interface ChildSummary {
  id: string;
  activity: 'running' | 'inactive' | string;
  label?: string;
  mode?: string;
}

/** 运行时事件(适配器规范化后交给 service;P0:插件级监听可全量收到)。 */
export type RuntimeEvent =
  | { kind: 'run-started'; childId: string; runId: string; at: number }
  | { kind: 'run-ended'; childId: string; runId: string; stopReason: string; at: number };

export interface RuntimeAdapter {
  readonly kind: 'mock' | 'dsh-subagent';
  listProviders(): string[];
  ensureSponsor(ws: string, modelProvider: string, model: string): Promise<SponsorHandle>;
  startContinuable(spec: StartChildSpec, signal: AbortSignal): Promise<{ childId: string; messageId: string }>;
  interruptByParent(childId: string, sponsorSessionId: string): { accepted: boolean };
  drainContinuableChildren(sponsor: SponsorHandle, childIds: string[]): Promise<void>;
  listChildren(sponsorSessionId: string): Promise<ChildSummary[]>;
  /** 仅供测试/探针:以 sponsor 身份向 child 发消息(P0:会恢复 parked 队列)。 */
  sendMessageAsSponsor(sponsor: SponsorHandle, childId: string, text: string): Promise<{ messageId: string }>;
  /** 生命周期事件订阅;返回退订函数。 */
  onEvent(fn: (ev: RuntimeEvent) => void): () => void;
}

/* ================= 真实适配器(ctx.subagents) ================= */

export class SubagentRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'dsh-subagent' as const;
  private listeners = new Set<(ev: RuntimeEvent) => void>();
  private sponsors = new Map<string, SponsorHandle>();

  constructor(private ctx: Context) {
    const anyCtx = ctx as unknown as { on?: (ev: string, fn: (info: unknown) => void) => void };
    anyCtx.on?.('subagent/start', (info) => {
      const i = info as { runId?: unknown; id?: unknown };
      this.emit({ kind: 'run-started', childId: String(i?.id ?? ''), runId: String(i?.runId ?? ''), at: Date.now() });
    });
    anyCtx.on?.('subagent/end', (info) => {
      const i = info as { runId?: unknown; id?: unknown; stopReason?: unknown };
      this.emit({
        kind: 'run-ended',
        childId: String(i?.id ?? ''),
        runId: String(i?.runId ?? ''),
        stopReason: String(i?.stopReason ?? ''),
        at: Date.now(),
      });
    });
  }

  private emit(ev: RuntimeEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* 监听器失败不阻断事件面 */ }
    }
  }

  onEvent(fn: (ev: RuntimeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listProviders(): string[] {
    const sub = (this.ctx as unknown as { subagents?: { list?: () => string[] } }).subagents;
    return typeof sub?.list === 'function' ? sub.list() : [];
  }

  private agentsSvc(): {
    get?: (id: string) => Agent | undefined;
    create?: (o: unknown) => Promise<{ agent: Agent }>;
    resume?: (o: unknown) => Promise<{ agent: Agent }>;
  } {
    const a = (this.ctx as unknown as { agents?: unknown }).agents;
    if (!a) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.agents 不可用', 503);
    return a as never;
  }

  /** P0 修订 1/2:sponsor 创建/领养必须带显式模型路由(agentOptions)。 */
  async ensureSponsor(ws: string, modelProvider: string, model: string): Promise<SponsorHandle> {
    const norm = ws.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    const sessionId = `dispatch-${createHash('sha256').update(norm).digest('hex').slice(0, 12)}`;
    const cached = this.sponsors.get(sessionId);
    if (cached) return cached;
    const agents = this.agentsSvc();
    const agentOptions = { provider: modelProvider, model };
    const live = agents.get?.(sessionId);
    if (live) {
      const h: SponsorHandle = { sessionId, agent: live, via: 'get-live' };
      this.sponsors.set(sessionId, h);
      return h;
    }
    try {
      const handle = await agents.create!({ sessionId, meta: { cwd: ws }, agentOptions });
      const h: SponsorHandle = { sessionId, agent: handle.agent, via: 'create' };
      this.sponsors.set(sessionId, h);
      return h;
    } catch {
      const handle = await agents.resume!({ resumeSessionId: sessionId, agentOptions });
      const h: SponsorHandle = { sessionId, agent: handle.agent, via: 'resume' };
      this.sponsors.set(sessionId, h);
      return h;
    }
  }

  async startContinuable(spec: StartChildSpec, signal: AbortSignal): Promise<{ childId: string; messageId: string }> {
    const sub = (this.ctx as unknown as {
      subagents?: { startContinuable?: (spec: unknown) => Promise<{ childId: unknown; messageId: unknown }> };
    }).subagents;
    if (!sub?.startContinuable) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.subagents.startContinuable 不可用', 503);
    const toolFilter: Record<string, string[]> = {};
    if (spec.toolAllow?.length) toolFilter.allow = spec.toolAllow;
    const prompt: ContentBlock[] = [{ type: 'text', text: spec.prompt }];
    const r = await sub.startContinuable({
      provider: 'spawn',
      label: spec.label,
      childId: spec.childId,
      request: {
        prompt,
        parent: spec.sponsor.agent,
        agentOptions: { provider: spec.modelProvider, model: spec.model },
        maxDepth: spec.maxDepth,
        ...(Object.keys(toolFilter).length ? { toolFilter } : {}),
      },
      signal,
    });
    return { childId: String(r.childId), messageId: String(r.messageId) };
  }

  interruptByParent(childId: string, sponsorSessionId: string): { accepted: boolean } {
    const sub = (this.ctx as unknown as {
      subagents?: { interruptByParent?: (c: string, p: string, m: 'continuable') => unknown };
    }).subagents;
    if (!sub?.interruptByParent) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.subagents.interruptByParent 不可用', 503);
    sub.interruptByParent(childId, sponsorSessionId, 'continuable');
    return { accepted: true };
  }

  async drainContinuableChildren(sponsor: SponsorHandle, childIds: string[]): Promise<void> {
    const sub = (this.ctx as unknown as {
      subagents?: { drainContinuableChildren?: (p: Agent, ids: string[]) => Promise<void> };
    }).subagents;
    if (!sub?.drainContinuableChildren) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.subagents.drainContinuableChildren 不可用', 503);
    await sub.drainContinuableChildren(sponsor.agent, childIds);
  }

  async listChildren(sponsorSessionId: string): Promise<ChildSummary[]> {
    const sub = (this.ctx as unknown as {
      subagents?: { listChildren?: (id: string) => Promise<unknown[]> };
    }).subagents;
    if (!sub?.listChildren) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.subagents.listChildren 不可用', 503);
    const list = await sub.listChildren(sponsorSessionId);
    return list.map((e) => {
      const x = e as Record<string, unknown>;
      return {
        id: String(x.id ?? ''),
        activity: String(x.activity ?? ''),
        label: x.label === undefined ? undefined : String(x.label),
        mode: x.mode === undefined ? undefined : String(x.mode),
      };
    });
  }

  async sendMessageAsSponsor(sponsor: SponsorHandle, childId: string, text: string): Promise<{ messageId: string }> {
    const sub = (this.ctx as unknown as {
      subagents?: {
        sendMessage?: (s: Agent, t: string, c: ContentBlock[], o: { signal: AbortSignal }) => Promise<unknown>;
      };
    }).subagents;
    if (!sub?.sendMessage) throw new ServiceError('DEPENDENCY_MISSING', 'ctx.subagents.sendMessage 不可用', 503);
    const id = await sub.sendMessage(sponsor.agent, childId, [{ type: 'text', text }], { signal: AbortSignal.timeout(20_000) });
    return { messageId: String(id) };
  }
}

/* ================= Mock 运行时(无 LLM 故障注入) ================= */

interface MockChild {
  inbox: string[];
  activeRuns: Set<string>;
  drained: boolean;
  label: string;
}

export class MockRuntime implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  private listeners = new Set<(ev: RuntimeEvent) => void>() as Set<(ev: RuntimeEvent) => void>;
  sponsors = new Map<string, SponsorHandle>();
  children = new Map<string, MockChild>();
  calls: Array<{ op: string; detail?: string }> = [];
  /** 故障注入开关 */
  failNextStart: string | null = null;
  failListChildren: string | null = null;
  failDrain: string | null = null;

  private emit(ev: RuntimeEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  onEvent(fn: (ev: RuntimeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listProviders(): string[] {
    return ['spawn', 'mock'];
  }

  private sponsorFor(ws: string): SponsorHandle {
    const norm = ws.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    const key = `mock-sponsor-${createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
    let s = this.sponsors.get(key);
    if (!s) {
      s = { sessionId: key, agent: { id: key } as Agent, via: 'create' };
      this.sponsors.set(key, s);
    }
    return s;
  }

  async ensureSponsor(ws: string): Promise<SponsorHandle> {
    this.calls.push({ op: 'ensureSponsor', detail: ws });
    return this.sponsorFor(ws);
  }

  async startContinuable(spec: StartChildSpec): Promise<{ childId: string; messageId: string }> {
    this.calls.push({ op: 'startContinuable', detail: spec.childId });
    if (this.failNextStart) {
      const err = new Error(this.failNextStart) as Error & { code?: string };
      this.failNextStart = null;
      throw err; // P0 语义:拒绝 = 完整回滚
    }
    // 模拟"崩溃于启动后、回执保存前"(T09):child 已登记但调用方可选择不收回执
    this.children.set(spec.childId, { inbox: [spec.prompt], activeRuns: new Set(), drained: false, label: spec.label });
    return { childId: spec.childId, messageId: `msg-${spec.childId}` };
  }

  interruptByParent(childId: string, sponsorSessionId: string): { accepted: boolean } {
    this.calls.push({ op: 'interruptByParent', detail: `${childId}@${sponsorSessionId}` });
    return { accepted: true };
  }

  async drainContinuableChildren(sponsor: SponsorHandle, childIds: string[]): Promise<void> {
    this.calls.push({ op: 'drain', detail: childIds.join(',') });
    if (this.failDrain) {
      const e = new Error(this.failDrain);
      this.failDrain = null;
      throw e;
    }
    for (const id of childIds) {
      const c = this.children.get(id);
      if (c) {
        c.drained = true;
        c.inbox = [];
        c.activeRuns.clear();
      }
    }
    void sponsor;
  }

  async listChildren(sponsorSessionId: string): Promise<ChildSummary[]> {
    if (this.failListChildren) {
      const e = new Error(this.failListChildren);
      this.failListChildren = null;
      throw e;
    }
    return [...this.children.entries()]
      .filter(([, c]) => !c.drained || c.inbox.length > 0)
      .map(([id, c]) => ({
        id,
        activity: c.activeRuns.size > 0 ? 'running' : 'inactive',
        label: c.label,
        mode: 'continuable',
      }));
  }

  async sendMessageAsSponsor(sponsor: SponsorHandle, childId: string, text: string): Promise<{ messageId: string }> {
    this.calls.push({ op: 'sendMessage', detail: childId });
    const c = this.children.get(childId);
    if (c) c.inbox.push(text);
    void sponsor;
    return { messageId: `msg-${Date.now()}` };
  }

  /* ---------- 测试驱动:显式制造生命周期事件 ---------- */

  emitRunStart(childId: string, runId: string): void {
    const c = this.children.get(childId);
    if (c) c.activeRuns.add(runId);
    this.emit({ kind: 'run-started', childId, runId, at: Date.now() });
  }

  emitRunEnd(childId: string, runId: string, stopReason: string): void {
    const c = this.children.get(childId);
    if (c) c.activeRuns.delete(runId);
    this.emit({ kind: 'run-ended', childId, runId, stopReason, at: Date.now() });
  }

  /** inbox 中是否仍有 parked 工作(P0 发现 4 的模拟面)。 */
  parkedWork(childId: string): number {
    return this.children.get(childId)?.inbox.length ?? 0;
  }
}
