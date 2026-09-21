import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.DSH_TEST_OUTPUT ?? resolve(root, '.verify', new Date().toISOString().replaceAll(':', '-')));
await mkdir(out, { recursive: true });
const env = { ...process.env, DSH_TEST_OUTPUT: out };
const results = [];
async function run(name, args, cwd = root, npm = false) {
  if (npm && !process.env.npm_execpath) throw Error('Run this entry point through npm test or npm run build.');
  const commandArgs = npm ? [process.env.npm_execpath, ...args] : args;
  console.log(`\n[verify] ${name}`);
  let output = '';
  const code = await new Promise((done, fail) => {
    const child = spawn(process.execPath, commandArgs, { cwd, env, windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
    child.once('error', fail); child.once('exit', done);
  });
  await writeFile(resolve(out, name + '.log'), output);
  results.push({ name, exitCode: code });
  await writeFile(resolve(out, 'run-results.json'), JSON.stringify({ results }, null, 2));
  if (code !== 0) throw Error(`${name} failed; see ${out}`);
}
for (const plugin of ['dsh-scholar', 'dsh-server-dashboard', 'dsh-trajectory']) await run(plugin + '-build', ['run', 'build'], resolve(root, plugin), true);
if (!process.argv.includes('--build-only')) {
  for (const [plugin, script] of [['dsh-scholar','smoke-test.mjs'], ['dsh-server-dashboard','test-alerts.mjs'], ['dsh-trajectory','smoke-test.mjs']]) await run(plugin + '-smoke', ['scripts/' + script], resolve(root, plugin));
  for (const test of ['regression', 'interaction-backend', 'dashboard-credential-compat']) await run(test, ['--experimental-vm-modules', 'tests/' + test + '.mjs']);
  await run('ui', ['tests/ui-regression.mjs']);
  await run('config-contract', ['--experimental-vm-modules', 'tests/config-contract.mjs']);
  await run('library-scroll', ['tests/library-scroll.mjs']);
}
console.log(`\nVerification artifacts: ${out}`);
