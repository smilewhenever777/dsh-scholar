#!/usr/bin/env node
/**
 * smoke-test.mjs — 无 LLM 冒烟(仓库 tests/run.mjs 编排风格)。
 * 两条链:正常 done 收尾 + 运行中取消静止收尾;断言占用释放与终态归因。
 */
import { makeHarness, baseReq, sleep } from '../tests/util.mjs';

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed++;
}

const h = await makeHarness();
try {
  /* 链 1:正常 done */
  const { dispatchId: d1 } = await h.service.start(baseReq({ idempotencyKey: 'smoke-1' }));
  const c1 = h.service.status(d1).runtime.childSessionId;
  h.runtime.emitRunStart(c1, 'run-1');
  await sleep(50);
  await h.service.ingestProgress(c1, { sequence: 1, summary: '步骤一' });
  await h.service.ingestReport(c1, { outcome: 'done', summary: '冒烟完成' });
  h.runtime.emitRunEnd(c1, 'run-1', 'completed');
  await sleep(80);
  const f1 = h.service.status(d1);
  check('done 链:finished/RESULT_SUBMITTED', f1.phase === 'finished' && f1.result.reasonCode === 'RESULT_SUBMITTED');
  check('done 链:占用全释放', !f1.reservation.targetHeld && !f1.reservation.workspaceHeld && !f1.reservation.executionSlotHeld);

  /* 链 2:运行中取消 → 静止收尾 */
  const { dispatchId: d2 } = await h.service.start(baseReq({ idempotencyKey: 'smoke-2' }));
  const c2 = h.service.status(d2).runtime.childSessionId;
  h.runtime.emitRunStart(c2, 'run-2');
  await sleep(50);
  await h.service.cancel(d2, 'smoke', '冒烟取消');
  h.runtime.emitRunEnd(c2, 'run-2', 'aborted');
  await sleep(1600);
  const f2 = h.service.status(d2);
  check('取消链:finished/CANCELLED_BEFORE_FINALIZATION', f2.phase === 'finished' && f2.result.reasonCode === 'CANCELLED_BEFORE_FINALIZATION');
  check('取消链:中断与 drain 都发出', h.runtime.calls.some((c) => c.op === 'interruptByParent') && h.runtime.calls.some((c) => c.op === 'drain'));

  /* 幂等重试 */
  const replay = await h.service.start(baseReq({ idempotencyKey: 'smoke-1' }));
  check('幂等:smoke-1 重试返回原派发', replay.replay === true && replay.dispatchId === d1);

  console.log(failed === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL(${failed})`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  h.dispose();
}
