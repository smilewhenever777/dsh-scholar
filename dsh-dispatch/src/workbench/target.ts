import type { TargetAdapter, TargetRef, ClaimResult, FinalizeResult } from '../adapters/target.js';
import type { TaskSnapshot } from '../types.js';
import { hash, newId, type WorkTask, type WorkbenchStore } from './store.js';

function fingerprint(task: WorkTask): string {
  return hash({ projectId: task.projectId, taskId: task.id, title: task.title,
    description: task.description, acceptanceCriteria: task.acceptanceCriteria, contentVersion: task.contentVersion });
}

/** Persistent native task target; every ownership change is atomic in workbench.json. */
export class WorkbenchTargetAdapter implements TargetAdapter {
  readonly kind = 'workbench' as const;
  constructor(private readonly store: WorkbenchStore) {}
  hasOwner(dispatchId: string): boolean {
    return Object.values(this.store.snapshot()?.tasks ?? {}).some((task) => task.owner?.dispatchId === dispatchId);
  }
  async readTask(ref: TargetRef): Promise<{ snapshot: TaskSnapshot; fingerprint: string } | null> {
    const root = this.store.snapshot();
    const task = root?.tasks[ref.nodeId];
    const project = root?.projects[ref.projectId];
    if (!task || !project || task.projectId !== project.id || project.root.replaceAll('\\', '/').toLowerCase() !== ref.canonicalRoot) return null;
    return { fingerprint: fingerprint(task), snapshot: {
      source: 'workbench', projectId: project.id, nodeId: task.id, nodeTitle: task.title,
      nodeDetail: task.description, contract: { completionCriteria: task.acceptanceCriteria,
        deliverables: '通过 dispatch_report 提交摘要和可核验证据' },
    } };
  }
  async claim(input: { dispatchId: string; childSessionId: string; ref: TargetRef; expectedFingerprint: string }): Promise<ClaimResult> {
    return this.store.mutate((root) => {
      const task = root.tasks[input.ref.nodeId];
      if (!task || task.projectId !== input.ref.projectId) return { ok: false, code: 'NOT_FOUND', detail: '任务不存在' };
      if (task.owner?.dispatchId === input.dispatchId) return { ok: true, epoch: task.owner.epoch, taskFingerprint: task.owner.fingerprint };
      if (task.owner) return { ok: false, code: 'NODE_OCCUPIED', detail: '任务已有运行中执行' };
      // 小队步骤交接:上一步 finalize 后任务停在 in_progress 且无 owner,
      // 此时 running 执行的存在即为接续凭证,放行下一步领取(指纹校验仍兜底内容变更)
      const squadHandoff = task.assignment?.kind === 'squad' && task.status === 'in_progress'
        && Object.values((root as unknown as { squadExecutions?: Record<string, { taskId: string; state: string }> }).squadExecutions ?? {})
          .some((e) => e.taskId === task.id && e.state === 'running');
      if (!['todo', 'blocked'].includes(task.status) && !squadHandoff) {
        return { ok: false, code: 'TASK_CHANGED', detail: `任务状态 ${task.status} 不能启动` };
      }
      const fp = fingerprint(task);
      if (fp !== input.expectedFingerprint) return { ok: false, code: 'TASK_CHANGED', detail: '任务目标在领取前已变化' };
      task.leaseEpoch = (task.leaseEpoch || 0) + 1;
      task.owner = { dispatchId: input.dispatchId, childSessionId: input.childSessionId, epoch: task.leaseEpoch,
        fingerprint: fp, workerWrites: true };
      task.status = 'in_progress';
      task.revision += 1;
      task.updatedAt = Date.now();
      task.runIds.push(input.dispatchId);
      task.timeline.push({ id: newId('ev'), kind: 'run', at: Date.now(), text: '开始执行', runId: input.dispatchId, actor: 'system' });
      return { ok: true, epoch: task.leaseEpoch, taskFingerprint: fp };
    });
  }
  async progress(input: { dispatchId: string; ref: TargetRef; operationId: string; title: string; payload?: unknown; metrics?: unknown }): Promise<{ ok: boolean; detail: string }> {
    return this.store.mutate((root) => {
      const task = root.tasks[input.ref.nodeId];
      if (!task || task.owner?.dispatchId !== input.dispatchId || !task.owner.workerWrites || task.owner.revoked) return { ok: false, detail: '执行者无任务写入权' };
      const fp = hash({ title: input.title, payload: input.payload, metrics: input.metrics });
      const prev = task.operations[input.operationId];
      if (prev) return { ok: prev.hash === fp, detail: prev.hash === fp ? '幂等重放' : '同 operationId 内容冲突' };
      task.operations[input.operationId] = { hash: fp, appliedAt: Date.now() };
      task.timeline.push({ id: newId('ev'), kind: 'progress', at: Date.now(), text: input.title.slice(0, 2000), runId: input.dispatchId, actor: 'agent' });
      task.revision += 1;
      task.updatedAt = Date.now();
      return { ok: true, detail: '进度已记录' };
    });
  }
  async finalize(input: { dispatchId: string; ref: TargetRef; operationId: string; outcome: 'done' | 'failed' | 'blocked' | 'aborted'; summary: string; reasonCode: string }): Promise<FinalizeResult> {
    return this.store.mutate((root) => {
      const task = root.tasks[input.ref.nodeId];
      if (!task) return { ok: false, code: 'NOT_FOUND', detail: '任务已删除' };
      const prev = task.operations[input.operationId];
      if (prev) return { ok: true, detail: '幂等重放', receipt: { operationId: input.operationId, appliedAt: prev.appliedAt } };
      if (task.owner?.dispatchId !== input.dispatchId) return { ok: false, code: 'SUPERSEDED', detail: '任务所有权已变化' };
      if (task.owner.revoked || task.owner.fingerprint !== fingerprint(task)) {
        task.owner = undefined;
        task.status = 'todo';
        task.revision += 1;
        return { ok: false, code: 'SUPERSEDED', detail: '任务已被接管或目标已变化' };
      }
      // P0-1/P0-3:小队感知状态转移,并把终态写回 squadExecutions——
      // 中间步骤 done 保持 in_progress(exec 仍 running,由 30s 接续定时器推进);
      // 最后一步 done → in_review + exec completed;失败 → blocked + paused_failed;
      // 取消 → todo + aborted。不写回终态会导致小队永远无法删除、任务永久 409。
      const isSquadTask = task.assignment?.kind === 'squad';
      const execRoot = root as unknown as { squadExecutions?: Record<string, {
        taskId: string; currentStep: number; steps: unknown[]; state: string; pauseReason?: string; updatedAt: number;
      }> };
      const exec = isSquadTask
        ? Object.values(execRoot.squadExecutions ?? {}).find((e) => e.taskId === task.id && e.state === 'running')
        : undefined;
      const at = Date.now();
      let nextStatus: string;
      if (input.outcome === 'done' && exec) {
        if (exec.currentStep < exec.steps.length - 1) {
          nextStatus = 'in_progress'; // 中间步骤成功 → 保持执行中,等待接续
        } else {
          nextStatus = 'in_review'; // 最后一步成功 → 待验收
          exec.state = 'completed';
          exec.updatedAt = at;
        }
      } else if (input.outcome === 'done') {
        nextStatus = 'in_review';
      } else if (input.outcome === 'aborted') {
        nextStatus = 'todo';
        if (exec) { exec.state = 'aborted'; exec.pauseReason = `步骤 ${exec.currentStep + 1} 被取消`; exec.updatedAt = at; }
      } else {
        nextStatus = 'blocked';
        if (exec) { exec.state = 'paused_failed'; exec.pauseReason = `步骤 ${exec.currentStep + 1} ${input.outcome}:${input.reasonCode}`; exec.updatedAt = at; }
      }
      task.status = nextStatus as typeof task.status;
      task.owner = undefined;
      task.revision += 1;
      task.updatedAt = at;
      task.operations[input.operationId] = { hash: hash(input), appliedAt: at };
      task.timeline.push({ id: newId('ev'), kind: 'run', at, text: input.summary.slice(0, 2000), runId: input.dispatchId, actor: 'agent' });
      return { ok: true, detail: '任务状态已同步', receipt: { operationId: input.operationId, appliedAt: at } };
    });
  }
  async revoke(input: { dispatchId: string; ref?: TargetRef; mode: 'worker_only' | 'takeover' }): Promise<{ ok: boolean; detail: string }> {
    return this.store.mutate((root) => {
      const task = input.ref ? root.tasks[input.ref.nodeId] : Object.values(root.tasks).find((t) => t.owner?.dispatchId === input.dispatchId);
      if (task?.owner?.dispatchId !== input.dispatchId) return { ok: true, detail: '无在册所有权' };
      task.owner.workerWrites = false;
      if (input.mode === 'takeover') task.owner.revoked = true;
      return { ok: true, detail: input.mode === 'takeover' ? '已接管' : '执行者写入已关闭' };
    });
  }
}

export class RoutedTargetAdapter implements TargetAdapter {
  readonly kind = 'routed' as const;
  constructor(private readonly legacy: TargetAdapter, private readonly workbench: WorkbenchTargetAdapter) {}
  private for(ref: TargetRef): TargetAdapter { return ref.targetType === 'workbench_task' ? this.workbench : this.legacy; }
  readTask(ref: TargetRef) { return this.for(ref).readTask(ref); }
  claim(input: Parameters<TargetAdapter['claim']>[0]) { return this.for(input.ref).claim(input); }
  progress(input: Parameters<TargetAdapter['progress']>[0]) { return this.for(input.ref).progress(input); }
  finalize(input: Parameters<TargetAdapter['finalize']>[0]) { return this.for(input.ref).finalize(input); }
  revoke(input: Parameters<TargetAdapter['revoke']>[0]) {
    if (input.ref) return this.for(input.ref).revoke(input);
    return this.workbench.hasOwner(input.dispatchId) ? this.workbench.revoke(input) : this.legacy.revoke(input);
  }
}
