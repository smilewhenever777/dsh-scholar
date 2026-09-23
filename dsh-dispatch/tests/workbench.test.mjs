import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchStore } from '../dist/store.js';
import { WorkbenchStore } from '../dist/workbench/store.js';
import { WorkbenchTargetAdapter, RoutedTargetAdapter } from '../dist/workbench/target.js';
import { WorkbenchService } from '../dist/workbench/service.js';
import { InMemoryTargetAdapter } from '../dist/adapters/target.js';
import { MockRuntime } from '../dist/runtime.js';
import { DispatchService } from '../dist/service.js';
import { defaultPolicyConfig } from '../dist/policy.js';
import { childToolFilter } from '../dist/policy.js';
import { guardLocal, presentEvent } from '../dist/workbench/routes.js';
import { assertRejects, sleep } from './util.mjs';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-workbench-'));
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
  const project = await workbench.createProject({ title: '独立工作台', root: ws });
  const agent = await workbench.createAgent({ name: '分析员', instructions: '只读分析', model: 'glm/glm-5.3' });
  const task = await workbench.createTask({ projectId: project.id, title: '检查日志', description: '逐份检查', acceptanceCriteria: '列出每份日志来源', assigneeId: agent.id });
  return { dir, home, ws, dispatchStore, workbenchStore, runtime, target, dispatch, workbench, project, agent, task,
    dispose() { dispatch.dispose(); dispatchStore.dispose(); workbenchStore.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('原生任务可独立创建，分派不启动；并发点击只生成一条 Run', async () => {
  const h = await harness();
  try {
    assert.equal(h.workbench.taskDetail(h.task.id).runs.length, 0);
    const [a, b] = await Promise.all([
      h.workbench.start(h.task.id, { idempotencyKey: 'same-click' }),
      h.workbench.start(h.task.id, { idempotencyKey: 'same-click' }),
    ]);
    assert.equal(a.dispatchId, b.dispatchId);
    assert.equal(h.runtime.calls.filter((x) => x.op === 'startContinuable').length, 1);
    assert.equal(h.workbench.taskDetail(h.task.id).task.status, 'in_progress');
    assert.equal(h.workbench.taskDetail(h.task.id).runs.length, 1);
    await assertRejects(() => h.workbench.start(h.task.id, { idempotencyKey: 'new-click' }), 'WRONG_STATE');
    const rec = h.workbench.runDetail(a.dispatchId);
    assert.equal(rec.source.promptText, undefined, '系统任务提示词不向客户端输出');
  } finally { h.dispose(); }
});

test('Run 完成进入人工验收；退回后再次运行保留首次记录，接受后才 done', async () => {
  const h = await harness();
  try {
    const first = await h.workbench.start(h.task.id, { idempotencyKey: 'first' });
    let task = h.workbench.taskDetail(h.task.id).task;
    await assertRejects(() => h.workbench.updateTask(task.id, { expectedRevision: task.revision, acceptanceCriteria: '偷偷修改' }), 'WRONG_STATE');
    const child = h.dispatch.status(first.dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(child, 'run-1');
    await h.dispatch.ingestReport(child, { outcome: 'done', summary: '已检查', evidence: ['report.md'] });
    h.runtime.emitRunEnd(child, 'run-1', 'completed');
    await sleep(120);
    task = h.workbench.taskDetail(h.task.id).task;
    assert.equal(task.status, 'in_review');
    assert.deepEqual(h.dispatch.status(first.dispatchId).report.evidence, [{ kind: 'artifact', ref: 'report.md' }]);
    await assertRejects(() => h.workbench.review(task.id, { expectedRevision: task.revision - 1, decision: 'accept' }), 'WRONG_STATE');
    task = await h.workbench.review(task.id, { expectedRevision: task.revision, decision: 'reject', comment: '缺少第三份日志' });
    assert.equal(task.status, 'todo');
    const second = await h.workbench.start(task.id, { idempotencyKey: 'second' });
    assert.notEqual(second.dispatchId, first.dispatchId);
    assert.deepEqual(h.workbench.taskDetail(task.id).task.runIds, [first.dispatchId, second.dispatchId]);
    const child2 = h.dispatch.status(second.dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(child2, 'run-2');
    await h.dispatch.ingestReport(child2, { outcome: 'done', summary: '三份日志均已检查' });
    h.runtime.emitRunEnd(child2, 'run-2', 'completed');
    await sleep(120);
    task = h.workbench.taskDetail(task.id).task;
    assert.equal(task.status, 'in_review');
    task = await h.workbench.review(task.id, { expectedRevision: task.revision, decision: 'accept', comment: '通过' });
    assert.equal(task.status, 'done');
    assert.equal(h.workbench.taskDetail(task.id).runs.length, 2);
    assert.equal(task.timeline.filter((x) => x.kind === 'review').length, 2);
    await assertRejects(() => h.workbench.updateTask(task.id, { expectedRevision: task.revision, acceptanceCriteria: '改验收标准' }), 'WRONG_STATE');
    const reopened = await h.workbench.updateTask(task.id, { expectedRevision: task.revision, status: 'todo' });
    assert.equal(reopened.status, 'todo');
    const revised = await h.workbench.updateTask(task.id, { expectedRevision: reopened.revision, acceptanceCriteria: '新验收标准' });
    assert.equal(revised.acceptanceCriteria, '新验收标准');
  } finally { h.dispose(); }
});

test('取消等待静止确认后返回待办，原 Run 留存', async () => {
  const h = await harness();
  try {
    const started = await h.workbench.start(h.task.id, { idempotencyKey: 'cancel' });
    await h.dispatch.cancel(started.dispatchId, 'user', '撤回');
    await sleep(1500);
    const task = h.workbench.taskDetail(h.task.id).task;
    assert.equal(h.dispatch.status(started.dispatchId).result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
    assert.equal(task.status, 'todo');
    assert.equal(task.runIds.length, 1);
  } finally { h.dispose(); }
});

test('原生任务接管会撤销本地目标所有权', async () => {
  const h = await harness();
  try {
    const started = await h.workbench.start(h.task.id, { idempotencyKey: 'takeover' });
    await h.dispatch.takeover(started.dispatchId, 'user', '人工接管');
    const owner = h.workbenchStore.snapshot().tasks[h.task.id].owner;
    assert.equal(owner?.revoked, true);
    assert.equal(owner?.workerWrites, false);
  } finally { h.dispose(); }
});

test('工作台持久化重载、备份和损坏只读', async () => {
  const h = await harness();
  const { home, task } = h;
  try {
    await h.workbench.comment(task.id, { expectedRevision: task.revision, text: '验证备份' });
    const path = join(home, 'dispatch', 'workbench.json');
    assert.ok(existsSync(`${path}.bak`));
    h.dispatch.dispose(); h.dispatchStore.dispose(); h.workbenchStore.dispose();
    const reloaded = new WorkbenchStore(home);
    await reloaded.init();
    assert.equal(reloaded.snapshot().tasks[task.id].title, '检查日志');
    reloaded.dispose();
    writeFileSync(path, '{broken', 'utf8');
    const broken = new WorkbenchStore(home);
    await broken.init();
    assert.equal(broken.fault.readOnly, true);
    assert.ok(broken.snapshot()?.tasks[task.id], '从备份加载可读快照');
    await assert.rejects(() => broken.mutate(() => undefined), (e) => e.code === 'STORE_READONLY');
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    broken.dispose();
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('Origin 与 Host 必须同源且只允许回环请求', () => {
  function check(host, origin, address) {
    const req = { headers: { host, ...(origin ? { origin } : {}) }, socket: { remoteAddress: address } };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
    return { allowed: guardLocal(req, res), status: res.statusCode };
  }
  assert.deepEqual(check('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1'), { allowed: true, status: 200 });
  assert.deepEqual(check('127.0.0.1:3080', 'http://evil.test', '127.0.0.1'), { allowed: false, status: 403 });
  assert.deepEqual(check('evil.test', 'http://evil.test', '127.0.0.1'), { allowed: false, status: 403 });
  assert.deepEqual(check('127.0.0.1:3080', 'http://127.0.0.1:3080', '192.168.0.1'), { allowed: false, status: 403 });
});

test('会话投影隐藏系统提示词、推理和插件注入，只保留可见消息与工具', () => {
  const at = 123;
  const event = (type, data) => presentEvent({ seq: 4, type, time: at, data });
  assert.equal(event('system/message', { message: { content: [{ type: 'text', text: 'system secret' }] } }), null);
  assert.equal(event('user/message', { source: { kind: 'plugin', plugin: 'skill' }, content: [{ type: 'text', text: 'private injected context' }] }), null);
  assert.equal(event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'generated task prompt' }] }), null);
  assert.equal(event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] } }).text, 'answer');
  assert.equal(event('tool/call', { name: 'dispatch_read_file', arguments: '{"path":"a.md"}' }).name, 'dispatch_read_file');
});

test('Agent 工具配置只能收紧；空权限不会回退为全部工具', async () => {
  const h = await harness();
  try {
    await assertRejects(() => h.workbench.createAgent({ name: '越权', model: 'glm/glm-5.3', toolAllow: ['exec_command'] }), 'VALIDATION');
    assert.deepEqual(childToolFilter([]).allow, []);
    assert.deepEqual(childToolFilter(['dispatch_read_file', 'exec_command']).allow, ['dispatch_read_file']);
    const empty = await h.workbench.updateAgent(h.agent.id, { expectedRevision: h.agent.revision, name: h.agent.name,
      instructions: '', model: h.agent.model, toolAllow: [] });
    assert.deepEqual(empty.toolAllow, []);
    const run = await h.workbench.start(h.task.id, { idempotencyKey: 'empty-tools' });
    assert.deepEqual(h.dispatch.status(run.dispatchId).effectiveConfig.agentProfile.toolAllow, []);
  } finally { h.dispose(); }
});

test('旧派发根格式 v2 升级留备份，旧记录保持原样', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-upgrade-'));
  try {
    mkdirSync(join(dir, 'dispatch'));
    const original = { schemaVersion: 2, revision: 7, dispatches: { old: { schemaVersion: 2, id: 'old', targetType: 'traj_node' } }, idempotency: {} };
    const file = join(dir, 'dispatch', 'dispatches.json');
    writeFileSync(file, JSON.stringify(original));
    const store = new DispatchStore(dir);
    await store.init();
    assert.equal(store.snapshot().schemaVersion, 3);
    assert.equal(store.get('old').schemaVersion, 2);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), original);
    store.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
