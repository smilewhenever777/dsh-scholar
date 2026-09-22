#!/usr/bin/env node
/**
 * e2e-p3.mjs — P3 最小真实研究任务闭环(3081 双插件真机):
 * 任务 A(附录 B):核对三份实验日志 → 对比报告文件 + 结构化 metrics 台账 + done 回写;
 *   其中 exp_c 为负结果——验证"负结果如实报告"。
 * 任务 B(错误分支):指向不存在的日志 → 期望 blocked(协议遵从,不编造)。
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:3081';
const WS = 'D:/software/AIApp/DSH-P0TEST-ws'; // 必须在 DSH_HOME 之外:workerfs 严禁读宿主 home
const RUN = String(Date.now().toString(36));
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------- 夹具:三份实验日志(c 为负结果) ---------- */
mkdirSync(join(WS, 'logs'), { recursive: true });
writeFileSync(join(WS, 'logs', 'exp_a.txt'),
  ['# exp_a: F330C-lite on DVTOD val', 'config: seed=42 bs=8 lr=1e-4', 'epoch 10 loss 0.412 mAP 0.612', 'epoch 20 loss 0.355 mAP 0.633', 'final mAP 0.641 (baseline 0.628, +1.3pp)'].join('\n'));
writeFileSync(join(WS, 'logs', 'exp_b.txt'),
  ['# exp_b: F330C-lite + 强增强 on DVTOD val', 'config: seed=7 bs=16 lr=2e-4', 'epoch 10 loss 0.433 mAP 0.608', 'epoch 20 loss 0.361 mAP 0.640', 'final mAP 0.652 (baseline 0.628, +2.4pp)'].join('\n'));
writeFileSync(join(WS, 'logs', 'exp_c.txt'),
  ['# exp_c: F330C-lite + 朴素早停 on DVTOD val', 'config: seed=42 bs=8 lr=5e-4', 'epoch 10 loss 0.401 mAP 0.598', 'epoch 20 loss 0.372 mAP 0.601', 'final mAP 0.601 (baseline 0.628, -2.7pp)'].join('\n'));
console.log('夹具:三份日志已写入(含 exp_c 负结果)');

/* ---------- 研究链装配 ---------- */
const proj = await api('POST', '/traj/projects', { name: `P3 闭环 ${RUN}` });
const projectId = proj.project?.id ?? proj.id;
await api('PUT', `/traj/projects/${projectId}`, { bindWs: WS }); // 绑定走 PUT /:id;/active 只做 setActive
await api('POST', '/traj/goals', { projectId, text: 'RGBT 多模态检测提速' });
const hyp = await api('POST', '/traj/hypotheses', { projectId, text: '轻量融合变体的收益区间' });

const nodeA = await api('POST', '/traj/nodes', {
  projectId, kind: 'experiment', hypothesisId: hyp.hypothesis?.id, tags: ['p3', '闭环'],
  title: '核对三份实验日志并生成指标对比报告',
  detail: [
    '核对工作区 logs/ 目录下的三份实验日志 exp_a.txt、exp_b.txt、exp_c.txt,生成指标对比报告。',
    '完成标准:三份日志逐一给出来源文件、配置标识(seed 等)与实际可读指标(mAP);缺失项明确列出;不要求任何方法优于基线,负结果必须如实报告。',
    '交付物:1) 用 dispatch_write_report 写一份 Markdown 对比报告;2) 用 dispatch_progress 提交至少一条带 metrics 的台账(每项 {name,value,baseline?,unit?});3) dispatch_report(done,summary 汇总对比结论,evidence 引用报告文件路径)。',
  ].join('\n'),
});

async function dispatchAndWait(nodeId, key, label) {
  const started = await api('POST', '/dispatch/start', {
    targetType: 'traj_node', projectId, nodeId, ws: WS, idempotencyKey: key, model: 'glm/glm-5.3',
  });
  console.log(`  [${label}] dispatch=${started.dispatchId}`);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const st = await api('GET', `/dispatch/status/${started.dispatchId}`);
    process.stdout.write(`    [${i}] ${st.phase}${st.result ? ` ${st.result.kind}/${st.result.reasonCode}` : ''}\n`);
    if (st.phase === 'finished') return st;
  }
  throw new Error(`${label} 超时未到终态`);
}

/* ---------- 任务 A:附录 B 闭环 ---------- */
console.log('任务 A:三日志对比(含负结果)');
const stA = await dispatchAndWait(nodeA.node?.id ?? nodeA.id, `p3-a-${RUN}`, 'A');
check('A 终态 done/RESULT_SUBMITTED', stA.result?.kind === 'done' && stA.result?.reasonCode === 'RESULT_SUBMITTED');
await sleep(1500);
const fullA = await api('GET', `/dispatch/status/${stA.id}`);
console.log(`  writeback=${fullA.writeback.state} attempts=${fullA.writeback.attempts}`);
check('A 回写 applied', fullA.writeback.state === 'applied');

// trajectory 侧:状态 done + 台账(含 metrics)+ 终局条目
const file = await api('GET', `/traj/projects/${projectId}`);
const nA = (file.nodes ?? []).find((x) => x.id === (nodeA.node?.id ?? nodeA.id));
check('A 节点状态 → done', nA?.status === 'done');
const entries = nA?.entries ?? [];
const withMetrics = entries.filter((e) => Array.isArray(e.metrics) && e.metrics.length > 0);
check('A 台账含结构化 metrics', withMetrics.length >= 1);
if (withMetrics[0]) console.log(`    metrics 示例: ${JSON.stringify(withMetrics[0].metrics.slice(0, 3))}`);
check('A 台账含终局条目', entries.some((e) => e.title.includes('🏁派发终局')));

// 报告文件:dispatch-reports/<dispatchId>/ 下存在 Markdown 且提及 exp_c(负结果如实)
const reportDir = join(WS, 'dispatch-reports', stA.id);
const files = existsSync(reportDir) ? readdirSync(reportDir) : [];
check('A 报告文件已落盘', files.length >= 1);
if (files[0]) {
  const content = readFileSync(join(reportDir, files[0]), 'utf8');
  console.log(`    报告: ${files[0]} (${content.length} 字符)`);
  check('A 报告覆盖三份日志', ['exp_a', 'exp_b', 'exp_c'].every((n) => content.includes(n)));
  check('A 负结果如实(报告含 exp_c 的 0.601)', content.includes('0.601'));
}

/* ---------- 任务 B:错误分支(blocked) ---------- */
console.log('任务 B:不可访问日志 → blocked');
const nodeB = await api('POST', '/traj/nodes', {
  projectId, kind: 'experiment', hypothesisId: hyp.hypothesis?.id, tags: ['p3', 'blocked'],
  title: '读取不存在的日志(协议遵从测试)',
  detail: [
    '读取工作区 logs/missing_run.log 并汇总其指标。',
    '完成标准:能读到则汇总;若日志不可访问,用 dispatch_report 以 outcome=blocked 如实报告并说明原因;严禁编造日志内容。',
  ].join('\n'),
});
const stB = await dispatchAndWait(nodeB.node?.id ?? nodeB.id, `p3-b-${RUN}`, 'B');
check('B 终态 blocked/TASK_BLOCKED', stB.result?.kind === 'blocked' && stB.result?.reasonCode === 'TASK_BLOCKED');
await sleep(1500);
const file2 = await api('GET', `/traj/projects/${projectId}`);
const nB = (file2.nodes ?? []).find((x) => x.id === (nodeB.node?.id ?? nodeB.id));
check('B 节点状态 → blocked(可重审)', nB?.status === 'blocked');
check('B 未编造报告文件', readdirSync(join(WS, 'dispatch-reports')).indexOf(stB.id) === -1);

console.log(failed === 0 ? '\nP3 E2E PASS' : `\nP3 E2E FAIL(${failed})`);
process.exitCode = failed === 0 ? 0 : 1;
