#!/usr/bin/env node
/**
 * e2e-p2.mjs — P2 双插件真机 E2E(3081 隔离实例):
 * 真实 trajectory 节点 → /dispatch/start(真实子代理)→ progress/report → 终态 →
 * 条件回写落盘(节点 status/台账/dispatchHistory),外加服务身份负向检查。
 */
const BASE = 'http://127.0.0.1:3081';
const RUN = String(Date.now().toString(36));
const WS = 'D:/software/AIApp/DSH-P0TEST/ws';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };

/* 1. 服务身份负向:无 token 的 dispatch-op 写路径被拒 */
{
  const res = await fetch(BASE + '/traj/dispatch-op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'claim', dispatchId: 'x', projectId: 'x', nodeId: 'x', childSessionId: 'x', expectedFingerprint: 'x' }),
  });
  check('无 token 的 claim 被 403 拒绝', res.status === 403);
}

/* 2. 种真实研究链:项目→绑定工作区→目标→假设→实验节点 */
const proj = await api('POST', '/traj/projects', { name: 'P2 双插件冒烟' });
const projectId = proj.project?.id ?? proj.id;
check('项目创建', !!projectId);

await api('PUT', `/traj/projects/${projectId}`, { bindWs: WS }); // 绑定走 PUT /:id;/active 只做 setActive
const goal = await api('POST', '/traj/goals', { projectId, text: 'RGBT 多模态检测提速' });
check('目标确立', !!(goal.goal?.id));

const hyp = await api('POST', '/traj/hypotheses', { projectId, text: '层级融合适应可提升 DVTOD' });
const hypothesisId = hyp.hypothesis?.id;
check('假设登记', !!hypothesisId);

const node = await api('POST', '/traj/nodes', {
  projectId,
  kind: 'experiment',
  title: '执行内核双插件冒烟',
  detail: '这是一次执行内核冒烟:不需要读取任何文件。请先用 dispatch_progress(sequence=1)说明你已开始,然后调用 dispatch_report(outcome=done,summary 一句话)。除此之外不要做任何事。',
  hypothesisId,
  tags: ['p2-smoke'],
});
const nodeId = node.node?.id ?? node.id;
check('节点登记', !!nodeId);
console.log(`    project=${projectId} node=${nodeId}`);

/* 3. 派发(真实子代理) */
const started = await api('POST', '/dispatch/start', {
  targetType: 'traj_node',
  projectId,
  nodeId,
  ws: WS,
  idempotencyKey: 'p2-e2e-' + RUN,
  model: 'glm/glm-5.3',
});
const dispatchId = started.dispatchId;
check('派发受理', !!dispatchId && started.phase !== 'finished');

/* 4. 轮询终态 */
let final = null;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const st = await api('GET', `/dispatch/status/${dispatchId}`);
  process.stdout.write(`    [${i}] ${st.phase}${st.result ? ` ${st.result.kind}/${st.result.reasonCode}` : ''}\n`);
  if (st.phase === 'finished') { final = st; break; }
}
check('到达终态', !!final);
if (final) {
  check('结果 done/RESULT_SUBMITTED', final.result?.kind === 'done' && final.result?.reasonCode === 'RESULT_SUBMITTED');
  check('报告关联 verified', final.report?.runAssociation === 'verified');
  await sleep(1500); // 自动回写落地
  const st2 = await api('GET', `/dispatch/status/${dispatchId}`);
  console.log(`    writeback=${st2.writeback.state} (attempts=${st2.writeback.attempts})`);
  check('回写 applied', st2.writeback.state === 'applied');
}

/* 5. 核对 trajectory 侧落盘:节点状态/台账/所有权历史 */
const file = await api('GET', `/traj/projects/${projectId}`);
const n = (file.nodes ?? []).find((x) => x.id === nodeId);
check('节点状态 → done', n?.status === 'done');
const entries = n?.entries ?? [];
console.log(`    entries: ${entries.map((e) => e.title.slice(0, 26)).join(' / ')}`);
check('台账含执行进度条目', entries.some((e) => e.title.includes('⚡派发#')));
check('台账含终局条目', entries.some((e) => e.title.includes('🏁派发终局')));
check('所有权已释放+回执在册', !n?.dispatchClaim && !!n?.dispatchHistory?.some((h) => h.receipt?.operationId === `${dispatchId}:finalize`));
const conclusion = entries.find((e) => e.title.includes('🏁'));
console.log(`    终局结论: ${conclusion?.data?.slice(0, 80)}`);

/* 6. 重复派发同节点被占(终写后节点空闲可再派;同幂等键重试返回原派发) */
const replay = await api('POST', '/dispatch/start', {
  targetType: 'traj_node', projectId, nodeId, ws: WS, idempotencyKey: 'p2-e2e-' + RUN, model: 'glm/glm-5.3',
});
check('幂等重试返回原派发', replay.dispatchId === dispatchId && replay.replay === true);

console.log(failed === 0 ? '\nP2 E2E PASS' : `\nP2 E2E FAIL(${failed})`);
process.exitCode = failed === 0 ? 0 : 1;
