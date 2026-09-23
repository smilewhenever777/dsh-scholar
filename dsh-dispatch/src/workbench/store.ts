import { randomBytes, createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dshHome } from '../store.js';
import { ServiceError } from '../types.js';

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
export type TimelineKind = 'comment' | 'progress' | 'run' | 'review';
export interface TimelineEvent { id: string; kind: TimelineKind; at: number; text: string; runId?: string; actor: string }

/** v2:分派对象——为小队预留多态,旧 assigneeId 迁移为 {kind:'agent', id} */
export interface Assignment { kind: 'agent' | 'squad'; id: string }

export interface Project {
  id: string;
  title: string;
  root: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** v2:项目目标(一段话描述研究/工作目的) */
  goal?: string;
  /** v2:自由说明(方法论、成员分工等) */
  description?: string;
  /** v2:归档时间——非终态,仅影响列表排序和默认筛选 */
  archivedAt?: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  instructions: string;
  model: string;
  toolAllow: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** v2:展示用角色描述——不注入提示词,仅 UI 显示(阶段 B §2) */
  displayDescription?: string;
}

export interface WorkTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** v2:分派对象(agent 或 squad);旧 assigneeId 由迁移生成 */
  assignment?: Assignment;
  /** v1 兼容读取:迁移后此字段不再写入 */
  assigneeId?: string;
  status: TaskStatus;
  revision: number;
  contentVersion: number;
  createdAt: number;
  updatedAt: number;
  runIds: string[];
  timeline: TimelineEvent[];
  leaseEpoch: number;
  owner?: { dispatchId: string; childSessionId: string; epoch: number; fingerprint: string; workerWrites: boolean; revoked?: boolean };
  operations: Record<string, { hash: string; appliedAt: number }>;
}

export interface WorkbenchRoot {
  schemaVersion: 2;
  revision: number;
  projects: Record<string, Project>;
  agents: Record<string, AgentProfile>;
  tasks: Record<string, WorkTask>;
  savedAt?: number;
}

export function newId(prefix: string): string { return `${prefix}_${randomBytes(8).toString('hex')}`; }
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** v1→v2 迁移:assigneeId → assignment;新增字段缺省。返回迁移后的根与是否发生了变更。 */
function migrateV1toV2(parsed: { schemaVersion: number; revision: number; projects: Record<string, Project>; agents: Record<string, AgentProfile>; tasks: Record<string, WorkTask> }): { root: WorkbenchRoot; changed: boolean } {
  let changed = false;
  const root: WorkbenchRoot = { ...parsed, schemaVersion: 2 };
  for (const task of Object.values(root.tasks)) {
    if (task.assigneeId && !task.assignment) {
      task.assignment = { kind: 'agent', id: task.assigneeId };
      changed = true;
    }
    if (!task.assigneeId && !task.assignment) {
      // 未分派任务保持无 assignment
    }
  }
  return { root, changed };
}

function parseRoot(raw: string): WorkbenchRoot {
  const parsed = JSON.parse(raw) as Partial<WorkbenchRoot> & { schemaVersion: number };
  if (![1, 2].includes(parsed.schemaVersion) || !Number.isSafeInteger(parsed.revision)
    || !parsed.projects || !parsed.agents || !parsed.tasks
    || Array.isArray(parsed.projects) || Array.isArray(parsed.agents) || Array.isArray(parsed.tasks)
    || typeof parsed.projects !== 'object' || typeof parsed.agents !== 'object' || typeof parsed.tasks !== 'object') {
    throw new Error('schemaVersion 或集合无效');
  }
  for (const project of Object.values(parsed.projects)) {
    if (!project || typeof project.id !== 'string' || typeof project.root !== 'string' || !Number.isSafeInteger(project.revision)) throw new Error('项目数据无效');
  }
  for (const agent of Object.values(parsed.agents)) {
    if (!agent || typeof agent.id !== 'string' || typeof agent.model !== 'string' || !Array.isArray(agent.toolAllow)
      || !Number.isSafeInteger(agent.revision)) throw new Error('Agent 数据无效');
  }
  for (const task of Object.values(parsed.tasks)) {
    if (!task || !['todo', 'in_progress', 'in_review', 'blocked', 'done'].includes(task.status)
      || !Array.isArray(task.runIds) || !Array.isArray(task.timeline) || !Number.isSafeInteger(task.revision)) throw new Error('任务数据无效');
  }
  if ((parsed.schemaVersion as number) === 1) {
    const migrated = migrateV1toV2(parsed as never);
    return migrated.root;
  }
  return parsed as WorkbenchRoot;
}

export function canonicalProjectRoot(input: string, home = dshHome()): string {
  if (!input || !isAbsolute(input)) throw new ServiceError('VALIDATION', '工作区必须是绝对路径', 422);
  let root: string;
  try {
    root = realpathSync(resolve(input));
    if (!statSync(root).isDirectory()) throw new Error('不是目录');
  } catch { throw new ServiceError('VALIDATION', '工作区目录不存在或不可访问', 422); }
  const homeReal = existsSync(home) ? realpathSync(home) : resolve(home);
  const rel = relative(homeReal, root);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new ServiceError('VALIDATION', '工作区不能位于 DSH_HOME 内', 422);
  }
  return root;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Local single-writer store. Failed reads/locks are fail-closed, preserving the original file. */
export class WorkbenchStore {
  readonly dir: string;
  private file: string;
  private lockFile: string;
  private bootId = newId('boot');
  private ownsLock = false;
  private root: WorkbenchRoot | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  readonly fault: { readOnly: boolean; reason?: string } = { readOnly: false };

  constructor(home = dshHome()) {
    this.dir = join(home, 'dispatch');
    this.file = join(this.dir, 'workbench.json');
    this.lockFile = join(this.dir, 'workbench.writer.lock');
  }

  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    this.acquire();
    if (!existsSync(this.file)) {
      if (!this.fault.readOnly) {
        this.root = { schemaVersion: 2, revision: 0, projects: {}, agents: {}, tasks: {} };
        try { this.persist(this.root); } catch { /* fault is exposed as read-only */ }
      }
      return;
    }
    try {
      this.root = parseRoot(readFileSync(this.file, 'utf8'));
      // 迁移后立即持久化(写前备份由 persist 内置)
      if (this.root && !this.fault.readOnly) {
        try { this.persist(this.root); } catch { /* 迁移写入失败保持可用,下次启动再试 */ }
      }
    } catch (e) {
      this.fault.readOnly = true;
      this.fault.reason = `workbench.json 损坏或不可读；原件已保留: ${String(e)}`;
      try {
        this.root = parseRoot(readFileSync(`${this.file}.bak`, 'utf8'));
        this.fault.reason += '；已加载上次备份供只读查看';
      } catch { this.root = null; }
    }
  }

  private acquire(): void {
    try {
      const fd = openSync(this.lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, bootId: this.bootId }), 'utf8');
      closeSync(fd);
      this.ownsLock = true;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder: { pid?: number; bootId?: string };
    try { holder = JSON.parse(readFileSync(this.lockFile, 'utf8')) as typeof holder; }
    catch {
      this.fault.readOnly = true;
      this.fault.reason = '工作台写入锁不可判读';
      return;
    }
    if (!Number.isInteger(holder.pid) || holder.pid === process.pid || alive(holder.pid!)) {
      this.fault.readOnly = true;
      this.fault.reason = `工作台写入锁被进程 ${holder.pid ?? '?'} 持有`;
      return;
    }
    try { renameSync(this.lockFile, `${this.lockFile}.stale-${Date.now()}`); this.acquire(); }
    catch { this.fault.readOnly = true; this.fault.reason = '工作台写入锁接管失败'; }
  }

  private persist(candidate: WorkbenchRoot): void {
    if (this.fault.readOnly) throw new ServiceError('STORE_READONLY', this.fault.reason ?? '工作台只读', 503);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const next = { ...candidate, revision: candidate.revision + 1, savedAt: Date.now() };
    try {
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      if (existsSync(this.file)) {
        const bak = `${this.file}.bak`;
        if (existsSync(bak)) unlinkSync(bak);
        renameSync(this.file, bak);
      }
      renameSync(tmp, this.file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      if (this.root) this.fault.readOnly = true;
      throw new ServiceError('STORE_READONLY', `workbench.json 写入失败:${String(e)}`, 503);
    }
    this.root = next;
  }

  /** 读快照(只读,不克隆;调用方不修改)。 */
  snapshot(): WorkbenchRoot | null { return this.root; }

  /** 串行变更;P1-2:fn 在克隆上执行,成功后才替换内存并持久化——被拒修改不会写入磁盘。 */
  async mutate<T>(fn: (root: WorkbenchRoot) => T): Promise<T> {
    if (this.fault.readOnly || !this.root) throw new ServiceError('STORE_READONLY', this.fault.reason ?? '工作台只读', 503);
    const run = async (): Promise<T> => {
      // 克隆候选根:fn 内的任何修改只发生在候选上;抛错时丢弃,不影响真实 root
      const candidate = structuredClone(this.root!) as WorkbenchRoot;
      const out = fn(candidate);
      // fn 成功:候选成为新真实根,持久化(含备份+原子替换)
      this.root = candidate;
      this.persist(candidate);
      return out;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** fn 内修改 root 后调用,触发持久化(含备份与原子替换)。 */
  commit(): void {
    if (!this.root) throw new ServiceError('STORE_READONLY', 'store 未初始化', 503);
    this.persist(this.root);
  }

  dispose(): void {
    if (this.ownsLock) {
      try { unlinkSync(this.lockFile); } catch { /* best-effort */ }
      this.ownsLock = false;
    }
  }
}
