/**
 * 阶段 C:固定顺序小队(方案 §4 阶段C)。
 *
 * 产品规则:
 * - 小队 = 2+ 有序步骤,每步绑定一个 Agent + 职责说明
 * - 分派给小队的任务仍需手动启动;每步产生独立 Run
 * - 中间步骤成功 → 自动接续下一步(仅在槽空闲时);最后一步成功 → in_review
 * - 任一步骤失败/受阻 → 任务 blocked,停在当前步
 * - 恢复:重跑失败步骤(新 Run),绝不改写旧 Run
 * - 全部步骤共享现有单执行槽
 */
import { ServiceError } from '../types.js';
import type { WorkbenchStore, WorkTask, AgentProfile } from './store.js';
import { newId } from './store.js';

export interface SquadStep {
  agentId: string;
  responsibility: string;
}

export interface Squad {
  id: string;
  name: string;
  description: string;
  steps: SquadStep[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SquadExecution {
  id: string;
  taskId: string;
  squadId: string;
  /** 启动时的步骤快照(小队配置后续修改不影响已启动的执行) */
  steps: SquadStep[];
  currentStep: number;
  /** running=某步在执行;paused_busy=槽被占;paused_failed=某步失败;completed=全部完成 */
  state: 'running' | 'paused_busy' | 'paused_failed' | 'completed';
  runIds: string[];
  pauseReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SquadStore {
  squads: Record<string, Squad>;
  executions: Record<string, SquadExecution>;
}

/**
 * 小队管理:CRUD + 执行编排。
 * 与 WorkbenchStore 共享同一 JSON 文件(在 root 上追加 squads/executions 集合)。
 */
export class SquadService {
  constructor(private readonly store: WorkbenchStore) {}

  private root() {
    const root = this.store.snapshot();
    if (!root) throw new ServiceError('STORE_READONLY', '工作台不可用', 503);
    // 延迟初始化 squads/executions(v2 存储上追加)
    if (!(root as never as SquadStore).squads) {
      (root as never as SquadStore).squads = {};
      (root as never as SquadStore).executions = {};
    }
    return root as never as SquadStore & { tasks: Record<string, WorkTask>; agents: Record<string, AgentProfile> };
  }

  list(): Squad[] { return Object.values(this.root().squads ?? {}); }

  get(id: string): Squad {
    const squad = this.root().squads?.[id];
    if (!squad) throw new ServiceError('NOT_FOUND', `小队 ${id} 不存在`, 404);
    return squad;
  }

  async create(raw: Record<string, unknown>): Promise<Squad> {
    const name = String(raw.name ?? '').trim();
    const description = String(raw.description ?? '').trim();
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    if (!name || name.length > 80) throw new ServiceError('VALIDATION', '小队名称必填且不超过 80 字符', 422);
    if (steps.length < 2) throw new ServiceError('VALIDATION', '小队至少需要 2 个步骤', 422);
    return this.store.mutate((root) => {
      const squadRoot = root as never as SquadStore;
      if (!squadRoot.squads) { squadRoot.squads = {}; squadRoot.executions = {}; }
      const validated = this.validateSteps(steps, root as never as { agents: Record<string, AgentProfile> });
      const now = Date.now();
      const squad: Squad = { id: newId('sq'), name, description, steps: validated, revision: 1, createdAt: now, updatedAt: now };
      squadRoot.squads[squad.id] = squad;
      return squad;
    });
  }

  async update(id: string, raw: Record<string, unknown>): Promise<Squad> {
    const name = String(raw.name ?? '').trim();
    const description = String(raw.description ?? '').trim();
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    if (!name || name.length > 80) throw new ServiceError('VALIDATION', '小队名称必填且不超过 80 字符', 422);
    if (steps.length < 2) throw new ServiceError('VALIDATION', '小队至少需要 2 个步骤', 422);
    return this.store.mutate((root) => {
      const squadRoot = root as never as SquadStore;
      const squad = squadRoot.squads?.[id];
      if (!squad) throw new ServiceError('NOT_FOUND', `小队 ${id} 不存在`, 404);
      const expectedRevision = Number(raw.expectedRevision);
      if (Number.isSafeInteger(expectedRevision) && expectedRevision !== squad.revision) {
        throw new ServiceError('IDEMPOTENCY_CONFLICT', '版本冲突;请刷新后重试', 409);
      }
      squad.name = name;
      squad.description = description;
      squad.steps = this.validateSteps(steps, root as never as { agents: Record<string, AgentProfile> });
      squad.revision += 1;
      squad.updatedAt = Date.now();
      return squad;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.store.mutate((root) => {
      const squadRoot = root as never as SquadStore;
      if (!squadRoot.squads?.[id]) return false;
      // 有活跃执行时不可删除
      const active = Object.values(squadRoot.executions ?? {}).find((e) => e.squadId === id && e.state === 'running');
      if (active) throw new ServiceError('WRONG_STATE', '小队有正在执行的步骤,不可删除', 409);
      delete squadRoot.squads[id];
      return true;
    });
  }

  private validateSteps(steps: unknown[], root: { agents: Record<string, AgentProfile> }): SquadStep[] {
    return steps.map((raw, i) => {
      const step = raw as { agentId?: unknown; responsibility?: unknown };
      const agentId = String(step.agentId ?? '');
      const responsibility = String(step.responsibility ?? '').slice(0, 500);
      if (!agentId || !root.agents[agentId]) throw new ServiceError('VALIDATION', `步骤 ${i + 1} 的 Agent 不存在`, 422);
      return { agentId, responsibility };
    });
  }

  /* ---------- 执行编排 ---------- */

  /** 创建执行并返回第一步的启动参数。 */
  async createExecution(taskId: string, squadId: string): Promise<{ execution: SquadExecution; firstAgent: AgentProfile; stepIndex: number }> {
    return this.store.mutate((root) => {
      const squadRoot = root as never as SquadStore;
      if (!squadRoot.squads || !squadRoot.executions) { squadRoot.squads = {}; squadRoot.executions = {}; }
      const task = root.tasks[taskId];
      if (!task) throw new ServiceError('NOT_FOUND', `任务 ${taskId} 不存在`, 404);
      const squad = squadRoot.squads[squadId];
      if (!squad) throw new ServiceError('NOT_FOUND', `小队 ${squadId} 不存在`, 404);
      if (task.owner) throw new ServiceError('WRONG_STATE', '任务已在执行中', 409);
      // 已有活跃小队执行时不可重复启动
      const existing = Object.values(squadRoot.executions).find((e) => e.taskId === taskId && e.state !== 'completed');
      if (existing) throw new ServiceError('WRONG_STATE', '该任务已有进行中的小队执行', 409);

      const now = Date.now();
      const execution: SquadExecution = {
        id: newId('se'),
        taskId,
        squadId,
        steps: structuredClone(squad.steps), // 快照:后续配置修改不影响
        currentStep: 0,
        state: 'running',
        runIds: [],
        createdAt: now,
        updatedAt: now,
      };
      squadRoot.executions[execution.id] = execution;
      const firstAgent = root.agents[squad.steps[0].agentId];
      if (!firstAgent) throw new ServiceError('VALIDATION', '第一步 Agent 不存在', 422);
      return { execution, firstAgent, stepIndex: 0 };
    });
  }

  /** 某步 Run 结束后:记录并决定是否接续下一步。返回 nextAgent(如果应接续)或 null。 */
  async onRunFinished(executionId: string, runId: string, outcome: 'done' | 'failed' | 'blocked' | 'aborted'): Promise<{ nextAgent: AgentProfile | null; execution: SquadExecution | null }> {
    return this.store.mutate((root) => {
      const squadRoot = root as never as SquadStore;
      const execution = squadRoot.executions?.[executionId];
      if (!execution) return { nextAgent: null, execution: null as never };
      execution.runIds.push(runId);
      execution.updatedAt = Date.now();

      if (outcome === 'done') {
        if (execution.currentStep < execution.steps.length - 1) {
          // 中间步骤成功 → 接续
          execution.currentStep += 1;
          execution.state = 'running';
          const nextAgent = root.agents[execution.steps[execution.currentStep].agentId];
          return { nextAgent: nextAgent ?? null, execution };
        }
        // 最后一步成功 → 完成
        execution.state = 'completed';
        return { nextAgent: null, execution };
      }

      // 失败/受阻/取消 → 停在当前步
      execution.state = outcome === 'aborted' ? 'paused_busy' : 'paused_failed';
      execution.pauseReason = `步骤 ${execution.currentStep + 1} ${outcome}`;
      return { nextAgent: null, execution };
    });
  }

  /** 获取任务的活跃小队执行。 */
  activeExecutionForTask(taskId: string): SquadExecution | null {
    const root = this.root();
    return Object.values(root.executions ?? {}).find((e) => e.taskId === taskId && e.state !== 'completed') ?? null;
  }

  listExecutions(): SquadExecution[] {
    return Object.values(this.root().executions ?? {}).sort((a, b) => b.createdAt - a.createdAt);
  }
}
