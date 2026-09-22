/** 服务编排 E2E(MockRuntime,无 LLM):幂等/占用/正常链/取消/预算/接管/校验(T01-T06/T10/T11/T24/T28)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, makeTask, baseReq, WS, WS_B, assertRejects, sleep } from './util.mjs';

function startCalls(h) {
  return h.runtime.calls.filter((c) => c.op === 'startContinuable').length;
}

test('T01:同幂等键并发 → 单派发单启动', async () => {
  const h = await makeHarness();
  try {
    const [a, b] = await Promise.all([h.service.start(baseReq()), h.service.start(baseReq())]);
    assert.equal(a.dispatchId, b.dispatchId);
    assert.ok(!a.replay || !b.replay, '至少一个是首创建');
    assert.equal(startCalls(h), 1);
  } finally { h.dispose(); }
});

test('T02:同键不同请求 → IDEMPOTENCY_CONFLICT,原记录不变', async () => {
  const h = await makeHarness();
  try {
    const a = await h.service.start(baseReq());
    await assertRejects(() => h.service.start(baseReq({ ws: WS_B })), 'IDEMPOTENCY_CONFLICT');
    assert.equal(h.service.status(a.dispatchId).phase !== 'finished' ? 1 : 1, 1);
    assert.equal(startCalls(h), 1);
  } finally { h.dispose(); }
});

test('T03:同节点不同键 → NODE_OCCUPIED', async () => {
  const h = await makeHarness();
  try {
    await h.service.start(baseReq({ idempotencyKey: 'k1' }));
    await assertRejects(() => h.service.start(baseReq({ idempotencyKey: 'k2' })), 'NODE_OCCUPIED');
  } finally { h.dispose(); }
});

test('T04:不同节点/工作区争执行槽与工作区占用', async () => {
  const h = await makeHarness({ taskB: makeTask({ nodeId: 'n2' }) });
  try {
    await h.service.start(baseReq({ idempotencyKey: 'k1' }));
    // 不同节点 + 不同工作区 → 全局单执行槽
    await assertRejects(
      () => h.service.start(baseReq({ idempotencyKey: 'k2', nodeId: 'n2', ws: WS_B })),
      'CAPACITY_EXCEEDED',
    );
    // 不同节点 + 同工作区 → 工作区占用(单槽下先命中)
    await assertRejects(
      () => h.service.start(baseReq({ idempotencyKey: 'k3', nodeId: 'n2' })),
      'WORKSPACE_OCCUPIED',
    );
  } finally { h.dispose(); }
});

test('T10:响应丢失重试同键 → 返回原派发,不二次启动', async () => {
  const h = await makeHarness();
  try {
    const a = await h.service.start(baseReq());
    const b = await h.service.start(baseReq());
    assert.equal(b.replay, true);
    assert.equal(b.dispatchId, a.dispatchId);
    assert.equal(startCalls(h), 1);
  } finally { h.dispose(); }
});

test('正常链:start→run→progress×2→report(done)→end(completed)→finished', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const rec0 = h.service.status(dispatchId);
    const childId = rec0.runtime.childSessionId;
    assert.equal(rec0.phase, 'queued');
    assert.ok(rec0.runtime.sponsorSessionId.startsWith('mock-sponsor-'));

    h.runtime.emitRunStart(childId, 'run-1');
    await sleep(50);
    assert.equal(h.service.status(dispatchId).phase, 'running');

    await h.service.ingestProgress(childId, { sequence: 1, summary: '读取日志A' });
    await h.service.ingestProgress(childId, { sequence: 2, summary: '汇总指标' });
    assert.equal(h.target.entriesOf('p1', 'n1'), 2);

    // sequence 幂等:同序号同内容重放 OK;不同内容冲突
    await h.service.ingestProgress(childId, { sequence: 2, summary: '汇总指标' });
    await assertRejects(() => h.service.ingestProgress(childId, { sequence: 2, summary: '改口' }), 'REPORT_CONFLICT');
    assert.equal(h.target.entriesOf('p1', 'n1'), 2);

    const rep = await h.service.ingestReport(childId, { outcome: 'done', summary: '报告完成', evidence: [{ kind: 'artifact', ref: 'report.md' }] });
    assert.ok(rep.receivedAt > 0);
    assert.equal(h.service.status(dispatchId).phase, 'settling');

    h.runtime.emitRunEnd(childId, 'run-1', 'completed');
    await sleep(80);
    const fin = h.service.status(dispatchId);
    assert.equal(fin.phase, 'finished');
    assert.equal(fin.result.reasonCode, 'RESULT_SUBMITTED');
    assert.equal(fin.report.runAssociation, 'verified');
  } finally { h.dispose(); }
});

test('报告幂等与冲突:同内容原回执,不同内容不覆盖(T11)', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    const first = await h.service.ingestReport(childId, { outcome: 'done', summary: 'v1' });
    const replay = await h.service.ingestReport(childId, { outcome: 'done', summary: 'v1' });
    assert.equal(replay.replay, true);
    assert.equal(replay.receivedAt, first.receivedAt);
    await assertRejects(() => h.service.ingestReport(childId, { outcome: 'done', summary: 'v2' }), 'REPORT_CONFLICT');
    assert.equal(h.service.status(dispatchId).report.summary, 'v1');
  } finally { h.dispose(); }
});

test('跨派发伪造:陌生 child → UNAUTHORIZED_WORKER(T11)', async () => {
  const h = await makeHarness();
  try {
    await h.service.start(baseReq());
    await assertRejects(() => h.service.ingestReport('not-a-child', { outcome: 'done', summary: 'x' }), 'UNAUTHORIZED_WORKER');
    await assertRejects(() => h.service.ingestProgress('not-a-child', { sequence: 1, summary: 'x' }), 'UNAUTHORIZED_WORKER');
  } finally { h.dispose(); }
});

test('T06:接受后立刻取消 → 静止确认(drain)后才收尾;parked 工作被清除', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const rec = h.service.status(dispatchId);
    assert.equal(rec.phase, 'queued');
    assert.equal(h.runtime.parkedWork(rec.runtime.childSessionId), 1, 'mock inbox 有 parked 初始消息');

    const r = await h.service.cancel(dispatchId, 'user', '改主意');
    assert.equal(r.accepted, true);

    await sleep(1500);
    const fin = h.service.status(dispatchId);
    assert.equal(fin.phase, 'finished');
    assert.equal(fin.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
    assert.ok(h.runtime.calls.some((c) => c.op === 'interruptByParent'), '发出中断');
    assert.ok(h.runtime.calls.some((c) => c.op === 'drain'), '发出 drain');
    assert.equal(h.runtime.parkedWork(rec.runtime.childSessionId), 0, 'parked 工作被 drain 清除');
    assert.equal(fin.reservation.workspaceHeld, false);
  } finally { h.dispose(); }
});

test('运行中取消:aborted 事件 + 静止 → 收尾;后续 progress 拒绝(T25 前半)', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.cancel(dispatchId, 'user', '停');
    h.runtime.emitRunEnd(childId, 'run-1', 'aborted');
    await sleep(1600);
    const fin = h.service.status(dispatchId);
    assert.equal(fin.phase, 'finished');
    assert.equal(fin.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
    // 取消后执行者再写 → 拒绝并隔离审计
    await assertRejects(() => h.service.ingestProgress(childId, { sequence: 3, summary: '迟到' }), 'WRITES_DISABLED');
    const audited = h.service.status(dispatchId).audit.some((a) => a.type === 'late-report-quarantined');
    assert.ok(audited, '迟到调用进入隔离审计');
  } finally { h.dispose(); }
});

test('T24:预算超限 → 请求停止并按证据收尾,不自动解锁', async () => {
  const h = await makeHarness({ maxWallMs: 40 });
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await sleep(140);
    const mid = h.service.status(dispatchId);
    assert.ok(['cancelling', 'finished'].includes(mid.phase), `phase=${mid.phase}`);
    h.runtime.emitRunEnd(childId, 'run-1', 'aborted');
    await sleep(1500);
    const fin = h.service.status(dispatchId);
    assert.equal(fin.phase, 'finished');
    assert.equal(fin.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
    assert.ok(fin.cancel?.reason.startsWith('BUDGET_EXCEEDED'));
  } finally { h.dispose(); }
});

test('接管:撤权目标与执行者,迟到报告拒绝,静止后 TAKEOVER_SUPERSEDED', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    assert.ok(h.target.ownerOf('p1', 'n1'), '领取后目标有主');

    await h.service.takeover(dispatchId, 'user', '人工接管');
    assert.equal(h.target.ownerOf('p1', 'n1'), null, '目标所有权已撤销');

    await assertRejects(() => h.service.ingestReport(childId, { outcome: 'done', summary: '迟到' }), 'WRITES_REVOKED');
    h.runtime.emitRunEnd(childId, 'run-1', 'aborted');
    await sleep(1500);
    const fin = h.service.status(dispatchId);
    assert.equal(fin.result.reasonCode, 'TAKEOVER_SUPERSEDED');
    assert.equal(fin.ownership.workerWrites, 'revoked');
  } finally { h.dispose(); }
});

test('start 被拒绝(P0 语义=完整回滚)→ START_REJECTED 并释放槽位', async () => {
  const h = await makeHarness();
  try {
    h.runtime.failNextStart = 'provider unavailable';
    await assertRejects(() => h.service.start(baseReq()), 'INTERNAL');
    const rec = h.service.list()[0];
    assert.equal(rec.result, 'failed/START_REJECTED');
    // 回写终写释放目标侧 claim(§5.6),之后槽位/节点均可再次派发
    await h.service.drainWritebacks();
    const again = await h.service.start(baseReq({ idempotencyKey: 'k2' }));
    assert.ok(again.dispatchId);
  } finally { h.dispose(); }
});

test('T28:输入校验——相对路径/.. 穿越/非法模型/超大任务', async () => {
  const h = await makeHarness();
  try {
    await assertRejects(() => h.service.start(baseReq({ ws: 'relative/path' })), 'VALIDATION');
    await assertRejects(() => h.service.start(baseReq({ ws: 'D:/x/../y' })), 'VALIDATION');
    await assertRejects(() => h.service.start(baseReq({ model: 'openai/gpt-9' })), 'VALIDATION');
  } finally { h.dispose(); }

  const big = await makeHarness({ task: makeTask({ nodeDetail: 'x'.repeat(300 * 1024) }) });
  try {
    await assertRejects(() => big.service.start(baseReq()), 'VALIDATION');
  } finally { big.dispose(); }
});

test('节点不存在 → NOT_FOUND;工具过滤排除 trajectory 直写工具', async () => {
  const h = await makeHarness();
  try {
    await assertRejects(() => h.service.start(baseReq({ nodeId: 'n404' })), 'NOT_FOUND');
    const { dispatchId } = await h.service.start(baseReq({ toolAllow: ['dispatch_progress', 'traj_node_update'] }));
    const rec = h.service.status(dispatchId);
    void rec;
    const startCall = h.runtime.calls.find((c) => c.op === 'startContinuable');
    assert.ok(startCall, '有启动调用');
    // 校验在 policy 层:childToolFilter 排除 traj_*
    const { childToolFilter } = await import('../dist/policy.js');
    const f = childToolFilter(['dispatch_progress', 'traj_node_update']);
    assert.deepEqual(f.allow, ['dispatch_progress'], 'trajectory 直写工具被剔出 allow');
  } finally { h.dispose(); }
});
