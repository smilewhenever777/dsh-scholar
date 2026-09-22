/** 待回写与补偿(§5.6):T19/T20/T21/T22 的服务级验证。
 *  注意:finish 会立即异步触发自动回写——需要"终态后人工介入"类用例时,
 *  用 blockAuto 让首次 finalize 失败,再执行人工动作后 drain,保证确定性。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, baseReq, sleep } from './util.mjs';

/** 走完一条 done 链;blockAuto=true 时,终态前的自动回写会被故障注入拦截(error 态)。 */
async function doneChain(h, key, { blockAuto = false } = {}) {
  const { dispatchId } = await h.service.start(baseReq({ idempotencyKey: key }));
  const childId = h.service.status(dispatchId).runtime.childSessionId;
  h.runtime.emitRunStart(childId, 'run-1');
  await sleep(40);
  await h.service.ingestProgress(childId, { sequence: 1, summary: '步骤' });
  await h.service.ingestReport(childId, { outcome: 'done', summary: '完成' });
  if (blockAuto) h.target.failNextFinalize = 'auto-block';
  h.runtime.emitRunEnd(childId, 'run-1', 'completed');
  await sleep(120);
  assert.equal(h.service.status(dispatchId).phase, 'finished');
  return dispatchId;
}

test('正常回写:finish 挂起回写 → finalize applied;结论落盘、claim 释放', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-ok');
    await h.service.drainWritebacks();
    const rec = h.service.status(id);
    assert.equal(rec.writeback.state, 'applied');
    assert.equal(h.target.entriesOf('p1', 'n1'), 2, '一条 progress + 一条终局');
    assert.equal(h.target.conclusionOf('p1', 'n1').outcome, 'done');
    assert.equal(h.target.ownerOf('p1', 'n1'), null, 'finalize 释放所有权');
  } finally { h.dispose(); }
});

test('T21:回执语义——重复 drain 不重复台账', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-t21');
    await h.service.drainWritebacks();
    await h.service.drainWritebacks();
    await h.service.drainWritebacks();
    assert.equal(h.target.entriesOf('p1', 'n1'), 2, '终局台账只追加一次');
  } finally { h.dispose(); }
});

test('T22:回写暂时失败 → error 可补偿,不重跑模型', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-t22', { blockAuto: true });
    assert.equal(h.service.status(id).writeback.state, 'error');
    await h.service.drainWritebacks();
    assert.equal(h.service.status(id).writeback.state, 'applied');
    assert.equal(h.runtime.calls.filter((c) => c.op === 'startContinuable').length, 1, '不重跑模型');
  } finally { h.dispose(); }
});

test('T19:终态后人工改任务 → skipped_superseded,不覆盖人工内容', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-t19', { blockAuto: true });
    h.target.humanEdit('p1', 'n1', { nodeTitle: '人工改过的标题' });
    await h.service.drainWritebacks();
    assert.equal(h.service.status(id).writeback.state, 'skipped_superseded');
    assert.equal(h.target.conclusionOf('p1', 'n1'), undefined, '终局结论未写入');
    assert.equal(h.target.entriesOf('p1', 'n1'), 1, '只有执行者自己的 progress 台账');
  } finally { h.dispose(); }
});

test('T20:节点删除 → skipped_deleted,不重建节点', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-t20', { blockAuto: true });
    h.target.removeNode('p1', 'n1');
    await h.service.drainWritebacks();
    assert.equal(h.service.status(id).writeback.state, 'skipped_deleted');
  } finally { h.dispose(); }
});

test('对账通道补偿 pending/error(§5.6)', async () => {
  const h = await makeHarness();
  try {
    const id = await doneChain(h, 'wb-rc', { blockAuto: true });
    assert.equal(h.service.status(id).writeback.state, 'error');
    const r = await h.service.reconcileOnce();
    assert.ok(r.notes.some((n) => n.includes('回写补偿')));
    assert.equal(h.service.status(id).writeback.state, 'applied');
  } finally { h.dispose(); }
});
