/** P2 派发四动作单元测试(直接驱动 TrajStore;HTTP 层由 3081 E2E 覆盖)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajStore } from '../dist/store.js';

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'traj-dispatchop-'));
  const store = new TrajStore(dir);
  await store.init();
  const { project } = await store.createProject({ name: '测试项目' });
  await store.setGoal(project.id, 'RGBT 检测提速');
  const hyp = await store.addHypothesis(project.id, { text: '层级融合假设' });
  const node = await store.addNode({
    projectId: project.id,
    title: '比对实验',
    kind: 'experiment',
    detail: '核对日志',
    hypothesisId: hyp.id,
  });
  return { store, dir, project, hyp, node };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('read 返回指纹;claim 幂等/占用/指纹校验', async () => {
  const h = await freshStore();
  try {
    const read = h.store.dispatchRead(h.project.id, h.node.id);
    assert.ok(read?.fingerprint.length === 64);
    assert.equal(read.goal.version, 1);

    const c1 = await h.store.dispatchClaim({
      dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c1.ok, true);
    assert.equal(c1.epoch, 1);

    // T07 幂等重领 → 原 epoch
    const c2 = await h.store.dispatchClaim({
      dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c2.ok, true);
    assert.equal(c2.epoch, c1.epoch);

    // 他派发 → NODE_OCCUPIED
    const c3 = await h.store.dispatchClaim({
      dispatchId: 'd2', childSessionId: 'c2', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c3.ok, false);
    assert.equal(c3.code, 'NODE_OCCUPIED');

    // takeover 废的是旧 claim 不是任务语义:同指纹的新派发可领,epoch 递增
    await h.store.dispatchRevoke({ dispatchId: 'd1', mode: 'takeover' });
    const c4 = await h.store.dispatchClaim({
      dispatchId: 'd3', childSessionId: 'c3', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c4.ok, true);
    assert.equal(c4.epoch, 2, '接管后新派发领取,代次递增');
    // 旧派发 d1 重领:节点被 d3 占用 → NODE_OCCUPIED(占用检查先于历史检查)
    const c5 = await h.store.dispatchClaim({
      dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c5.ok, false);
    assert.equal(c5.code, 'NODE_OCCUPIED');
    // d3 终写释放后,d1 再领 → SUPERSEDED(历史在册,不允许旧派发复活)
    await h.store.dispatchFinalize({ dispatchId: 'd3', projectId: h.project.id, nodeId: h.node.id, operationId: 'd3:finalize', outcome: 'done', summary: 's', reasonCode: 'R' });
    const c6 = await h.store.dispatchClaim({
      dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id,
      expectedFingerprint: read.fingerprint,
    });
    assert.equal(c6.ok, false);
    assert.equal(c6.code, 'SUPERSEDED');
  } finally { cleanup(h.dir); }
});

test('progress:operationId 幂等;worker_only 封闭后拒绝', async () => {
  const h = await freshStore();
  try {
    const read = h.store.dispatchRead(h.project.id, h.node.id);
    await h.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id, expectedFingerprint: read.fingerprint });
    const p1 = await h.store.dispatchProgress({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:progress:1', sequence: 1, title: '第一步', payload: { x: 1 } });
    assert.equal(p1.ok, true);
    const p2 = await h.store.dispatchProgress({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:progress:1', sequence: 1, title: '第一步', payload: { x: 1 } });
    assert.equal(p2.ok, true, '同内容重放幂等');
    const p3 = await h.store.dispatchProgress({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:progress:1', sequence: 1, title: '改口', payload: { x: 2 } });
    assert.equal(p3.ok, false);
    assert.equal(p3.code, 'CONFLICT');

    await h.store.dispatchRevoke({ dispatchId: 'd1', mode: 'worker_only' });
    const p4 = await h.store.dispatchProgress({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:progress:2', sequence: 2, title: '迟到' });
    assert.equal(p4.ok, false);
    assert.equal(p4.code, 'WRITES_DISABLED');
    // claim 仍在(宿主收尾用):finalize 仍可进行
    const f = await h.store.dispatchFinalize({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:finalize', outcome: 'done', summary: '完成', reasonCode: 'RESULT_SUBMITTED' });
    assert.equal(f.ok, true);
  } finally { cleanup(h.dir); }
});

test('finalize:T21 幂等原回执;done→done;failed→blocked;aborted 不改状态', async () => {
  for (const [outcome, expectStatus] of [['done', 'done'], ['failed', 'blocked'], ['blocked', 'blocked'], ['aborted', null]]) {
    const h = await freshStore();
    try {
      const read = h.store.dispatchRead(h.project.id, h.node.id);
      const before = h.node.status;
      await h.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id, expectedFingerprint: read.fingerprint });
      const f1 = await h.store.dispatchFinalize({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:finalize', outcome, summary: 's', reasonCode: 'R' });
      assert.equal(f1.ok, true);
      const f2 = await h.store.dispatchFinalize({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:finalize', outcome, summary: 's', reasonCode: 'R' });
      assert.equal(f2.ok, true);
      assert.equal(f2.receipt.appliedAt, f1.receipt.appliedAt, '原回执');
      const after = h.store.dispatchRead(h.project.id, h.node.id);
      assert.equal(after.node.status, expectStatus ?? before, `outcome=${outcome} 状态映射`);
      assert.equal(after.entriesCount, 1, '终局台账恰好一条(重试不重复)');
      // 已释放:再次 claim 同派发 → SUPERSEDED
      const c = await h.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id, expectedFingerprint: after.fingerprint });
      assert.equal(c.ok ? 'ok' : c.code, 'SUPERSEDED');
    } finally { cleanup(h.dir); }
  }
});

test('人工编辑撤销所有权(即使只改 status);台账追加不撤;改绑工作区撤全项目', async () => {
  const h = await freshStore();
  try {
    const read = h.store.dispatchRead(h.project.id, h.node.id);
    await h.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id, expectedFingerprint: read.fingerprint });

    // 人工只改 status → 撤权(§5.5:状态编辑即使不改指纹也令旧 claim 失效)
    await h.store.updateNode(h.node.id, { status: 'in_progress' });
    const f1 = await h.store.dispatchFinalize({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:finalize', outcome: 'done', summary: 's', reasonCode: 'R' });
    assert.equal(f1.ok, false);
    assert.equal(f1.code, 'SUPERSEDED', '人工编辑后宿主终写被拒');
  } finally { cleanup(h.dir); }

  const h2 = await freshStore();
  try {
    const read = h2.store.dispatchRead(h2.project.id, h2.node.id);
    await h2.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h2.project.id, nodeId: h2.node.id, expectedFingerprint: read.fingerprint });
    // 台账追加(执行产物路径)不撤所有权
    await h2.store.dispatchProgress({ dispatchId: 'd1', projectId: h2.project.id, nodeId: h2.node.id, operationId: 'd1:progress:1', sequence: 1, title: '进度' });
    const read2 = h2.store.dispatchRead(h2.project.id, h2.node.id);
    await h2.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h2.project.id, nodeId: h2.node.id, expectedFingerprint: read2.fingerprint });
    // 改绑工作区 → 撤全项目
    await h2.store.bindWorkspace(h2.project.id, 'D:/lab/other-ws');
    const f = await h2.store.dispatchFinalize({ dispatchId: 'd1', projectId: h2.project.id, nodeId: h2.node.id, operationId: 'd1:finalize', outcome: 'done', summary: 's', reasonCode: 'R' });
    assert.equal(f.ok, false);
    assert.equal(f.code, 'SUPERSEDED');
  } finally { cleanup(h2.dir); }
});

test('节点删除 → finalize NOT_FOUND(派发侧记 skipped_deleted,不重建节点)', async () => {
  const h = await freshStore();
  try {
    const read = h.store.dispatchRead(h.project.id, h.node.id);
    await h.store.dispatchClaim({ dispatchId: 'd1', childSessionId: 'c1', projectId: h.project.id, nodeId: h.node.id, expectedFingerprint: read.fingerprint });
    await h.store.removeNode(h.node.id);
    const f = await h.store.dispatchFinalize({ dispatchId: 'd1', projectId: h.project.id, nodeId: h.node.id, operationId: 'd1:finalize', outcome: 'done', summary: 's', reasonCode: 'R' });
    assert.equal(f.ok, false);
    assert.equal(f.code, 'NOT_FOUND');
  } finally { cleanup(h.dir); }
});
