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
      concurrency: (this.dispatch as unknown as { concurrency?: () => { active: number; max: number } }).concurrency?.() ?? { active: 0, max: 1 },
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
    const title = required(raw.taskTitle ?? raw.title, '任务标题', 200);
    const description = optional(raw.description, 30000);
    const acceptanceCriteria = required(raw.acceptanceCriteria, '验收标准', 10000);
    const assigneeId = typeof raw.assigneeId === 'string' && raw.assigneeId ? raw.assigneeId : undefined;
    return this.store.mutate((root) => {
      if (!root.projects[projectId]) throw new ServiceError('NOT_FOUND', '项目不存在', 404);
      // P0-1:assigneeId 可以是 Agent 或小队——按存在性判定 kind
      let assignment: WorkTask['assignment'];
      if (assigneeId) {
        if (root.agents[assigneeId]) assignment = { kind: 'agent', id: assigneeId };
        else {
          const squadsRoot = root as unknown as { squads?: Record<string, { id: string }> };
          if (squadsRoot.squads?.[assigneeId]) assignment = { kind: 'squad', id: assigneeId };
          else throw new ServiceError('NOT_FOUND', '执行者或小队不存在', 404);
        }
      }
      const now = Date.now();
      const sourceNote = typeof raw.sourceNote === 'string' && raw.sourceNote.trim() ? raw.sourceNote.slice(0, 200) : '';
      // 内部参数(不经路由暴露):fixedId 使创建幂等——自动化崩溃恢复重放不重建任务
      const fixedId = typeof raw.fixedId === 'string' && /^t_[A-Za-z0-9_-]{4,64}$/.test(raw.fixedId) ? raw.fixedId : null;
      if (fixedId && root.tasks[fixedId]) return root.tasks[fixedId];
      const task: WorkTask = { id: fixedId ?? newId('t'), projectId, title, description, acceptanceCriteria,
        assignment,
        status: 'todo', revision: 1, contentVersion: 1, createdAt: now, updatedAt: now,
        leaseEpoch: 0, runIds: [], operations: {},
        timeline: sourceNote ? [{ id: newId('ev'), kind: 'comment', at: now, text: sourceNote, actor: 'system' }] : [] };
      root.tasks[task.id] = task;
      return task;
    });
  }
  async updateTask(id: string, raw: Record<string, unknown>): Promise<WorkTask> {
    return this.store.mutate((root) => {
      const task = getTask(root, id);
      expectRevision(task.revision, raw.expectedRevision);
      if (task.owner) throw new ServiceError('WRONG_STATE', '任务执行中；先取消或接管', 409);
      // P0-1(审计):小队步骤交接间隙(任务 in_progress 且无 owner)同样锁定内容——
      // 否则下一步可能领取到另一份任务合同(标题/验收/分派已被改)
      const execLock = (root as unknown as { squadExecutions?: Record<string, { taskId: string; state: string }> });
      if (task.assignment?.kind === 'squad'
        && Object.values(execLock.squadExecutions ?? {}).some((e) => e.taskId === id && e.state === 'running')) {
        throw new ServiceError('WRONG_STATE', '小队执行进行中，任务内容已锁定；请等待完成或先取消', 409);
      }
      if (['in_review', 'done'].includes(task.status) && (raw.title !== undefined || raw.description !== undefined || raw.acceptanceCriteria !== undefined)) {
        throw new ServiceError('WRONG_STATE', '已完成或待验收任务须先重新打开或退回', 409);
      }
      let semantic = false;
      if (raw.title !== undefined) { const v = required(raw.title, '任务标题', 200); semantic ||= v !== task.title; task.title = v; }
      if (raw.description !== undefined) { const v = optional(raw.description, 30000); semantic ||= v !== task.description; task.description = v; }
      if (raw.acceptanceCriteria !== undefined) { const v = required(raw.acceptanceCriteria, '验收标准', 10000); semantic ||= v !== task.acceptanceCriteria; task.acceptanceCriteria = v; }
      if (raw.assigneeId !== undefined) {
        const assignee = raw.assigneeId === null || raw.assigneeId === '' ? undefined : String(raw.assigneeId);
        if (assignee) {
          // P0-1:Agent 或小队
          if (root.agents[assignee]) task.assignment = { kind: 'agent', id: assignee };
          else {
            const squadsRoot = root as unknown as { squads?: Record<string, { id: string }> };
            if (squadsRoot.squads?.[assignee]) task.assignment = { kind: 'squad', id: assignee };
            else throw new ServiceError('NOT_FOUND', '执行者或小队不存在', 404);
          }
        } else task.assignment = undefined;
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
    if (!project) throw new ServiceError('VALIDATION', '请先设置有效项目', 422);

    // P0-1:小队任务——创建 SquadExecution,启动第一步的 Agent
    if (task.assignment?.kind === 'squad') {
      const squadsRoot = root as unknown as { squads?: Record<string, { id: string; name: string; steps: Array<{ agentId: string; responsibility: string }> }> };
      const squad = squadsRoot.squads?.[task.assignment.id];
      if (!squad || squad.steps.length < 2) throw new ServiceError('VALIDATION', '小队不存在或步骤不足', 422);
      const firstAgent = root.agents[squad.steps[0].agentId];
      if (!firstAgent) throw new ServiceError('VALIDATION', '小队第一步 Agent 不存在', 422);
      if (!this.allowedModels().includes(firstAgent.model)) throw new ServiceError('VALIDATION', '第一步 Agent 模型不在允许列表', 422);
      // P0-5:执行记录在独立 mutate 中原子创建(查重+写入同一事务);
      // dispatch.start 必须放在 mutate 外——旧写法把 Promise 传进 mutate,候选根
      // 先于启动结果持久化,启动失败会留下 running 孤儿 exec,任务从此永久 409。
      const execId = await this.store.mutate((mutRoot) => {
        const execRoot = mutRoot as unknown as { squadExecutions?: Record<string, { id: string; taskId: string; state: string }> };
        if (!execRoot.squadExecutions) execRoot.squadExecutions = {};
        // 仅 running 视为活跃:paused_failed/aborted/completed 是终态,重跑创建新执行
        const active = Object.values(execRoot.squadExecutions).find((e) => e.taskId === id && e.state === 'running');
        if (active) throw new ServiceError('WRONG_STATE', '该任务已有进行中的小队执行', 409);
        const now = Date.now();
        const execution = { id: newId('se'), taskId: id, squadId: task.assignment!.id,
          steps: structuredClone(squad.steps), currentStep: 0, state: 'running', runIds: [], createdAt: now, updatedAt: now };
        execRoot.squadExecutions[execution.id] = execution;
        return execution.id;
      });
      let startResult: Awaited<ReturnType<typeof this.dispatch.start>>;
      try {
        startResult = await this.dispatch.start({ actorScope: 'workbench', idempotencyKey, targetType: 'workbench_task',
          projectId: project.id, nodeId: task.id, ws: project.root, model: firstAgent.model,
          toolAllow: firstAgent.toolAllow,
          agentProfile: { id: firstAgent.id, name: firstAgent.name, instructions: firstAgent.instructions,
            revision: firstAgent.revision, toolAllow: firstAgent.toolAllow } });
      } catch (e) {
        // 补偿事务:启动失败回滚执行记录(仅在未登记 run 时),避免孤儿 exec 锁死任务
        await this.store.mutate((mutRoot) => {
          const execRoot = mutRoot as unknown as { squadExecutions?: Record<string, { runIds: string[] }> };
          const exec = execRoot.squadExecutions?.[execId];
          if (exec && exec.runIds.length === 0) delete execRoot.squadExecutions![execId];
        }).catch(() => undefined);
        throw e;
      }
      await this.store.mutate((mutRoot) => {
        const exec = (mutRoot as unknown as { squadExecutions?: Record<string, { runIds: string[]; updatedAt: number }> }).squadExecutions?.[execId];
        if (exec) { exec.runIds.push(startResult.dispatchId); exec.updatedAt = Date.now(); }
      });
      return startResult;
    }

    // 单 Agent 任务(现有路径)
    const agent = task.assignment?.kind === 'agent' ? root.agents[task.assignment.id] : undefined;
    if (!agent) throw new ServiceError('VALIDATION', '请先设置有效执行者或小队', 422);
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

  /**
   * P0-1:小队编排接续——检查 running 小队执行,如果当前步的 Run 已完成则启动下一步。
   * 由调度器周期调用或 dispatch end 事件后调用。
   * P0-3:接续目标(下一步 Agent/项目)缺失时落终态 paused_failed + 任务 blocked,
   * 避免 exec 永久卡 running(小队删不掉、任务锁死)。
   */
  private squadContinuing = false;
  async continueSquadExecutions(): Promise<string[]> {
    if (this.squadContinuing) return []; // 上一轮未结束(30s 内未完成),跳过防双发
    this.squadContinuing = true;
    try {
      return await this.continueSquadExecutionsInner();
    } finally {
      this.squadContinuing = false;
    }
  }
  private async continueSquadExecutionsInner(): Promise<string[]> {
    const started: string[] = [];
    const root = this.snapshot();
    const execRoot = root as unknown as { squadExecutions?: Record<string, {
      id: string; taskId: string; squadId: string; steps: Array<{ agentId: string; responsibility: string }>;
      currentStep: number; state: string; runIds: string[]; createdAt: number; updatedAt: number; pauseReason?: string;
    }> };
    const executions = Object.values(execRoot.squadExecutions ?? {}).filter((e) => e.state === 'running');
    for (const exec of executions) {
      const task = root.tasks[exec.taskId];
      if (!task) continue;
      // 检查任务是否有活跃的派发(如果任务是 in_progress 且有 owner,当前步仍在执行)
      if (task.owner) continue;
      // in_review 或 blocked 说明小队执行已由 finalize 写终态,不需要接续
      if (task.status !== 'in_progress') continue;

      // 任务回到 in_progress 且无 owner → 上一步成功,需要接续下一步
      if (exec.currentStep < exec.steps.length - 1) {
        const nextStep = exec.steps[exec.currentStep + 1];
        const nextAgent = root.agents[nextStep.agentId];
        const project = root.projects[task.projectId];
        if (!nextAgent || !project) {
          // P0-3:接续目标缺失 → 终态 + 任务 blocked,用户可修复后重跑(新执行)
          await this.store.mutate((mutRoot) => {
            const mExecRoot = mutRoot as unknown as { squadExecutions?: Record<string, { state: string; pauseReason?: string; updatedAt: number }> };
            const mExec = mExecRoot.squadExecutions?.[exec.id];
            if (mExec) {
              mExec.state = 'paused_failed';
              mExec.pauseReason = `步骤 ${exec.currentStep + 2} 无法接续:${!nextAgent ? 'Agent 不存在' : '项目不存在'}`;
              mExec.updatedAt = Date.now();
            }
            const mTask = mutRoot.tasks[exec.taskId];
            if (mTask && mTask.status === 'in_progress' && !mTask.owner) {
              mTask.status = 'blocked';
              mTask.revision += 1;
              mTask.updatedAt = Date.now();
              mTask.timeline.push({ id: newId('ev'), kind: 'run', at: Date.now(),
                text: `小队接续中断:${!nextAgent ? '下一步 Agent 不存在' : '项目不存在'},任务退回 blocked`, actor: 'system' });
            }
          });
          continue;
        }

        // P1(审计):交接包——把上一步报告结论与证据注入下一步提示词,
        // 让顺序执行成为真正的协作交接(而非各自重读同一份任务描述)
        const prevRunId = exec.runIds[exec.currentStep];
        const prevRun = prevRunId ? this.dispatchStore.get(prevRunId) : undefined;
        const prevAgentName = root.agents[exec.steps[exec.currentStep].agentId]?.name ?? '上一步';
        const prevEvidence = (prevRun?.report?.evidence ?? []).map((item) => (typeof item === 'string' ? item : item.ref)).slice(0, 10);
        const handoffText = prevRun?.report?.summary
          ? `【小队交接】本任务由小队按步骤执行,你是第 ${exec.currentStep + 2}/${exec.steps.length} 步。
上一步「${prevAgentName}」结论:${prevRun.report.summary.slice(0, 1500)}${prevEvidence.length ? `
上一步交付物:${prevEvidence.join('、')}` : ''}
请在此基础上继续,不要重复已完成的工作。`
          : undefined;

        // P0-2(审计):步骤幂等键不含时间戳——固定键使崩溃重放安全;
        // 启动成功与步骤记账之间崩溃后,下个周期按同键查到既有 Run 直接绑定,不再重发
        const stepKey = `squad:${exec.id}:step:${exec.currentStep + 1}`;
        const bindStep = async (dispatchId: string) => {
          await this.store.mutate((mutRoot) => {
            const mExecRoot = mutRoot as unknown as { squadExecutions?: Record<string, { currentStep: number; runIds: string[]; updatedAt: number; waitReason?: string; waitSince?: number; handoffs?: Record<string, { fromAgent: string; summary: string; evidence?: string[]; at: number }> }> };
            const mExec = mExecRoot.squadExecutions?.[exec.id];
            if (mExec) {
              if (!mExec.runIds.includes(dispatchId)) mExec.runIds.push(dispatchId);
              mExec.currentStep = Math.max(mExec.currentStep, exec.currentStep + 1);
              mExec.waitReason = undefined;
              mExec.waitSince = undefined;
              if (handoffText && prevRun?.report?.summary) {
                mExec.handoffs = { ...(mExec.handoffs ?? {}), [String(exec.currentStep)]:
                  { fromAgent: prevAgentName, summary: prevRun.report.summary.slice(0, 300), evidence: prevEvidence, at: Date.now() } };
              }
              mExec.updatedAt = Date.now();
            }
          });
          started.push(dispatchId);
        };
        const existing = this.dispatchStore.findByIdempotency('workbench', stepKey);
        if (existing) {
          await bindStep(existing.dispatchId); // 崩溃恢复:绑定已启动的 Run
          continue;
        }
        try {
          const startResult = await this.dispatch.start({
            actorScope: 'workbench', idempotencyKey: stepKey,
            targetType: 'workbench_task', projectId: project.id, nodeId: task.id, ws: project.root,
            model: nextAgent.model, toolAllow: nextAgent.toolAllow,
            agentProfile: { id: nextAgent.id, name: nextAgent.name, instructions: nextAgent.instructions,
              revision: nextAgent.revision, toolAllow: nextAgent.toolAllow },
            extraContext: handoffText,
          });
          await bindStep(startResult.dispatchId);
        } catch (e) {
          // P1(审计):失败分类可见——容量/工作区占用是暂时性,记录等待原因继续自动重试;
          // 其余(模型失效等)是永久性,落 paused_failed + 任务 blocked,不再静默循环
          const code = (e as { code?: string }).code;
          const retryable = code === 'CAPACITY_EXCEEDED' || code === 'WORKSPACE_OCCUPIED';
          await this.store.mutate((mutRoot) => {
            const mExecRoot = mutRoot as unknown as { squadExecutions?: Record<string, { state: string; pauseReason?: string; waitReason?: string; waitSince?: number; updatedAt: number }> };
            const mExec = mExecRoot.squadExecutions?.[exec.id];
            if (!mExec) return;
            if (retryable) {
              mExec.waitReason = code === 'CAPACITY_EXCEEDED' ? '并发已满,等待空位自动重试' : '工作区被其他任务占用,等待自动重试';
              mExec.waitSince = mExec.waitSince ?? Date.now();
            } else {
              mExec.state = 'paused_failed';
              mExec.pauseReason = `步骤 ${exec.currentStep + 2} 启动失败:${String((e as Error)?.message ?? e).slice(0, 160)}`;
            }
            mExec.updatedAt = Date.now();
            if (!retryable) {
              const mTask = mutRoot.tasks[exec.taskId];
              if (mTask && mTask.status === 'in_progress' && !mTask.owner) {
                mTask.status = 'blocked';
                mTask.revision += 1;
                mTask.updatedAt = Date.now();
                mTask.timeline.push({ id: newId('ev'), kind: 'run', at: Date.now(),
                  text: `小队步骤启动失败,任务退回 blocked:${String((e as Error)?.message ?? e).slice(0, 120)}`, actor: 'system' });
              }
            }
          });
        }
      }
    }
    return started;
  }
}
