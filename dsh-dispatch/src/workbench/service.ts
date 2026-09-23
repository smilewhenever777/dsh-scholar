import type { DispatchService } from '../service.js';
import type { DispatchStore } from '../store.js';
import type { DispatchRecord } from '../types.js';
import { DEFAULT_CHILD_TOOL_ALLOW } from '../policy.js';
import { ServiceError } from '../types.js';
import { canonicalProjectRoot, newId, type AgentProfile, type Project, type TaskStatus, type WorkTask,
  type WorkbenchRoot, type WorkbenchStore } from './store.js';

function required(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new ServiceError('VALIDATION', `${label} 必填且不超过 ${max} 字符`, 422);
  return text;
}
function optional(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw new ServiceError('VALIDATION', `文本不得超过 ${max} 字符`, 422);
  return text;
}
function toolAllow(value: unknown): string[] {
  const tools = value === undefined ? DEFAULT_CHILD_TOOL_ALLOW : value;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string' || !DEFAULT_CHILD_TOOL_ALLOW.includes(tool))) {
    throw new ServiceError('VALIDATION', '工具权限只能从受控白名单中选择', 422);
  }
  return [...new Set(tools)];
}
function expectRevision(actual: number, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || expected !== actual) throw new ServiceError('WRONG_STATE', `版本冲突：当前 revision=${actual}`, 409);
}
function getTask(root: WorkbenchRoot, id: string): WorkTask {
  const task = root.tasks[id];
  if (!task) throw new ServiceError('NOT_FOUND', `任务 ${id} 不存在`, 404);
  return task;
}
function publicRun(run: DispatchRecord) {
  const { promptText: _privatePrompt, ...source } = run.source;
  return { ...run, source };
}

export class WorkbenchService {
  constructor(private readonly store: WorkbenchStore, private readonly dispatch: DispatchService,
    private readonly dispatchStore: DispatchStore, private readonly allowedModels: () => string[],
    private readonly defaultModel: () => string) {}

  snapshot(): WorkbenchRoot {
    const root = this.store.snapshot();
    if (!root) throw new ServiceError('STORE_READONLY', this.store.fault.reason ?? '工作台不可用', 503);
    return root;
  }
  /** 根存储总 revision(任意写递增)——sinceRevision 短路的依据。 */
  rootRevision(): number {
    return this.store.snapshot()?.revision ?? 0;
  }
  overview(sinceRevision?: number) {
    const root = this.snapshot();
    if (sinceRevision !== undefined && Number.isSafeInteger(sinceRevision) && sinceRevision === root.revision) {
      return { unchanged: true as const, revision: root.revision };
    }
    // 瘦身:任务 timeline 只带最近 6 条 + 总数(完整 timeline 在 /tasks/:id 详情)
    const tasks = Object.values(root.tasks).map((task) => this.withRuns(task))
      .map((task) => ({ ...task, timeline: task.timeline.slice(-6), timelineTotal: task.timeline.length }));
    const counts: Record<TaskStatus, number> = { todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 };
    for (const task of tasks) counts[task.status] += 1;
    return { projects: Object.values(root.projects), agents: Object.values(root.agents), tasks, counts,
      legacyCount: this.dispatchStore.all().filter((d) => d.targetType === 'traj_node').length,
      readOnly: this.store.fault.readOnly, revision: root.revision };
  }
  private withRuns(task: WorkTask): WorkTask {
    const attempts = this.dispatchStore.all().filter((run) => run.targetType === 'workbench_task' && run.targetRef.nodeId === task.id)
      .sort((a, b) => a.createdAt - b.createdAt).map((run) => run.id);
    return { ...task, runIds: [...new Set([...attempts, ...task.runIds])] };
  }
  async createProject(raw: Record<string, unknown>): Promise<Project> {
    const title = required(raw.title, '项目名称', 120);
    const rootPath = canonicalProjectRoot(required(raw.root, '工作区路径', 2000));
    const goal = optional(raw.goal, 2000);
    const description = optional(raw.description, 8000);
    return this.store.mutate((root) => {
      if (Object.values(root.projects).some((p) => p.root.toLowerCase() === rootPath.toLowerCase())) {
        throw new ServiceError('VALIDATION', '该工作区已有项目', 409);
      }
      const now = Date.now();
      const project: Project = { id: newId('p'), title, root: rootPath, revision: 1, createdAt: now, updatedAt: now,
        ...(goal ? { goal } : {}), ...(description ? { description } : {}) };
      root.projects[project.id] = project;
      return project;
    });
  }
  async updateProject(id: string, raw: Record<string, unknown>): Promise<Project> {
    return this.store.mutate((root) => {
      const project = root.projects[id];
      if (!project) throw new ServiceError('NOT_FOUND', '项目不存在', 404);
      expectRevision(project.revision, raw.expectedRevision);
      const title = required(raw.title, '项目名称', 120);
      project.title = title;
      // v2:可选更新 goal/description/archived
      if (raw.goal !== undefined) project.goal = optional(raw.goal, 2000) ?? '';
      if (raw.description !== undefined) project.description = optional(raw.description, 8000) ?? '';
      if (raw.archived === true && !project.archivedAt) project.archivedAt = Date.now();
      if (raw.archived === false && project.archivedAt) project.archivedAt = undefined;
      project.revision += 1;
      project.updatedAt = Date.now();
      return project;
    });
  }
  async createAgent(raw: Record<string, unknown>): Promise<AgentProfile> {
    const name = required(raw.name, '执行者名称', 80);
    const instructions = optional(raw.instructions, 12000);
    const model = typeof raw.model === 'string' ? raw.model : this.defaultModel();
    const tools = toolAllow(raw.toolAllow);
    const displayDescription = optional(raw.displayDescription, 500);
    if (!this.allowedModels().includes(model)) throw new ServiceError('VALIDATION', '模型不在允许列表', 422);
    return this.store.mutate((root) => {
      const now = Date.now();
      const agent: AgentProfile = { id: newId('a'), name, instructions, model, toolAllow: tools, revision: 1, createdAt: now, updatedAt: now,
        ...(displayDescription ? { displayDescription } : {}) };
      root.agents[agent.id] = agent;
      return agent;
    });
  }
  async updateAgent(id: string, raw: Record<string, unknown>): Promise<AgentProfile> {
    const name = required(raw.name, '执行者名称', 80);
    const instructions = optional(raw.instructions, 12000);
    const model = required(raw.model, '模型', 200);
    const tools = toolAllow(raw.toolAllow);
    const displayDescription = optional(raw.displayDescription, 500);
    if (!this.allowedModels().includes(model)) throw new ServiceError('VALIDATION', '模型不在允许列表', 422);
    return this.store.mutate((root) => {
      const agent = root.agents[id];
      if (!agent) throw new ServiceError('NOT_FOUND', '执行者不存在', 404);
      expectRevision(agent.revision, raw.expectedRevision);
      agent.name = name;
      agent.instructions = instructions;
      agent.model = model;
      agent.toolAllow = tools;
      if (raw.displayDescription !== undefined) agent.displayDescription = displayDescription ?? '';
      agent.revision += 1;
      agent.updatedAt = Date.now();
      return agent;
    });
  }
  async createTask(raw: Record<string, unknown>): Promise<WorkTask> {
    const projectId = required(raw.projectId, '项目', 100);
    const title = required(raw.title, '任务标题', 200);
    const description = optional(raw.description, 30000);
    const acceptanceCriteria = required(raw.acceptanceCriteria, '验收标准', 10000);
    const assigneeId = typeof raw.assigneeId === 'string' && raw.assigneeId ? raw.assigneeId : undefined;
    return this.store.mutate((root) => {
      if (!root.projects[projectId]) throw new ServiceError('NOT_FOUND', '项目不存在', 404);
      if (assigneeId && !root.agents[assigneeId]) throw new ServiceError('NOT_FOUND', '执行者不存在', 404);
      const now = Date.now();
      const task: WorkTask = { id: newId('t'), projectId, title, description, acceptanceCriteria,
        assignment: assigneeId ? { kind: 'agent', id: assigneeId } : undefined,
        status: 'todo', revision: 1, contentVersion: 1, createdAt: now, updatedAt: now,
        leaseEpoch: 0, runIds: [], timeline: [], operations: {} };
      root.tasks[task.id] = task;
      return task;
    });
  }
  async updateTask(id: string, raw: Record<string, unknown>): Promise<WorkTask> {
    return this.store.mutate((root) => {
      const task = getTask(root, id);
      expectRevision(task.revision, raw.expectedRevision);
      if (task.owner) throw new ServiceError('WRONG_STATE', '任务执行中；先取消或接管', 409);
      if (['in_review', 'done'].includes(task.status) && (raw.title !== undefined || raw.description !== undefined || raw.acceptanceCriteria !== undefined)) {
        throw new ServiceError('WRONG_STATE', '已完成或待验收任务须先重新打开或退回', 409);
      }
      let semantic = false;
      if (raw.title !== undefined) { const v = required(raw.title, '任务标题', 200); semantic ||= v !== task.title; task.title = v; }
      if (raw.description !== undefined) { const v = optional(raw.description, 30000); semantic ||= v !== task.description; task.description = v; }
      if (raw.acceptanceCriteria !== undefined) { const v = required(raw.acceptanceCriteria, '验收标准', 10000); semantic ||= v !== task.acceptanceCriteria; task.acceptanceCriteria = v; }
      if (raw.assigneeId !== undefined) {
        const assignee = raw.assigneeId === null || raw.assigneeId === '' ? undefined : String(raw.assigneeId);
        if (assignee && !root.agents[assignee]) throw new ServiceError('NOT_FOUND', '执行者不存在', 404);
        task.assignment = assignee ? { kind: 'agent', id: assignee } : undefined;
      }
      if (raw.status !== undefined) {
        if (!['todo', 'blocked'].includes(String(raw.status))) throw new ServiceError('VALIDATION', '只能手动移到待办或受阻；完成需要验收', 422);
        task.status = raw.status as TaskStatus;
      }
      if (semantic) task.contentVersion += 1;
      task.revision += 1;
      task.updatedAt = Date.now();
      return task;
    });
  }
  async comment(id: string, raw: Record<string, unknown>): Promise<WorkTask> {
    const text = required(raw.text, '评论', 10000);
    return this.store.mutate((root) => {
      const task = getTask(root, id);
      expectRevision(task.revision, raw.expectedRevision);
      task.timeline.push({ id: newId('ev'), kind: 'comment', at: Date.now(), text, actor: 'user' });
      task.revision += 1;
      task.updatedAt = Date.now();
      return task;
    });
  }
  async review(id: string, raw: Record<string, unknown>): Promise<WorkTask> {
    const decision = String(raw.decision ?? '');
    if (decision !== 'accept' && decision !== 'reject') throw new ServiceError('VALIDATION', 'decision 必须为 accept 或 reject', 422);
    const comment = decision === 'reject' ? required(raw.comment, '退回意见', 10000) : optional(raw.comment, 10000);
    return this.store.mutate((root) => {
      const task = getTask(root, id);
      expectRevision(task.revision, raw.expectedRevision);
      if (task.status !== 'in_review' || task.owner) throw new ServiceError('WRONG_STATE', '任务尚未进入可验收状态', 409);
      const last = this.dispatchStore.get(task.runIds.at(-1) ?? '');
      if (!last || last.result?.kind !== 'done' || last.writeback.state !== 'applied') {
        throw new ServiceError('WRONG_STATE', '执行结果尚未完成并同步', 409);
      }
      task.status = decision === 'accept' ? 'done' : 'todo';
      task.revision += 1;
      task.updatedAt = Date.now();
      task.timeline.push({ id: newId('ev'), kind: 'review', at: Date.now(),
        text: comment || (decision === 'accept' ? '验收通过' : '退回'), actor: 'user', runId: last.id });
      return task;
    });
  }
  async start(id: string, raw: Record<string, unknown>) {
    const idempotencyKey = required(raw.idempotencyKey, 'idempotencyKey', 200);
    const prior = this.dispatchStore.findByIdempotency('workbench', idempotencyKey);
    if (prior) {
      const existing = this.dispatchStore.get(prior.dispatchId);
      if (!existing || existing.targetType !== 'workbench_task' || existing.targetRef.nodeId !== id) {
        throw new ServiceError('IDEMPOTENCY_CONFLICT', '同幂等键对应其他任务', 409);
      }
      return { dispatchId: existing.id, phase: existing.phase, replay: true };
    }
    const root = this.snapshot();
    const task = getTask(root, id);
    if (!['todo', 'blocked'].includes(task.status) || task.owner) throw new ServiceError('WRONG_STATE', '任务当前不可启动', 409);
    const project = root.projects[task.projectId];
    const agent = task.assignment?.kind === 'agent' ? root.agents[task.assignment.id] : undefined;
    if (!project || !agent) throw new ServiceError('VALIDATION', '请先设置有效项目和执行者', 422);
    if (canonicalProjectRoot(project.root).toLowerCase() !== project.root.toLowerCase()) {
      throw new ServiceError('WRONG_STATE', '项目工作区路径已变化，请重新核查项目', 409);
    }
    if (!this.allowedModels().includes(agent.model)) throw new ServiceError('VALIDATION', '执行者模型当前不在允许列表', 422);
    toolAllow(agent.toolAllow);
    return this.dispatch.start({ actorScope: 'workbench', idempotencyKey, targetType: 'workbench_task',
      projectId: project.id, nodeId: task.id, ws: project.root, model: agent.model,
      toolAllow: agent.toolAllow,
      agentProfile: { id: agent.id, name: agent.name, instructions: agent.instructions, revision: agent.revision,
        toolAllow: agent.toolAllow } });
  }
  taskDetail(id: string) {
    const task = this.withRuns(getTask(this.snapshot(), id));
    const runs = this.dispatchStore.all().filter((d) => d.targetType === 'workbench_task' && d.targetRef.nodeId === id)
      .sort((a, b) => a.createdAt - b.createdAt);
    return { task, runs: runs.map(publicRun) };
  }
  runDetail(id: string) {
    const run = this.dispatchStore.get(id);
    if (!run) throw new ServiceError('NOT_FOUND', '执行记录不存在', 404);
    return publicRun(run);
  }
  legacy() { return this.dispatchStore.all().filter((d) => d.targetType === 'traj_node').sort((a, b) => b.createdAt - a.createdAt).map(publicRun); }
  models() { return { allowed: this.allowedModels(), default: this.defaultModel() }; }
}
