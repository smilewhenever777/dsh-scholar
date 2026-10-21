/**
 * library-peer — 可移植的库级合作桥协议（工作台与旧 Scholar 共用同一份实现）。
 *
 * 安全基线（对应独立审查 5 项探针）：
 *  1. 进程内不按目录放宽互斥：每根一个串行队列 + AsyncLocalStorage 归属令牌——只有
 *     同一异步链（真正持有租约的调用栈）可重入；无关并发调用者必须排队，绝不重叠。
 *  2. 活 PID 永不抢占：owner 存活只看 PID（心跳过期不代表进程死亡——GC/睡眠/繁忙 I/O
 *     都可能暂停心跳定时器）；活 PID → 有界等待 BUSY；ESRCH（已验证死亡）才可恢复；
 *     EPERM/歧义 → 阻塞并保留文件。
 *  3. 路径安全：每次 marker/lease/heartbeat/receipt 访问前，自盘根逐级验证每个已存在
 *     祖先是真实目录（拒绝 junction/symlink），并核对 realpath 规范身份与解析路径一致
 *     （父级别名漂移 fail-closed）；lease 目录及 owner/protocol/receipt/cache-ack 文件
 *     必须是普通文件且 nlink===1（拒绝硬链接），绝不跟随链接写任何字节。
 *  4. 损坏 owner 永不归档/恢复：无法证明 owner 已死（不可解析）→ 有限重试（新写 owner
 *     的落盘窗口）后持续 INVALID 并原样保留；恢复仅限"解析成功且 PID 已验证死亡"的 owner，
 *     恢复前逐项复验目录内容（全部普通文件、已知命名、归档内容可解析），rename 前重读
 *     owner 身份防并发恢复者误搬新 owner；并发恢复靠独占 'wx' 新建 + 失败方重读仲裁。
 *  5. receipt 严格校验：canonical libraryRoot 必须精确等于当前库；pluginRoot/入口/源文件
 *     清单由调用方固定（不允许 receipt 自报任意路径）；sourceSha256s 键集合必须与清单
 *     完全一致且每个源文件哈希实测匹配；全部文件普通且 nlink===1。出站必须持有效
 *     receipt——协议标记/心跳不能证明对端加载了兼容代码。
 *
 * peerCacheReady（live-cache 确认）与 outbound 能力分离：仅当 协议就绪 + 有效 receipt +
 * 活跃 scholar owner + 该 owner 在成功只读重载后写入的 cache-ack 指纹与当前库元数据指纹
 * 一致时为 true；冷装只保证磁盘目的地安全，绝不声称旧端进程缓存已刷新。
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, parse, resolve, sep } from 'node:path';

export const LIBRARY_PEER_PROTOCOL_VERSION = 1;
export const LEASE_DIR_NAME = '.peer-lease';
/** 心跳展示窗口（仅用于状态描述，不参与存活判定）。 */
export const LEASE_TTL_MS = 15_000;
export const LEASE_KNOWN_FILES = ['owner.json', 'protocol.json', 'receipt.json', 'cache-ack.json'] as const;

export interface LeaseOwnerIdentity {
  ownerUuid: string;
  pid: number;
  side: 'workbench' | 'scholar';
  heartbeatAtMs: number;
  protocolVersion: number;
}

export interface LeaseOptions {
  side?: 'workbench' | 'scholar';
  /** 有界等待存活 owner 的最长时间；超时抛 PEER_LEASE_BUSY。 */
  timeoutMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

export interface ReceiptExpectation {
  /** 固定的旧插件根（由登记/enrollment 提供，receipt 不得自报）。 */
  pluginRoot: string;
  entryRelPath: string;
  /** 必须逐一验证的源文件相对路径清单。 */
  sourceAllowlist: string[];
  /** 必须逐一验证的关键构建产物（未打包 dist JS）相对路径清单——入口哈希不能代表实际加载实现。 */
  buildRelPaths?: string[];
}

/** 同步对端是否在本库在册（协议标记存在且版本一致）——只读探测，供 init 自愈让路判定。 */
export async function isPeerProtocolEnrolled(libraryRoot: string): Promise<boolean> {
  try {
    const root = await validatedLibraryRoot(libraryRoot);
    const raw = await readControlledFile(join(root, LEASE_DIR_NAME, 'protocol.json'));
    if (raw === null) return false;
    const p = JSON.parse(raw) as { version?: unknown };
    return p.version === LIBRARY_PEER_PROTOCOL_VERSION;
  } catch { return false; }
}

class LeaseError extends Error {}
const busy = () => new LeaseError('PEER_LEASE_BUSY');
const invalid = (why: string) => new LeaseError(`PEER_LEASE_INVALID:${why}`);

/* ---------- 归属令牌 + 每根串行队列：同异步链可重入，无关调用者排队不重叠 ---------- */

const leaseAls = new AsyncLocalStorage<{ leaseKey: string }>();
const rootQueues = new Map<string, Promise<unknown>>();
/** 每根当前持有者（仅由持有链内写入）；depth 支持同一异步链的嵌套。 */
const heldRoots = new Map<string, { identity: LeaseOwnerIdentity; depth: number }>();

/* ---------- 路径安全：盘根起祖先链 + 规范身份，每次访问前执行 ---------- */

async function assertRealDirChain(base: string, to: string, requireFinal: boolean): Promise<void> {
  if (to === base) return;
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!to.startsWith(prefix)) throw invalid('path escapes base');
  let cur = base;
  const comps = to.slice(prefix.length).split(sep).filter(Boolean);
  for (let i = 0; i < comps.length; i++) {
    cur = join(cur, comps[i]!);
    const st = await lstat(cur).catch(() => null);
    if (!st) {
      if (requireFinal && i === comps.length - 1) throw invalid('library root does not exist');
      return; // 中途缺失：更深层不可能存在
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw invalid(`component not a real directory: ${cur}`);
  }
}

/** 每次租约/标记/receipt 访问前的根验证：所有已存在祖先真实目录 + realpath 身份一致。 */
async function validatedLibraryRoot(libraryRoot: string): Promise<string> {
  const resolved = resolve(libraryRoot);
  await assertRealDirChain(parse(resolved).root, resolved, true);
  let canonical: string;
  try { canonical = realpathSync(resolved).toLowerCase(); }
  catch { throw invalid('cannot resolve library root identity'); }
  if (canonical !== resolved.toLowerCase()) {
    throw invalid('library root is reachable only through an alias (junction/symlink ancestor)');
  }
  return resolved;
}

/** 租约目录：缺失则原子创建；存在必须真实目录且链路无链接；创建后复验。 */
async function ensureLeaseDir(root: string): Promise<string> {
  const leaseDir = join(root, LEASE_DIR_NAME);
  const st = await lstat(leaseDir).catch(() => null);
  if (!st) {
    try { await mkdir(leaseDir); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw invalid('cannot create lease directory');
    }
  } else if (st.isSymbolicLink() || !st.isDirectory()) {
    throw invalid('lease directory is a link');
  }
  await assertRealDirChain(root, leaseDir, false);
  return leaseDir;
}

/** 受控文件读取：普通文件、nlink===1（拒绝符号链接与硬链接），不跟随。 */
async function readControlledFile(file: string): Promise<string | null> {
  const st = await lstat(file).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw invalid(`controlled file is not a regular file: ${file}`);
  if (st.nlink !== 1) throw invalid(`controlled file has multiple links: ${file}`);
  return readFile(file, 'utf8').catch(() => null);
}

function pidLiveness(pid: number): 'alive' | 'dead' | 'uncertain' {
  if (pid === process.pid) return 'alive';
  try { process.kill(pid, 0); return 'alive'; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'uncertain'; }
}

function parseOwner(raw: string): LeaseOwnerIdentity | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.ownerUuid !== 'string' || !/^[0-9a-f-]{8,64}$/.test(v.ownerUuid)) return null;
    if (!Number.isSafeInteger(v.pid) || (v.pid as number) <= 0) return null;
    if (v.side !== 'workbench' && v.side !== 'scholar') return null;
    if (!Number.isFinite(v.heartbeatAtMs)) return null;
    if (v.protocolVersion !== LIBRARY_PEER_PROTOCOL_VERSION) return null;
    return {
      ownerUuid: v.ownerUuid, pid: v.pid as number, side: v.side,
      heartbeatAtMs: v.heartbeatAtMs as number, protocolVersion: v.protocolVersion as number,
    };
  } catch { return null; }
}

const ownerFileOf = (leaseDir: string) => join(leaseDir, 'owner.json');

async function writeOwnerAtomic(leaseDir: string, identity: LeaseOwnerIdentity): Promise<void> {
  const file = ownerFileOf(leaseDir);
  const tmp = join(leaseDir, `.tmp-owner-${randomUUID().slice(0, 8)}`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(JSON.stringify(identity, null, 1), 'utf8');
    await fh.sync();
  } finally { await fh.close(); }
  try {
    // Windows 并发读句柄会让 rename 报 EPERM：有界重试（读方微秒级持锁）
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, file); break; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') && attempt < 10) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        throw err;
      }
    }
  }
  catch (err) { await unlink(tmp).catch(() => {}); throw err; }
}

async function readOwner(leaseDir: string): Promise<{ owner: LeaseOwnerIdentity | null; exists: boolean }> {
  const raw = await readControlledFile(ownerFileOf(leaseDir));
  if (raw === null) {
    const st = await lstat(ownerFileOf(leaseDir)).catch(() => null);
    return { owner: null, exists: st !== null };
  }
  return { owner: parseOwner(raw), exists: true };
}

/** 恢复前置校验：目录内每一项都必须是普通文件、命中已知命名；归档 owner 内容必须可解析。 */
async function assertLeaseDirRecoverable(leaseDir: string): Promise<void> {
  const names = await readdir(leaseDir).catch(() => []);
  for (const name of names) {
    const st = await lstat(join(leaseDir, name)).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) throw invalid(`unknown lease entry type: ${name}`);
    if (st.nlink !== 1) throw invalid(`lease entry has multiple links: ${name}`);
    const isKnown = (LEASE_KNOWN_FILES as readonly string[]).includes(name)
      || /^owner\.json\.stale-[0-9a-f-]{8,64}$/.test(name)
      || /^\.tmp-/.test(name);
    if (!isKnown) throw invalid(`unknown lease content: ${name}`);
    if (/^owner\.json\.stale-/.test(name)) {
      const raw = await readControlledFile(join(leaseDir, name));
      if (raw === null || parseOwner(raw) === null) throw invalid(`stale archive unreadable: ${name}`);
    }
  }
}

async function acquireOwnerSlot(
  leaseDir: string, identity: LeaseOwnerIdentity, options: LeaseOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  const malformedWindow = Math.min(750, timeoutMs);
  const malformedSince = Date.now();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 每轮访问前重验根与租约目录（父链漂移 fail-closed）
    const fh = await open(ownerFileOf(leaseDir), 'wx').catch((err: NodeJS.ErrnoException) =>
      err.code === 'EEXIST' ? null : Promise.reject(err));
    if (fh) {
      try {
        await fh.writeFile(JSON.stringify(identity, null, 1), 'utf8');
        await fh.sync();
      } finally { await fh.close(); }
      return;
    }
    const { owner, exists } = await readOwner(leaseDir);
    if (exists && owner === null) {
      // 不可解析：可能是新写 owner 的落盘窗口——有限重试；持续损坏则拒绝并保留
      if (Date.now() - malformedSince > malformedWindow) throw invalid('malformed owner.json');
      if (Date.now() > deadline) throw busy();
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (owner && owner.ownerUuid === identity.ownerUuid) return;
    const liveness = owner ? pidLiveness(owner.pid) : 'dead';
    if (owner && liveness === 'alive') {
      if (Date.now() > deadline) throw busy();
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (owner && liveness === 'uncertain') {
      throw invalid(`owner liveness unverifiable (pid ${owner.pid})`);
    }
    // owner 为空，或已验证死亡：内容复验后原子恢复；rename 前重读身份防误搬新 owner
    await assertLeaseDirRecoverable(leaseDir);
    const reread = await readOwner(leaseDir);
    if (owner && !(reread.exists && reread.owner && reread.owner.ownerUuid === owner.ownerUuid
      && reread.owner.pid === owner.pid)) {
      continue; // 身份已变（并发恢复/新建）：重新仲裁
    }
    if (!owner && reread.exists) continue; // 期间出现新 owner：重新仲裁
    const staleName = join(leaseDir, `owner.json.stale-${randomUUID().slice(0, 8)}`);
    try {
      await rename(ownerFileOf(leaseDir), staleName);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (Date.now() > deadline) throw busy();
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
    }
    if (Date.now() > deadline) throw busy();
  }
}

/** 库级写租约：同异步链可重入（ALS 令牌）；同根所有调用者在进程内严格 FIFO 串行；跨进程文件互斥。
 *  队位在同步阶段即占用（resolve 求 key），任何 fs 验证都在队槽内进行，保证调用顺序=执行顺序。 */
export async function withLibraryLease<T>(libraryRoot: string, options: LeaseOptions, fn: () => Promise<T>): Promise<T> {
  const key = resolve(libraryRoot).toLowerCase(); // 同步占位：FIFO 与互斥的基准
  const token = leaseAls.getStore();
  if (token && token.leaseKey === key) {
    const held = heldRoots.get(key);
    if (held) {
      held.depth++;
      try { return await fn(); } finally { held.depth--; }
    }
  }
  const identity: LeaseOwnerIdentity = {
    ownerUuid: randomUUID(), pid: process.pid, side: options.side ?? 'scholar',
    heartbeatAtMs: Date.now(), protocolVersion: LIBRARY_PEER_PROTOCOL_VERSION,
  };
  // 每根串行队列：获取→执行→释放为一个槽位，进程内调用者绝不重叠
  const run = (rootQueues.get(key) ?? Promise.resolve()).then(() => attempt(), () => attempt());
  rootQueues.set(key, run.then(() => undefined, () => undefined));
  return run;

  async function attempt(): Promise<T> {
    const root = await validatedLibraryRoot(libraryRoot);
    const leaseDir = await ensureLeaseDir(root);
    await acquireOwnerSlot(leaseDir, identity, options);
    heldRoots.set(key, { identity, depth: 1 });
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let released = false;
    // 迟到心跳防护：释放先置 released 并停表，再等在速心跳写完，最后才 unlink——
    // 任何异步心跳都不能在释放后重建 owner.json
    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (released) return;
        identity.heartbeatAtMs = Date.now();
        heartbeatInFlight = heartbeatInFlight.then(() =>
          released ? undefined : writeOwnerAtomic(leaseDir, identity)).catch(() => {});
      }, heartbeatMs);
      heartbeat.unref?.();
    }
    try {
      return await leaseAls.run({ leaseKey: key }, fn);
    } finally {
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      const held = heldRoots.get(key);
      if (held && held.identity.ownerUuid === identity.ownerUuid) {
        held.depth--;
        if (held.depth <= 0) {
          heldRoots.delete(key);
          await heartbeatInFlight.catch(() => {}); // 在速心跳落定后才释放
          // 只释放仍属于本 owner 的租约；被恢复/接管后绝不删除他人文件
          const current = await readOwner(leaseDir).catch(() => ({ owner: null, exists: false }));
          if (current.owner && current.owner.ownerUuid === identity.ownerUuid) {
            await unlink(ownerFileOf(leaseDir)).catch(() => {});
          }
        }
      }
    }
  }
}

/** 本端就绪声明：写入协议标记（旧端插件启动/工作台激活时调用）。 */
export async function writeProtocolMarker(libraryRoot: string, side: 'workbench' | 'scholar'): Promise<void> {
  const root = await validatedLibraryRoot(libraryRoot);
  const leaseDir = await ensureLeaseDir(root);
  const tmp = join(leaseDir, `.tmp-protocol-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, JSON.stringify({ version: LIBRARY_PEER_PROTOCOL_VERSION, side, at: Date.now() }, null, 1), 'utf8');
  try { await rename(tmp, join(leaseDir, 'protocol.json')); }
  catch (err) { await unlink(tmp).catch(() => {}); throw err; }
}

export interface PeerReceipt {
  version: 1;
  libraryRoot: string;
  pluginRoot: string;
  protocolVersion: number;
  entrySha256: string;
  sourceSha256s: Record<string, string>;
  /** 关键构建产物（未打包 dist JS）的实测哈希；与 expectation.buildRelPaths 完全一致地校验。 */
  buildSha256s?: Record<string, string>;
  installedAt: number;
  installedBy: string;
}

function sha256File(abs: string): Promise<string | null> {
  return readFile(abs).then((b) => createHash('sha256').update(b).digest('hex'), () => null);
}

/** 受限相对路径：白名单成员、无穿越、无绝对/盘符。 */
function allowlistedUnder(pluginRoot: string, rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\\') || rel.includes('..') || rel.startsWith('/')
    || /^[a-zA-Z]:/.test(rel)) throw invalid(`receipt path not allowlisted: ${rel}`);
  return join(pluginRoot, ...rel.split('/'));
}

/** 冷装 receipt 校验（P5）：canonical libraryRoot 精确匹配、固定插件根/入口/源清单、
 *  源哈希全验、全部受控文件普通且无硬链接；receipt 不得自报任意可读路径。
 *  无 expectation 时只做库根一致性等基础校验并一律判 not-valid（不声称完成完整验证）。 */
export async function validateReceipt(
  libraryRoot: string,
  expectation?: ReceiptExpectation,
): Promise<{ valid: true; receipt: PeerReceipt } | { valid: false; reason: string } | null> {
  let root: string;
  try { root = await validatedLibraryRoot(libraryRoot); }
  catch { return { valid: false, reason: 'RECEIPT_LIBRARY_ROOT_INVALID' }; }
  const leaseDir = join(root, LEASE_DIR_NAME);
  let raw: string | null;
  try { raw = await readControlledFile(join(leaseDir, 'receipt.json')); }
  catch { return { valid: false, reason: 'RECEIPT_FILE_INVALID' }; }
  if (raw === null) return null;
  let parsed: PeerReceipt;
  try { parsed = JSON.parse(raw) as PeerReceipt; }
  catch { return { valid: false, reason: 'RECEIPT_MALFORMED' }; }
  const shapeOk = parsed.version === 1
    && typeof parsed.libraryRoot === 'string' && typeof parsed.pluginRoot === 'string'
    && parsed.protocolVersion === LIBRARY_PEER_PROTOCOL_VERSION
    && typeof parsed.entrySha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.entrySha256)
    && parsed.sourceSha256s !== null && typeof parsed.sourceSha256s === 'object' && !Array.isArray(parsed.sourceSha256s)
    && Number.isFinite(parsed.installedAt) && parsed.installedAt > 0
    && typeof parsed.installedBy === 'string' && parsed.installedBy.length > 0 && parsed.installedBy.length <= 128;
  if (!shapeOk) return { valid: false, reason: 'RECEIPT_SHAPE_INVALID' };
  // 库根必须精确等于当前库（canonical 比较；他库拷贝的 receipt 一律拒绝）
  let receiptLibCanonical: string;
  try { receiptLibCanonical = realpathSync(parsed.libraryRoot).toLowerCase(); }
  catch { return { valid: false, reason: 'RECEIPT_LIBRARY_ROOT_UNRESOLVABLE' }; }
  if (receiptLibCanonical !== root.toLowerCase()) return { valid: false, reason: 'RECEIPT_LIBRARY_ROOT_MISMATCH' };
  if (!expectation) return { valid: false, reason: 'RECEIPT_EXPECTATION_REQUIRED' };
  // 插件根必须等于固定期望（canonical 比较）
  let expectedCanonical: string;
  try { expectedCanonical = realpathSync(expectation.pluginRoot).toLowerCase(); }
  catch { return { valid: false, reason: 'RECEIPT_EXPECTATION_INVALID' }; }
  let receiptPluginCanonical: string;
  try { receiptPluginCanonical = realpathSync(parsed.pluginRoot).toLowerCase(); }
  catch { return { valid: false, reason: 'RECEIPT_PLUGIN_ROOT_UNRESOLVABLE' }; }
  if (receiptPluginCanonical !== expectedCanonical) return { valid: false, reason: 'RECEIPT_PLUGIN_ROOT_MISMATCH' };
  // 源哈希键集合必须与清单完全一致（缺项/多项/空清单都无效）
  const keys = Object.keys(parsed.sourceSha256s);
  if (keys.length === 0 || keys.length !== expectation.sourceAllowlist.length
    || expectation.sourceAllowlist.some((rel) => !keys.includes(rel))
    || keys.some((k) => !expectation.sourceAllowlist.includes(k))) {
    return { valid: false, reason: 'RECEIPT_SOURCE_SET_MISMATCH' };
  }
  for (const [rel, recorded] of Object.entries(parsed.sourceSha256s)) {
    if (typeof recorded !== 'string' || !/^[a-f0-9]{64}$/.test(recorded)) return { valid: false, reason: 'RECEIPT_SOURCE_HASH_MALFORMED' };
    const file = allowlistedUnder(expectation.pluginRoot, rel);
    let st;
    try { st = await lstat(file); }
    catch { return { valid: false, reason: 'RECEIPT_SOURCE_MISSING' }; }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return { valid: false, reason: 'RECEIPT_SOURCE_FILE_INVALID' };
    const actual = await sha256File(file);
    if (actual === null || actual !== recorded) return { valid: false, reason: 'RECEIPT_SOURCE_HASH_MISMATCH' };
  }
  const entry = allowlistedUnder(expectation.pluginRoot, expectation.entryRelPath);
  let entrySt;
  try { entrySt = await lstat(entry); }
  catch { return { valid: false, reason: 'RECEIPT_ENTRY_MISSING' }; }
  if (entrySt.isSymbolicLink() || !entrySt.isFile() || entrySt.nlink !== 1) return { valid: false, reason: 'RECEIPT_ENTRY_FILE_INVALID' };
  const entryHash = await sha256File(entry);
  if (entryHash === null || entryHash !== parsed.entrySha256) return { valid: false, reason: 'RECEIPT_ENTRY_HASH_MISMATCH' };
  // 关键构建产物全验：入口未打包时 entry 哈希不能证明实际加载的实现——
  // buildRelPaths 与 receipt.buildSha256s 必须集合完全一致且每个 dist JS 实测匹配
  if (expectation.buildRelPaths !== undefined) {
    if (!Array.isArray(expectation.buildRelPaths) || expectation.buildRelPaths.length === 0) {
      return { valid: false, reason: 'RECEIPT_EXPECTATION_INVALID' };
    }
    const buildMap = parsed.buildSha256s;
    if (buildMap === null || typeof buildMap !== 'object' || Array.isArray(buildMap)) {
      return { valid: false, reason: 'RECEIPT_BUILD_SET_MISMATCH' };
    }
    const buildKeys = Object.keys(buildMap);
    if (buildKeys.length !== expectation.buildRelPaths.length
      || expectation.buildRelPaths.some((rel) => !buildKeys.includes(rel))
      || buildKeys.some((k) => !expectation.buildRelPaths!.includes(k))) {
      return { valid: false, reason: 'RECEIPT_BUILD_SET_MISMATCH' };
    }
    for (const [rel, recorded] of Object.entries(buildMap)) {
      if (typeof recorded !== 'string' || !/^[a-f0-9]{64}$/.test(recorded)) return { valid: false, reason: 'RECEIPT_BUILD_HASH_MALFORMED' };
      const file = allowlistedUnder(expectation.pluginRoot, rel);
      let st;
      try { st = await lstat(file); }
      catch { return { valid: false, reason: 'RECEIPT_BUILD_MISSING' }; }
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return { valid: false, reason: 'RECEIPT_BUILD_FILE_INVALID' };
      const actual = await sha256File(file);
      if (actual === null || actual !== recorded) return { valid: false, reason: 'RECEIPT_BUILD_HASH_MISMATCH' };
    }
  }
  return { valid: true, receipt: parsed };
}

/* ---------- cache-ack：只读重载成功后的指纹确认 ---------- */

export interface CacheAck { side: 'scholar' | 'workbench'; ownerUuid: string; pid: number; fingerprint: string; at: number }

/** 旧端在成功只读重载（refreshFromDisk 无异常）后写入指纹确认。
 *  guard（可选）在原子发布 rename 前最后一次执行：异步读期间 store 被弃用（dispose/目录切换）
 *  时拒绝迟到的发布——已弃 store 绝不落地新的 cache-ack。 */
export async function writeCacheAck(libraryRoot: string, ownerUuid: string, fingerprint: string, guard?: () => boolean): Promise<void> {
  const root = await validatedLibraryRoot(libraryRoot);
  const leaseDir = await ensureLeaseDir(root);
  const ack: CacheAck = { side: 'scholar', ownerUuid, pid: process.pid, fingerprint, at: Date.now() };
  const tmp = join(leaseDir, `.tmp-ack-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, JSON.stringify(ack, null, 1), 'utf8');
  try {
    if (guard && !guard()) throw new Error('PEER_ACK_GUARD_REJECTED: store disposed before ack publication');
    // Windows 并发读句柄会让 rename 报 EPERM：有界重试（读方微秒级持锁）
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, join(leaseDir, 'cache-ack.json')); break; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') && attempt < 10 && (!guard || guard())) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        throw err;
      }
    }
  }
  catch (err) { await unlink(tmp).catch(() => {}); throw err; }
}

async function readCacheAck(root: string): Promise<CacheAck | null> {
  let raw: string | null;
  try { raw = await readControlledFile(join(root, LEASE_DIR_NAME, 'cache-ack.json')); }
  catch { return null; }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.side !== 'scholar' || typeof v.ownerUuid !== 'string' || !Number.isSafeInteger(v.pid)
      || typeof v.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint) || !Number.isFinite(v.at)) return null;
    return { side: 'scholar', ownerUuid: v.ownerUuid as string, pid: v.pid as number, fingerprint: v.fingerprint as string, at: v.at as number };
  } catch { return null; }
}

export interface PeerBridgeStatus {
  protocolReady: boolean;
  activeOwner: { pid: number; side: string; heartbeatAgeMs: number } | null;
  coldReceipt: { valid: true } | { valid: false; reason: string } | null;
  /** 出站能力 = 协议就绪 + 有效冷装 receipt（标记/心跳不构成代码加载证明），活跃 owner 额外加分。 */
  outboundAllowed: boolean;
  /** live-cache 确认 = 上述全部 + 活跃 scholar owner + 该 owner 的指纹 ack 与当前库元数据一致。 */
  peerCacheReady: boolean;
  note: string;
}

export async function peerBridgeStatus(libraryRoot: string, expectation?: ReceiptExpectation): Promise<PeerBridgeStatus> {
  let root: string;
  try { root = await validatedLibraryRoot(libraryRoot); }
  catch {
    return { protocolReady: false, activeOwner: null, coldReceipt: null, outboundAllowed: false, peerCacheReady: false,
      note: '原端目录不可用（缺失/为链接/别名漂移）' };
  }
  const leaseDir = join(root, LEASE_DIR_NAME);
  let protocolReady = false;
  try {
    const raw = await readControlledFile(join(leaseDir, 'protocol.json'));
    if (raw !== null) {
      const p = JSON.parse(raw) as { version?: unknown };
      protocolReady = p.version === LIBRARY_PEER_PROTOCOL_VERSION;
    }
  } catch { protocolReady = false; }
  let owner: LeaseOwnerIdentity | null = null;
  try {
    const r = await readOwner(leaseDir);
    owner = r.owner;
  } catch { owner = null; }
  const live = owner !== null && pidLiveness(owner!.pid) === 'alive' ? {
    pid: owner!.pid, side: owner!.side, heartbeatAgeMs: Date.now() - owner!.heartbeatAtMs,
  } : null;
  const receipt = expectation ? await validateReceipt(root, expectation) : null;
  const receiptValid = receipt !== null && receipt.valid;
  const outboundAllowed = protocolReady && receiptValid;
  let peerCacheReady = false;
  let note: string;
  if (receiptValid) {
    // live-cache 确认：与写租约 owner 解耦的成员 ack——旧端实例成功只读重载后写入，
    // 其 PID 必须存活、ack 新鲜（重载轮询 ≤2s），且指纹与当前库元数据一致
    const ack = await readCacheAck(root).catch(() => null);
    const ackAlive = ack !== null && pidLiveness(ack.pid) === 'alive';
    const ackFresh = ackAlive && Date.now() - ack.at < 10_000;
    if (ackAlive && ackFresh) {
      const fp = await libraryMetadataFingerprint(root);
      peerCacheReady = ack.fingerprint === fp;
      note = peerCacheReady
        ? `原端实例活跃（pid ${ack.pid}）且重载确认指纹一致（live cache 已确认）`
        : '原端实例活跃但重载确认指纹落后于当前库状态（缓存待刷新）';
    } else if (ackAlive) {
      note = '原端实例存活但重载确认过期（如系统睡眠/繁忙 I/O 暂停刷新）——不声称缓存已刷新';
    } else {
      note = '冷装 receipt 已验证（磁盘目的地安全），无运行中的旧端缓存——peerCacheReady 保持 false';
    }
  } else {
    note = '缺少有效冷装 receipt：出站保持 pending（标记/心跳不构成代码加载证明）';
  }
  return { protocolReady, activeOwner: live, coldReceipt: receipt, outboundAllowed, peerCacheReady, note };
}

/** 有界元数据指纹：白名单目录的 name+size+mtimeNs 摘要（不做附件内容轮询）。 */
export async function libraryMetadataFingerprint(libraryRoot: string, maxEntries = 5_000): Promise<string> {
  const root = await validatedLibraryRoot(libraryRoot);
  const parts: string[] = [];
  for (const dir of ['papers', 'cards', 'attachments', 'reports']) {
    const dirAbs = join(root, dir);
    const names = await readdir(dirAbs).catch(() => []);
    for (const name of names.slice(0, maxEntries)) {
      const st = await lstat(join(dirAbs, name), { bigint: true }).catch(() => null);
      if (!st) continue;
      parts.push(`${dir}/${name}:${st.size}:${st.mtimeNs}`);
    }
    if (names.length > maxEntries) parts.push(`${dir}:TRUNCATED:${names.length}`);
  }
  for (const fixed of ['graph.json', 'collections.json']) {
    const st = await lstat(join(root, fixed), { bigint: true }).catch(() => null);
    parts.push(st ? `${fixed}:${st.size}:${st.mtimeNs}` : `${fixed}:absent`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export { parseOwner };
export function isLeaseBusy(err: unknown): boolean {
  return err instanceof LeaseError && err.message.includes('PEER_LEASE_BUSY');
}
export function isLeaseError(err: unknown): err is LeaseError {
  return err instanceof LeaseError;
}
