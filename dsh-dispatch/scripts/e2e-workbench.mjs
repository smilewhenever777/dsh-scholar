#!/usr/bin/env node
/** Real DSH host E2E; run against an isolated dispatch-only profile. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const base = process.env.DSH_E2E_BASE;
const ws = process.env.DSH_E2E_WS;
const receiptPath = process.env.DSH_E2E_RECEIPT;
if (!base || !ws || !receiptPath) throw new Error('Set DSH_E2E_BASE, DSH_E2E_WS and DSH_E2E_RECEIPT');
const endpoint = '/dispatch/workbench';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(method, path, body, expected = [200, 201, 202]) {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json', origin: base },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const json = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(json).slice(0, 400)}`);
  return { status: response.status, body: json };
}
function check(label, value) { if (!value) throw new Error(`FAIL ${label}`); console.log(`PASS ${label}`); }
async function taskDetail(id) { return (await request('GET', `${endpoint}/tasks/${id}`)).body; }
async function waitRun(id) {
  for (let i = 0; i < 90; i++) {
    await sleep(4000);
    const run = (await request('GET', `${endpoint}/runs/${id}`)).body;
    if (i % 5 === 0) console.log(`Run ${id.slice(0, 10)}: ${run.phase}/${run.result?.kind ?? '…'}`);
    if (run.phase === 'finished' && run.writeback.state !== 'pending') return run;
  }
  throw new Error(`Run ${id} timed out`);
}
async function events(id) {
  const all = [];
  let after = -1;
  for (let i = 0; i < 100; i++) {
    const page = (await request('GET', `${endpoint}/runs/${id}/events?after=${after}&limit=50`)).body;
    all.push(...page.events);
    after = page.nextCursor;
    if (!page.hasMore) return all;
  }
  throw new Error('event pagination did not end');
}

if (process.argv.includes('--post-restart')) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const detail = await taskDetail(receipt.taskId);
  check('重启后任务已验收', detail.task.status === 'done');
  check('重启后两次 Run 均保留', detail.runs.length === 2);
  const firstEvents = await events(receipt.firstRun);
  const secondEvents = await events(receipt.secondRun);
  check('重启后第一次会话记录可读取', firstEvents.length > 0);
  check('重启后第二次会话记录可读取', secondEvents.length > 0);
  console.log(JSON.stringify({ phase: 'post-restart', taskId: receipt.taskId, firstEvents: firstEvents.length, secondEvents: secondEvents.length }));
} else {

const marker = `WB-${Date.now().toString(36)}`;
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, 'workbench-fixture.txt'), `check=${marker}\n`, 'utf8');
const initial = (await request('GET', `${endpoint}/overview`)).body;
check('隔离实例无旧 trajectory 派发', initial.legacyCount === 0);
const project = (await request('POST', `${endpoint}/projects`, { title: `独立工作台 ${marker}`, root: ws })).body;
const agent = (await request('POST', `${endpoint}/agents`, { name: '验证分析员', model: 'glm/glm-5.3',
  instructions: '按任务要求使用受控工具。简短、准确，不编造文件内容。',
  toolAllow: ['dispatch_read_file', 'dispatch_list_dir', 'dispatch_write_report', 'dispatch_progress', 'dispatch_report'] })).body;
const task = (await request('POST', `${endpoint}/tasks`, { projectId: project.id, title: `读取并核验 ${marker}`,
  description: `读取工作区根目录的 workbench-fixture.txt，核对 check= 的值。用 dispatch_write_report 写 verify.md，包含值 ${marker} 和来源文件名。用 dispatch_progress 记录进度，然后用 dispatch_report 提交 done 结果，并在 evidence 中引用 verify.md。`,
  acceptanceCriteria: `报告文件写明 ${marker}，并引用 workbench-fixture.txt；执行结果附有报告证据。`, assigneeId: agent.id })).body;
check('任务创建与分派后仍待办', task.status === 'todo' && (await taskDetail(task.id)).runs.length === 0);
const conflict = await request('PATCH', `${endpoint}/tasks/${task.id}`, { expectedRevision: task.revision + 1, title: 'stale' }, [409]);
check('revision 冲突返回 409', conflict.status === 409);
const cross = await fetch(base + `${endpoint}/tasks/${task.id}/comments`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, body: JSON.stringify({ expectedRevision: task.revision, text: 'cross' }) });
check('跨源写入拒绝', cross.status === 403);
const first = (await request('POST', `${endpoint}/tasks/${task.id}/run`, { idempotencyKey: `${marker}-1` })).body;
const replay = (await request('POST', `${endpoint}/tasks/${task.id}/run`, { idempotencyKey: `${marker}-1` })).body;
check('重复点击同键只产生一个 Run', replay.dispatchId === first.dispatchId && replay.replay === true);
let run = await waitRun(first.dispatchId);
check('第一次 Run 正常完成并同步', run.result?.kind === 'done' && run.writeback.state === 'applied');
check('执行提示词未下发', run.source.promptText === undefined);
let detail = await taskDetail(task.id);
check('正常结束仅进入待验收', detail.task.status === 'in_review');
const firstEvents = await events(first.dispatchId);
check('第一次会话含 Agent 消息与工具调用', firstEvents.some((e) => e.kind === 'assistant') && firstEvents.some((e) => e.kind === 'tool_call'));
check('会话不含系统提示词或推理事件', firstEvents.every((e) => !['system', 'reasoning'].includes(e.kind)));
await request('POST', `${endpoint}/tasks/${task.id}/comments`, { expectedRevision: detail.task.revision, text: '首轮记录完整，先退回验证重跑。' });
detail = await taskDetail(task.id);
await request('POST', `${endpoint}/tasks/${task.id}/review`, { expectedRevision: detail.task.revision, decision: 'reject', comment: '验证退回与再次运行' });
detail = await taskDetail(task.id);
check('退回后变待办且保留首次 Run', detail.task.status === 'todo' && detail.runs.length === 1);
const second = (await request('POST', `${endpoint}/tasks/${task.id}/run`, { idempotencyKey: `${marker}-2` })).body;
run = await waitRun(second.dispatchId);
check('第二次 Run 正常完成并同步', run.result?.kind === 'done' && run.writeback.state === 'applied');
detail = await taskDetail(task.id);
check('第二次待验收且两次 Run 均保留', detail.task.status === 'in_review' && detail.runs.length === 2);
await request('POST', `${endpoint}/tasks/${task.id}/review`, { expectedRevision: detail.task.revision, decision: 'accept', comment: '验证通过' });
detail = await taskDetail(task.id);
check('人工接受后进入 done', detail.task.status === 'done');
const secondEvents = await events(second.dispatchId);
check('第二次会话记录可读取', secondEvents.length > 0);
const receipt = { marker, projectId: project.id, taskId: task.id, firstRun: first.dispatchId, secondRun: second.dispatchId,
  firstEvents: firstEvents.length, secondEvents: secondEvents.length, completedAt: new Date().toISOString() };
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
console.log('WORKBENCH E2E PASS', JSON.stringify(receipt));
}
