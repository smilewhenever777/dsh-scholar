import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchStore } from '../dist/store.js';
import { WorkbenchStore } from '../dist/workbench/store.js';
import { WorkbenchTargetAdapter, RoutedTargetAdapter } from '../dist/workbench/target.js';
import { WorkbenchService } from '../dist/workbench/service.js';
import { SquadService } from '../dist/workbench/squad.js';
import { AutomationService } from '../dist/workbench/automation.js';
import { InMemoryTargetAdapter } from '../dist/adapters/target.js';
import { MockRuntime } from '../dist/runtime.js';
import { DispatchService } from '../dist/service.js';
import { defaultPolicyConfig } from '../dist/policy.js';
import { sleep, assertRejects } from './util.mjs';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-squad-'));
  const home = join(dir, 'home');
  const ws = join(dir, 'workspace');
  mkdirSync(home); mkdirSync(ws);
  const dispatchStore = new DispatchStore(home);
  const workbenchStore = new WorkbenchStore(home);
  await dispatchStore.init(); await workbenchStore.init();
  const runtime = new MockRuntime();
  const target = new RoutedTargetAdapter(new InMemoryTargetAdapter(), new WorkbenchTargetAdapter(workbenchStore));
  const dispatch = new DispatchService({ store: dispatchStore, runtime, target, config: defaultPolicyConfig() });
  const workbench = new WorkbenchService(workbenchStore, dispatch, dispatchStore, () => ['glm/glm-5.3'], () => 'glm/glm-5.3');
  const squad = new SquadService(workbenchStore);
  const automation = new AutomationService(workbenchStore,
    async (template, source) => {
      const task = await workbench.createTask({ ...template, sourceNote: `自动化规则「${source}」定时创建` });
      const result = await workbench.start(task.id, { idempotencyKey: `auto-${source}` });
      return { taskId: task.id, dispatchId: result.dispatchId };
    },
    () => false);
  const project = await workbench.createProject({ title: '小队项目', root: ws });
  const agentA = await workbench.createAgent({ name: '起草员', instructions: '起草', model: 'glm/glm-5.3' });
  const agentB = await workbench.createAgent({ name: '审校员', instructions: '审校', model: 'glm/glm-5.3' });
  return { dir, home, ws, dispatchStore, workbenchStore, runtime, dispatch, workbench, squad, automation, project, agentA, agentB,
    async finishRun(dispatchId, outcome, summary) {
      const child = dispatch.status(dispatchId).runtime.childSessionId;
      runtime.emitRunStart(child, `run-${dispatchId}`);
      await dispatch.ingestReport(child, { outcome, summary, evidence: [] });
      runtime.emitRunEnd(child, `run-${dispatchId}`, 'completed');
      await sleep(150);
    },
    async cancelRun(dispatchId, reason = '手动取消') {
      await dispatch.cancel(dispatchId, 'user', reason);
      await sleep(300);
    },
    execOf(taskId) {
      return squad.listExecutions().find((e) => e.taskId === taskId);
    },
    dispose() { dispatch.dispose(); dispatchStore.dispose(); workbenchStore.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ---------- cron 计算(P0-2:周/月级不得回退 +1h) ---------- */

test('cron:周级规则落到下一个周一 9:00,绝不落在 +1h 回退', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '周报', cron: '0 9 * * 1', template: { projectId: 'p1', title: 't', acceptanceCriteria: 'a' } });
    const next = new Date(rule.nextTriggerAt);
    assert.ok(rule.nextTriggerAt > Date.now(), '下次触发必须在未来');
    assert.equal(next.getDay(), 1, '必须落在周一');
    assert.equal(next.getHours(), 9, '必须落在 9 点');
    assert.equal(next.getMinutes(), 0);
    assert.ok(rule.nextTriggerAt - Date.now() <= 8 * 86_400_000, '距下次触发不超过 8 天');
  } finally { h.dispose(); }
});

test('cron:月级规则(每月 1 号)在 32 天窗口内命中', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '月度汇总', cron: '0 9 1 * *', template: { projectId: 'p1', title: 't', acceptanceCriteria: 'a' } });
    const next = new Date(rule.nextTriggerAt);
    assert.ok(rule.nextTriggerAt > Date.now());
    assert.equal(next.getDate(), 1, '必须落在 1 号');
    assert.equal(next.getHours(), 9);
    assert.ok(rule.nextTriggerAt - Date.now() <= 32 * 86_400_000, '距下次触发不超过 32 天');
  } finally { h.dispose(); }
});

test('cron:不存在的日子(2 月 30 日)返回 0 表示永不调度,不再回退 +1h', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '永不存在', cron: '0 9 30 2 *', template: { projectId: 'p1', title: 't', acceptanceCriteria: 'a' } });
    assert.equal(rule.nextTriggerAt, 0, '400 天无匹配应返回 0(调度器按 falsy 跳过)');
  } finally { h.dispose(); }
});

test('cron:分钟级表达式仍即时命中(回归检查两段式重构)', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '高频', cron: '*/30 * * * *', template: { projectId: 'p1', title: 't', acceptanceCriteria: 'a' } });
    const next = new Date(rule.nextTriggerAt);
    assert.equal(next.getMinutes() % 30, 0);
    assert.ok(rule.nextTriggerAt - Date.now() <= 30 * 60_000 + 60_000, '半小时内必有命中');
  } finally { h.dispose(); }
});

test('自动化规则默认禁用;启用+触发创建带来源标记的任务', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '默认关', cron: '0 9 * * *', template: { projectId: h.project.id, title: '定时任务', description: '', acceptanceCriteria: '完成', assigneeId: h.agentA.id } });
    assert.equal(rule.enabled, false, '新规则必须默认禁用');
    await h.automation.update(rule.id, { expectedRevision: rule.revision, enabled: true });
    await h.automation.tryTrigger(rule.id, rule.nextTriggerAt);
    const attempts = h.automation.attempts();
    assert.equal(attempts[0].result, 'started');
    const task = h.workbench.taskDetail(attempts[0].taskId).task;
    assert.equal(task.title, '定时任务');
    assert.ok(task.timeline.some((ev) => ev.text.includes('自动化规则')), '任务时间线须带自动化来源标记');
    // 幂等:同 (ruleId, scheduledAt) 重复触发不产生第二条
    await h.automation.tryTrigger(rule.id, rule.nextTriggerAt);
    assert.equal(h.workbenchStore.snapshot().tasks ? Object.values(h.workbenchStore.snapshot().tasks).filter((t) => t.title === '定时任务').length : 0, 1);
  } finally { h.dispose(); }
});

/* ---------- 小队执行终态(P0-3)+ 接续 + 孤儿回滚(P0-5) ---------- */

test('小队两步全流程:中间步 in_progress → 接续 → 最后步 in_review + exec completed,小队可删', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '两步小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '小队任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    const started = await h.workbench.start(task.id, { idempotencyKey: 'squad-1' });
    let exec = h.execOf(task.id);
    assert.equal(exec.state, 'running');
    assert.equal(exec.currentStep, 0);

    // 第一步完成 → 任务 in_progress(不是 in_review),exec 仍 running 等接续
    await h.finishRun(started.dispatchId, 'done', '第一步完成');
    let t = h.workbench.taskDetail(task.id).task;
    assert.equal(t.status, 'in_progress', '中间步骤成功应保持 in_progress');
    exec = h.execOf(task.id);
    assert.equal(exec.state, 'running');

    // 接续第二步(claim 须放行小队交接的 in_progress)
    const startedNext = await h.workbench.continueSquadExecutions();
    assert.equal(startedNext.length, 1, '应启动第二步');
    exec = h.execOf(task.id);
    assert.equal(exec.currentStep, 1);
    assert.equal(exec.runIds.length, 2, '两步各留一条 Run');

    // 第二步(最后一步)完成 → in_review + exec completed
    await h.finishRun(startedNext[0], 'done', '第二步完成');
    t = h.workbench.taskDetail(task.id).task;
    assert.equal(t.status, 'in_review');
    exec = h.execOf(task.id);
    assert.equal(exec.state, 'completed', '最后一步成功必须写回 completed');
    assert.equal(exec.pauseReason, undefined);

    // 终态后小队可删除(旧 bug:exec 永远 running → 永久 409)
    assert.equal(await h.squad.delete(squad.id), true);
  } finally { h.dispose(); }
});

test('小队中途失败:任务 blocked + exec paused_failed;修复后重跑创建新执行(不再 409)', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '容错小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '会失败的小队任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    const started = await h.workbench.start(task.id, { idempotencyKey: 'squad-f1' });
    await h.finishRun(started.dispatchId, 'failed', '第一步失败');

    const t = h.workbench.taskDetail(task.id).task;
    assert.equal(t.status, 'blocked');
    let exec = h.execOf(task.id);
    assert.equal(exec.state, 'paused_failed', '失败必须写回 paused_failed 终态');
    assert.ok(exec.pauseReason.includes('步骤 1'));

    // paused_failed 不是活跃态 → 重跑放行,创建新执行从头开始
    const retry = await h.workbench.start(task.id, { idempotencyKey: 'squad-f2' });
    exec = h.execOf(task.id);
    assert.equal(exec.state, 'running');
    assert.equal(exec.currentStep, 0);
    await h.cancelRun(retry.dispatchId);
    exec = h.execOf(task.id);
    assert.equal(exec.state, 'aborted', '取消必须写回 aborted 终态');
    assert.equal(h.workbench.taskDetail(task.id).task.status, 'todo');
  } finally { h.dispose(); }
});

test('P0-5:第一步启动失败 → 执行记录回滚,不留孤儿;重试可正常启动', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '回滚小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '回滚任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    h.runtime.failNextStart = 'boom';
    await assertRejects(() => h.workbench.start(task.id, { idempotencyKey: 'squad-o1' }), 'INTERNAL');
    assert.equal(h.squad.listExecutions().length, 0, '启动失败不得留下孤儿执行记录');

    // 任务未被锁死:重试成功
    const retry = await h.workbench.start(task.id, { idempotencyKey: 'squad-o2' });
    assert.equal(h.execOf(task.id).state, 'running');
    await h.cancelRun(retry.dispatchId);
    assert.notEqual(h.execOf(task.id).state, 'running', '收尾后执行不得停留在 running');
  } finally { h.dispose(); }
});

test('接续目标缺失(下一步 Agent 被删):exec 落 paused_failed + 任务 blocked,不永久卡 running', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '缺员小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '缺员任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    const started = await h.workbench.start(task.id, { idempotencyKey: 'squad-m1' });
    await h.finishRun(started.dispatchId, 'done', '第一步完成');
    // 第一步结束后删除下一步 Agent,模拟接续目标消失
    await h.workbenchStore.mutate((root) => { delete root.agents[h.agentB.id]; });
    const startedNext = await h.workbench.continueSquadExecutions();
    assert.equal(startedNext.length, 0, '无法接续时不应启动');
    const exec = h.execOf(task.id);
    assert.equal(exec.state, 'paused_failed', '接续目标缺失必须落终态');
    assert.ok(exec.pauseReason.includes('无法接续'));
    assert.equal(h.workbench.taskDetail(task.id).task.status, 'blocked', '任务退回 blocked 供用户处理');
  } finally { h.dispose(); }
});
