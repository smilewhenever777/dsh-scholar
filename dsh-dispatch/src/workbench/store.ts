import { randomBytes, createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dshHome } from '../store.js';
import { ServiceError } from '../types.js';

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
export type TimelineKind = 'comment' | 'progress' | 'run' | 'review';
export interface TimelineEvent { id: string; kind: TimelineKind; at: number; text: string; runId?: string; actor: string }
export interface Project { id: string; title: string; root: string; revision: number; createdAt: number; updatedAt: number }
export interface AgentProfile { id: string; name: string; instructions: string; model: string; toolAllow: string[]; revision: number; createdAt: number; updatedAt: number }
export interface WorkTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
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
  schemaVersion: 1;
  revision: number;
  projects: Record<string, Project>;
  agents: Record<string, AgentProfile>;
  tasks: Record<string, WorkTask>;
  savedAt?: number;
}

export function newId(prefix: string): string { return `${prefix}_${randomBytes(8).toString('hex')}`; }
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function parseRoot(raw: string): WorkbenchRoot {
  const parsed = JSON.parse(raw) as WorkbenchRoot;
  if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision) || !parsed.projects || !parsed.agents || !parsed.tasks
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
  return parsed;
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
        this.root = { schemaVersion: 1, revision: 0, projects: {}, agents: {}, tasks: {} };
        try { this.persist(this.root); } catch { /* fault is exposed as read-only */ }
      }
      return;
    }
    try {
      this.root = parseRoot(readFileSync(this.file, 'utf8'));
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
      this.root = next;
    } catch (e) {
      const bak = `${this.file}.bak`;
      if (!existsSync(this.file) && existsSync(bak)) {
        try { renameSync(bak, this.file); } catch { /* retain backup for manual recovery */ }
      }
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* preserve primary error */ }
      this.fault.readOnly = true;
      this.fault.reason = `工作台持久化失败: ${String(e)}`;
      throw new ServiceError('STORE_READONLY', this.fault.reason, 503);
    }
  }

  snapshot(): WorkbenchRoot | null { return this.root; }
  async mutate<T>(fn: (root: WorkbenchRoot) => T): Promise<T> {
    if (!this.root || this.fault.readOnly) throw new ServiceError('STORE_READONLY', this.fault.reason ?? '工作台只读', 503);
    const run = async () => {
      const root = structuredClone(this.root!);
      const result = fn(root);
      this.persist(root);
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
  dispose(): void {
    if (!this.ownsLock) return;
    try {
      const info = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { bootId?: string };
      if (info.bootId === this.bootId) unlinkSync(this.lockFile);
    } catch { /* do not remove someone else's lock */ }
    this.ownsLock = false;
  }
}
