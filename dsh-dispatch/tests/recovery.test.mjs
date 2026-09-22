/** 崩溃窗口与恢复(T07-T09/T21/T23):重启对账保守、不自动重启、不二次执行。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, makeTask, baseReq, assertRejects, sleep } from './util.mjs';

test('T08:启动意图已落盘后崩溃 → 恢复进入 reconciling,不自动重启,占用保留', async () => {
  const h = await makeHarness();
  try {
    // 让 startContinuable 永不返回:意图已持久化、回执未到即"崩溃"
    const orig = h.runtime.startContinuable.bind(h.runtime);
    h.runtime.startContinuable = () => {
      h.runtime.calls.push({ op: 'startContinuable', detail: 'hung' });
      return new Promise(() => {});
    };
    void h.service.start(baseReq()).catch(() => undefined);
    await sleep(150);
    const id = h.service.list()[0].id;
    const crashed = h.service.status(id);
    assert.equal(crashed.phase, 'starting');
    assert.equal(crashed.startIntent.mayHaveExecuted, true);
    h.service.dispose();

    const { service: svc2 } = await h.restartService();
    const r = await svc2.reconcileOnce();
    const rec = svc2.status(id);
    assert.equal(rec.phase, 'reconciling', '未知状态 → 待核验');
    assert.equal(rec.reservation.executionSlotHeld, true, '占用保留');
    assert.ok(r.notes.some((n) => n.includes(id)));
    // 六约束 3:不自动再次启动
    assert.equal(h.runtime.calls.filter((c) => c.op === 'startContinuable').length, 1);
    void orig;
    // 操作员核验后允许收尾(§7.7)
    const done = await svc2.resolve(id, 'operator-1', '核查会话已停');
    assert.equal(done.phase, 'finished');
    svc2.dispose();
  } finally { h.dispose(); }
});

test('T09:child 已创建但回执保存前崩溃 → 预留 childId 定位,不创建第二个执行者', async () => {
  const h = await makeHarness();
  try {
    const orig = h.runtime.startContinuable.bind(h.runtime);
    let reserved = '';
    h.runtime.startContinuable = async (spec) => {
      reserved = spec.childId;
      const r = await orig(spec); // mock 已登记 child
      return new Promise(() => r); // 但永远不把回执交回(崩溃于保存前)
    };
    void h.service.start(baseReq()).catch(() => undefined);
    await sleep(150);
    const id = h.service.list()[0].id;
    const crashed = h.service.status(id);
    assert.equal(crashed.phase, 'starting');
    assert.equal(crashed.runtime.childSessionId, reserved, '预留 childId 在册');
    h.service.dispose();

    const { service: svc2 } = await h.restartService();
    await svc2.reconcileOnce();
    const rec = svc2.status(id);
    // child 在目录但无接受回执 → 证据不足,待核验;绝不二次启动
    assert.equal(rec.phase, 'reconciling');
    assert.equal(h.runtime.calls.filter((c) => c.op === 'startContinuable').length, 1, '没有第二个执行者');
    assert.ok(h.runtime.children.has(reserved), '用预留 childId 定位到既有 child');
    svc2.dispose();
  } finally { h.dispose(); }
});

test('崩溃于 report 与 end 之间(settling 无终止证据)→ 对账转 reconciling,操作员 resolve 收尾', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.ingestReport(childId, { outcome: 'done', summary: '完成' });
    assert.equal(h.service.status(dispatchId).phase, 'settling');
    h.service.dispose();

    const { service: svc2 } = await h.restartService();
    await svc2.reconcileOnce();
    assert.equal(svc2.status(dispatchId).phase, 'reconciling', '无终止证据不猜终态');
    const done = await svc2.resolve(dispatchId, 'operator', '核会话已静止,报告属实');
    assert.equal(done.phase, 'finished');
    assert.equal(svc2.status(dispatchId).result.reasonCode, 'RESULT_SUBMITTED');
    svc2.dispose();
  } finally { h.dispose(); }
});

test('崩溃于 end 与结算之间(证据在册)→ 对账重放证据完成结算', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.ingestReport(childId, { outcome: 'done', summary: '完成' });
    // 手工把记录停在"end 已观察但未 finished"是 reducer 原子性的反例——
    // 真实路径:end 事件落库即结算;这里模拟"end 事件在崩溃前刚落":
    h.service.dispose();
    const { service: svc2, store: store2 } = await h.restartService();
    // 通过运行事件把 end 送进新实例(等价于重启后补达的证据)
    h.runtime.emitRunEnd(childId, 'run-1', 'completed');
    await sleep(150);
    const rec = svc2.status(dispatchId);
    assert.equal(rec.phase, 'finished');
    assert.equal(rec.result.reasonCode, 'RESULT_SUBMITTED');
    svc2.dispose();
    store2.dispose();
  } finally { h.dispose(); }
});

test('T23:目录查询失败 → 保持待核验,不释放占用', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    h.runtime.failListChildren = 'catalog down';
    await h.service.cancel(dispatchId, 'user', '停');
    await sleep(250);
    const rec = h.service.status(dispatchId);
    assert.ok(['cancelling', 'reconciling'].includes(rec.phase), '查询失败不得标完成');
    assert.equal(rec.reservation.workspaceHeld, true, '占用保留');
  } finally { h.dispose(); }
});

test('T07:领取幂等——同 dispatchId 重领返回原 epoch;他派冲突', async () => {
  const h = await makeHarness();
  try {
    const ref = { projectId: 'p1', nodeId: 'n1', workspaceId: 'x', canonicalRoot: 'x' };
    const fp = h.target.ownerOf('p1', 'n1') === null ? (await import('../dist/adapters/target.js')).taskFingerprint(makeTask()) : '';
    const c1 = await h.target.claim({ dispatchId: 'd_a', childSessionId: 'c_a', ref, expectedFingerprint: fp });
    assert.equal(c1.ok, true);
    const c2 = await h.target.claim({ dispatchId: 'd_a', childSessionId: 'c_a', ref, expectedFingerprint: fp });
    assert.equal(c2.ok, true);
    assert.equal(c2.epoch, c1.epoch, '幂等重领 → 原 epoch');
    const c3 = await h.target.claim({ dispatchId: 'd_b', childSessionId: 'c_b', ref, expectedFingerprint: fp });
    assert.equal(c3.ok, false);
    assert.equal(c3.code, 'NODE_OCCUPIED');
  } finally { h.dispose(); }
});

test('T21:finalize 幂等——同 operationId 重试返回原回执,不重复台账', async () => {
  const h = await makeHarness();
  try {
    const ref = { projectId: 'p1', nodeId: 'n1', workspaceId: 'x', canonicalRoot: 'x' };
    const fp = (await import('../dist/adapters/target.js')).taskFingerprint(makeTask());
    await h.target.claim({ dispatchId: 'd_a', childSessionId: 'c_a', ref, expectedFingerprint: fp });
    const before = h.target.entriesOf('p1', 'n1');
    const f1 = await h.target.finalize({ dispatchId: 'd_a', operationId: 'd_a:finalize', outcome: 'done', summary: 's', finalEntryTitle: '最终台账' });
    assert.equal(f1.ok, true);
    const f2 = await h.target.finalize({ dispatchId: 'd_a', operationId: 'd_a:finalize', outcome: 'done', summary: 's', finalEntryTitle: '最终台账' });
    assert.equal(f2.ok, true);
    assert.equal(f2.receipt.appliedAt, f1.receipt.appliedAt, '原回执');
    assert.equal(h.target.entriesOf('p1', 'n1'), before + 1, '台账只追加一次');
    assert.equal(h.target.ownerOf('p1', 'n1'), null, 'finalize 释放所有权');
  } finally { h.dispose(); }
});

test('T17/T18:人工编辑令旧 claim 失效;新派发 TASK_CHANGED/占用正确', async () => {
  const h = await makeHarness();
  try {
    const ref = { projectId: 'p1', nodeId: 'n1', workspaceId: 'x', canonicalRoot: 'x' };
    const { taskFingerprint } = await import('../dist/adapters/target.js');
    const fp1 = taskFingerprint(makeTask());
    await h.target.claim({ dispatchId: 'd_a', childSessionId: 'c_a', ref, expectedFingerprint: fp1 });
    assert.ok(h.target.ownerOf('p1', 'n1'));

    // 人工只改 detail、不改状态 → 旧 claim 失效(§5.5)
    h.target.humanEdit('p1', 'n1', { nodeDetail: '改过的任务' });
    assert.equal(h.target.ownerOf('p1', 'n1'), null, '人工编辑撤销所有权');

    // 语义变化后的指纹 → 旧指纹再领 → TASK_CHANGED
    const c = await h.target.claim({ dispatchId: 'd_b', childSessionId: 'c_b', ref, expectedFingerprint: fp1 });
    assert.equal(c.ok, false);
    assert.equal(c.code, 'TASK_CHANGED');

    // 重新读取任务后的新指纹可领
    const fresh = await h.target.readTask(ref);
    const c2 = await h.target.claim({ dispatchId: 'd_b', childSessionId: 'c_b', ref, expectedFingerprint: fresh.fingerprint });
    assert.equal(c2.ok, true);
  } finally { h.dispose(); }
});
