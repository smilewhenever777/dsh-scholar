/**
 * 阶段 C:固定顺序小队(方案 §4 阶段C)。
 *
 * 产品规则:
 * - 小队 = 2+ 有序步骤,每步绑定一个 Agent + 职责说明
 * - 分派给小队的任务仍需手动启动;每步产生独立 Run
 * - 中间步骤成功 → 自动接续下一步(槽有空位即接续);最后一步成功 → in_review
 * - 任一步骤失败/受阻 → 任务 blocked,停在当前步
 * - 恢复:重跑失败步骤(新 Run),绝不改写旧 Run
 * - 全部步骤共享全局并发配额(跨工作区可与其他任务并行)
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
  /** running=某步在执行;paused_failed=某步失败;completed=全部完成;aborted=被取消 */
  state: 'running' | 'paused_failed' | 'completed' | 'aborted';
  runIds: string[];
  pauseReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SquadStore {
  squads: Record<string, Squad>;
  /** 活执行集合:由 WorkbenchService.start() 创建、WorkbenchTargetAdapter.finalize() 写终态 */
  squadExecutions: Record<string, SquadExecution>;
}

/**
 * 小队管理:CRUD。与 WorkbenchStore 共享同一 JSON 文件。
 * 执行编排在 WorkbenchService.start()/continueSquadExecutions() 与 target.finalize()——
 * 本服务只负责定义与查询,不再持有执行状态机(旧 createExecution/onRunFinished 已删)。
 */
export class SquadService {
  constructor(private readonly store: WorkbenchStore) {}

  private root() {
    const root = this.store.snapshot();
    if (!root) throw new ServiceError('STORE_READONLY', '工作台不可用', 503);
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
      if (!squadRoot.squads) { squadRoot.squads = {}; squadRoot.squadExecutions = {}; }
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
      // 有活跃执行时不可删除(读活集合 squadExecutions)
      const active = Object.values(squadRoot.squadExecutions ?? {}).find((e) => e.squadId === id && e.state === 'running');
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

  /* ---------- 执行查询 ---------- */

  /** 任务的活跃(运行中)小队执行。 */
  activeExecutionForTask(taskId: string): SquadExecution | null {
    return Object.values(this.root().squadExecutions ?? {})
      .find((e) => e.taskId === taskId && e.state === 'running') ?? null;
  }

  /** 全部执行记录(读活集合 squadExecutions——旧版误读从未写入的 executions,永远返回空)。 */
  listExecutions(): SquadExecution[] {
    return Object.values(this.root().squadExecutions ?? {}).sort((a, b) => b.createdAt - a.createdAt);
  }
}
