/**
 * 派发持久层(P1):单写入者 JSON store。
 * 依据 §4.6(原子保存/备份/快照目录)、§4.7(单写入者与损坏处理)。
 *
 * - 根对象 $DSH_HOME/dispatch/dispatches.json:dispatches + 幂等索引 + revision,整体原子替换
 * - 写入互斥:进程内 promise 链 + 跨进程 writer.lock(exclusive-create;仅当持锁 PID 可证已死才允许接管)
 * - 损坏:保留原文件,进入只读故障态,拒绝一切写(不备份后重建空 store)
 */
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DispatchRecord } from './types.js';
import { ServiceError } from './types.js';

export interface DispatchStoreRoot {
  schemaVersion: 3;
  revision: number;
  dispatches: Record<string, DispatchRecord>;
  /** key = `${actorScope}\u0000${idempotencyKey}` */
  idempotency: Record<string, { dispatchId: string; payloadHash: string }>;
  savedAt?: number;
}

/** 幂等索引键:统一 NUL 分隔(actorScope 已在服务层去空格,双保险)。
 * 全项目唯一合法构造点——此前出现过 NUL/空格两种分隔混用的 bug。 */
export function idemKey(actorScope: string, key: string): string {
  return actorScope + String.fromCharCode(0) + key;
}

export function idemNodeKey(projectId: string, nodeId: string): string {
  return projectId + String.fromCharCode(0) + nodeId;
}

export function dshHome(): string {
  const home = process.env.DSH_HOME?.trim();
  return home || join(homedir(), '.dsh');
}

interface LockInfo { pid: number; bootId: string; at: number }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 存在但无权限(Windows 常见)→ 视为存活;ESRCH = 不存在
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class DispatchStore {
  readonly dir: string;
  private readonly file: string;
  private root: DispatchStoreRoot | null = null;
  private writeLock: Promise<unknown> = Promise.resolve();
  /** 只读故障态(损坏/未取得锁):一切写操作拒绝。 */
  readonly fault: { readOnly: boolean; reason?: string } = { readOnly: false };
  private lockInfo: LockInfo | null = null;

  constructor(homeOverride?: string) {
    this.dir = join(homeOverride ?? dshHome(), 'dispatch');
    this.file = join(this.dir, 'dispatches.json');
  }

  /* ---------- 单写入者锁 ---------- */

  private lockFile(): string {
    return join(this.dir, 'writer.lock');
  }

  /** §4.7:取得独占锁才允许写模式;持锁者可证已死时接管并留痕;其余一律拒绝。 */
  private acquireLock(): void {
    const p = this.lockFile();
    try {
      const fd = openSync(p, 'wx');
      const info: LockInfo = { pid: process.pid, bootId: `${Date.now().toString(36)}`, at: Date.now() };
      writeFileSync(fd, JSON.stringify(info), 'utf8');
      closeSync(fd);
      this.lockInfo = info;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // 已有锁:空文件(创建者中途崩溃,从未持锁)→ 可安全替换
    let raw = '';
    try { raw = readFileSync(p, 'utf8'); } catch { /* 读失败按损坏处理 */ }
    if (raw.trim() === '') {
      try { unlinkSync(p); } catch { /* 竞争失败则重走创建 */ }
      return this.acquireLock();
    }
    let held: LockInfo | null = null;
    try { held = JSON.parse(raw) as LockInfo; } catch { held = null; }
    if (held && typeof held.pid === 'number' && held.pid !== process.pid && pidAlive(held.pid)) {
      this.fault.readOnly = true;
      this.fault.reason = `writer.lock 被存活进程 ${held.pid} 持有`;
      return;
    }
    if (held && held.pid === process.pid) {
      this.lockInfo = held; // 同进程重入(测试场景)
      return;
    }
    // 持锁者可证已死(PID 不存在)或内容不可判读为存活 → 移作 stale 后接管
    const stale = `${p}.stale-${Date.now().toString(36)}`;
    try { renameSync(p, stale); } catch {
      this.fault.readOnly = true;
      this.fault.reason = 'writer.lock 存在但无法接管(竞争失败)';
      return;
    }
    return this.acquireLock();
  }

  /* ---------- 初始化 / 持久化 ---------- */

  /** 加载(并取锁)。损坏 → 只读故障态;首次运行 → 空 root。 */
  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.acquireLock();
    if (!existsSync(this.file)) {
      if (this.fault.readOnly) return; // 无锁也至少允许读空?
      this.root = { schemaVersion: 3, revision: 0, dispatches: {}, idempotency: {} };
      this.persistLocked();
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      this.fault.readOnly = true;
      this.fault.reason = `dispatches.json 读取失败:${String(e)}`;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as DispatchStoreRoot | (Omit<DispatchStoreRoot, 'schemaVersion'> & { schemaVersion: 2 });
      if ((parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)
        || typeof parsed.dispatches !== 'object' || parsed.dispatches === null
        || typeof parsed.idempotency !== 'object' || parsed.idempotency === null) {
        throw new Error(`schemaVersion=${parsed.schemaVersion}`);
      }
      this.root = { ...parsed, schemaVersion: 3 };
      // v2 stays in the .bak file; individual legacy records are not rewritten.
      if (parsed.schemaVersion === 2 && !this.fault.readOnly) this.persistLocked();
    } catch (e) {
      // §4.7:损坏文件原地保留,只读故障,绝不"备份后建空 store 继续"
      this.fault.readOnly = true;
      this.fault.reason = `dispatches.json 损坏(${String(e)});原件原样保留`;
      this.root = null;
    }
  }

  private persistLocked(): void {
    if (!this.root) throw new ServiceError('STORE_READONLY', this.fault.reason ?? 'store 未初始化', 503);
    if (this.fault.readOnly) throw new ServiceError('STORE_READONLY', this.fault.reason ?? 'store 只读', 503);
    this.root.revision += 1;
    this.root.savedAt = Date.now();
    const tmp = `${this.file}.${process.pid}-${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.root), 'utf8');
    // 备份旧版本(保留最近 3 份)
    if (existsSync(this.file)) {
      try {
        const bak = `${this.file}.bak`;
        if (existsSync(bak)) {
          const older = `${bak}.1`;
          if (existsSync(older)) unlinkSync(older);
          renameSync(bak, older);
        }
        renameSync(this.file, bak);
      } catch { /* 备份失败不阻断替换 */ }
    }
    try {
      renameSync(tmp, this.file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
      if (!existsSync(this.file) && existsSync(`${this.file}.bak`)) {
        try { renameSync(`${this.file}.bak`, this.file); } catch { /* keep backup for manual recovery */ }
      }
      throw new ServiceError('INTERNAL', `原子替换失败:${String(e)}`, 500);
    }
  }

  /** §2.5:锁内只做校验、归约与持久化;fn 内禁止跨进程调用。 */
  async mutate<T>(fn: () => T): Promise<T> {
    if (this.fault.readOnly || !this.root) {
      throw new ServiceError('STORE_READONLY', this.fault.reason ?? 'store 只读/未初始化', 503);
    }
    const run = async (): Promise<T> => {
      const out = fn();
      this.persistLocked();
      return out;
    };
    const next = this.writeLock.then(run, run);
    this.writeLock = next.catch(() => undefined);
    return next;
  }

  /* ---------- 查询(锁外只读快照) ---------- */

  snapshot(): DispatchStoreRoot | null {
    return this.root;
  }

  get(id: string): DispatchRecord | undefined {
    return this.root?.dispatches[id];
  }

  findByIdempotency(actorScope: string, key: string): { dispatchId: string; payloadHash: string } | undefined {
    return this.root?.idempotency[idemKey(actorScope, key)];
  }

  all(): DispatchRecord[] {
    return Object.values(this.root?.dispatches ?? {});
  }

  /** 活跃占用检查(§2.2 第 4 步临界区复查用):同一节点/同一规范化工作区/全局执行槽。 */
  occupancy(): { nodeKeys: Set<string>; workspaceRoots: Set<string>; activeAttempts: number } {
    const nodeKeys = new Set<string>();
    const workspaceRoots = new Set<string>();
    let activeAttempts = 0;
    for (const d of this.all()) {
      if (d.phase === 'finished') continue;
      if (d.reservation.targetHeld) nodeKeys.add(idemNodeKey(d.targetRef.projectId, d.targetRef.nodeId));
      if (d.reservation.workspaceHeld) workspaceRoots.add(d.targetRef.canonicalRoot);
      if (d.reservation.executionSlotHeld) activeAttempts += 1;
    }
    return { nodeKeys, workspaceRoots, activeAttempts };
  }

  /** 按 childSessionId 反查(P0:exec.agent.id 即 childSessionId,工具归属解析入口)。 */
  findByChildSessionId(childId: string): DispatchRecord | undefined {
    return this.all().find((d) => d.runtime.childSessionId === childId);
  }

  /** 释放锁(正常停机/测试拆卸)。 */
  dispose(): void {
    if (this.lockInfo) {
      try { unlinkSync(this.lockFile()); } catch { /* 已不存在 */ }
      this.lockInfo = null;
    }
  }
}
