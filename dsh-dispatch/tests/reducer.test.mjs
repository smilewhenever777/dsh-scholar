/** 纯 reducer 状态机与终态决策表(T05/T13/T14/T16/T27 等)。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceDispatch } from '../dist/reducer.js';

function base() {
  return {
    schemaVersion: 2,
    revision: 0,
    id: 'd_test',
    request: { actorScope: 'local', idempotencyKey: 'k', payloadHash: 'h' },
    targetType: 'traj_node',
    targetRef: { projectId: 'p1', nodeId: 'n1', workspaceId: 'ws', canonicalRoot: 'ws' },
    source: { taskFingerprint: 'fp', snapshot: { source: 'memory', projectId: 'p1', nodeId: 'n1', nodeTitle: 't' }, protocolVersion: 'v' },
    runtime: { sponsorSessionId: 's', childSessionId: 'c1', observedRuns: [], quiescence: 'unconfirmed' },
    ownership: { state: 'owned', epoch: 1, workerWrites: 'enabled' },
    reservation: { targetHeld: true, workspaceHeld: true, executionSlotHeld: true },
    startIntent: { mayHaveExecuted: true, persistedAt: 1 },
    phase: 'preparing',
    writeback: { operationId: 'op', state: 'not_ready', attempts: 0 },
    createdAt: 1,
    limits: { maxWallMs: 1 },
    effectiveConfig: { provider: 'spawn', modelProvider: 'glm', model: 'glm-5.3', toolPolicyVersion: 'p1' },
    audit: [],
  };
}

const EV = {
  claimOk: (at = 10) => ({ type: 'claim-ok', at, epoch: 7, taskFingerprint: 'fp' }),
  intent: (at = 11) => ({ type: 'start-intent', at }),
  accepted: (at = 12) => ({ type: 'start-accepted', at, childId: 'c1', messageId: 'm1' }),
  runStart: (at = 13, runId = 'r1') => ({ type: 'run-started', at, runId }),
  runEnd: (at = 20, runId = 'r1', stopReason = 'completed') => ({ type: 'run-ended', at, runId, stopReason }),
  report: (at = 15, outcome = 'done') => ({
    type: 'report',
    at,
    fromChild: 'c1',
    report: {
      hash: `hash-${outcome}`,
      submittedByChildSessionId: 'c1',
      runAssociation: 'verified',
      outcome,
      summary: 's',
      evidence: [],
      receivedAt: at,
    },
  }),
  cancel: (at = 16) => ({ type: 'cancel-requested', at, by: 'user', reason: 'r' }),
  quiesce: (at = 30, evidence = 'drain-ok', operator = false) => ({ type: 'quiescence-confirmed', at, evidence, operator }),
  takeover: (at = 17) => ({ type: 'takeover', at, actor: 'user', reason: 'r' }),
};

function to(d, ...evs) {
  let cur = d;
  for (const e of evs) cur = reduceDispatch(cur, e);
  return cur;
}

test('正常 done 全链:claim→intent→accepted→run→report→end→finish', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(), EV.runEnd());
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.kind, 'done');
  assert.equal(d.result.reasonCode, 'RESULT_SUBMITTED');
  assert.equal(d.reservation.targetHeld, false);
  assert.equal(d.reservation.executionSlotHeld, false);
  assert.equal(d.ownership.state, 'released');
  assert.equal(d.ownership.workerWrites, 'disabled');
  assert.ok(d.report);
});

test('T05:start 事件先于接受回执 → running 不被回执倒退', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.runStart(12), EV.accepted(13));
  assert.equal(d.phase, 'running');
  assert.equal(d.runtime.messageId, 'm1');
});

test('T14:正常结束无报告 → failed/REPORT_MISSING', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.runEnd());
  assert.equal(d.result.reasonCode, 'REPORT_MISSING');
  assert.equal(d.result.kind, 'failed');
});

test('T13:report(done) 后运行异常 → failed 保留报告,不错误成功', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(15, 'done'), EV.runEnd(20, 'r1', 'error'));
  assert.equal(d.result.kind, 'failed');
  assert.equal(d.result.reasonCode, 'RUN_ERROR');
  assert.ok(d.report, '报告保留');
});

test('T27:未知 stopReason → 异常分支;max-tokens/refusal 各归因', () => {
  const mk = (reason) => to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(), EV.runEnd(20, 'r1', reason));
  assert.equal(mk('weird-new-reason').result.reasonCode, 'RUN_UNKNOWN_STOP');
  assert.equal(mk('max-tokens').result.reasonCode, 'RUN_MAX_TOKENS');
  assert.equal(mk('refusal').result.reasonCode, 'RUN_REFUSAL');
  assert.equal(mk('error').result.reasonCode, 'RUN_ERROR');
});

test('blocked / failed 报告归因', () => {
  const b = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(15, 'blocked'), EV.runEnd());
  assert.deepEqual([b.result.kind, b.result.reasonCode], ['blocked', 'TASK_BLOCKED']);
  const f = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(15, 'failed'), EV.runEnd());
  assert.deepEqual([f.result.kind, f.result.reasonCode], ['failed', 'TASK_FAILED']);
});

test('T16a:完成先持久化,取消迟到 → 结果保留,取消记为过晚', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(), EV.runEnd(), EV.cancel(40));
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.kind, 'done');
  assert.ok(d.audit.some((a) => a.type === 'cancel-too-late'));
  assert.equal(d.cancel, undefined);
});

test('T16b:取消先生效,done 迟到 → 部分提交,静止后 aborted', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.cancel(16), EV.report(17, 'done'), EV.runEnd(20), EV.quiesce(30));
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.kind, 'aborted');
  assert.equal(d.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
  assert.equal(d.report.supersededByCancel, true);
});

test('取消路径:queued 取消(未运行)→ 静止即收尾,不恢复执行授权', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.cancel(), EV.quiesce());
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
});

test('aborted 结束(无取消)→ 静止后 ABORTED_STOPPED', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.runEnd(20, 'r1', 'aborted'), EV.quiesce(30));
  assert.equal(d.result.reasonCode, 'ABORTED_STOPPED');
  assert.equal(d.result.kind, 'aborted');
});

test('取消中运行报错 → failed 保留,不用取消掩盖错误', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.cancel(), EV.runEnd(20, 'r1', 'error'), EV.quiesce());
  assert.equal(d.result.kind, 'failed');
  assert.equal(d.result.reasonCode, 'RUN_ERROR');
});

test('接管:撤销所有权与写权限,静止后 TAKEOVER_SUPERSEDED,迟到报告只隔离', () => {
  let d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.takeover());
  assert.equal(d.ownership.state, 'revoked');
  assert.equal(d.ownership.workerWrites, 'revoked');
  d = reduceDispatch(d, EV.report(18, 'done'));
  assert.equal(d.report, undefined, '迟到报告不进入决策');
  assert.ok(d.audit.some((a) => a.type === 'late-report-quarantined'));
  d = to(d, EV.quiesce(30));
  assert.equal(d.result.reasonCode, 'TAKEOVER_SUPERSEDED');
});

test('预算超限 → 取消语义;终局按停止证据', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), { type: 'budget-exceeded', at: 18, kind: 'wall-clock' }, EV.runEnd(20, 'r1', 'aborted'), EV.quiesce(30));
  assert.equal(d.result.kind, 'aborted');
  assert.ok(d.cancel.reason.startsWith('BUDGET_EXCEEDED'));
});

test('claim-conflict → failed 终态并释放占用', () => {
  const d = to(base(), { type: 'claim-conflict', at: 9, detail: '节点被占' });
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.reasonCode, 'CLAIM_CONFLICT');
  assert.equal(d.reservation.targetHeld, false);
});

test('start-rejected(P0:拒绝即完整回滚)→ START_REJECTED', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), { type: 'start-rejected', at: 12, detail: 'boom' });
  assert.equal(d.result.reasonCode, 'START_REJECTED');
  assert.equal(d.reservation.executionSlotHeld, false);
});

test('报告幂等:同哈希重发不变,不同哈希不覆盖', () => {
  let d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(15, 'done'));
  const rev = d.revision;
  d = reduceDispatch(d, EV.report(16, 'done'));
  assert.equal(d.revision, rev + 1, '仍产生一次归约(审计)');
  assert.equal(d.report.receivedAt, 15, '原报告保留');
  d = reduceDispatch(d, EV.report(17, 'failed'));
  assert.equal(d.report.outcome, 'done', '不同内容不覆盖');
});

test('reconciling 不清除取消/报告/终止事实', () => {
  let d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.cancel());
  d = reduceDispatch(d, { type: 'reconcile-unresolved', at: 25, detail: 'x' });
  assert.equal(d.phase, 'reconciling');
  assert.ok(d.cancel, '取消事实保留');
  assert.equal(d.lastKnownPhase, 'cancelling');
  d = to(d, EV.quiesce(30));
  assert.equal(d.result.reasonCode, 'CANCELLED_BEFORE_FINALIZATION');
});

test('T15:终局后的新执行周期只记录不改动结果', () => {
  let d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.runStart(), EV.report(), EV.runEnd());
  const resultBefore = d.result;
  d = reduceDispatch(d, EV.runStart(50, 'r2'));
  d = reduceDispatch(d, EV.runEnd(60, 'r2', 'completed'));
  assert.deepEqual(d.result, resultBefore);
  assert.equal(d.runtime.observedRuns.length, 2);
});

test('T12:缺 start 的 end 按已知身份记录,仍可结算', () => {
  const d = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.report(), EV.runEnd(20, 'r9'));
  assert.equal(d.phase, 'finished');
  assert.equal(d.result.reasonCode, 'RESULT_SUBMITTED');
  assert.ok(d.audit.some((a) => a.type === 'end-without-start'));
});

test('操作员确认静止:有报告按申报结果收尾,无报告 REPORT_MISSING', () => {
  const withReport = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.report(15, 'blocked'), EV.quiesce(30, 'operator:x', true));
  assert.equal(withReport.result.reasonCode, 'TASK_BLOCKED');
  const noReport = to(base(), EV.claimOk(), EV.intent(), EV.accepted(), EV.quiesce(30, 'operator:x', true));
  assert.equal(noReport.result.reasonCode, 'REPORT_MISSING');
});
