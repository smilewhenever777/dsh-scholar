/**
 * SSH collectors: read-only remote sampling + parsing.
 * Pure logic — no DSH framework imports, so it stays testable in isolation.
 */
import type { BaseInfo, GpuInfo, GpuProcessInfo, LogTail, MetricSeries, ServerSnapshot } from '../client/types';

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  /** mutually exclusive */
  privateKey?: string;
  password?: string;
  /** F04:已持久化的服务器主机密钥指纹(SHA256:base64)。提供时强制校验,
   *  不匹配即拒绝连接;未提供时 TOFU——首次记录并经 onFingerprint 回传持久化 */
  hostKeyFingerprint?: string;
  /** F04:TOFU 首连观测到的指纹回传(宿主侧写入配置) */
  onFingerprint?: (fingerprint: string) => void;
}

export interface HostRuntimeConfig {
  id: string;
  auth: SshAuth;
  logPath?: string;
}

/** single-quote a remote path for shell interpolation — paths arrive from
 *  OTHER USERS' /proc (cwd, fd targets) and are fully attacker-controlled on
 *  multi-user boxes; unquoted interpolation would break the read-only promise */
function sq(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/* ---------- ssh2 plumbing ---------- */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

function loadSsh2(): typeof import('ssh2') {
  return nodeRequire('ssh2') as typeof import('ssh2');
}

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 12_000;
/** pooled connections send keepalives so half-dead TCP states surface within ~45s */
const KEEPALIVE_INTERVAL_MS = 15_000;
/** an idle pooled connection is recycled instead of pinning a server slot */
const POOL_IDLE_MS = 10 * 60_000;

function connect(auth: SshAuth, keepalive = false): Promise<import('ssh2').Client> {
  const { Client } = loadSsh2();
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH 连接超时 ${auth.host}:${auth.port}`));
    }, CONNECT_TIMEOUT_MS);
    conn.on('ready', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.connect({
      host: auth.host,
      port: auth.port,
      username: auth.username,
      privateKey: auth.privateKey,
      password: auth.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: keepalive ? KEEPALIVE_INTERVAL_MS : 0,
      // F04:主机密钥验证——有已存指纹必须匹配(变化即拒绝,可能被中间人替换);
      // 无指纹时 TOFU 记录并回传持久化。ssh2 默认接受任意主机密钥,加密≠认证。
      hostVerifier: (key: Buffer) => {
        const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64');
        if (auth.hostKeyFingerprint) return auth.hostKeyFingerprint === fp;
        try { auth.onFingerprint?.(fp); } catch { /* 持久化失败不阻断连接 */ }
        return true;
      },
    });
  });
}

/** one pooled SSH connection per host, reused across polls (the handshake is
 *  0.5–1.5s; the commands themselves are tens of ms). */
interface PooledSsh {
  conn: import('ssh2').Client;
  /** content hash of the auth — a rotated credential must not ride the old connection */
  authKey: string;
  lastUsed: number;
  dead: boolean;
}

function authKeyOf(auth: SshAuth): string {
  // 凭据部分只入 sha1 摘要不入池键 —— 池键不得携带明文密码/私钥
  const cred = createHash('sha1').update(`${auth.password ?? ''}|${auth.privateKey ?? ''}`).digest('hex').slice(0, 16);
  // R02:指纹入池键——pin 变化(重绑/首次确认)必须重建连接,旧连接的 verifier 是旧的
  return `${auth.username}@${auth.host}:${auth.port}|${cred}|${auth.hostKeyFingerprint ?? ""}`;
}

async function acquireConn(runtime: HostRuntimeConfig, state: CollectState): Promise<import('ssh2').Client> {
  // loop: after awaiting a FAILED shared handshake we must re-check from the
  // top — another waiter may have already started (and finished) a fresh one.
  // Falling through naively makes every waiter open its own connection; all
  // but the last leak (disposeState only closes state.ssh).
  for (;;) {
    if (state.disposed) throw new Error('主机状态已释放,不再建立 SSH 连接');
    const want = authKeyOf(runtime.auth);
    const cur = state.ssh;
    if (cur && !cur.dead && cur.authKey === want && Date.now() - cur.lastUsed < POOL_IDLE_MS) {
      cur.lastUsed = Date.now();
      return cur.conn;
    }
    // 并发窗口内的重复 acquire 共享同一次握手 —— 否则会建第二条连接并
    // 泄漏刚被 end() 掉的旧连接;凭据不一致或共享握手失败时才另起连接
    if (state.connecting) {
      const ok = await state.connecting.then(() => true, () => false);
      if (ok && state.ssh && !state.ssh.dead && state.ssh.authKey === want) {
        state.ssh.lastUsed = Date.now();
        return state.ssh.conn;
      }
      if (state.disposed) throw new Error('主机状态已释放,不再建立 SSH 连接');
      continue; // re-check: a new shared handshake may exist now
    }
    if (cur && !cur.dead) {
      try { cur.conn.end(); } catch { /* already closing */ }
    }
    const connPromise = connect(runtime.auth, true);
    state.connecting = connPromise;
    try {
      const conn = await connPromise;
      if (state.disposed) {
        // 等待期间宿主已释放 —— 不入池,立即关闭,避免卸载后漏一条 SSH
        try { conn.end(); } catch { /* closing */ }
        throw new Error('主机状态已释放,不再建立 SSH 连接');
      }
      const pooled: PooledSsh = { conn, authKey: want, lastUsed: Date.now(), dead: false };
      conn.on('close', () => { pooled.dead = true; });
      conn.on('error', () => { pooled.dead = true; });
      state.ssh = pooled;
      return conn;
    } finally {
      if (state.connecting === connPromise) state.connecting = undefined;
    }
  }
}

/** close a host's pooled connection (host removed from config / plugin disposal);
 *  the disposed flag makes later acquireConn attempts (in-flight retries) fail
 *  fast instead of silently reconnecting after unload. */
export function disposeState(state: CollectState): void {
  state.disposed = true;
  if (state.ssh && !state.ssh.dead) {
    try { state.ssh.conn.end(); } catch { /* already closing */ }
  }
  state.ssh = undefined;
}

function exec(conn: import('ssh2').Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // F22:通道打开截止时间在 conn.exec 之前启动——服务器 ready 但不回应
    // channel-open 时原实现的回调内注册计时器永远不会启动,轮询 inflight 永久挂起
    // R11:settled 与 opened 分离——超时 reject 后迟到回调仍会到达,必须
    // close+destroy 迟到流,而不是只"弃置"(监听器与命令计时器仍被装上)
    let settled = false;
    const settle = () => { settled = true; clearTimeout(openTimer); };
    const openTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`远程命令通道超时: ${cmd.slice(0, 60)}`));
    }, COMMAND_TIMEOUT_MS);
    conn.exec(cmd, (err, stream) => {
      if (settled) {
        try { stream?.close(); } catch { /* 已关闭 */ }
        try { stream?.destroy(); } catch { /* 已销毁 */ }
        return;
      }
      settle();
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      const timer = setTimeout(() => {
        // close 只发通道关闭请求,destroy 才真正断掉本地流 —— 半死连接上
        // 只 close 会把挂起的读取一并留下
        stream.close();
        stream.destroy();
        reject(new Error(`远程命令超时: ${cmd.slice(0, 60)}`));
      }, COMMAND_TIMEOUT_MS);
      stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      stream.stderr.on('data', (d: Buffer) => { errOut += d.toString('utf8'); });
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        if (code !== 0 && !out.trim()) reject(new Error(errOut.trim() || `命令退出码 ${code}`));
        else resolve(out);
      });
    });
  });
}

/** SFTP tail read. The whole stat/open/read chain runs under the same 12s
 *  budget as exec — a half-dead connection would otherwise hang the
 *  single-flight poll forever (no callback ever fires). `onHang` fires on
 *  timeout so the caller can recycle the pooled connection immediately. */
function readTail(
  conn: import('ssh2').Client,
  path: string,
  maxBytes = 262_144,
  maxLines = 20,
  onHang?: () => void,
): Promise<LogTail> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sftp: import('ssh2').SFTPWrapper | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // the SFTP session is a channel on the pooled connection — it MUST be
      // ended on every exit path or each read leaks one (MaxSessions=10)
      try { sftp?.end(); } catch { /* half-dead session */ }
      fn();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sftp?.end(); } catch { /* half-dead session */ }
      onHang?.(); // 超时 = 半死连接:立即标记回收,走既有重连路径
      reject(new Error(`SFTP 读取超时: ${path}`));
    }, COMMAND_TIMEOUT_MS);
    conn.sftp((err, s) => {
      if (err) return settle(() => reject(err));
      sftp = s;
      s.stat(path, (statErr, stats) => {
        if (statErr) return settle(() => reject(statErr));
        const size = stats.size;
        const offset = Math.max(0, size - maxBytes);
        s.open(path, 'r', (openErr, handle) => {
          if (openErr) return settle(() => reject(openErr));
          const buf = Buffer.alloc(maxBytes);
          s.read(handle, buf, 0, maxBytes, offset, (readErr, n) => {
            s.close(handle, () => {});
            if (readErr) return settle(() => reject(readErr));
            // short reads leave NUL padding — cut at the actual byte count
            const text = buf.toString('utf8', 0, n).replace(/\0/g, '');
            const lines = text.split('\n').filter((l: string) => l.length > 0);
            // 从文件中部起读时首行大概率是被切断的半行(tqdm 长行会产出垃圾点),丢弃
            if (offset > 0 && lines.length > 0) lines.shift();
            settle(() => resolve({ path, lines: lines.slice(-maxLines), size, mtimeMs: (stats.mtime ?? 0) * 1000 }));
          });
        });
      });
    });
  });
}

/* ---------- command recipes (read-only) ---------- */

const CMD_GPUS =
  "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,uuid --format=csv,noheader,nounits 2>/dev/null";
const CMD_PROCS =
  "nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits 2>/dev/null";
const CMD_CPU = "grep '^cpu ' /proc/stat";
const CMD_MEM = "free -m | awk '/^Mem:/{print $3, $2}'";
const CMD_DISK = "df -P -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | awk 'NR>1 && $6 ~ /^\\// {print $6, $5}'";
const CMD_LOAD = 'cat /proc/loadavg';

/* ---------- parsers ---------- */

function parseGpus(text: string): GpuInfo[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [index, name, util, memUsed, memTotal, temp, power, uuid] = line.split(',').map((s) => s.trim());
    return {
      index: Number(index),
      name,
      uuid,
      utilPercent: Number(util) || 0,
      memoryUsedMiB: Number(memUsed) || 0,
      memoryTotalMiB: Number(memTotal) || 0,
      tempC: Number(temp) || 0,
      powerW: Number(power) || 0,
      processes: [],
    };
  });
}

function parseProcs(text: string): Map<number, { memMiB: number; gpuUuid?: string }> {
  const map = new Map<number, { memMiB: number; gpuUuid?: string }>();
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(',').map((s) => s.trim());
    const p = Number(parts[0]);
    if (!(p > 0)) continue;
    if (parts.length >= 3) map.set(p, { memMiB: Number(parts[2]) || 0, gpuUuid: parts[1] });
    else map.set(p, { memMiB: Number(parts[1]) || 0 });
  }
  return map;
}

/** cumulative /proc/stat counters (utilization needs a delta between two reads) */
function parseCpuParts(text: string): { idle: number; total: number } | null {
  const parts = text.replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const idle = parts[3] + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return total > 0 ? { idle, total } : null;
}

/**
 * Current CPU utilization from cumulative counters. /proc/stat holds counters
 * since boot — a single read yields the lifetime AVERAGE, not the load now.
 * Deltas against the previous poll give the true window utilization; the first
 * poll (no history yet) samples twice 400ms apart.
 */
async function sampleCpu(conn: import('ssh2').Client, state: CollectState): Promise<number> {
  const read = async () => parseCpuParts(await exec(conn, CMD_CPU).catch(() => ''));
  let a = state.cpuPrev ?? null;
  if (!a) {
    a = await read();
    if (!a) return 0;
    await new Promise((r) => setTimeout(r, 400));
  }
  const b = await read();
  if (!b) return 0;
  state.cpuPrev = b;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

function parseLoad(text: string): number | undefined {
  const v = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : undefined;
}

function parseMem(text: string): { usedMiB: number; totalMiB: number } {
  const [used, total] = text.trim().split(/\s+/).map(Number);
  return { usedMiB: used || 0, totalMiB: total || 0 };
}

function parseDisk(text: string): { mount: string; usedPercent: number }[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    // 行形如 "<挂载点> <百分比>":按空白切分,最后一个 token 是百分比,
    // 其余整体是挂载点 —— 挂载点含空格时 lastIndexOf 切分会错位
    const parts = line.split(/\s+/);
    const pct = parseInt(parts[parts.length - 1] ?? '', 10);
    const mount = parts.slice(0, -1).join(' ');
    return { mount, usedPercent: Number.isFinite(pct) ? pct : 0 };
  });
}

/** 数值字面量源(支持前导 + 号与大写指数):+5 / 1.5E-5 / -0.25 */
const NUM_PATTERN = '[+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';

/** Extract `name=value` / `name: value` numeric pairs from a log line (tqdm-style). */
function parseMetricLine(line: string): { name: string; v: number }[] {
  const out: { name: string; v: number }[] = [];
  const seen = new Set<string>();
  const add = (name: string, v: number) => {
    if (Number.isFinite(v) && !seen.has(name)) {
      seen.add(name);
      out.push({ name, v });
    }
  };
  const re = new RegExp(`([A-Za-z][\\w./-]*)\\s*[:=]\\s*(${NUM_PATTERN})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) add(m[1], Number(m[2]));
  // flat JSON object lines: {"train_loss": 1.23, "epoch": 57, ...} (DEIM-style)
  const jsonRe = new RegExp(`"([A-Za-z][\\w./-]*)"\\s*:\\s*(${NUM_PATTERN})`, 'g');
  while ((m = jsonRe.exec(line)) !== null) add(m[1], Number(m[2]));
  // epoch with slash total, space-separated: "Epoch 12/100" (\b 挡住 Subepoch 之类的词内命中)
  const epoch = line.match(/\b(?:epoch|Epoch)\s+(\d+)\s*\/\s*(\d+)/);
  if (epoch) add('epoch', Number(epoch[1]));
  // bare leading "269/300" (YOLO data rows); 行首日期不算 epoch:
  // 首个数字 ≥1000 且行含时间样式(d+:dd)或三段 d/d/d(如 2026/09/02)时跳过
  const lead = line.match(/^(\d+)\s*\/\s*(\d+)/);
  if (lead) {
    const n = Number(lead[1]);
    const looksLikeDate = n >= 1000
      && (/\d+\s*:\s*\d+/.test(line) || /^\d+\s*\/\s*\d+\s*\/\s*\d+/.test(line));
    if (!looksLikeDate) add('epoch', n);
  }
  // tqdm progress bar: "12/100 [00:05<00:10, 0.05s/it]"
  const bar = line.match(/(?:^|[\s|])(\d+)\s*\/\s*(\d+)\s*\[/);
  if (bar) add('progress', Number(bar[1]));
  return out;
}

function appendSeries(series: Map<string, MetricSeries>, name: string, v: number, t: number, maxPoints = 200) {
  let s = series.get(name);
  if (!s) {
    s = { name, points: [] };
    series.set(name, s);
  }
  // skip consecutive identical values: \r-update logs re-expose the same
  // segment on every poll; only actual changes extend the curve
  if (s.points.length > 0 && s.points[s.points.length - 1].v === v) return;
  s.points.push({ t, v });
  if (s.points.length > maxPoints) s.points.splice(0, s.points.length - maxPoints);
}

/** names worth keeping when the series budget is tight (loss/lr/epoch/acc/map/...) */
const PRIORITY_METRIC = /(loss|lr|epoch|acc|map|f1|iou|mem)/i;

/**
 * Keep the most valuable maxSeries series when the budget overflows. Rank by
 * point count, then recency, then priority name. This is what lets live curves
 * push out one-shot static values: a hyperparameter table printed at training
 * start ("epochs: 300, fliplr: 0.5, iou: 0.7, …") creates a dozen frozen
 * 1-point series that would otherwise jam the whole budget — several of those
 * names even match the priority regex by accident ("fliplr" contains "lr").
 */
function compactSeries(series: Map<string, MetricSeries>, maxSeries: number): void {
  if (series.size <= maxSeries) return;
  const ranked = [...series.entries()].map(([key, s], idx) => {
    const last = s.points[s.points.length - 1];
    return {
      key, idx,
      count: s.points.length,
      lastT: last ? last.t : -1,
      priority: PRIORITY_METRIC.test(key) ? 1 : 0,
    };
  });
  ranked.sort((a, b) => (b.count - a.count) || (b.lastT - a.lastT) || (b.priority - a.priority) || (a.idx - b.idx));
  const keep = new Set(ranked.slice(0, maxSeries).map((r) => r.key));
  for (const key of [...series.keys()]) {
    if (!keep.has(key)) series.delete(key);
  }
}

/** Per-log ingestion cursor: series plus the dedupe/table context of the last poll. */
interface LogIngestState {
  series: Map<string, MetricSeries>;
  lastLine?: string;
  lastHeader?: string;
  /** last ingested log path — a path change resets the cursor */
  path?: string;
  /** last tail size — a shrink (incl. truncation to 0) means rotation: reset the cursor */
  lastSize?: number;
  /** last tail mtime — an older mtime (rotated-in file) also resets the cursor */
  lastMtime?: number;
}

/** Append new lines of one log into its series (shared by host-level and per-GPU logs). */
function ingestLogLines(state: LogIngestState, tail: LogTail, at: number, maxSeries = Infinity, maxPoints = 200): MetricSeries[] {
  // parse only lines newer than the last parsed one (prevents duplicate points)
  let start = 0;
  // rotation detection: a smaller size (including truncate-to-0, which used to
  // slip through and re-ingest the file once it grew back) OR an older mtime
  // (rotated-in fresh file) means the cursor no longer maps to this content
  const rotated = (state.lastSize !== undefined && tail.size < state.lastSize)
    || (state.lastMtime !== undefined && tail.mtimeMs < state.lastMtime);
  if (rotated) {
    state.lastLine = undefined;
    state.lastHeader = undefined;
  } else if (state.lastLine) {
    const idx = tail.lines.lastIndexOf(state.lastLine);
    if (idx >= 0) start = idx + 1;
    else {
      // mid-write growth: the stored final line is now a PREFIX of a longer line
      // (tqdm/\r writers keep appending) — re-ingest only that one line; the
      // consecutive-value dedupe absorbs unchanged metrics
      for (let i = tail.lines.length - 1; i >= 0; i--) {
        if (tail.lines[i].startsWith(state.lastLine)) { start = i; break; }
      }
    }
  }
  // \r-update logs (YOLO etc.) refresh one physical line: split into segments
  const segments: string[] = [];
  for (const line of tail.lines.slice(start)) segments.push(...line.split(/\r+/).map((s) => stripAnsi(s).trim()).filter(Boolean));
  let lastHeader = state.lastHeader ?? '';
  for (const seg of segments) {
    const pairs: { name: string; v: number }[] = [...parseMetricLine(seg)];
    if (lastHeader) {
      const t = parseTablePair(lastHeader, seg);
      if (t.length) pairs.push(...t);
    }
    const isHeader = /^[A-Za-z_][\w]*(?:\s+[A-Za-z_][\w]*){2,}$/.test(seg) && !/\d/.test(seg);
    const seen = new Set<string>();
    for (const { name, v } of pairs) {
      if (seen.has(name)) continue;
      seen.add(name);
      appendSeries(state.series, name, v, at, maxPoints);
    }
    if (isHeader) lastHeader = seg;
  }
  state.lastHeader = lastHeader || state.lastHeader;
  // 更新游标:轮转后即使本轮没有可读行也要落盘新的 size/mtime,
  // 否则截到 0 后涨回来的文件会被当成同一文件重吃
  if (rotated || tail.lines.length > 0) {
    state.lastLine = tail.lines.length > 0 ? tail.lines[tail.lines.length - 1] : undefined;
    state.lastSize = tail.size;
    state.lastMtime = tail.mtimeMs;
  }
  // budget compaction AFTER ingestion: creation-time rejection cannot tell a
  // frozen 1-point table value from the first point of a live curve (they share
  // the poll timestamp), but point count can
  if (maxSeries !== Infinity) compactSeries(state.series, maxSeries);
  return [...state.series.values()];
}

/**
 * Columnar table parser: align header-column spans with character positions in
 * the data row (fixed-width / space-padded tables, e.g. YOLO training logs).
 * Header names may be fused (dfl_lossrgb_evidence_box_loss) — each name span
 * extracts the first number at the same character range of the data row.
 */
function parseTablePair(headerLine: string, dataLine: string): { name: string; v: number }[] {
  const h = headerLine;
  const d = dataLine;
  if (h.length < 8 || d.length < 8) return [];
  if (!/\d/.test(d)) return [];
  if (Math.abs(h.length - d.length) / Math.max(h.length, 1) > 0.35) return [];
  const out: { name: string; v: number }[] = [];
  const re = /[A-Za-z_][\w]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h)) !== null) {
    // widen the extraction window past the name span so trailing digits survive
    const start = m.index;
    const span = d.slice(start, Math.min(start + m[0].length + 10, d.length));
    const val = span.match(new RegExp(NUM_PATTERN));
    if (!val) continue;
    out.push({ name: m[0].toLowerCase(), v: Number(val[0]) });
  }
  return out;
}

/** Strip ANSI escape sequences (progress bars / clear-line codes) from a log segment. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u2500-\u25FF]+\s*/g, ' ');
}

/* ---------- one-shot snapshot ---------- */

/** A training-log candidate discovered from a running process. */
export interface LogCandidate {
  pid: number;
  user: string;
  cmd: string;
  logPath: string;
  size: number;
  mtimeMs: number;
  /** how it was found: stdout-redirect / stderr-redirect / cwd-scan */
  source: 'stdout' | 'stderr' | 'cwd';
}

/**
 * Auto-discover training logs: for GPU/py processes, resolve the file behind
 * /proc/<pid>/fd/{1,2} and scan the process cwd for recently modified logs.
 * Processes owned by OTHER users yield cmdline only (no fd/cwd access) and are
 * reported as unreadable-path candidates so the UI can explain why.
 */
export async function discoverLogs(auth: SshAuth, maxProcs = 12): Promise<LogCandidate[]> {
  const conn = await connect(auth);
  const out: LogCandidate[] = [];
  const seen = new Set<string>();
  try {
    // running python/training processes + their tee/screen wrappers (log paths
    // often live in `tee -a /path/x.log` rather than in python's own args)
    const psText = await exec(conn, "ps -eo pid,user,args | grep -Ei 'python|torch|train|jupyter|tee -|screen' | grep -v grep | head -30");
    const procs: { pid: number; user: string; cmd: string }[] = [];
    for (const line of psText.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), user: m[2], cmd: m[3].slice(0, 200) });
    }
    const add = (pid: number, user: string, cmd: string, path: string, source: LogCandidate['source']) => {
      const key = `${path}`;
      if (!path || path === '/dev/null' || path === 'pipe:' || seen.has(key)) return;
      seen.add(key);
      out.push({ pid, user, cmd, logPath: path, size: -1, mtimeMs: 0, source });
    };
    for (const p of procs.slice(0, maxProcs)) {
      // 1) stdout/stderr redirects (same-user readable only)
      for (const [fd, source] of [[1, 'stdout'], [2, 'stderr']] as const) {
        try {
          const link = (await exec(conn, `readlink /proc/${p.pid}/fd/${fd} 2>/dev/null`)).trim();
          if (link.startsWith('/') && /\.(log|out|txt)$|nohup|output/i.test(link)) add(p.pid, p.user, p.cmd, link, source);
        } catch { /* fd unreadable (other user) — skip */ }
      }
      // 2) cwd scan for recent log files, 3 levels deep (logs often sit in subdirs)
      try {
        const cwd = (await exec(conn, `readlink /proc/${p.pid}/cwd 2>/dev/null`)).trim();
        if (cwd.startsWith('/')) {
          const ls = await exec(conn, `find ${sq(cwd)} -maxdepth 3 -type f \\( -name '*.log' -o -name '*.out' -o -name 'nohup.out' \\) -mmin -1440 2>/dev/null | head -8`);
          for (const full of ls.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)) {
            add(p.pid, p.user, p.cmd, full, 'cwd');
          }
        }
      } catch { /* cwd unreadable — skip */ }
      // 3) other-user processes: cmdline often contains a readable script/log hint
      try {
        const hint = p.cmd.match(/(\/[^\s]*(?:\.log|\.out|\.txt))/);
        if (hint) add(p.pid, p.user, p.cmd, hint[1], 'cwd');
      } catch { /* ignore */ }
    }
    // stat the candidates (only readable ones get real size/mtime)
    for (const c of out) {
      try {
        const st = (await exec(conn, `stat -c '%s %Y' ${sq(c.logPath)} 2>/dev/null`)).trim().split(/\s+/);
        if (st.length === 2) {
          c.size = Number(st[0]);
          c.mtimeMs = Number(st[1]) * 1000;
        }
      } catch { /* stat failed: other-user path */ }
    }
  } finally {
    conn.end();
  }
  return out;
}

/**
 * Find the training log behind one compute process. Tries, in order:
 *  1. open file descriptors pointing at a log-ish regular file
 *     (logger-opened logs show up here even when stdout is a pipe),
 *  2. cmdline: a direct `*.log` arg or `--output-dir <dir>` → `<dir>/log.txt`,
 *  3. unique recent `*.log` under the process cwd (only when unambiguous).
 */
async function statOk(conn: import('ssh2').Client, path: string): Promise<boolean> {
  try {
    const out = (await exec(conn, `stat -c '%s %Y' ${sq(path)} 2>/dev/null`)).trim();
    const [size, mtime] = out.split(/\s+/).map(Number);
    return Number.isFinite(size) && Number.isFinite(mtime);
  } catch {
    return false;
  }
}

export async function discoverGpuLog(conn: import('ssh2').Client, pid: number): Promise<string | undefined> {
  // 1) open fds
  const fdOut = await exec(conn, `for f in /proc/${pid}/fd/*; do readlink "$f" 2>/dev/null; done`);
  const fdCandidates: string[] = [];
  for (const raw of fdOut.split('\n')) {
    const p = raw.trim();
    if (!p.startsWith('/')) continue;
    if (/\(deleted\)$/.test(p)) continue;
    if (/^\/dev\/(null|pts|tty)/.test(p)) continue;
    if (/(pipe|socket):/.test(p)) continue;
    if (/\.(log|out|txt)$/i.test(p) || /nohup/i.test(p)) fdCandidates.push(p);
  }
  // prefer the newest / largest regular log among the open fds
  let bestFd: { path: string; size: number; mtime: number } | undefined;
  for (const p of fdCandidates.slice(0, 6)) {
    try {
      const st = (await exec(conn, `stat -c '%s %Y' ${sq(p)} 2>/dev/null`)).trim().split(/\s+/);
      if (st.length !== 2) continue;
      const size = Number(st[0]);
      const mtime = Number(st[1]);
      if (!bestFd || mtime > bestFd.mtime || (mtime === bestFd.mtime && size > bestFd.size)) bestFd = { path: p, size, mtime };
    } catch { /* stat failed */ }
  }
  // 2) cmdline: direct log arg, then --output-dir/<log.txt>
  try {
    const cmd = await exec(conn, `tr '\\0' '\\n' < /proc/${pid}/cmdline 2>/dev/null`);
    const args = cmd.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const a of args) {
      const m = a.match(/^(\/\S+\.(?:log|out|txt))$/i);
      if (m) return m[1];
    }
    let outDir: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--output-dir' || args[i] === '-o') outDir = args[i + 1];
      else if (args[i].startsWith('--output-dir=')) outDir = args[i].slice('--output-dir='.length);
    }
    if (outDir?.startsWith('/')) {
      const candidate = `${outDir}/log.txt`;
      if (await statOk(conn, candidate)) return candidate;
    }
  } catch { /* cmdline unreadable */ }
  // 3) open fd winner
  if (bestFd) return bestFd.path;
  // 4) unique recent log under cwd
  try {
    const cwd = (await exec(conn, `readlink /proc/${pid}/cwd 2>/dev/null`)).trim();
    if (cwd.startsWith('/')) {
      const finds = (await exec(conn, `find ${sq(cwd)} -maxdepth 3 -type f -name '*.log' -mmin -60 2>/dev/null | head -3`))
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (finds.length === 1) return finds[0];
    }
  } catch { /* cwd unreadable */ }
  return undefined;
}

/** Light connectivity probe: hostname + GPU count (for the settings "test connection" button). */
export async function testConnection(auth: SshAuth): Promise<{ ok: boolean; detail: string; gpus: number }> {
  let conn: import('ssh2').Client | null = null;
  try {
    conn = await connect(auth);
    const hostname = (await exec(conn, 'hostname')).trim();
    let gpus = 0;
    try {
      const text = await exec(conn, 'nvidia-smi -L 2>/dev/null');
      gpus = text.split('\n').filter((l) => l.trim().startsWith('GPU')).length;
    } catch {
      gpus = 0;
    }
    return { ok: true, detail: `${hostname} · ${gpus} 张 GPU`, gpus };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), gpus: 0 };
  } finally {
    conn?.end();
  }
}

export interface CollectState extends LogIngestState {
  /** last host-level tail mtime — an older mtime (rotated-in file) also resets */
  lastMtime?: number;
  /** previous /proc/stat counters — CPU% is the delta between polls */
  cpuPrev?: { idle: number; total: number };
  /** per-GPU log ingestion state, keyed by gpu index */
  gpu?: Map<string, LogIngestState>;
  /** per-PID discovered log path cache — discovery is 5-10 remote execs, so it is
   *  worth skipping while the process set is unchanged (hit TTL 5min, miss 60s);
   *  `starttime` (/proc/<pid>/stat field 22) guards against PID reuse */
  logCache?: Map<string, { path?: string; at: number; starttime?: string }>;
  /** pooled SSH connection reused across polls (per host) */
  ssh?: PooledSsh;
  /** consecutive log-read failures on the pooled connection */
  sshFail?: number;
  /** in-flight handshake shared by concurrent acquireConn callers (anti double-connect) */
  connecting?: Promise<import('ssh2').Client>;
  /** set by disposeState — later acquireConn attempts fail fast (no post-unload SSH) */
  disposed?: boolean;
}

/** per-GPU curve budget (4 GPUs × 8 series × 150 points keeps the payload sane) */
const MAX_GPU_SERIES = 8;
const MAX_GPU_POINTS = 150;
const LOG_CACHE_TTL_MS = 5 * 60_000;
const LOG_CACHE_MISS_TTL_MS = 60_000;

export async function collectSnapshot(runtime: HostRuntimeConfig, state: CollectState): Promise<ServerSnapshot> {
  const snap: ServerSnapshot = { hostId: runtime.id, at: Date.now(), ok: false };
  // 1) acquire the pooled connection — handshake/auth failures are not
  //    retryable (the credentials would be the same)
  let conn: import('ssh2').Client;
  try {
    conn = await acquireConn(runtime, state);
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
    // a half-dead pooled connection can poison later attempts — drop ONLY the
    // pooled connection so the next poll reconnects. The state itself must
    // survive: a temporarily unreachable host (reboot / network blip) has to
    // recover via the backoff ladder, and disposeState here would permanently
    // kill it ("主机状态已释放" forever) until the plugin reloads.
    if (state.ssh) {
      try { state.ssh.conn.end(); } catch { /* closing */ }
      state.ssh = undefined;
    }
    return snap;
  }
  const run = async (): Promise<void> => {
    // half-dead pooled connection recycle (SFTP hang / repeated read failures):
    // flag it dead so the next acquireConn reconnects
    const recycleConn = () => {
      if (state.ssh && !state.ssh.dead) {
        try { state.ssh.conn.end(); } catch { /* closing */ }
        state.ssh.dead = true;
      }
    };
    // GPU queries are best-effort: a CPU-only server (or a down driver) must
    // still surface CPU/memory/disk instead of failing the whole snapshot
    // core reads are individually best-effort (a CPU-only box still surfaces
    // memory/disk) — but ALL of them coming back empty means the pooled
    // connection is half-dead: throw so the retry/reconnect path engages
    // instead of shipping a healthy-looking all-zero snapshot
    const [gpuText, procText, cpuPercent, memText, diskText, loadText] = await Promise.all([
      exec(conn, CMD_GPUS).catch(() => ''),
      exec(conn, CMD_PROCS).catch(() => ''),
      sampleCpu(conn, state),
      exec(conn, CMD_MEM).catch(() => ''),
      exec(conn, CMD_DISK).catch(() => ''),
      exec(conn, CMD_LOAD).catch(() => ''),
    ]);
    if (!gpuText.trim() && !memText.trim() && !diskText.trim() && !loadText.trim()) {
      throw new Error('核心读取全部为空（疑似半死连接）');
    }
    const gpus = parseGpus(gpuText);
    const procs = parseProcs(procText);
    if (procs.size > 0) {
      const pids = [...procs.keys()].join(',');
      // full command line so the table answers "WHICH experiment is this" —
      // comm would only say "python"; cut bounds the wire payload
      const psText = await exec(conn, `ps -o pid=,user=,args= -p ${pids} 2>/dev/null | cut -c1-220`).catch(() => '');
      const psMap = new Map<number, { user: string; name: string; cmd?: string }>();
      for (const line of psText.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [pid, user, ...rest] = line.split(/\s+/);
        const cmd = rest.join(' ').slice(0, 200);
        // name: leading token's basename (compact display), cmd: the full line
        const name = cmd.split(/\s+/)[0]?.split('/').pop() ?? cmd;
        psMap.set(Number(pid), { user, name, cmd });
      }
      // map processes onto GPUs via driver uuid; a uuid we cannot match (MIG
      // reconfig, driver hiccup) means we DON'T know the card — drop instead
      // of piling everything onto GPU0 and polluting its table/alerts
      const uuidToIndex = new Map(gpus.map((g) => [g.uuid, g.index]));
      const anyUuidMatch = [...procs.values()].some((p) => p.gpuUuid === undefined || uuidToIndex.has(p.gpuUuid));
      const byGpu = new Map<number, GpuProcessInfo[]>();
      for (const [pid, { memMiB, gpuUuid }] of procs) {
        const info = psMap.get(pid);
        if (!anyUuidMatch) continue; // legacy 2-col output: cannot attribute
        const gpuIndex = gpuUuid !== undefined ? uuidToIndex.get(gpuUuid) : undefined;
        if (gpuIndex === undefined) continue; // unmatched uuid: unknown card
        const row: GpuProcessInfo = { pid, user: info?.user ?? '?', name: info?.name ?? '?', cmd: info?.cmd, memoryMiB: memMiB };
        const list = byGpu.get(gpuIndex) ?? [];
        list.push(row);
        byGpu.set(gpuIndex, list);
      }
      for (const gpu of gpus) gpu.processes = byGpu.get(gpu.index) ?? [];
    }
    snap.gpus = gpus;
    const mem = parseMem(memText);
    snap.base = {
      cpuPercent,
      memUsedMiB: mem.usedMiB,
      memTotalMiB: mem.totalMiB,
      disks: parseDisk(diskText),
      load1: parseLoad(loadText),
    };
    // host-level log tail result — a per-GPU log resolving to the SAME path
    // reuses it instead of a second SFTP read of the file
    let hostTail: LogTail | undefined;
    if (runtime.logPath) {
      try {
        // cold start: seed the curves from a larger tail window — the log file
        // itself is the persistence, so a host restart must not zero the history
        const seed = state.path === undefined && state.lastLine === undefined;
        const tail = await readTail(conn, runtime.logPath, seed ? 2_000_000 : 262_144, seed ? 2000 : 20, recycleConn);
        hostTail = tail;
        snap.log = seed ? { ...tail, lines: tail.lines.slice(-20) } : tail;
        state.sshFail = 0;
        if (state.path !== tail.path) {
          state.series.clear();
          state.lastLine = undefined;
          state.lastHeader = undefined;
          state.lastSize = undefined;
          state.lastMtime = undefined;
          state.path = tail.path;
        }
        snap.series = ingestLogLines(state, tail, snap.at, 12, 200);
      } catch {
        snap.log = { path: runtime.logPath, lines: [], size: 0, mtimeMs: 0 };
        // SFTP reads dying while exec still works = a half-dead pooled
        // connection; recycle it after two consecutive failures or the curves
        // never come back
        state.sshFail = (state.sshFail ?? 0) + 1;
        if (state.sshFail >= 2) recycleConn();
      }
    }

    // per-GPU experiment logs: discover the log behind each GPU's processes and
    // keep independent curves per GPU
    if (gpus.length > 0) {
      const gpuStates = state.gpu ??= new Map();
      const logCache = state.logCache ??= new Map();
      // PID-reuse guard: one exec reads the starttime (/proc/<pid>/stat field
      // 22) of every compute process; a cached path only survives while the
      // starttime matches. When the read fails the map stays empty and we
      // degrade to trusting the cache (previous behavior).
      const startTimes = new Map<string, string>();
      if (procs.size > 0) {
        const pidList = [...procs.keys()].map(String);
        const stText = await exec(conn, `for p in ${pidList.join(' ')}; do awk '{print $22}' /proc/$p/stat 2>/dev/null || echo __gone__; done`).catch(() => '');
        stText.split('\n').forEach((l, i) => {
          if (pidList[i] !== undefined) startTimes.set(pidList[i], l.trim());
        });
      }
      const livePids = new Set<string>();
      await Promise.all(gpus.map(async (gpu) => {
        const gpuProcs = gpu.processes.filter((p) => p.memoryMiB > 0).slice(0, 3);
        let gpuLog: LogTail | undefined;
        for (const p of gpuProcs) {
          livePids.add(String(p.pid));
          const pidKey = String(p.pid);
          const cached = logCache.get(pidKey);
          const curStart = startTimes.get(pidKey);
          let path: string | undefined;
          if (cached && Date.now() - cached.at < (cached.path ? LOG_CACHE_TTL_MS : LOG_CACHE_MISS_TTL_MS)) {
            path = cached.path;
            // starttime mismatch = the PID was reused by a new process — the
            // cached path belongs to a dead experiment, rediscover
            if (path && cached.starttime !== undefined && curStart !== undefined && cached.starttime !== curStart) {
              path = undefined;
            }
          } else {
            try { path = await discoverGpuLog(conn, p.pid); } catch { path = undefined; }
            logCache.set(pidKey, { path, at: Date.now(), starttime: curStart });
          }
          if (!path) continue;
          try {
            const key = String(gpu.index);
            let gs = gpuStates.get(key);
            if (!gs) {
              gs = { series: new Map() };
              gpuStates.set(key, gs);
            }
            const seedGpu = gs.path === undefined && gs.lastLine === undefined;
            // same file as the host-level logPath → reuse that tail (one SFTP
            // read instead of two; the seed window then follows the host level)
            const tail = hostTail && hostTail.path === path
              ? hostTail
              : await readTail(conn, path, seedGpu ? 524_288 : 65_536, seedGpu ? 800 : 20, recycleConn);
            gpuLog = seedGpu ? { ...tail, lines: tail.lines.slice(-20) } : tail;
            if (gs.path !== gpuLog.path) {
              gs.series.clear();
              gs.lastLine = undefined;
              gs.lastHeader = undefined;
              gs.lastSize = undefined;
              gs.lastMtime = undefined;
              gs.path = gpuLog.path;
            }
            gpu.log = gpuLog;
            gpu.series = ingestLogLines(gs, gpuLog, snap.at, MAX_GPU_SERIES, MAX_GPU_POINTS);
            break;
          } catch {
            logCache.delete(String(p.pid)); // stale path — rediscover next poll
          }
        }
      }));
      // drop cache rows of processes that are gone
      for (const pid of [...logCache.keys()]) {
        if (!livePids.has(pid)) logCache.delete(pid);
      }
    }
    snap.ok = true;
  };
  try {
    await run();
  } catch (err) {
    // mid-poll failure — most likely the pooled connection died under us:
    // recycle it and retry once on a fresh connection (read-only, idempotent)
    if (state.ssh) {
      try { if (!state.ssh.dead) state.ssh.conn.end(); } catch { /* closing */ }
      state.ssh = undefined;
    }
    try {
      conn = await acquireConn(runtime, state);
      await run();
    } catch (err2) {
      snap.error = err2 instanceof Error ? err2.message : String(err2);
      if (!snap.error && err instanceof Error) snap.error = err.message;
    }
  }
  return snap;
}
