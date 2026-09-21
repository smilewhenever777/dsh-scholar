// Replay browser-emitted config request bodies against the actual built route.
// Only the opaque revision is exchanged for the real server's current revision.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { context, call, loadIsolated } from './harness.mjs';
const out = resolve(process.env.DSH_TEST_OUTPUT ?? 'repair-final-2026-09-21');
const requests = JSON.parse(await readFile(out + '/ui-config-contracts.json', 'utf8'));
if (requests.length !== 2) throw Error('Run tests/ui-regression.mjs first; two config contracts are required.');
const mod = await loadIsolated('dsh-server-dashboard/dist/index.js', {
  '@deepseek-ai/dsh-credentials': { credentialRef: x => x },
  './host/collector.js': { collectSnapshot: async () => { throw Error('Unexpected SSH'); }, testConnection: async () => ({}), discoverLogs: async () => [], disposeState() {} },
});
const ctx = context();
let config = { hosts: ['s1', 's2'].map(id => ({ id, name: '合成主机 ' + id, host: id + '.invalid', port: 22, username: 'audit', authKind: 'none', credentialRef: '', identityFile: '', logPath: '', pinned: false })), refreshIntervalS: 30, staleMinutes: 10, alertIdleMin: 5 };
ctx.settings = { register: () => ({ get: () => config, update: async patch => { config = { ...config, ...patch }; } }) };
ctx.credentials = { resolve: async () => undefined, set: async () => { throw Error('Unexpected vault write'); } };
mod.apply(ctx); const results = [];
try {
  for (const request of requests) {
    const revision = (await call(ctx, '/dash/config')).json.revision;
    const res = await call(ctx, request.url, request.method, { ...request.body, revision });
    const isHost = !!request.body.updateHost;
    const passed = res.statusCode === 200 && config.hosts.length === 2 && config.hosts[1].name === '合成主机 s2'
      && (isHost ? config.hosts[0].name === request.body.updateHost.changes.name : config.refreshIntervalS === request.body.refreshIntervalS);
    results.push({ id: isHost ? 'browser-host-patch-real-backend' : 'browser-threshold-patch-real-backend', passed, status: res.statusCode });
  }
} finally { ctx.disposers.reverse().forEach(f => f()); }
await writeFile(out + '/contract-results.json', JSON.stringify({ results }, null, 2));
console.log(JSON.stringify(results)); process.exitCode = results.some(r => !r.passed) ? 1 : 0;
