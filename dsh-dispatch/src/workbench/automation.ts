/**
 * 阶段 D:本地定时自动化(方案 §4 阶段D)。
 *
 * 首版规则:用户保存任务模板(项目/标题/目标/验收标准)+ 执行对象(Agent),
 * 设置 cron 表达式并启用。到点创建新任务并启动 Run;忙时跳过;停机不补跑。
 *
 * 执行语义:
 * - (ruleId, scheduledAt) 唯一——重复调度/重启不产生两条
 * - 全局槽忙 → skipped_busy,不创建等待任务
 * - 停机错过 → missed_offline 摘要,不补跑
 * - 每次尝试先持久 TriggerAttempt 再启动
 */
import { ServiceError } from '../types.js';
import type { WorkbenchStore } from './store.js';
import { newId } from './store.js';

export type TriggerResult = 'planned' | 'started' | 'skipped_busy' | 'skipped_invalid' | 'failed' | 'missed_offline';

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  /** cron 表达式(分 时 日 月 周) */
  cron: string;
  timezone: string;
  /** 任务模板 */
  template: {
    projectId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    assigneeId: string;
  };
  /** 下次触发时间(ms epoch);由调度器维护 */
  nextTriggerAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TriggerAttempt {
  id: string;
  ruleId: string;
  ruleName: string;
  scheduledAt: number;
  result: TriggerResult;
  reason?: string;
  taskId?: string;
  dispatchId?: string;
  at: number;
}

export interface AutomationStore {
  automationRules: Record<string, AutomationRule>;
  triggerAttempts: Record<string, TriggerAttempt>;
}

export class AutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxAttempts = 200;

  constructor(
    private readonly store: WorkbenchStore,
    private readonly startTask: (template: AutomationRule['template'], source: string, ruleName: string) => Promise<{ taskId: string; dispatchId: string }>,
    private readonly isSlotBusy: () => boolean,
  ) {}

  private root(): AutomationStore & { automationRules: Record<string, AutomationRule>; triggerAttempts: Record<string, TriggerAttempt> } {
    const root = this.store.snapshot();
    if (!root) throw new ServiceError('STORE_READONLY', '工作台不可用', 503);
    const autoRoot = root as never as AutomationStore;
    if (!autoRoot.automationRules) { autoRoot.automationRules = {}; autoRoot.triggerAttempts = {}; }
    return autoRoot;
  }

  list(): AutomationRule[] { return Object.values(this.root().automationRules ?? {}); }
  attempts(): TriggerAttempt[] { return Object.values(this.root().triggerAttempts ?? {}).sort((a, b) => b.at - a.at).slice(0, this.maxAttempts); }

  async create(raw: Record<string, unknown>): Promise<AutomationRule> {
    const name = String(raw.name ?? '').trim();
    const cron = String(raw.cron ?? '').trim();
    const timezone = String(raw.timezone ?? 'Asia/Shanghai').trim();
    const template = raw.template as AutomationRule['template'];
    if (!name || name.length > 120) throw new ServiceError('VALIDATION', '规则名称必填且不超过 120 字符', 422);
    if (!cron || !this.isValidCron(cron)) throw new ServiceError('VALIDATION', '无效的 cron 表达式', 422);
    if (!template?.projectId || !template?.title || !template?.acceptanceCriteria) {
      throw new ServiceError('VALIDATION', '任务模板缺少必填字段(项目/标题/验收标准)', 422);
    }
    if (!this.isValidTimezone(timezone)) throw new ServiceError('VALIDATION', `无效的 IANA 时区:${timezone}`, 422);
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      if (!autoRoot.automationRules) { autoRoot.automationRules = {}; autoRoot.triggerAttempts = {}; }
      // 模板引用存在性:项目与执行者(Agent 或小队)缺失即拒绝——避免触发时才失败留孤儿
      if (!root.projects[template.projectId]) throw new ServiceError('VALIDATION', '模板引用的项目不存在', 422);
      const assigneeRoot = root as unknown as { agents: Record<string, unknown>; squads?: Record<string, unknown> };
      if (template.assigneeId && !assigneeRoot.agents[template.assigneeId] && !assigneeRoot.squads?.[template.assigneeId]) {
        throw new ServiceError('VALIDATION', '模板引用的执行者或小队不存在', 422);
      }
      const now = Date.now();
      const rule: AutomationRule = {
        id: newId('ar'),
        name, cron, timezone, template,
        enabled: raw.enabled === true, // 默认禁用:创建后由用户显式启用,防止模板有误即自动开跑
        revision: 1, createdAt: now, updatedAt: now,
      };
      rule.nextTriggerAt = this.computeNextTrigger(cron, now, timezone);
      autoRoot.automationRules[rule.id] = rule;
      return rule;
    });
  }

  async update(id: string, raw: Record<string, unknown>): Promise<AutomationRule> {
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const rule = autoRoot.automationRules?.[id];
      if (!rule) throw new ServiceError('NOT_FOUND', `规则 ${id} 不存在`, 404);
      const expectedRevision = Number(raw.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new ServiceError('IDEMPOTENCY_CONFLICT', '缺少有效的 expectedRevision', 409);
      }
      if (expectedRevision !== rule.revision) throw new ServiceError('IDEMPOTENCY_CONFLICT', '版本冲突', 409);
      if (raw.name !== undefined) rule.name = String(raw.name).slice(0, 120);
      if (raw.cron !== undefined) {
        const cron = String(raw.cron);
        if (!this.isValidCron(cron)) throw new ServiceError('VALIDATION', '无效的 cron 表达式', 422);
        rule.cron = cron;
      }
      if (raw.timezone !== undefined) {
        const tz = String(raw.timezone);
        if (!this.isValidTimezone(tz)) throw new ServiceError('VALIDATION', `无效的 IANA 时区:${tz}`, 422);
        rule.timezone = tz;
      }
      if (raw.enabled !== undefined) rule.enabled = Boolean(raw.enabled);
      if (raw.template !== undefined) Object.assign(rule.template, raw.template);
      rule.nextTriggerAt = this.computeNextTrigger(rule.cron, Date.now(), rule.timezone);
      rule.revision += 1;
      rule.updatedAt = Date.now();
      return rule;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      if (!autoRoot.automationRules?.[id]) return false;
      delete autoRoot.automationRules[id];
      return true;
    });
  }

  /** 启动调度器(每 30s 检查一次)。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    (this.timer as { unref?: () => void }).unref?.();
    console.log('[dsh-dispatch] 自动化调度器已启动(30s 间隔)');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private ticking = false;
  /** 单次调度检查:串行(上一轮未完成则跳过);停机期间过期的先记 missed_offline 再推进游标。 */
  async tick(): Promise<void> {
    if (this.store.fault.readOnly || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const rules = this.list().filter((r) => r.enabled && r.nextTriggerAt);
      for (const rule of rules) {
        if (rule.nextTriggerAt! > now) continue;
        try {
          // P0-4:停机不补跑——过期的计划时刻只记审计,不执行;推进游标到未来
          const missedMs = now - rule.nextTriggerAt!;
          if (missedMs > 120_000) { // 超过 2 分钟视为停机错过
            await this.recordMissedOffline(rule, rule.nextTriggerAt!, missedMs);
            await this.advanceCursor(rule.id);
            continue;
          }
          await this.tryTrigger(rule.id, rule.nextTriggerAt!);
        } catch (e) {
          console.error(`[dsh-dispatch] 自动化规则 ${rule.id} 触发异常:${String((e as Error)?.message ?? e)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 尝试触发一条规则(P0-5:原子去重——检查+创建在同一 store.mutate 内)。 */
  async tryTrigger(ruleId: string, scheduledAt: number): Promise<TriggerAttempt | null> {
    // P0-5:原子检查+创建——同 (ruleId, scheduledAt) 的并发调用只有一个成功
    const attemptOrExisting = await this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const rule = autoRoot.automationRules?.[ruleId];
      if (!rule) return { error: 'not_found' as const };
      // 原子检查:同键已有记录 → 直接返回(不创建新的)
      const existing = Object.values(autoRoot.triggerAttempts ?? {})
        .find((a) => a.ruleId === ruleId && a.scheduledAt === scheduledAt);
      if (existing) return { existing };
      // 创建新 attempt(planned)——在同一次原子操作内
      const attempt: TriggerAttempt = {
        id: newId('ta'), ruleId, ruleName: rule.name,
        scheduledAt, result: 'planned', at: Date.now(),
      };
      if (!autoRoot.triggerAttempts) autoRoot.triggerAttempts = {};
      autoRoot.triggerAttempts[attempt.id] = attempt;
      // 限制数量
      const all = Object.values(autoRoot.triggerAttempts).sort((a, b) => a.at - b.at);
      while (all.length > this.maxAttempts) delete autoRoot.triggerAttempts[all.shift()!.id];
      return { attempt };
    });
    if ('error' in attemptOrExisting) throw new ServiceError('NOT_FOUND', `规则 ${ruleId} 不存在`, 404);
    // P0-4:planned 态可恢复——崩溃在"落盘 planned"与"启动完成"之间时,
    // 重试同一 (ruleId, scheduledAt) 会走这里继续启动而非永久搁置;
    // 已到 started/failed/skipped_* 的原样返回(不重复动作)
    const attempt = 'existing' in attemptOrExisting ? attemptOrExisting.existing : attemptOrExisting.attempt;
    if (!attempt) return null;
    if (attempt.result !== 'planned') return attempt;
    const rule = this.root().automationRules?.[ruleId];
    if (!rule) throw new ServiceError('NOT_FOUND', `规则 ${ruleId} 不存在`, 404);
    try {
      if (this.isSlotBusy()) {
        await this.updateAttempt(attempt.id, { result: 'skipped_busy', reason: '全局并发已满' });
        return { ...attempt, result: 'skipped_busy', reason: '全局并发已满' };
      }
      // P0-5:确定性幂等键(含 scheduledAt,重试可定位)——替代 Date.now()
      const { taskId, dispatchId } = await this.startTask(rule.template, `automation:${rule.id}:${scheduledAt}`, rule.name);
      await this.updateAttempt(attempt.id, { result: 'started', taskId, dispatchId });
      return { ...attempt, result: 'started', taskId, dispatchId };
    } catch (e) {
      await this.updateAttempt(attempt.id, { result: 'failed', reason: String((e as Error)?.message ?? e).slice(0, 200) });
      return { ...attempt, result: 'failed', reason: String(e) };
    } finally {
      await this.advanceCursor(ruleId);
    }
  }

  /** P0-4:停机错过审计(不执行,只记录时间范围)。 */
  private async recordMissedOffline(rule: AutomationRule, scheduledAt: number, missedMs: number): Promise<void> {
    await this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      if (!autoRoot.triggerAttempts) autoRoot.triggerAttempts = {};
      const attempt: TriggerAttempt = {
        id: newId('ta'), ruleId: rule.id, ruleName: rule.name,
        scheduledAt, result: 'missed_offline',
        reason: `停机错过 ${Math.round(missedMs / 60000)} 分钟(不补跑)`,
        at: Date.now(),
      };
      autoRoot.triggerAttempts[attempt.id] = attempt;
    });
  }

  private async recordAttempt(rule: AutomationRule, scheduledAt: number, result: TriggerResult): Promise<TriggerAttempt> {
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const attempt: TriggerAttempt = {
        id: newId('ta'), ruleId: rule.id, ruleName: rule.name,
        scheduledAt, result, at: Date.now(),
      };
      autoRoot.triggerAttempts[attempt.id] = attempt;
      // 限制 attempts 数量
      const all = Object.values(autoRoot.triggerAttempts).sort((a, b) => a.at - b.at);
      while (all.length > this.maxAttempts) {
        delete autoRoot.triggerAttempts[all.shift()!.id];
      }
      return attempt;
    });
  }

  private async updateAttempt(id: string, patch: Partial<TriggerAttempt>): Promise<void> {
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const attempt = autoRoot.triggerAttempts?.[id];
      if (attempt) Object.assign(attempt, patch);
    });
  }

  private async advanceCursor(ruleId: string): Promise<void> {
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const rule = autoRoot.automationRules?.[ruleId];
      if (rule) rule.nextTriggerAt = this.computeNextTrigger(rule.cron, Date.now(), rule.timezone);
    });
  }

  private static tzCache = new Map<string, Intl.DateTimeFormat>();
  private formatter(tz: string): Intl.DateTimeFormat {
    let f = AutomationService.tzCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
      AutomationService.tzCache.set(tz, f);
    }
    return f;
  }
  private isValidTimezone(tz: string): boolean {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }
  /** 指定时区的墙钟分量(epoch → 该时区年月日时分+周几)。 */
  private wallOf(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
    const parts = this.formatter(tz).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? '0');
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .indexOf(parts.find((x) => x.type === 'weekday')?.value ?? 'Sun');
    return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), dow };
  }
  /** 墙钟 → epoch:固定锚点两轮偏移逼近 offset = guess - U(W(guess)),
   *  epoch = U(目标墙钟) + offset。DST 不存在的时刻收敛到偏移后实际时刻,由调用方回读校验。 */
  private wallToMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
    const wallUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
    let guess = wallUtc;
    for (let i = 0; i < 2; i++) {
      const w = this.wallOf(guess, tz);
      const next = wallUtc + (guess - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, 0));
      if (next === guess) break;
      guess = next;
    }
    return guess;
  }

  /** P0-4/P0-2/P0-3:全字段 cron(分 时 日 月 周)按规则时区两段式搜索——
   *  先按墙钟日推进(10 年窗口,覆盖闰日跨世纪最大 8 年间隔),再在天内按小时×分钟匹配;
   *  日 与 周 同时受限时按 Vixie cron 语义取 OR。窗口内无匹配返回 0 表示永不调度,
   *  绝不回退 from+1h(旧回退会使周/月级每小时触发一次)。 */
  private computeNextTrigger(cron: string, from: number, timezone: string): number {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return 0;
    const [minPart, hourPart, domPart, monPart, dowPart] = parts;
    const domAll = domPart === '*';
    const dowAll = dowPart === '*';
    let { y, mo, d } = this.wallOf(from + 60_000, timezone);
    for (let i = 0; i < 3660; i++) {
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const monOk = this.cronFieldMatches(monPart, mo);
      const domOk = this.cronFieldMatches(domPart, d);
      const dowOk = this.cronFieldMatches(dowPart, dow);
      if (monOk && (domAll || dowAll ? domOk && dowOk : domOk || dowOk)) {
        for (let h = 0; h < 24; h++) {
          if (!this.cronFieldMatches(hourPart, h)) continue;
          for (let mi = 0; mi < 60; mi++) {
            if (!this.cronFieldMatches(minPart, mi)) continue;
            const t = this.wallToMs(y, mo, d, h, mi, timezone);
            // 回读校验:DST 跳变产生的不存在墙钟时刻不采纳(顺延到下一个匹配)
            const v = this.wallOf(t, timezone);
            if (v.y === y && v.mo === mo && v.d === d && v.h === h && v.mi === mi && t > from) return t;
          }
        }
      }
      const nd = new Date(Date.UTC(y, mo - 1, d + 1));
      y = nd.getUTCFullYear(); mo = nd.getUTCMonth() + 1; d = nd.getUTCDate();
    }
    return 0;
  }

  private cronFieldMatches(part: string, value: number): boolean {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      return step > 0 && value % step === 0;
    }
    return part.split(',').some((p) => Number(p.trim()) === value);
  }

  /** P0-4:全字段校验(含范围检查和逗号多值)。 */
  private isValidCron(cron: string): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    return parts.every((p, i) => {
      const [min, max] = ranges[i];
      if (p === '*') return true;
      if (p.startsWith('*/')) {
        const step = Number(p.slice(2));
        return Number.isInteger(step) && step > 0;
      }
      return p.split(',').every((v) => {
        const n = Number(v.trim());
        return Number.isInteger(n) && n >= min && n <= max;
      });
    });
  }
}
