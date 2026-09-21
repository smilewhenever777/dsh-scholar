/**
 * dsh-server-dashboard — host half.
 *
 * Cordis plugin providing:
 *  - settings namespace `server-dashboard` (host list, refresh interval, staleness threshold)
 *  - credential-backed SSH auth (private key / password)
 *  - HTTP route `/dash/snapshots` returning collected snapshots
 *
 * Client-driven: the browser panel polls the route; each poll runs a fresh
 * read-only SSH sample (nvidia-smi / free / df / log tail). No write commands.
 *
 * NOTE: the route MUST NOT live under /api — dsh-client-connection owns the
 * /api prefix (RPC bridge) and would swallow it.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
// 仅加载 dsh-settings 的 Context 类型增强(ctx.settings);0.1.5 起无值导出需要
import type {} from '@deepseek-ai/dsh-settings';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { collectSnapshot, discoverLogs, testConnection, disposeState } from './host/collector.js';
import type { CollectState, HostRuntimeConfig, SshAuth } from './host/collector.js';
import { parseSshConfig } from './host/sshconfig.js';
import { TEMP_HOT } from './client/thresholds.js';
import type { LogTail, ServerSnapshot } from './client/types.js';

export const name = 'dsh-server-dashboard';

/** Host services this plugin waits for (registry, credentials vault, http carrier). */
export const inject = ['settings', 'credentials', 'webServer'];

export interface DashboardHostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 'password' | 'key' | 'none' */
  authKind: 'password' | 'key' | 'none';
  /** credential ref (POSIX shell identifier) holding password or private key */
  credentialRef: string;
  /** local path of an SSH identity file (imported from ~/.ssh/config); used when credentialRef is empty */
  identityFile: string;
  /** F04:已确认的 SSH 主机密钥指纹(SHA256:base64) */
  hostKeyFingerprint?: string;
  /** absolute path of the training log on the remote host */
  logPath: string;
  pinned: boolean;
  /** user-archived: stays folded into 其他服务器 even when offline/anomalous */
  archived: boolean;
}

export interface DashboardConfig {
  hosts: DashboardHostConfig[];
  refreshIntervalS: number;
  staleMinutes: number;
  /** crash alert: GPU busy→idle sustained this many minutes */
  alertIdleMin: number;
}

const HostSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  host: z.string().required(),
  port: z.number().step(1).min(1).max(65535).default(22),
  username: z.string().required(),
  authKind: z.union(['password', 'key', 'none']).default('none'),
  credentialRef: z.string().default(''),
  identityFile: z.string().default(''),
  logPath: z.string().default(''),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** F04:已确认的 SSH 主机密钥指纹(SHA256:base64),TOFU 首连写入,变化即拒连 */
  hostKeyFingerprint: z.string().default(''),
});

const DashboardConfigSchema = z.object({
  hosts: z.array(HostSchema).default([]),
  refreshIntervalS: z.number().step(1).min(10).max(300).default(30),
  staleMinutes: z.number().step(1).min(1).max(1440).default(10),
  alertIdleMin: z.number().step(1).min(1).max(120).default(5),
});

// 0.1.5 起 dsh-settings 移除了 settingsNamespace 包装:命名空间直接以字面量传入
const NS = 'server-dashboard';
const CRED_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readIdentityFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`无法读取密钥文件 ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Server-derived credential name for a host row — one host maps to exactly one
 *  credential. Client-supplied credentialRef values are display-only and are
 *  never used to address the vault (prevents overwriting arbitrary existing
 *  credentials via PUT /dash/config). */
function derivedCredName(hostId: string): string {
  // F21:无碰撞编码——非字母数字(含下划线本身)统一转 '_<hex>',十六进制字符
  // 属于字母数字集不会被再次编码,因此映射是单射;旧实现把 'audit-a' 与
  // 'audit_a' 都折叠成 SD_audit_a。纯字母数字 id(如 A5000)编码不变。
  return `SD_${hostId.replace(/[^A-Za-z0-9]/g, (c) => '_' + c.codePointAt(0)!.toString(16))}`;
}

/** Cached resolveAuth result per host; invalidated by PUT /dash/config or by an
 *  identity-file mtime change, so polling does not re-read key files each round. */
interface AuthCacheEntry {
  credentialRef: string;
  /** connection coordinates — a host edit must not serve a stale auth */
  sig: string;
  identityMtimeMs: number;
  auth: SshAuth;
}

async function resolveAuth(ctx: Context, cfg: DashboardHostConfig, cache?: Map<string, AuthCacheEntry>): Promise<SshAuth> {
  const ref = derivedCredName(cfg.id);
  const sig = `${cfg.authKind}|${cfg.username}@${cfg.host}:${cfg.port}`;
  let identityMtimeMs = -1;
  if (cfg.authKind === 'key' && cfg.identityFile) {
    try {
      const { stat } = await import('node:fs/promises');
      identityMtimeMs = Math.round((await stat(cfg.identityFile)).mtimeMs);
    } catch { identityMtimeMs = -1; }
  }
  const hit = cache?.get(cfg.id);
  if (hit && hit.credentialRef === ref && hit.sig === sig && hit.identityMtimeMs === identityMtimeMs) return hit.auth;
  const auth: SshAuth = { host: cfg.host, port: cfg.port, username: cfg.username };
  if (cfg.hostKeyFingerprint) auth.hostKeyFingerprint = cfg.hostKeyFingerprint;
  // 1) credential vault (explicitly stored private key / password) — always
  //    addressed by the SERVER-DERIVED name, never by a client-supplied ref
  if (cfg.authKind !== 'none') {
    let cred = await ctx.credentials.resolve(credentialRef(ref)).catch(() => undefined);
    // legacy migration: pre-derivation configs stored credentials under the
    // client-supplied ref (SD_<hostId> style). If the derived name is empty but
    // the legacy ref holds a value, copy it across once — self-heals existing
    // installs without weakening the derived-name model.
    if (!cred?.value && cfg.credentialRef && CRED_NAME.test(cfg.credentialRef) && cfg.credentialRef !== ref) {
      const legacy = await ctx.credentials.resolve(credentialRef(cfg.credentialRef)).catch(() => undefined);
      if (legacy?.value) {
        await ctx.credentials.set(credentialRef(ref), legacy.value).catch(() => undefined);
        cred = legacy;
      }
    }
    const value = cred?.value;
    if (value) {
      if (cfg.authKind === 'password') auth.password = String(value);
      else auth.privateKey = String(value);
    }
  }
  // 2) identity file referenced by an import from ~/.ssh/config
  if (cfg.authKind === 'key' && !auth.privateKey && cfg.identityFile) {
    auth.privateKey = await readIdentityFile(cfg.identityFile);
  }
  // 3) authKind 'none': mirror OpenSSH default identities
  if (cfg.authKind === 'none' && !auth.privateKey && !auth.password) {
    auth.privateKey = await readDefaultIdentity();
  }
  cache?.set(cfg.id, { credentialRef: ref, sig, identityMtimeMs, auth });
  return auth;
}

/** OpenSSH default-identity order for authKind 'none' (unencrypted keys only). */
async function readDefaultIdentity(): Promise<string | undefined> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const { readFile } = await import('node:fs/promises');
  for (const f of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    try {
      return await readFile(`${home}/.ssh/${f}`, 'utf8');
    } catch {
      // try the next default identity
    }
  }
  return undefined;
}

/** Auth resolution for one-off route bodies (test / discover-logs): same chain
 *  as polling — inline secret → credential vault → identityFile → default key. */
async function resolveAuthFromBody(ctx: Context, body: {
  host?: string; port?: number; username?: string;
  authKind?: DashboardHostConfig['authKind']; credentialRef?: string;
  identityFile?: string; password?: string; privateKey?: string;
}): Promise<SshAuth> {
  const auth: SshAuth = { host: body.host as string, port: body.port ?? 22, username: body.username ?? 'root' };
  const kind = body.authKind ?? 'none';
  // F03:临时测试流程解析的凭据引用必须属于看板(SD_*)命名空间——凭据 seam
  // 可解析环境变量等其他引用,不限定就会把无关 secret 当密码发给任意目标
  const refOk = (r: string | undefined): r is string => !!r && CRED_NAME.test(r) && r.startsWith('SD_');
  if (kind === 'password') {
    if (body.password) auth.password = body.password;
    else if (refOk(body.credentialRef)) {
      const hit = await ctx.credentials.resolve(credentialRef(body.credentialRef));
      if (hit?.value) auth.password = String(hit.value);
    }
  } else if (kind === 'key') {
    if (body.privateKey) auth.privateKey = body.privateKey;
    else if (refOk(body.credentialRef)) {
      const hit = await ctx.credentials.resolve(credentialRef(body.credentialRef));
      if (hit?.value) auth.privateKey = String(hit.value);
    } else if (body.identityFile) auth.privateKey = await readIdentityFile(body.identityFile);
  } else {
    auth.privateKey = await readDefaultIdentity();
  }
  return auth;
}

/**
 * Staleness observation cursor for one log target (host-level logPath or a
 * per-GPU log). Staleness is judged INCREMENTALLY — "has mtime/size changed
 * since the previous observation" — instead of comparing the remote mtime to
 * the local wall clock, so a remote clock skew can never flag a log that is
 * actively being written (the clock-skewed host case).
 */
export interface LogActivity {
  mtimeMs: number;
  size: number;
  /** LOCAL clock: the last moment a change (mtime or size) was observed */
  changeAt: number;
}

/**
 * Refresh the observation cursors from one round of snapshots. Targets are
 * keyed by log path; an mtime/size change (or a first observation, which gets
 * a full-threshold grace period) bumps changeAt to `now`. Failed snapshots
 * keep their previous cursors — a transient collect failure must not fake
 * either freshness or staleness. Pure (unit-testable).
 */
export function refreshLogActivity(
  snapshots: Record<string, ServerSnapshot>,
  prev: Record<string, Record<string, LogActivity>>,
  now: number,
): Record<string, Record<string, LogActivity>> {
  const next: Record<string, Record<string, LogActivity>> = {};
  for (const [hostId, snap] of Object.entries(snapshots)) {
    if (!snap || !snap.ok) {
      if (prev[hostId]) next[hostId] = prev[hostId];
      continue;
    }
    const targets: LogTail[] = [];
    if (snap.log && snap.log.mtimeMs > 0) targets.push(snap.log);
    for (const g of snap.gpus ?? []) if (g.log && g.log.mtimeMs > 0) targets.push(g.log);
    const prevRecord = prev[hostId] ?? {};
    const record: Record<string, LogActivity> = {};
    for (const t of targets) {
      const p = prevRecord[t.path];
      record[t.path] = p && p.mtimeMs === t.mtimeMs && p.size === t.size
        ? { mtimeMs: t.mtimeMs, size: t.size, changeAt: p.changeAt } // unchanged — keep the last change moment
        : { mtimeMs: t.mtimeMs, size: t.size, changeAt: now }; // changed or first sight — grace from now
    }
    next[hostId] = record;
  }
  return next;
}

/** Is a target fresh under the incremental rule? (pure) */
function activityFresh(
  record: Record<string, LogActivity> | undefined,
  path: string,
  now: number,
  staleMs: number,
): boolean {
  const a = record?.[path];
  return !!a && now - a.changeAt < staleMs;
}

/**
 * Crash alert engine (pure, unit-testable): a GPU that HAD training processes
 * and then sat process-less for ≥ idleMs fires ONE 'crash' event; going busy
 * again re-arms it. GPUs that were never busy do not alert (idle ≠ crash).
 * This is the industry-standard busy→idle transition (RunPod-style) and works
 * without any log-path configuration — pure GPU-state observation.
 */
type HostLevel = 'ok' | 'warn' | 'offline';

export interface GpuBusyState {
  busy: boolean[];
  idleSince: number[];
  alerted: boolean[];
}

export function planGpuAlerts(
  state: GpuBusyState | undefined,
  snap: { ok: boolean; gpus?: { processes: unknown[] }[] },
  now: number,
  idleMs: number,
): { state: GpuBusyState; fired: { gpuIndex: number; min: number }[] } {
  const gpus = snap.ok ? (snap.gpus ?? []) : [];
  const n = Math.max(state?.busy.length ?? 0, gpus.length);
  const st: GpuBusyState = {
    busy: new Array(n).fill(false),
    idleSince: new Array(n).fill(0),
    alerted: new Array(n).fill(false),
  };
  const fired: { gpuIndex: number; min: number }[] = [];
  for (let i = 0; i < n; i++) {
    const busy = (gpus[i]?.processes?.length ?? 0) > 0;
    const since = state?.idleSince[i] ?? 0;
    const wasAlerted = state?.alerted[i] ?? false;
    st.busy[i] = busy;
    if (busy) {
      // re-arm on activity
      continue;
    }
    if (since > 0) {
      st.idleSince[i] = since;
      if (!wasAlerted && now - since >= idleMs) {
        st.alerted[i] = true;
        fired.push({ gpuIndex: i, min: Math.max(1, Math.round((now - since) / 60_000)) });
      } else {
        st.alerted[i] = wasAlerted;
      }
    } else if (state?.busy[i]) {
      // busy→idle transition just happened: start the countdown
      st.idleSince[i] = now;
    }
  }
  return { state: st, fired };
}

/**
 * Host-level logPath lifecycle:
 *  - a configured path whose log shows no mtime/size CHANGE for ≥ staleMinutes
 *    (observation-based, immune to remote clock skew) is cleared — the
 *    experiment ended, stop flagging it;
 *  - an empty path adopts the freshest per-GPU log (still being written; ties
 *    broken by the largest remote mtime, comparable within one host) so the
 *    card-level log follows whatever experiment starts next.
 * Pure logic (unit-testable); the caller persists the returned patches.
 */
export function planLogPathUpdates(
  config: DashboardConfig,
  snapshots: Record<string, ServerSnapshot>,
  activity: Record<string, Record<string, LogActivity>>,
  staleMinutes: number,
  now: number,
): { id: string; logPath: string }[] {
  const staleMs = staleMinutes * 60_000;
  const out: { id: string; logPath: string }[] = [];
  for (const hostCfg of config.hosts) {
    const snap = snapshots[hostCfg.id];
    if (!snap || !snap.ok) continue;
    const record = activity[hostCfg.id];
    if (hostCfg.logPath && snap.log && snap.log.mtimeMs > 0 && snap.log.path === hostCfg.logPath) {
      // stalled = no observed change within the threshold (first observation
      // starts its grace period, so a genuinely old log is not cleared at once)
      if (!activityFresh(record, hostCfg.logPath, now, staleMs)) out.push({ id: hostCfg.id, logPath: '' });
    } else if (!hostCfg.logPath) {
      // adopt: freshest changed-recently per-GPU log; mtimeMs tiebreak compares
      // clocks of the SAME remote host, so skew cannot reorder the candidates
      let best: LogTail | undefined;
      for (const g of snap.gpus ?? []) {
        const l = g.log;
        if (!l || l.mtimeMs <= 0 || !activityFresh(record, l.path, now, staleMs)) continue;
        if (!best || l.mtimeMs > best.mtimeMs) best = l;
      }
      if (best) out.push({ id: hostCfg.id, logPath: best.path });
    }
  }
  return out;
}

export function apply(ctx: Context) {
  const scope = ctx.settings.register(NS, DashboardConfigSchema, {});

  const hostState = new Map<string, CollectState>();
  // last good snapshot cache, so a transient collect failure still renders
  const cache = new Map<string, ServerSnapshot>();
  // time-based exponential backoff per host: consecutive failures push the next
  // probe 1min → 2min → 5min → 10min → 30min out; the cached error snapshot is
  // served in between so a dead host never blocks healthy polls on SSH timeouts.
  // A manual refresh (?force=1) clears the cooldown so a revived host is retried
  // immediately instead of waiting out the full backoff.
  const backoff = new Map<string, { failures: number; nextTryAt: number }>();
  const BACKOFF_MINUTES = [1, 2, 5, 10, 30];
  const noteFailure = (id: string) => {
    const failures = (backoff.get(id)?.failures ?? 0) + 1;
    backoff.set(id, {
      failures,
      nextTryAt: Date.now() + BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] * 60_000,
    });
  };
  // single-flight: concurrent snapshot requests share one polling round
  let inflight: Promise<Record<string, ServerSnapshot>> | null = null;
  let lastRun = 0;
  // resolveAuth result cache per host (invalidated by PUT /dash/config; see
  // AuthCacheEntry for the identity-file mtime part of the key)
  const authCache = new Map<string, AuthCacheEntry>();
  // staleness observation cursors: hostId → log path → {mtime,size,changeAt};
  // the incremental rule lives in refreshLogActivity/planLogPathUpdates
  const logActivity = new Map<string, Record<string, LogActivity>>();
  // one-shot stall notices with a 2-minute grace: a client that connects shortly
  // AFTER the clearing poll still gets the experiment-finished toast
  const pendingNotices = new Map<string, { path: string; minutes: number; at: number }>();
  // crash-alert engine state: per-host GPU busy/idle trackers (evaluated by the
  // /dash/events watcher; events flow through emitAlert)
  const gpuBusyState = new Map<string, GpuBusyState>();
  // per-host alarm level: the watcher pushes only TRANSITIONS (declared here —
  // sweepRemovedHosts below touches it synchronously)
  const lastLevels = new Map<string, HostLevel>();
  const cacheSnapshot = () => Object.fromEntries([...cache.entries()]);

  /** drop ALL runtime state of hosts that are no longer in the config (covers
   *  both PUT /dash/config and direct settings edits); disposing the CollectState
   *  also closes its pooled SSH connection, so a removed host cannot pin one */
  const sweepRemovedHosts = (live: Set<string>) => {
    for (const id of [...hostState.keys()]) {
      if (!live.has(id)) {
        const st = hostState.get(id);
        if (st) disposeState(st);
        hostState.delete(id);
      }
    }
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
    for (const id of [...backoff.keys()]) if (!live.has(id)) backoff.delete(id);
    for (const id of [...logActivity.keys()]) if (!live.has(id)) logActivity.delete(id);
    for (const id of [...pendingNotices.keys()]) if (!live.has(id)) pendingNotices.delete(id);
    for (const id of [...gpuBusyState.keys()]) if (!live.has(id)) gpuBusyState.delete(id);
    for (const id of [...lastLevels.keys()]) if (!live.has(id)) lastLevels.delete(id);
  };

  async function runPoll(config: DashboardConfig): Promise<Record<string, ServerSnapshot>> {
      await Promise.all(config.hosts.map(async (hostCfg) => {
        const back = backoff.get(hostCfg.id);
        if (back && Date.now() < back.nextTryAt) {
          // cooling down — serve the cached error with a fresh timestamp
          const cached = cache.get(hostCfg.id);
          if (cached) cache.set(hostCfg.id, { ...cached, at: Date.now(), ok: false });
          return;
        }
        let state = hostState.get(hostCfg.id);
        if (!state) {
          state = { series: new Map() };
          hostState.set(hostCfg.id, state);
        }
        try {
          const auth = await resolveAuth(ctx, hostCfg, authCache);
          // F04:TOFU 首连观测到主机密钥指纹时持久化到配置(供下次连接校验)
          if (!auth.hostKeyFingerprint) {
            auth.onFingerprint = (fp) => {
              try {
                const cur = scope.get() as DashboardConfig;
                const hosts = cur.hosts.map((h) => (h.id === hostCfg.id ? { ...h, hostKeyFingerprint: fp } : h));
                void scope.update({ hosts });
              } catch { /* 持久化失败不阻断连接 */ }
            };
          }
          const runtime: HostRuntimeConfig = {
            id: hostCfg.id,
            auth,
            logPath: hostCfg.logPath || undefined,
          };
          const snap = await collectSnapshot(runtime, state);
          if (snap.ok) {
            backoff.delete(hostCfg.id);
          } else {
            noteFailure(hostCfg.id);
          }
          cache.set(hostCfg.id, snap);
        } catch (err) {
          const failures = (backoff.get(hostCfg.id)?.failures ?? 0) + 1;
          backoff.set(hostCfg.id, {
            failures,
            nextTryAt: Date.now() + BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] * 60_000,
          });
          cache.set(hostCfg.id, {
            hostId: hostCfg.id,
            at: Date.now(),
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }));
      // refresh the incremental staleness cursors from this round's snapshots
      const snapsForPlan = Object.fromEntries([...cache.entries()]);
      const nextActivity = refreshLogActivity(
        snapsForPlan,
        Object.fromEntries([...logActivity.entries()]),
        Date.now(),
      );
      for (const [id, rec] of Object.entries(nextActivity)) logActivity.set(id, rec);
      for (const id of [...logActivity.keys()]) if (!(id in nextActivity)) logActivity.delete(id);
      // host-level logPath lifecycle: stalled path → auto-clear, empty path → adopt a fresh GPU log
      try {
        const patches = planLogPathUpdates(config, snapsForPlan, Object.fromEntries([...logActivity.entries()]), config.staleMinutes, Date.now());
        if (patches.length > 0) {
          const byId = new Map(patches.map((p) => [p.id, p.logPath]));
          // re-read the config right before writing: a concurrent PUT during
          // this poll must not be overwritten by our stale host list (lost update)
          const fresh = scope.get() as DashboardConfig;
          const next = fresh.hosts.map((h) => (byId.has(h.id) ? { ...h, logPath: byId.get(h.id) as string } : h));
          await scope.update({ hosts: next });
          for (const p of patches) {
            const st = hostState.get(p.id);
            if (st) {
              st.series.clear();
              st.lastLine = undefined;
              st.lastHeader = undefined;
              st.path = undefined;
              st.lastSize = undefined;
              st.lastMtime = undefined;
            }
            if (!p.logPath) {
              // the stalled log is being dropped from the snapshot — record a
              // one-shot notice, otherwise the client can never see the
              // "unchanged for N minutes" evidence its toast is built on
              const clearedPath = config.hosts.find((h) => h.id === p.id)?.logPath ?? '';
              pendingNotices.set(p.id, { path: clearedPath, minutes: config.staleMinutes, at: Date.now() });
              emitStall(p.id, config.hosts.find((h) => h.id === p.id)?.name ?? p.id, config.staleMinutes);
              const cached = cache.get(p.id);
              if (cached) cache.set(p.id, { ...cached, log: undefined, series: undefined });
            }
            ctx.logger.info(`[dsh-server-dashboard] ${p.id} logPath ${p.logPath ? `自动接管 ${p.logPath}` : '已停滞，自动清除'}`);
          }
        }
      } catch (err) {
        ctx.logger.warn('[dsh-server-dashboard] logPath lifecycle update failed:', err instanceof Error ? err.message : String(err));
      }
      // recycle state (and pooled SSH connections) of hosts removed from the
      // config outside our PUT handler (direct settings edits)
      sweepRemovedHosts(new Set(config.hosts.map((h) => h.id)));
    return cacheSnapshot();
  }

  async function pollAll(config: DashboardConfig, force = false, forceHost?: string): Promise<Record<string, ServerSnapshot>> {
    // loop: after awaiting an inflight round, RE-CHECK before starting our own —
    // two concurrent ?force=1 requests would otherwise overlap rounds (double
    // config writes from planLogPathUpdates, duplicate stall events)
    for (;;) {
      if (inflight) {
        // a poll round is already running — non-forced callers just wait for it
        if (!force) return inflight;
        await inflight.catch(() => {});
        continue;
      }
      break;
    }
    // ?host=<id> alone must NOT bypass the backoff — only a real manual retry
    // (force=1, optionally narrowed to one host) clears it
    if (forceHost && force) backoff.delete(forceHost);
    else if (force) backoff.clear();
    else if (Date.now() - lastRun < 5_000) return cacheSnapshot();
    inflight = runPoll(config);
    try {
      return await inflight;
    } finally {
      inflight = null;
      lastRun = Date.now();
    }
  }

  /* ---------- shared route helpers ---------- */

  /** Loopback guard for every /dash/* route: only 127.0.0.1 / ::1 / IPv4-mapped
   *  loopback may talk to the dashboard API. Even when the web server is bound
   *  to 0.0.0.0 for LAN sharing, remote clients cannot reach the dashboard
   *  routes (config write / SSH probes / snapshots) directly. */
  const isLoopback = (req: import('node:http').IncomingMessage): boolean => {
    const addr = req.socket.remoteAddress ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };

  /** 403 unless loopback; returns false when the response is already sent */
  const guard = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean => {
  // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
  const hostRaw = String(req.headers.host ?? '').toLowerCase();
  let hostName = hostRaw;
  if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
  else if (hostName.includes(':')) hostName = hostName.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    sendJson(res, 403, { error: '非法 Host' });
    return false;
  }
  // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的
  // 简单 CSRF 因此被拒;无 Origin 的非浏览器客户端放行(loopback 对端已校验)
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const o = new URL(origin);
      const oHost = (o.hostname || '').toLowerCase();
      const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
      const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
      if (!loopback || !sameOrigin) {
        sendJson(res, 403, { error: '跨源请求被拒绝' });;
        return false;
      }
    } catch {
      sendJson(res, 403, { error: '跨源请求被拒绝' });;
      return false;
    }
  }
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: '仅允许本机(loopback)访问' });
      return false;
    }
    return true;
  };

  const readBody = (req: import('node:http').IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    // F02:严格媒体类型——分号前主类型必须精确等于 application/json;includes 匹配
    // 可被 "text/plain;application/json" 绕过(浏览器简单请求不需预检即可携带)
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
    const hostRaw = String(req.headers.host ?? '').toLowerCase();
    let hostName = hostRaw;
    if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
    else if (hostName.includes(':')) hostName = hostName.split(':')[0];
    if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
      reject(new Error('非法 Host'));
      return;
    }
    // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的
    // 简单 CSRF 因此被拒;无 Origin 的非浏览器客户端放行(loopback 对端已校验)
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const o = new URL(origin);
        const oHost = (o.hostname || '').toLowerCase();
        const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
        const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
        if (!loopback || !sameOrigin) {
          reject(new Error('跨源请求被拒绝'));
          return;
        }
      } catch {
        reject(new Error('非法 Origin'));
        return;
      }
    }
    // F10:字节缓冲 + 一次性解码——逐 chunk 字符串拼接会把多字节汉字拆开损坏
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        over = true;
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });

  const sendJson = (res: import('node:http').ServerResponse, code: number, payload: unknown) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/snapshots',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const config = scope.get() as DashboardConfig;
      const hostsMeta = config.hosts.map((h) => ({ id: h.id, name: h.name, pinned: h.pinned, archived: h.archived }));
      // ?force=1[&host=<id>] — manual refresh bypasses the failure backoff,
      // optionally only for one host (the offline card's retry button)
      const query = new URL(req.url ?? '', 'http://localhost').searchParams;
      const force = query.get('force') === '1';
      const forceHost = query.get('host') ?? undefined;
      try {
        const snapshots = await pollAll(config, force, forceHost);
        // attach unexpired stall notices so late-connecting clients still toast
        for (const [id, notice] of [...pendingNotices.entries()]) {
          if (Date.now() - notice.at > 120_000 || !config.hosts.some((h) => h.id === id)) {
            pendingNotices.delete(id);
            continue;
          }
          if (snapshots[id] && !snapshots[id].stallNotice) snapshots[id] = { ...snapshots[id], stallNotice: notice };
        }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          hosts: hostsMeta,
          snapshots,
          refreshIntervalS: config.refreshIntervalS,
          staleMinutes: config.staleMinutes,
        }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    },
  } satisfies WebRoute));

  // config read (secrets never leave the host; only refs are returned)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/config',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        if (req.method === 'GET') {
          const config = scope.get() as DashboardConfig;
          sendJson(res, 200, { config });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as {
            hosts?: DashboardHostConfig[];
            secrets?: Record<string, { password?: string; privateKey?: string }>;
            refreshIntervalS?: number;
            staleMinutes?: number;
          };
          const hosts = body.hosts;
          if (!Array.isArray(hosts)) return sendJson(res, 400, { error: 'hosts 必须是数组' });
          // duplicate ids would share one CollectState and reconnect every poll
          const seenIds = new Set<string>();
          for (const h of hosts) {
            if (seenIds.has(h.id)) return sendJson(res, 400, { error: `主机 id 重复：${h.id}` });
            seenIds.add(h.id);
          }
          // omitted fields keep their persisted values — a hosts-only PUT (host
          // edit, import, log apply) must not reset the interval thresholds
          const current = scope.get() as DashboardConfig;
          const refreshIntervalS = body.refreshIntervalS ?? current.refreshIntervalS;
          const staleMinutes = body.staleMinutes ?? current.staleMinutes;
          const alertIdleMin = (body as { alertIdleMin?: number }).alertIdleMin ?? current.alertIdleMin;
          // validate against the schema before persisting
          DashboardConfigSchema({ hosts, refreshIntervalS, staleMinutes, alertIdleMin });
          // secrets are ALWAYS stored under the server-derived SD_<hostId> name;
          // a client-supplied credentialRef is never used as a vault address
          // (prevents overwriting arbitrary existing credentials). The config
          // field is normalized for display only.
          const secretIds = new Set(Object.entries(body.secrets ?? {})
            .filter(([, s]) => s?.privateKey || s?.password)
            .map(([id]) => id));
          for (const row of hosts) {
            if (secretIds.has(row.id)) row.credentialRef = derivedCredName(row.id);
          }
          const prevHostIds = new Set(current.hosts.map((h) => h.id));
          await scope.update({ hosts, refreshIntervalS, staleMinutes, alertIdleMin });
          // config changed: clear the failure backoff + poll throttle so the
          // next request re-probes immediately ("fixed the credentials but the
          // card stayed red for up to 30min" case), drop the auth cache, and
          // re-arm the events watcher at the new interval
          backoff.clear();
          lastRun = 0;
          authCache.clear();
          scheduleWatcher(Math.max(WATCHER_MIN_MS, refreshIntervalS * 1000));
          // drop runtime state of hosts that no longer exist (cache/backoff/state leak)
          sweepRemovedHosts(new Set(hosts.map((h) => h.id)));
          // removed hosts take their derived credential with them — otherwise
          // stale SD_<id> keys accumulate in the vault forever
          for (const gone of [...prevHostIds].filter((id) => !seenIds.has(id))) {
            try {
              await (ctx.credentials as unknown as { remove?: (ref: unknown) => Promise<void> }).remove?.(credentialRef(derivedCredName(gone)));
            } catch { /* vault without remove support — key stays, harmless */ }
          }
          // persist the supplied secrets; ids not in the host list are ignored.
          // Failure here is reported as 500: the config half IS already saved,
          // and a 400 would make the client believe nothing happened.
          try {
            for (const [id, secret] of Object.entries(body.secrets ?? {})) {
              if (!seenIds.has(id)) continue;
              const name = derivedCredName(id);
              if (secret?.privateKey) await ctx.credentials.set(credentialRef(name), secret.privateKey);
              else if (secret?.password) await ctx.credentials.set(credentialRef(name), secret.password);
            }
          } catch (err) {
            return sendJson(res, 500, { error: `配置已保存，但凭据写入失败：${err instanceof Error ? err.message : String(err)}` });
          }
          sendJson(res, 200, { ok: true, config: { hosts, refreshIntervalS, staleMinutes, alertIdleMin } });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        // schema/validation problems are client errors; anything raised by
        // scope.update / the settings backend is a server error
        const msg = err instanceof Error ? err.message : String(err);
        const isValidation = msg.includes('必') || /invalid|expected|参数/.test(msg);
        sendJson(res, isValidation ? 400 : 500, { error: msg });
      }
    },
  } satisfies WebRoute));

  // import hosts from ~/.ssh/config (host side runs as the local user)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/import-ssh',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(`${home}/.ssh/config`, 'utf8');
        sendJson(res, 200, { hosts: parseSshConfig(text) });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  // connection test (light SSH probe; accepts one-off secrets for untested entries)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/test',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = JSON.parse(await readBody(req)) as {
          host?: string; port?: number; username?: string;
          authKind?: DashboardHostConfig['authKind']; credentialRef?: string;
          identityFile?: string;
          password?: string; privateKey?: string;
        };
        if (!body.host) return sendJson(res, 400, { error: 'host 必填' });
        const result = await testConnection(await resolveAuthFromBody(ctx, body));
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  // auto-discover training logs from running processes
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/discover-logs',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const body = JSON.parse(await readBody(req)) as {
          host?: string; port?: number; username?: string;
          authKind?: DashboardHostConfig['authKind']; credentialRef?: string;
          identityFile?: string;
          password?: string; privateKey?: string;
        };
        if (!body.host) return sendJson(res, 400, { error: 'host 必填' });
        const candidates = await discoverLogs(await resolveAuthFromBody(ctx, body));
        sendJson(res, 200, { candidates });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.logger.info('[dsh-server-dashboard] host half ready: settings ns + /dash/snapshots + /dash/config + /dash/test');

  /* ---------- instant alerts (/dash/events, long-poll) ----------
   * The browser panel polls snapshots; this endpoint pushes second-level
   * alerts the moment the host sampler sees a transition:
   *   {type:'stall', hostId, hostName, minutes}   — experiment log stalled
   *   {type:'host-status', hostId, hostName, level, previous}
   *                                               — offline / hot flips
   * Hanging GET + seq cursor: request /dash/events?since=N and it resolves
   * the instant an event lands (25s idle timeout). Sampling reuses pollAll
   * (single-flight + per-host backoff) and only runs while a client is
   * actually waiting, so no SSH load is added when the panel is closed. */
  const eventLog: { seq: number; payload: unknown }[] = [];
  let eventSeq = 0;
  const eventWaiters = new Set<() => void>();
  const emitAlert = (payload: unknown) => {
    eventLog.push({ seq: ++eventSeq, payload });
    if (eventLog.length > 80) eventLog.splice(0, eventLog.length - 80);
    for (const wake of [...eventWaiters]) wake();
    eventWaiters.clear();
  };

  // per-host alarm level type + classifier (map lives with the state above)
  const levelOf = (snap?: ServerSnapshot): HostLevel => {
    if (!snap || !snap.ok) return 'offline';
    return (snap.gpus ?? []).some((g) => g.tempC >= TEMP_HOT) ? 'warn' : 'ok';
  };

  // host-level stall: emit the moment planLogPathUpdates records a notice
  function emitStall(hostId: string, hostName: string, minutes: number) {
    emitAlert({ type: 'stall', hostId, hostName, minutes });
  }

  // sampling interval follows the configured refreshIntervalS (10s floor), so
  // the watcher never polls SSH more often than the panel itself; rebuilt when
  // the config (or its interval) changes
  const WATCHER_MIN_MS = 10_000;
  let watcherTimer: NodeJS.Timeout | null = null;
  let watcherIntervalMs = 0;
  function scheduleWatcher(intervalMs: number) {
    if (watcherTimer) clearInterval(watcherTimer);
    watcherIntervalMs = intervalMs;
    watcherTimer = setInterval(watcherTick, intervalMs);
    watcherTimer.unref();
  };
  async function watcherTick() {
    if (eventWaiters.size === 0) return; // nobody long-polling — skip SSH sampling
    const config = scope.get() as DashboardConfig;
    // the interval may have changed via direct settings edit — re-arm
    const want = Math.max(WATCHER_MIN_MS, config.refreshIntervalS * 1000);
    if (want !== watcherIntervalMs) scheduleWatcher(want);
    const snaps = await pollAll(config).catch(() => cacheSnapshot());
    for (const h of config.hosts) {
      const level = levelOf(snaps[h.id]);
      const prev = lastLevels.get(h.id);
      lastLevels.set(h.id, level);
      if (!prev || prev !== level) {
        emitAlert({ type: 'host-status', hostId: h.id, hostName: h.name, level, previous: prev });
      }
      // GPU crash detection: busy→idle sustained ≥ alertIdleMin (re-arms on
      // activity; never-busy GPUs stay silent — idle alone is not a crash).
      // A snapshot that is !ok, or a GPU host whose GPU LIST vanished while we
      // previously saw busy cards, means the COLLECTION failed — freeze the
      // countdown instead of letting a dead nvidia-smi masquerade as crashes
      const idleMs = (config.alertIdleMin ?? 5) * 60_000;
      const snap = snaps[h.id];
      const st = gpuBusyState.get(h.id);
      const collectionSuspect = !snap?.ok
        || ((snap.gpus ?? []).length === 0 && (st?.busy.some(Boolean) ?? false));
      if (!collectionSuspect) {
        const { state, fired } = planGpuAlerts(st, snap ?? { ok: false }, Date.now(), idleMs);
        gpuBusyState.set(h.id, state);
        for (const f of fired) {
          emitAlert({ type: 'gpu-crash', hostId: h.id, hostName: h.name, gpuIndex: f.gpuIndex, minutes: f.min });
        }
      }
    }
  }
  scheduleWatcher(Math.max(WATCHER_MIN_MS, ((scope.get() as DashboardConfig).refreshIntervalS || 30) * 1000));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dash/events',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const sinceRaw = Number(q.get('since') ?? 0) || 0;
      // fresh client (since=0): no history replay (re-toasting hours-old alerts
      // on reload would be wrong) — but STILL register a waiter with the
      // CURRENT seq as the floor. Returning immediately without one starves
      // the watcher (it only samples when a waiter exists) and, on an instance
      // where eventSeq is still 0, the client's next poll also sends since=0:
      // a cold-start deadlock where no event can ever fire.
      let since = sinceRaw === 0 ? eventSeq : sinceRaw;
      // cursor fell behind the trimmed log (80-cap): the pending list would
      // re-deliver long-seen events — treat as a fresh client instead
      if (eventLog.length > 0 && since < eventLog[0].seq - 1) since = eventSeq;
      const deliver = () => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          events: eventLog.filter((e) => e.seq > since).map((e) => e.payload),
          last: eventSeq,
        }));
      };
      if (eventLog.some((e) => e.seq > since)) return deliver();
      const to = setTimeout(() => { eventWaiters.delete(wake); deliver(); }, 25_000);
      const wake = () => { clearTimeout(to); eventWaiters.delete(wake); deliver(); };
      eventWaiters.add(wake);
      res.on('close', () => { clearTimeout(to); eventWaiters.delete(wake); });
    },
  } satisfies WebRoute));

  // close all pooled SSH connections when the plugin scope is disposed
  ctx.effect(() => () => {
    if (watcherTimer) clearInterval(watcherTimer);
    for (const wake of [...eventWaiters]) wake(); // release hanging /dash/events
    eventWaiters.clear();
    for (const st of hostState.values()) disposeState(st);
  });
}
