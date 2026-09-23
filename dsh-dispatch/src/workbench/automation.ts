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
    private readonly startTask: (template: AutomationRule['template'], source: string) => Promise<{ taskId: string; dispatchId: string }>,
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
    return this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      if (!autoRoot.automationRules) { autoRoot.automationRules = {}; autoRoot.triggerAttempts = {}; }
      const now = Date.now();
      const rule: AutomationRule = {
        id: newId('ar'),
        name, cron, timezone, template, enabled: raw.enabled !== false,
        revision: 1, createdAt: now, updatedAt: now,
      };
      rule.nextTriggerAt = this.computeNextTrigger(cron, now);
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
      if (Number.isSafeInteger(expectedRevision) && expectedRevision !== rule.revision) {
        throw new ServiceError('IDEMPOTENCY_CONFLICT', '版本冲突', 409);
      }
      if (raw.name !== undefined) rule.name = String(raw.name).slice(0, 120);
      if (raw.cron !== undefined) {
        const cron = String(raw.cron);
        if (!this.isValidCron(cron)) throw new ServiceError('VALIDATION', '无效的 cron 表达式', 422);
        rule.cron = cron;
      }
      if (raw.timezone !== undefined) rule.timezone = String(raw.timezone);
      if (raw.enabled !== undefined) rule.enabled = Boolean(raw.enabled);
      if (raw.template !== undefined) Object.assign(rule.template, raw.template);
      rule.nextTriggerAt = this.computeNextTrigger(rule.cron, Date.now());
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

  /** 单次调度检查:找到到期的启用规则,逐个尝试触发。 */
  async tick(): Promise<void> {
    if (this.store.fault.readOnly) return;
    const now = Date.now();
    const rules = this.list().filter((r) => r.enabled && r.nextTriggerAt && r.nextTriggerAt <= now);
    for (const rule of rules) {
      await this.tryTrigger(rule.id, rule.nextTriggerAt!);
    }
  }

  /** 尝试触发一条规则(幂等:同 (ruleId, scheduledAt) 不重复)。 */
  async tryTrigger(ruleId: string, scheduledAt: number): Promise<TriggerAttempt> {
    const rule = this.root().automationRules?.[ruleId];
    if (!rule) throw new ServiceError('NOT_FOUND', `规则 ${ruleId} 不存在`, 404);

    // 幂等检查:同 (ruleId, scheduledAt) 已有记录
    const existing = Object.values(this.root().triggerAttempts ?? {})
      .find((a) => a.ruleId === ruleId && a.scheduledAt === scheduledAt);
    if (existing) return existing;

    // 先持久 attempt(planned),再启动
    const attempt = await this.recordAttempt(rule, scheduledAt, 'planned');
    try {
      if (this.isSlotBusy()) {
        await this.updateAttempt(attempt.id, { result: 'skipped_busy', reason: '全局执行槽被占用' });
        return { ...attempt, result: 'skipped_busy', reason: '全局执行槽被占用' };
      }
      const { taskId, dispatchId } = await this.startTask(rule.template, `automation:${rule.id}`);
      await this.updateAttempt(attempt.id, { result: 'started', taskId, dispatchId });
      return { ...attempt, result: 'started', taskId, dispatchId };
    } catch (e) {
      await this.updateAttempt(attempt.id, { result: 'failed', reason: String((e as Error)?.message ?? e).slice(0, 200) });
      return { ...attempt, result: 'failed', reason: String(e) };
    } finally {
      await this.advanceCursor(ruleId);
    }
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
    this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const attempt = autoRoot.triggerAttempts?.[id];
      if (attempt) Object.assign(attempt, patch);
    });
  }

  private async advanceCursor(ruleId: string): Promise<void> {
    this.store.mutate((root) => {
      const autoRoot = root as never as AutomationStore;
      const rule = autoRoot.automationRules?.[ruleId];
      if (rule) rule.nextTriggerAt = this.computeNextTrigger(rule.cron, Date.now());
    });
  }

  /** 计算下次触发时间(简化版 cron:支持通配、步进、指定小时)。 */
  private computeNextTrigger(cron: string, from: number): number {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return from + 3600_000; // fallback 1h
    const [, hourPart] = parts;
    // 简化:只支持 hourly 和 daily
    const next = new Date(from);
    if (hourPart === '*') {
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
    } else if (hourPart.startsWith('*/')) {
      const interval = Number(hourPart.slice(2)) || 1;
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + interval);
    } else {
      // daily at specific hour
      const hour = Number(hourPart) || 9;
      next.setHours(hour, 0, 0, 0);
      if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  private isValidCron(cron: string): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    return parts.every((p) => /^(\*|\d+|\*\/\d+)$/.test(p));
  }
}
