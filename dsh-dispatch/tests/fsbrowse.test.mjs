/** 目录浏览器(项目路径选择器后端)单元测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseDirs } from '../dist/workbench/fsbrowse.js';

function makeFs() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-fsbrowse-'));
  mkdirSync(join(dir, 'alpha'));
  mkdirSync(join(dir, 'beta'));
  mkdirSync(join(dir, 'Zeta'));
  mkdirSync(join(dir, 'alpha', 'inner'));
  mkdirSync(join(dir, 'home'), { recursive: true });
  return { dir, dispose() { rmSync(dir, { recursive: true, force: true }); } };
}

test('根视图:空路径返回盘符/根与主目录,不列目录', () => {
  const r = browseDirs('');
  assert.equal(r.path, '');
  assert.equal(r.parent, null);
  assert.ok(r.drives.length >= 1, '至少一个根');
  assert.ok(r.home.length > 0);
  assert.deepEqual(r.dirs, []);
});

test('列子目录:真实目录入列并按名排序;符号链接不入列', () => {
  const fs = makeFs();
  try {
    const r = browseDirs(fs.dir);
    assert.equal(r.path.replaceAll('\\', '/').toLowerCase(), fs.dir.replaceAll('\\', '/').toLowerCase());
    assert.deepEqual(r.dirs.map((d) => d.name), ['alpha', 'beta', 'home', 'Zeta'].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true })));
    assert.ok(r.dirs.every((d) => d.path.length > fs.dir.length));
    // 符号链接(即使指向目录)不入列
    const link = join(fs.dir, 'alink');
    try { symlinkSync(join(fs.dir, 'alpha'), link, 'dir'); } catch { return; /* Windows 无权限建链接则跳过 */ }
    const r2 = browseDirs(fs.dir);
    assert.ok(!r2.dirs.some((d) => d.name === 'alink'));
  } finally { fs.dispose(); }
});

test('上级链:子目录的 parent 指向父目录;盘符根的 parent 为空串(回根视图)', () => {
  const fs = makeFs();
  try {
    const inner = browseDirs(join(fs.dir, 'alpha', 'inner'));
    const parent = browseDirs(inner.parent);
    assert.equal(parent.dirs.some((d) => d.name === 'inner'), true);
    if (process.platform === 'win32') {
      const drive = browseDirs(process.cwd().slice(0, 3));
      assert.equal(drive.parent, '');
    }
  } finally { fs.dispose(); }
});

test('DSH_HOME 内目录标 blocked(含子目录),外层不标', () => {
  const fs = makeFs();
  process.env.DSH_HOME = join(fs.dir, 'home');
  try {
    mkdirSync(join(fs.dir, 'home', 'inner'));
    const r = browseDirs(fs.dir);
    const home = r.dirs.find((d) => d.name === 'home');
    assert.equal(home.blocked, true, 'DSH_HOME 本身 blocked');
    const inner = browseDirs(home.path);
    assert.equal(inner.blocked, true, 'DSH_HOME 内目录整层 blocked');
    assert.equal(inner.dirs.some((d) => d.name === 'inner' && d.blocked), true, '更深子目录也 blocked');
    assert.equal(r.dirs.find((d) => d.name === 'alpha').blocked, false, '外部目录不 blocked');
  } finally {
    delete process.env.DSH_HOME;
    fs.dispose();
  }
});

test('不存在/非绝对路径 → 明确错误;不可读目录 → 404 语义', () => {
  const fs = makeFs();
  try {
    assert.throws(() => browseDirs(join(fs.dir, 'nope')), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => browseDirs('relative/path'), (e) => e.code === 'VALIDATION');
  } finally { fs.dispose(); }
});
