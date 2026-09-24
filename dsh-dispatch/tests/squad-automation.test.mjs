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
import { createHash } from 'node:crypto';
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
    async (template, source, ruleName) => {
      // 与 index.ts 生产版一致:确定性任务 ID 使崩溃重放不重建任务
      const fixedId = 't_auto_' + createHash('sha256').update(source).digest('hex').slice(0, 24);
      const task = await workbench.createTask({ ...template, sourceNote: `自动化规则「${ruleName}」定时创建`, fixedId });
      const result = await workbench.start(task.id, { idempotencyKey: `auto-${source}` });
      return { taskId: task.id, dispatchId: result.dispatchId };
    },
    () => false);
  const project = await workbench.createProject({ title: '小队项目', root: ws });
  const agentA = await workbench.createAgent({ name: '起草员', instructions: '起草', model: 'glm/glm-5.3' });
  const agentB = await workbench.createAgent({ name: '审校员', instructions: '审校', model: 'glm/glm-5.3' });
  return { dir, home, ws, dispatchStore, workbenchStore, runtime, dispatch, workbench, squad, automation, project, agentA, agentB,
    async finishRun(dispatchId, outcome, summary, evidence = []) {
      const child = dispatch.status(dispatchId).runtime.childSessionId;
      runtime.emitRunStart(child, `run-${dispatchId}`);
      await dispatch.ingestReport(child, { outcome, summary, evidence });
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
    const rule = await h.automation.create({ name: '周报', cron: '0 9 * * 1', template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
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
    const rule = await h.automation.create({ name: '月度汇总', cron: '0 9 1 * *', template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
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
    const rule = await h.automation.create({ name: '永不存在', cron: '0 9 30 2 *', template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
    assert.equal(rule.nextTriggerAt, 0, '400 天无匹配应返回 0(调度器按 falsy 跳过)');
  } finally { h.dispose(); }
});

test('cron:分钟级表达式仍即时命中(回归检查两段式重构)', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '高频', cron: '*/30 * * * *', template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
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
    await h.finishRun(started.dispatchId, 'done', '起草完成,初稿在 draft.md', ['draft.md']);
    let t = h.workbench.taskDetail(task.id).task;
    assert.equal(t.status, 'in_progress', '中间步骤成功应保持 in_progress');
    exec = h.execOf(task.id);
    assert.equal(exec.state, 'running');

    // 接续第二步(claim 须放行小队交接的 in_progress)
    const startedNext = await h.workbench.continueSquadExecutions();
    assert.equal(startedNext.length, 1, '应启动第二步');
    // P1:交接包——上一步结论与证据进入第二步提示词快照
    const snap2 = h.dispatch.status(startedNext[0]).source.snapshot;
    assert.ok(String(snap2.nodeDetail).includes('小队交接'), '快照须含交接标记');
    assert.ok(String(snap2.nodeDetail).includes('起草完成'), '交接须带上一步结论');
    assert.ok(String(snap2.nodeDetail).includes('draft.md'), '交接须带交付物');
    assert.ok(h.execOf(task.id).handoffs?.['0']?.summary.includes('起草完成'), 'exec 须记录交接(供 UI 展示)');
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

/* ---------- v0.10 审计修复回归 ---------- */

test('P0-3:cron 按规则时区计算——同时区墙钟不同 epoch;非法时区 422', async () => {
  const h = await harness();
  try {
    const mk = (tz) => h.automation.create({ name: 'tz-' + tz.replace('/', '_'), cron: '0 9 * * *', timezone: tz,
      template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
    const sh = await mk('Asia/Shanghai');
    const utc = await mk('UTC');
    assert.notEqual(sh.nextTriggerAt, utc.nextTriggerAt, '相同时刻表在不同时区必须产生不同触发时间');
    // 各自落到自己时区的 9:00(宿主机即上海时区,本地小时即上海墙钟)
    const shd = new Date(sh.nextTriggerAt);
    assert.equal(shd.getHours(), 9);
    assert.equal(shd.getMinutes(), 0);
    const utcd = new Date(utc.nextTriggerAt);
    assert.equal(utcd.getUTCHours(), 9);
    assert.equal(utcd.getUTCMinutes(), 0);
    // 两次触发的时间差恰为时区差的整数圈(8h mod 24h)
    const diffH = (utc.nextTriggerAt - sh.nextTriggerAt) / 3600_000;
    const m = ((diffH % 24) + 24) % 24; // 归一化余数:时差 ±8h 跨日界后表现为 8 或 16
    assert.ok(m === 8 || m === 16, `触发差应 ≡ ±8h (mod 24h),实际 ${diffH}h`);
    await assertRejects(() => mk('Mars/Olympus'), 'VALIDATION');
  } finally { h.dispose(); }
});

test('P0-3:闰日 cron 在 10 年窗口内命中(2 月 29 日)', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: 'leap', cron: '0 9 29 2 *', timezone: 'UTC',
      template: { projectId: h.project.id, title: 't', acceptanceCriteria: 'a' } });
    assert.ok(rule.nextTriggerAt > 0, '闰日必须命中(旧 400 天窗口可能为 0)');
    const d = new Date(rule.nextTriggerAt);
    assert.equal(d.getUTCMonth(), 1);
    assert.equal(d.getUTCDate(), 29);
    assert.equal(d.getUTCHours(), 9);
  } finally { h.dispose(); }
});

test('P0-4:planned attempt 崩溃恢复——重放不重建任务(fixedId 幂等)', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: 'recover', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
      template: { projectId: h.project.id, title: '恢复任务', description: '', acceptanceCriteria: '完成', assigneeId: h.agentA.id } });
    await h.automation.update(rule.id, { expectedRevision: rule.revision, enabled: true });
    const first = await h.automation.tryTrigger(rule.id, rule.nextTriggerAt);
    assert.equal(first.result, 'started');
    await h.cancelRun(first.dispatchId); // 收尾首个 run(任务回 todo),模拟启动后崩溃前任务已存在
    const countAfter = Object.values(h.workbenchStore.snapshot().tasks).filter((t) => t.title === '恢复任务').length;
    assert.equal(countAfter, 1);
    // 模拟崩溃后重放:把 attempt 手工拨回 planned(去 taskId),再触发同一 scheduledAt
    await h.workbenchStore.mutate((root) => {
      const attempts = root.triggerAttempts;
      const at = Object.values(attempts).find((a) => a.ruleId === rule.id);
      if (at) { at.result = 'planned'; delete at.taskId; }
    });
    const again = await h.automation.tryTrigger(rule.id, rule.nextTriggerAt);
    assert.equal(again.result, 'started', 'planned 态必须可恢复(幂等键重放)');
    const countReplay = Object.values(h.workbenchStore.snapshot().tasks).filter((t) => t.title === '恢复任务').length;
    assert.equal(countReplay, 1, 'fixedId 幂等——重放不得重建任务');
    const t2 = h.workbench.taskDetail(again.taskId).task;
    assert.ok(t2.timeline.some((ev) => ev.text.includes('自动化规则')), '来源标记仍在');
  } finally { h.dispose(); }
});

test('P0-1:小队执行期间(含交接间隙)任务内容锁定;人工接管落终态', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '锁定小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '锁定任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    const started = await h.workbench.start(task.id, { idempotencyKey: 'lock-1' });
    // 执行中(owner 在):旧路径已锁;交接间隙(无 owner + in_progress):新锁定
    await h.finishRun(started.dispatchId, 'done', '第一步完成');
    const t1 = h.workbench.taskDetail(task.id).task;
    assert.equal(t1.status, 'in_progress');
    assert.equal(t1.owner, undefined, '交接间隙无 owner');
    await assertRejects(() => h.workbench.updateTask(task.id, { expectedRevision: t1.revision, title: '偷偷改名' }), 'WRONG_STATE');
    // 人工接管 → 执行落终态,小队可删,任务不再被 30s 重试锁死
    await h.dispatch.takeover(started.dispatchId, 'user', '测试接管');
    const exec = h.execOf(task.id);
    assert.equal(exec.state, 'paused_failed');
    assert.ok(exec.pauseReason.includes('人工接管'));
    assert.equal(await h.squad.delete(squad.id), true, '接管后小队可删除');
  } finally { h.dispose(); }
});

test('P1:接续启动永久失败(模型失效)→ paused_failed + 任务 blocked,不静默循环', async () => {
  const h = await harness();
  try {
    const squad = await h.squad.create({ name: '坏模型小队', description: '',
      steps: [{ agentId: h.agentA.id, responsibility: '起草' }, { agentId: h.agentB.id, responsibility: '审校' }] });
    const task = await h.workbench.createTask({ projectId: h.project.id, title: '坏模型任务', description: '', acceptanceCriteria: '完成', assigneeId: squad.id });
    const started = await h.workbench.start(task.id, { idempotencyKey: 'badm-1' });
    await h.finishRun(started.dispatchId, 'done', '第一步完成');
    // 第一步后把第二步 Agent 模型改成不在允许列表(模拟配置失效)
    await h.workbenchStore.mutate((root) => { root.agents[h.agentB.id].model = 'glm/glm-nonexistent'; });
    const next = await h.workbench.continueSquadExecutions();
    assert.equal(next.length, 0);
    const exec = h.execOf(task.id);
    assert.equal(exec.state, 'paused_failed', '永久性失败必须落终态');
    assert.ok(exec.pauseReason.includes('启动失败'), `原因可见:${exec.pauseReason}`);
    assert.equal(h.workbench.taskDetail(task.id).task.status, 'blocked', '任务退回 blocked 供处理');
  } finally { h.dispose(); }
});

test('P1:missed_offline 按在线区间判定——boot 前到期记错过,lastTick 邻近的照常触发', async () => {
  const h = await harness();
  try {
    const rule = await h.automation.create({ name: '在线区间', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
      template: { projectId: h.project.id, title: '区间任务', description: '', acceptanceCriteria: '完成', assigneeId: h.agentA.id } });
    await h.automation.update(rule.id, { expectedRevision: rule.revision, enabled: true });
    // 模拟调度器已启动:bootedAt=now-10min, lastTickAt=now-40s
    await h.workbenchStore.mutate((root) => {
      (root).schedulerMeta = { bootedAt: Date.now() - 600_000, lastTickAt: Date.now() - 40_000 };
    });
    // 情形 A:到期时刻在 boot 之前(停机错过)
    await h.workbenchStore.mutate((root) => {
      const r = root.automationRules[rule.id];
      r.nextTriggerAt = Date.now() - 700_000; // 早于 bootedAt
    });
    await h.automation.tick();
    let attempts = h.automation.attempts();
    assert.equal(attempts[0]?.result, 'missed_offline', 'boot 前到期只记审计');
    // 情形 B:到期时刻在 lastTick 邻近(在线期间刚到期)→ 正常触发
    await h.workbenchStore.mutate((root) => {
      const r = root.automationRules[rule.id];
      r.nextTriggerAt = Date.now() - 30_000; // 晚于 lastTick-120s
    });
    await h.automation.tick();
    attempts = h.automation.attempts();
    assert.equal(attempts[0]?.result, 'started', '在线期间到期应正常触发');
    const t = h.workbench.taskDetail(attempts[0].taskId).task;
    assert.equal(t.title, '区间任务');
    await h.cancelRun(attempts[0].dispatchId);
  } finally { h.dispose(); }
});

test('P1:store 二次 init 无迁移时不重写文件(mtime 不变)', async () => {
  const h = await harness();
  try {
    const file = join(h.home, 'dispatch', 'workbench.json');
    mkdirSync(join(h.dir, 'ws-c'));
    await h.workbench.createProject({ title: 'p2', root: join(h.dir, 'ws-c') });
    const { statSync } = await import('node:fs');
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const store2 = new WorkbenchStore(h.home);
    await store2.init();
    assert.equal(statSync(file).mtimeMs, before, '无迁移的启动不得重写 workbench.json');
    assert.equal(Object.keys(store2.snapshot().projects).length, 2, '数据完好');
    store2.dispose();
  } finally { h.dispose(); }
});
