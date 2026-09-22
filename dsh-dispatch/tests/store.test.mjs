/** 存储层(T26):原子写/损坏只读/跨进程单写入者锁。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DispatchStore } from '../dist/store.js';
import { ServiceError } from '../dist/types.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dispatch-store-'));
}

test('原子写与 revision 递增,备份存在,重载后数据完整', async () => {
  const dir = tempDir();
  try {
    const s = new DispatchStore(dir);
    await s.init();
    for (let i = 0; i < 3; i++) {
      await s.mutate(() => {
        const root = s.snapshot();
        root.dispatches[`d_${i}`] = { id: `d_${i}`, marker: i };
      });
    }
    const raw = JSON.parse(readFileSync(join(dir, 'dispatch', 'dispatches.json'), 'utf8'));
    assert.equal(raw.revision, 4, 'init 一次 + 三次 mutate');
    assert.equal(Object.keys(raw.dispatches).length, 3);
    assert.ok(existsSync(join(dir, 'dispatch', 'dispatches.json.bak')), '有备份');
    s.dispose();

    const s2 = new DispatchStore(dir);
    await s2.init();
    assert.equal(Object.keys(s2.snapshot().dispatches).length, 3, '重载完整');
    assert.equal(s2.fault.readOnly, false);
    s2.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T26a:store 损坏 → 只读故障态,拒绝写入,不重建空 store', async () => {
  const dir = tempDir();
  try {
    const s = new DispatchStore(dir);
    await s.init();
    await s.mutate(() => {
      s.snapshot().dispatches.d_1 = { id: 'd_1' };
    });
    s.dispose();

    writeFileSync(join(dir, 'dispatch', 'dispatches.json'), '{corrupted!!!', 'utf8');
    const s2 = new DispatchStore(dir);
    await s2.init();
    assert.equal(s2.fault.readOnly, true, '只读故障态');
    await assert.rejects(
      () => s2.mutate(() => {}),
      (e) => e instanceof ServiceError && e.code === 'STORE_READONLY',
    );
    // 损坏原件被保留(.corrupt-*),没有新的干净 store 被建出来
    const kept = readFileSync(join(dir, 'dispatch', 'dispatches.json'), 'utf8');
    assert.match(kept, /corrupted/, '损坏内容原样保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T26b:存活他进程持锁 → 拒绝写模式;其退出后可接管', async () => {
  const dir = tempDir();
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => holder.once('spawn', r));
    mkdirSync(join(dir, 'dispatch'), { recursive: true });
    writeFileSync(join(dir, 'dispatch', 'writer.lock'), JSON.stringify({ pid: holder.pid, bootId: 'x', at: 1 }), 'utf8');
    writeFileSync(join(dir, 'dispatch', 'dispatches.json'), JSON.stringify({ schemaVersion: 2, revision: 0, dispatches: {}, idempotency: {} }), 'utf8');

    const s = new DispatchStore(dir);
    await s.init();
    assert.equal(s.fault.readOnly, true, '持锁者存活 → 拒绝写模式');
    await assert.rejects(() => s.mutate(() => {}), (e) => e.code === 'STORE_READONLY');

    holder.kill();
    await new Promise((r) => holder.once('exit', r));

    const s2 = new DispatchStore(dir);
    await s2.init();
    assert.equal(s2.fault.readOnly, false, '持锁者死亡 → 接管并正常写');
    await s2.mutate(() => { s2.snapshot().dispatches.d_ok = { id: 'd_ok' }; });
    s2.dispose();
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
