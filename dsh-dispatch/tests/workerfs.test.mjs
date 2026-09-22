/** 执行者受控文件面(P3):授权门控/路径穿越/符号链接/写入封闭/尺寸上限。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness, makeTask, baseReq, WS, assertRejects, sleep } from './util.mjs';
import { resolveInsideWs, validReportFilename } from '../dist/workerfs.js';

/** 真实文件系统夹具(独立于 mock 目标的 ws 逻辑路径,服务端 canonicalRoot 即用 WS 字符串)。 */
function makeWsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-ws-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'a.log'), 'epoch 10 loss 0.41 mAP 0.612\n');
  writeFileSync(join(dir, 'logs', 'b.log'), 'epoch 10 loss 0.39 mAP 0.628\n');
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
  // 越界符号链接目标
  const outside = mkdtempSync(join(tmpdir(), 'dispatch-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
  try {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'), 'file');
  } catch { /* Windows 无符号链接权限时跳过该夹具 */ }
  return { dir, outside };
}

async function started(h, wsPath, key) {
  const { dispatchId } = await h.service.start(baseReq({ ws: wsPath, idempotencyKey: key }));
  const childId = h.service.status(dispatchId).runtime.childSessionId;
  h.runtime.emitRunStart(childId, 'run-1');
  await sleep(40);
  return { dispatchId, childId };
}

test('纯函数:resolveInsideWs 拒绝穿越与越界,接受工作区内', () => {
  const ws = 'D:/lab/ws';
  const norm = (p) => (p === null ? null : p.split('\\').join('/'));
  assert.equal(norm(resolveInsideWs(ws, 'logs/a.log')), 'D:/lab/ws/logs/a.log');
  assert.equal(norm(resolveInsideWs(ws, 'D:/lab/ws/x.txt')), 'D:/lab/ws/x.txt');
  assert.equal(resolveInsideWs(ws, '../escape.txt'), null);
  assert.equal(resolveInsideWs(ws, 'D:/lab/ws-evil/x.txt'), null);
  assert.equal(resolveInsideWs(ws, ''), null);
  assert.ok(validReportFilename('report.md'));
  assert.ok(!validReportFilename('../evil'));
  assert.ok(!validReportFilename('a/b.txt'));
  assert.ok(!validReportFilename('..'));
});

test('授权门控:陌生 child 403;报告后封闭;取消后封闭', async () => {
  const h = await makeHarness();
  const f = makeWsFixture();
  try {
    await assertRejects(() => h.service.workerReadFile('dc_unknown', 'logs/a.log'), 'UNAUTHORIZED_WORKER');
    await assertRejects(() => h.service.workerWriteReport('dc_unknown', 'r.md', 'x'), 'UNAUTHORIZED_WORKER');

    const { childId } = await started(h, f.dir, 'wf-auth');
    const r = await h.service.workerReadFile(childId, 'logs/a.log');
    assert.equal(r.ok, true);
    assert.match(r.content, /mAP 0\.612/);

    await h.service.ingestReport(childId, { outcome: 'done', summary: '完成' });
    await assertRejects(() => h.service.workerReadFile(childId, 'logs/b.log'), 'WRITES_DISABLED');
    await assertRejects(() => h.service.workerWriteReport(childId, 'r.md', 'x'), 'WRITES_DISABLED');
  } finally { h.dispose(); }
});

test('路径与实路径:穿越拒绝;符号链接逃逸拒绝;尺寸截断', async () => {
  const h = await makeHarness();
  const f = makeWsFixture();
  try {
    const { childId } = await started(h, f.dir, 'wf-path');
    const esc = await h.service.workerReadFile(childId, '../' + f.outside.split(/[\\/]/).pop() + '/secret.txt');
    assert.equal(esc.ok, false);
    const outsideAbs = await h.service.workerReadFile(childId, join(f.outside, 'secret.txt'));
    assert.equal(outsideAbs.ok, false, '绝对路径越界拒绝');

    if (existsSync(join(f.dir, 'leak.txt'))) {
      const leak = await h.service.workerReadFile(childId, 'leak.txt');
      assert.equal(leak.ok, false, '符号链接逃逸拒绝(realpath 校验)');
    } else {
      console.log('    (跳过符号链接用例:环境无创建权限)');
    }

    const big = await h.service.workerReadFile(childId, 'big.txt');
    assert.equal(big.ok, true);
    assert.equal(big.truncated, true, '超 1MB 截断');
    assert.equal(big.content.length, 1024 * 1024);
  } finally { h.dispose(); }
});

test('报告写入封闭:只进 dispatch-reports/<dispatchId>/,文件名白名单,内容上限', async () => {
  const h = await makeHarness();
  const f = makeWsFixture();
  try {
    const { dispatchId, childId } = await started(h, f.dir, 'wf-write');
    const bad1 = await h.service.workerWriteReport(childId, '../evil.md', 'x');
    assert.equal(bad1.ok, false);
    const bad2 = await h.service.workerWriteReport(childId, 'a/b.md', 'x');
    assert.equal(bad2.ok, false);
    const bad3 = await h.service.workerWriteReport(childId, 'r.md', 'x'.repeat(3 * 1024 * 1024));
    assert.equal(bad3.ok, false, '内容超限拒绝');

    const ok = await h.service.workerWriteReport(childId, 'comparison-report.md', '# 对比报告\n\n结论:负结果如实。');
    assert.equal(ok.ok, true);
    const expectPath = join(f.dir, 'dispatch-reports', dispatchId, 'comparison-report.md');
    // canonicalRoot 为小写规范形:按小写比较
    assert.equal(
      ok.path.split('\\').join('/').toLowerCase(),
      expectPath.split('\\').join('/').toLowerCase(),
    );
    assert.ok(existsSync(expectPath), '文件落盘');
    assert.match(readFileSync(expectPath, 'utf8'), /对比报告/);
    // 工作区其他位置不可写(无入口);源文件未被改动
    assert.match(readFileSync(join(f.dir, 'logs', 'a.log'), 'utf8'), /mAP/);
  } finally { h.dispose(); }
});

test('DSH_HOME 不可读(ws 内嵌 home 的极端情形)', async () => {
  const h = await makeHarness();
  const f = makeWsFixture();
  const prevHome = process.env.DSH_HOME;
  try {
    // 把 DSH_HOME 指到 ws 内部:即使这样,home 内文件也应被拒读
    process.env.DSH_HOME = join(f.dir, 'logs');
    const { childId } = await started(h, f.dir, 'wf-home');
    const r = await h.service.workerReadFile(childId, 'logs/a.log');
    assert.equal(r.ok, false, 'DSH_HOME 内文件不可读');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    h.dispose();
  }
});

test('metrics 贯通:progress 的结构化指标落到目标台账', async () => {
  const h = await makeHarness({ task: makeTask() });
  try {
    const { childId } = await started(h, WS, 'wf-metrics');
    await h.service.ingestProgress(childId, {
      sequence: 1,
      summary: 'exp_a 读取完成',
      metrics: [{ name: 'exp_a mAP', value: 0.612, baseline: 0.628, unit: '' }],
    });
    // 内存目标:metrics 在 payload 里;trajectory 侧在 TrajEntry.metrics(由 E2E 验证)
    assert.equal(h.target.entriesOf('p1', 'n1'), 1);
  } finally { h.dispose(); }
});
