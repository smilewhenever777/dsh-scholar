// Publication checks inspect Git candidates and npm manifests, never local vaults.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.DSH_TEST_OUTPUT ?? resolve(root, '.verify', 'release'));
await mkdir(out, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
const published = new Set(files), issues = [], packages = [];
const rules = [
 ['private-key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
 ['api-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16})\b/g],
 ['bearer-token', /Bearer\s+[A-Za-z0-9_.-]{32,}/g],
 ['login-url-token', /[?&]token=[A-Za-z0-9_.-]{24,}/g],
 ['credential-url', /https?:\/\/[^\s/:]+:[^\s/@]+@/g],
 ['personal-absolute-path', /[A-Z]:[\\/]Users[\\/](?!Public\b|<)[A-Za-z0-9_.-]+[\\/]/gi],
];
const inspect = (file, source) => {
 for (const [rule, re] of rules) {
  re.lastIndex = 0;
  for (const match of source.matchAll(re)) issues.push({ file, rule, line: source.slice(0, match.index).split('\n').length });
 }
};
for (const file of files) {
 if (/(?:^|\/)(?:node_modules|\.verify|dist-client|\.credentials|settings\.yaml|server\.log|\.env)(?:\/|\.|$)|\.(?:tgz|pem|key)$/i.test(file)) issues.push({ file, rule: 'private-or-generated-file' });
 let text;
 try { if ((await stat(resolve(root, file))).size > 4 * 1024 * 1024) { issues.push({ file, rule: 'large-file-review' }); continue; } text = await readFile(resolve(root, file), 'utf8'); }
 catch (error) { if (error.code === 'ENOENT') continue; throw error; }
 inspect(file, text);
 if (file.endsWith('.md')) for (const m of text.replace(/```[\s\S]*?```|`[^`\n]+`/g, '').matchAll(/\]\(<?([^\s)>]+)>?\)/g)) {
  const target = m[1].split('#')[0];
  if (!target || /^[a-z]+:|^\//i.test(target)) continue;
  const relative = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(target)));
  if (!published.has(relative) && !files.some(f => f.startsWith(relative.replace(/\/$/, '') + '/'))) issues.push({ file, rule: 'broken-public-link', target: relative });
 }
}
// Historical checks are reported separately: old paths need not block a fixed checkout,
// but actual historical secrets must be reviewed before a first public push.
const currentIssues = issues.splice(0);
inspect('git-history', git('log', '--all', '--format=', '-p', '--no-ext-diff'));
const historyIssues = issues.splice(0);
if (!process.env.npm_execpath) throw Error('Run npm run check:release.');
for (const plugin of ['dsh-scholar', 'dsh-server-dashboard', 'dsh-trajectory']) {
 const cwd = resolve(root, plugin), pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
 const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
 const names = new Set(pack.files.map(f => f.path));
 for (const expected of ['package.json', 'LICENSE', 'README.md', 'cordis.patch.yml', ...Object.values(pkg.exports).map(p => p.replace(/^\.\//, ''))]) {
  if (!names.has(expected)) currentIssues.push({ file: plugin, rule: 'missing-package-file', target: expected });
 }
 for (const name of names) if (!/^(?:dist\/|package\.json$|LICENSE$|README\.md$|cordis\.patch\.yml$)/.test(name)) currentIssues.push({ file: plugin + '/' + name, rule: 'unexpected-package-file' });
 packages.push({ name: pkg.name, version: pkg.version, files: pack.files.length, bytes: pack.unpackedSize, paths: [...names] });
}
const report = { candidates: files.length, currentIssues, historyIssues, packages };
await writeFile(resolve(out, 'release-check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ candidates: files.length, currentIssues, historyIssues, packages: packages.map(({ paths, ...p }) => p) }, null, 2));
process.exitCode = currentIssues.length || historyIssues.some(x => x.rule !== 'personal-absolute-path') ? 1 : 0;
