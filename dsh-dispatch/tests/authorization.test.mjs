/** 授权与撤权(T25/T11 交叉):门控每次调用重查,冷恢复后旧执行者拿不回写权限。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, baseReq, assertRejects, sleep } from './util.mjs';

test('T25:报告后执行者再写 → 拒绝(worker_only 封闭)', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.ingestReport(childId, { outcome: 'done', summary: '完成' });
    await assertRejects(() => h.service.ingestProgress(childId, { sequence: 9, summary: '报告后再写' }), 'WRITES_DISABLED');
    await assertRejects(() => h.service.ingestReport(childId, { outcome: 'done', summary: '二报' }), 'REPORT_CONFLICT');
    assert.equal(h.service.status(dispatchId).ownership.workerWrites, 'disabled');
  } finally { h.dispose(); }
});

test('T25:重启(模拟冷恢复)后旧执行者写入仍被拒', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.cancel(dispatchId, 'user', '停');
    h.runtime.emitRunEnd(childId, 'run-1', 'aborted');
    await sleep(1500);

    const { service: svc2 } = await h.restartService();
    // 冷恢复后同一 child(旧会话续聊路径)再写:撤权状态随记录恢复,依然拒绝
    await assertRejects(() => svc2.ingestProgress(childId, { sequence: 5, summary: '复活' }), 'WRITES_DISABLED');
    svc2.dispose();
  } finally { h.dispose(); }
});

test('门控不缓存:同 child 接连调用,中途撤权立即生效', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.ingestProgress(childId, { sequence: 1, summary: 'ok' }); // 授权中通过
    await h.service.cancel(dispatchId, 'user', '停');
    await assertRejects(() => h.service.ingestProgress(childId, { sequence: 2, summary: '应拒' }), 'WRITES_DISABLED');
  } finally { h.dispose(); }
});

test('takeover 后的宿主终写路径:目标拒绝(无所有权),结果按接管收尾', async () => {
  const h = await makeHarness();
  try {
    const { dispatchId } = await h.service.start(baseReq());
    const childId = h.service.status(dispatchId).runtime.childSessionId;
    h.runtime.emitRunStart(childId, 'run-1');
    await h.service.takeover(dispatchId, 'user', '人工接管');
    // 迟到的执行者报告 → 拒绝
    await assertRejects(() => h.service.ingestReport(childId, { outcome: 'done', summary: '迟' }), 'WRITES_REVOKED');
    h.runtime.emitRunEnd(childId, 'run-1', 'aborted');
    await sleep(1500);
    assert.equal(h.service.status(dispatchId).result.reasonCode, 'TAKEOVER_SUPERSEDED');
    // 目标侧 finalize:takeover 后无所有权 → 拒绝
    const f = await h.target.finalize({ dispatchId, operationId: `${dispatchId}:finalize`, outcome: 'done', summary: 's', finalEntryTitle: 't' });
    assert.equal(f.ok, false);
  } finally { h.dispose(); }
});

test('workspaceKey 不参与授权:不同 ws 的 child 无法伪造为目标派发写', async () => {
  const h = await makeHarness();
  try {
    await h.service.start(baseReq());
    // 任何不属于在册派发的 child 一律 403
    await assertRejects(() => h.service.ingestReport('dc_foreign', { outcome: 'done', summary: '伪造' }), 'UNAUTHORIZED_WORKER');
    const recs = h.service.list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].result, null, '伪造未影响记录');
  } finally { h.dispose(); }
});
