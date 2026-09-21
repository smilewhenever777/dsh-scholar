// Real built routes/stores. All collectors, credentials and records are synthetic.
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { context, call, loadIsolated } from './harness.mjs';
import { TrajStore } from '../dsh-trajectory/dist/store.js';
import { registerTrajRoutes } from '../dsh-trajectory/dist/routes.js';
import { PaperStore } from '../dsh-scholar/dist/store.js';
import { createPaper } from '../dsh-scholar/dist/domain.js';
import { registerScholarRoutes } from '../dsh-scholar/dist/routes.js';
const out = resolve(process.env.DSH_TEST_OUTPUT ?? 'repair-final-2026-09-21');
await fs.mkdir(out, { recursive: true });
const fixture = await fs.mkdtemp(join(out, 'interaction-synthetic-')), results = [];
const check = (id, passed, observed = {}) => { results.push({ id, passed, observed }); console.log(JSON.stringify({ id, passed, observed })); };
const capture = []; let collects = 0;
const dash = await loadIsolated('dsh-server-dashboard/dist/index.js', {
  '@deepseek-ai/dsh-credentials': { credentialRef: x => x },
  './host/collector.js': {
    collectSnapshot: async r => { collects++; capture.push(r); return { hostId: r.id, ok: true, gpus: [], at: Date.now() }; },
    testConnection: async () => ({ ok: true }), discoverLogs: async () => [], disposeState() {},
  },
});
const dc = context(), vault = new Map();
let config = { hosts: [], refreshIntervalS: 30, staleMinutes: 10, alertIdleMin: 5 }, failVault = false, failSettings = false, failUnset = false;
dc.settings = { register: () => ({ get: () => config, update: async p => {
  await new Promise(r => setTimeout(r, 5));
  if (failSettings) throw Error('synthetic settings failure');
  config = { ...config, ...p };
} }) };
dc.credentials = { resolve: async r => vault.has(r) ? { value: vault.get(r) } : undefined,
  set: async (r, v) => { if (failVault) throw Error('SYNTHETIC_SECRET_NOT_FOR_RESPONSE'); vault.set(r, v); },
  unset: async r => { if (failUnset) throw Error('SYNTHETIC_SECRET_NOT_FOR_RESPONSE'); vault.delete(r); } };
dash.apply(dc);
const rev = async () => (await call(dc, '/dash/config')).json.revision;
const patch = async body => call(dc, '/dash/config', 'PATCH', { ...body, revision: await rev() });
const host = { id: 'synthetic', name: '合成主机', host: 'synthetic.invalid', port: 22, username: 'audit', authKind: 'password', credentialRef: '', identityFile: '', logPath: '', pinned: false, archived: false };
try {
  const setup = await patch({ addHosts: [host], secrets: { synthetic: { password: 'SYNTHETIC_ONLY' } } });
  check('config-add-derives-credential', setup.statusCode === 200 && vault.get('SD_synthetic') === 'SYNTHETIC_ONLY' && config.hosts.length === 1);
  const thresholds = await patch({ refreshIntervalS: 60 });
  check('R09-threshold-only-preserves-hosts-vault', thresholds.statusCode === 200 && config.refreshIntervalS === 60 && config.hosts.length === 1 && vault.size === 1);
  const empty = await patch({ addHosts: [] });
  check('R02-empty-import-preserves-data', empty.statusCode === 200 && config.hosts.length === 1 && vault.size === 1);
  const unsafe = await call(dc, '/dash/config', 'PUT', { hosts: [] });
  check('R02-unversioned-replacement-rejected', unsafe.statusCode === 409 && config.hosts.length === 1 && vault.size === 1);
  const old = { ...structuredClone(config), revision: await rev() };
  await patch({ updateHost: { id: host.id, changes: { name: '新名字' } } });
  const stale = await call(dc, '/dash/config', 'PUT', { ...old, hosts: old.hosts.map(h => ({ ...h, pinned: true })) });
  check('R10-stale-full-list-rejected', stale.statusCode === 409 && config.hosts[0].name === '新名字');
  const pin = await patch({ updateHost: { id: host.id, changes: { pinned: true } } });
  check('R10-partial-pin-preserves-name-threshold', pin.statusCode === 200 && config.hosts[0].name === '新名字' && config.refreshIntervalS === 60);
  const version = await rev();
  const concurrent = await Promise.all([false, true].map(archived => call(dc, '/dash/config', 'PATCH', { revision: version, updateHost: { id: host.id, changes: { archived } } })));
  check('R10-same-version-writers-serialized', concurrent.filter(r => r.statusCode === 200).length === 1 && concurrent.filter(r => r.statusCode === 409).length === 1, { statuses: concurrent.map(r => r.statusCode) });
  const credVersion = await rev();
  await patch({ secrets: { synthetic: { password: 'SYNTHETIC_UPDATED' } } });
  check('R10-secret-only-save-advances-version', await rev() !== credVersion);
  const identity = await patch({ updateHost: { id: host.id, changes: { host: 'other.invalid' } } });
  check('credential-identity-binding-preserved', identity.statusCode === 400 && config.hosts[0].host === host.host);
  const evilRef = await patch({ updateHost: { id: host.id, changes: { credentialRef: 'VICTIM' } } });
  check('partial-update-cannot-select-vault-ref', evilRef.statusCode === 400);
  const unknown = await patch({ updateHost: { id: 'missing', changes: { pinned: true } } });
  check('missing-host-update-cannot-recreate', unknown.statusCode === 404);
  const before = collects;
  await call(dc, '/dash/snapshots', 'GET', undefined, { url: '/dash/snapshots?cached=1' });
  check('UX02-reference-preview-does-not-start-SSH', collects === before);
  await call(dc, '/dash/snapshots', 'GET', undefined, { url: '/dash/snapshots?force=1' });
  vault.set('SD_synthetic', 'SYNTHETIC_ROTATED');
  dc.listeners.get('credentials/reference-updated')?.('SD_synthetic');
  await call(dc, '/dash/snapshots', 'GET');
  check('external-vault-rotation-used-on-next-poll', capture.at(-1)?.auth.password === 'SYNTHETIC_ROTATED');
  vault.set('SD_synthetic', 'SYNTHETIC_ROTATED_AGAIN');
  await call(dc, '/dash/snapshots', 'GET', undefined, { url: '/dash/snapshots?force=1' });
  check('manual-refresh-resolves-vault-without-event', capture.at(-1)?.auth.password === 'SYNTHETIC_ROTATED_AGAIN');
  const auth = capture.at(-1)?.auth;
  await patch({ updateHost: { id: host.id, changes: { hostKeyFingerprint: 'SHA256:USER_PIN' } } });
  auth?.onFingerprint?.('SHA256:LATE_OLD_PIN');
  await new Promise(r => setTimeout(r, 30));
  check('R10-late-TOFU-cannot-replace-user-pin', config.hosts[0].hostKeyFingerprint === 'SHA256:USER_PIN');
  await patch({ removeHostId: host.id }); auth?.onFingerprint?.('SHA256:LATE_OLD_PIN');
  await new Promise(r => setTimeout(r, 30));
  check('R10-deletion-cleans-vault-no-TOFU-resurrection', config.hosts.length === 0 && vault.size === 0);
  failVault = true;
  const failed = await patch({ addHosts: [host], secrets: { synthetic: { password: 'SYNTHETIC_NEW' } } });
  check('credential-failure-explicit-and-redacted', failed.statusCode === 500 && failed.text.includes('配置已保存') && !failed.text.includes('SYNTHETIC_SECRET_NOT_FOR_RESPONSE'));
  failVault = false; failSettings = true; const stateBefore = JSON.stringify(config);
  const failedConfig = await patch({ updateHost: { id: host.id, changes: { name: 'not persisted' } } });
  check('failed-config-write-retains-baseline', failedConfig.statusCode === 500 && JSON.stringify(config) === stateBefore);
  failSettings = false;
  const origin = await call(dc, '/dash/config', 'PATCH', { revision: await rev(), hosts: [] }, { headers: { origin: 'https://attacker.invalid' } });
  check('PATCH-retains-origin-guard', origin.statusCode === 403 && config.hosts.length === 1, { status: origin.statusCode });
  await patch({ secrets: { synthetic: { password: 'SYNTHETIC_ONLY' } } });
  failUnset = true;
  const cleanup = await patch({ removeHostId: host.id });
  check('credential-cleanup-failure-explicit-and-redacted', cleanup.statusCode === 500 && config.hosts.length === 0 && vault.has('SD_synthetic') && cleanup.text.includes('凭据清理失败') && !cleanup.text.includes('SYNTHETIC_SECRET_NOT_FOR_RESPONSE'));
} finally { dc.disposers.reverse().forEach(f => f()); }
const ts = new TrajStore(join(fixture, 'trajectory')); await ts.init();
const { project } = await ts.createProject({ name: 'synthetic project', activate: true });
const node = await ts.addNode({ projectId: project.id, title: 'before', mainline: false });
const tc = context(); registerTrajRoutes(tc, async () => ts, () => ({ dataDir: ts.dir }), async () => {});
const saved = await call(tc, '/traj/nodes', 'PUT', { projectId: project.id, title: 'after', mainline: true, refs: { paperId: 'A' } }, { url: '/traj/nodes/' + node.id });
const reload = new TrajStore(ts.dir); await reload.init();
check('R07-node-mainline-atomic-route-and-disk', saved.statusCode === 200 && reload.getNode(node.id).title === 'after' && reload.files.get(project.id).project.mainline.includes(node.id));
const write = ts.atomicWrite; ts.atomicWrite = async () => { throw Error('synthetic disk failure'); };
const failedNode = await call(tc, '/traj/nodes', 'PUT', { title: 'failed', mainline: false }, { url: '/traj/nodes/' + node.id });
check('R07-disk-failure-no-half-saved-memory', failedNode.statusCode >= 400 && ts.getNode(node.id).title === 'after' && ts.files.get(project.id).project.mainline.includes(node.id));
const count = ts.files.get(project.id).nodes.length;
await ts.addNode({ projectId: project.id, title: 'failed-create' }).catch(() => {});
check('R07-failed-creation-no-phantom-node', ts.files.get(project.id).nodes.length === count); ts.atomicWrite = write;
const ps = new PaperStore(join(fixture, 'papers')); await ps.init();
const paper = createPaper({ title: 'synthetic paper', source: 'manual', summary: 'new summary', notes: 'new notes' }); await ps.upsertPaper(paper);
const pc = context(); registerScholarRoutes(pc, async () => ps, () => ({ paperDir: ps.dir, defaultTags: [] }), async () => {});
await call(pc, '/scholar/papers', 'PUT', { importance: 5 }, { url: '/scholar/papers/' + paper.id });
check('E02-real-paper-route-retains-text', ps.papers.get(paper.id).importance === 5 && ps.papers.get(paper.id).summary === 'new summary' && ps.papers.get(paper.id).notes === 'new notes');
await fs.writeFile(join(out, 'backend-results.json'), JSON.stringify({ results, fixture }, null, 2));
process.exitCode = results.some(r => !r.passed) ? 1 : 0;
