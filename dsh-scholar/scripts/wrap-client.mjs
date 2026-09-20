// Wrap the tsdown-emitted client bundle into the web module-loader factory
// format the DSH shell consumes: window.__ModuleLoader__.load({id, factory}).
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 注册 id 必须与包名一致(加载器按包名找注册);从 package.json 动态读取,
// 避免改名后 wrap 仍写旧 id 导致 client 加载失败
const pkgId = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const srcDir = join(root, 'dist-client');
const outfile = join(root, 'dist/client.js');

const files = readdirSync(srcDir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));
if (files.length !== 1) {
  throw new Error(`expected exactly one client bundle in dist-client, got: ${files.join(', ')}`);
}
const body = readFileSync(join(srcDir, files[0]), 'utf8');

const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkgId)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  body,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n');

mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, wrapped);
unlinkSync(join(srcDir, files[0]));
console.log('client bundle wrapped:', outfile, `(${wrapped.length} bytes)`);
