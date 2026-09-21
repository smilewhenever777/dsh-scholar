/**
 * dsh-trajectory — local JSON file storage.
 *
 * Layout under the configured data directory:
 *   projects/<id>.json   one TrajProjectFile per project ({project, nodes, edges})
 *   meta.json            { activeProjectId }
 *
 * All writes are atomic (random-suffix tmp file + rename) and serialized by an
 * instance-level write lock. Loads tolerate corrupt files (quarantined as
 * <file>.bad with a warning) so a single bad write never breaks the store.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TrajEdge, TrajEntry, TrajGoal, TrajGoalLog, TrajHypothesis, TrajHypStatus, TrajNode, TrajProject, TrajProjectFile, TrajStats, TrajTrack } from './shared/types.js';
import { TRAJ_STATUSES } from './shared/types.js';
import {
  applyNodePatch, applyHypothesisPatch, countsByStatus, createEntry, createGoal, createGoalLog,
  createHypothesis, createNode, applyProjectPatch, MAX_EDGES, MAX_NODES, MAX_PROJECTS,
  newEdgeValidated, newProjectId, normalizeMainline, normalizeWorkspaceKey, reviseGoal, wsBasename,
} from './domain.js';
import type { NodeInput, NodePatch } from './domain.js';

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class TrajStore {
  readonly dir: string;
  files = new Map<string, TrajProjectFile>();
  activeProjectId: string | null = null;
  /** 已删除项目 id:在途 saveFile 据此跳过落盘,防止删除后又被并发写"复活"。 */
  private deletedIds = new Set<string>();
  /** 实例级写互斥(promise 链):全部 mutating 操作串行执行,
   *  防止读-改-写交错互相覆盖、并发 rename 撕裂落盘文件。 */
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Wrap a mutating operation in the instance-level write lock. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.then(() => undefined, () => undefined);
    return run;
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'projects'), { recursive: true });

    for (const f of await readdir(join(this.dir, 'projects'))) {
      if (!f.endsWith('.json')) continue;
      const p = join(this.dir, 'projects', f);
      let ok = false;
      try {
        const raw = JSON.parse(await readFile(p, 'utf8')) as TrajProjectFile;
        if (
          raw && typeof raw.project?.id === 'string' && typeof raw.project?.name === 'string'
          && Array.isArray(raw.nodes) && Array.isArray(raw.edges)
        ) {
          if (!Array.isArray(raw.goals)) raw.goals = [];
          if (!Array.isArray(raw.hypotheses)) raw.hypotheses = [];
          if (!Array.isArray(raw.goalLog)) raw.goalLog = [];
          if (!Array.isArray(raw.project.mainline)) raw.project.mainline = [];
          this.files.set(raw.project.id, raw);
          ok = true;
        }
      } catch (err) {
        console.warn(`[dsh-trajectory] 跳过损坏的项目文件 ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!ok) {
        // 隔离损坏文件(一次性改名为 <file>.bad,rename 失败忽略),下次启动不再扫到
        await rename(p, `${p}.bad`).catch(() => {});
      }
    }

    try {
      const meta = JSON.parse(await readFile(join(this.dir, 'meta.json'), 'utf8')) as { activeProjectId?: string };
      if (meta && typeof meta.activeProjectId === 'string' && this.files.has(meta.activeProjectId)) {
        this.activeProjectId = meta.activeProjectId;
      }
    } catch { /* first run or corrupt — fall through to auto-select */ }
    // v0.3 存量迁移(旧格式自动升级)
    for (const f of this.files.values()) {
      if (this.migrateIfNeeded(f)) {
        await this.saveFile(f);
        console.log(`[dsh-trajectory] 项目「${f.project.name}」已从 v0.2 迁移到 v0.3 目标树结构`);
      }
    }

    if (!this.activeProjectId) {
      const mostRecent = this.listProjectFiles().sort((a, b) => b.project.updatedAt - a.project.updatedAt)[0];
      if (mostRecent) this.activeProjectId = mostRecent.project.id;
    }
  }

  private async atomicWrite(file: string, data: unknown): Promise<void> {
    // 随机 tmp 后缀:并发写不再共用同一 tmp 名(撕裂体 / 双 rename 竞态)
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {}); // rename 失败清理残留 tmp 后原样抛出
      throw err;
    }
  }

  private filePath(id: string): string {
    return join(this.dir, 'projects', `${safeName(id)}.json`);
  }

  private async saveFile(file: TrajProjectFile): Promise<void> {
    if (this.deletedIds.has(file.project.id)) return; // 项目已删除:在途写入直接丢弃(防复活)
    file.project.updatedAt = Date.now();
    await this.atomicWrite(this.filePath(file.project.id), file);
  }

  private async saveActiveMeta(): Promise<void> {
    await this.atomicWrite(join(this.dir, 'meta.json'), { activeProjectId: this.activeProjectId });
  }

  listProjectFiles(): TrajProjectFile[] {
    return [...this.files.values()].sort((a, b) => a.project.createdAt - b.project.createdAt);
  }

  /** Active project file, falling back to the most recently updated one. */
  peekActive(): TrajProjectFile | null {
    if (this.activeProjectId) {
      const f = this.files.get(this.activeProjectId);
      if (f) return f;
    }
    return this.listProjectFiles().sort((a, b) => b.project.updatedAt - a.project.updatedAt)[0] ?? null;
  }

  getActive(): TrajProjectFile | null {
    return this.peekActive();
  }

  getFile(id: string): TrajProjectFile | null {
    return this.files.get(id) ?? null;
  }

  async setActive(id: string): Promise<TrajProjectFile> {
    return this.mutate(() => this.setActiveLocked(id));
  }

  private async setActiveLocked(id: string): Promise<TrajProjectFile> {
    const f = this.files.get(id);
    if (!f) throw new Error(`项目不存在: ${id}`);
    this.activeProjectId = id;
    await this.saveActiveMeta();
    return f;
  }

  /** Create-or-get by exact name (case-insensitive), so repeated tool calls
   *  never fork same-named projects. Optionally switches active. */
  async createProject(input: { name?: string; description?: string; activate?: boolean }): Promise<{ project: TrajProject; existed: boolean }> {
    return this.mutate(async () => {
      const name = (input.name ?? '').trim();
      if (!name) throw new Error('项目名称不能为空');
      const hit = this.listProjectFiles().find((f) => f.project.name.toLowerCase() === name.toLowerCase());
      if (hit) {
        if (input.activate) await this.setActiveLocked(hit.project.id);
        return { project: hit.project, existed: true };
      }
      return this.createWithBuilder(() => {
        const project: TrajProject = {
          id: newProjectId(),
          name,
          description: input.description?.trim() || undefined,
          mainline: [],
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return { project, description: input.description };
      }, input.activate === true);
    });
  }

  /**
   * 工作区绑定项目:create-or-get(同一工作区幂等返回已绑项目)。
   * 未给名时用工作区目录 basename。
   */
  async createForWorkspace(input: { workspaceKey: string; name?: string; description?: string }): Promise<{ project: TrajProject; existed: boolean }> {
    return this.mutate(async () => {
      const key = normalizeWorkspaceKey(input.workspaceKey);
      if (!key) throw new Error('workspaceKey 不能为空');
      const bound = this.findByWorkspace(key);
      if (bound) return { project: bound.project, existed: true };
      const name = (input.name ?? '').trim() || wsBasename(key);
      return this.createWithBuilder(() => {
        const project: TrajProject = {
          id: newProjectId(),
          name,
          description: input.description?.trim() || undefined,
          mainline: [],
          status: 'active',
          workspaceKey: key,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return { project, description: input.description };
      }, true);
    });
  }

  /** Shared builder so both creation paths stay atomic under MAX_PROJECTS. */
  private async createWithBuilder(
    build: () => { project: TrajProject; description?: string },
    activate: boolean,
  ): Promise<{ project: TrajProject; existed: boolean }> {    if (this.files.size >= MAX_PROJECTS) {
      throw new Error(`项目数已达上限（${MAX_PROJECTS}），请先归并旧项目`);
    }
    const { project } = build();
    this.files.set(project.id, { project, nodes: [], edges: [], goals: [], hypotheses: [], goalLog: [] });
    await this.saveFile(this.files.get(project.id)!);
    if (activate || !this.activeProjectId) {
      this.activeProjectId = project.id;
      await this.saveActiveMeta();
    }
    return { project, existed: false };
  }

  /** 绑定/改绑已有项目到工作区;传空串解绑。绑定是精确匹配(不做子目录前缀推断)。 */
  async bindWorkspace(id: string, workspaceKey: string): Promise<TrajProject> {
    return this.mutate(async () => {
      const f = this.files.get(id);
      if (!f) throw new Error(`项目不存在: ${id}`);
      const key = normalizeWorkspaceKey(workspaceKey);
      if (key) {
        const lower = key.toLowerCase();
        const other = this.listProjectFiles().find(
          (x) => x.project.id !== id && x.project.workspaceKey
          && normalizeWorkspaceKey(x.project.workspaceKey).toLowerCase() === lower,
        );
        if (other) throw new Error(`该工作区已绑定项目「${other.project.name}」`);
        f.project.workspaceKey = key;
      } else {
        delete f.project.workspaceKey;
      }
      await this.saveFile(f);
      return f.project;
    });
  }

  /** 按工作区键找绑定项目:精确匹配优先,退化到最长路径前缀
   *  (会话 cwd 可能是工作区的子目录,如 <ws>/rknn/N0_minimal_repro)。 */
  findByWorkspace(workspaceKey: string): TrajProjectFile | null {
    const key = normalizeWorkspaceKey(workspaceKey);
    if (!key) return null;
    let best: TrajProjectFile | null = null;
    let bestLen = -1;
    const lower = key.toLowerCase();
    for (const f of this.files.values()) {
      const bound = f.project.workspaceKey;
      if (!bound) continue;
      const bLower = normalizeWorkspaceKey(bound).toLowerCase();
      if (bLower === lower) return f;
      // 前缀匹配:键是某绑定工作区的子目录(以 / 分界)
      if (lower.startsWith(bLower + '/') && bLower.length > bestLen) {
        best = f;
        bestLen = bLower.length;
      }
    }
    return best;
  }

  /**
   * 解析操作目标项目(路由与工具共用):
   *   显式 projectId > 工作区绑定 > 全局活跃。
   * mutating 操作(autoCreate 或显式 mutating)时,工作区无绑定项目则自动创建(名字 = 目录名);
   * **mutating 且既无 projectId 也无法识别工作区(ws 缺失)时显式抛错,绝不静默落全局活跃**(防跨项目串写)。
   * 非 mutating 读操作保持现状:无 ws 回落全局活跃。
   */
  async resolveProject(opts: { ws?: string; projectId?: string; autoCreate?: boolean; mutating?: boolean; description?: string }): Promise<TrajProjectFile> {
    if (opts.projectId) {
      const f = this.files.get(opts.projectId);
      if (!f) throw new Error(`项目不存在: ${opts.projectId}`);
      return f;
    }
    const key = opts.ws ? normalizeWorkspaceKey(opts.ws) : '';
    if (key) {
      const bound = this.findByWorkspace(key);
      if (bound) return bound;
      if (opts.autoCreate) {
        const { project } = await this.createForWorkspace({ workspaceKey: key, description: opts.description });
        return this.files.get(project.id)!;
      }
      throw new Error('当前工作区还没有绑定研究主线(先创建或绑定一个项目)');
    }
    if (opts.autoCreate || opts.mutating) {
      throw new Error('无法识别当前工作区，请先在面板绑定项目或用 traj_project_set 创建');
    }
    const active = this.peekActive();
    if (!active) throw new Error('没有可用项目，请先创建项目');
    return active;
  }

  async updateProject(
    id: string,
    patch: { name?: string; description?: string; status?: TrajProject['status']; mainline?: unknown; researchQuestion?: string },
  ): Promise<TrajProject> {
    return this.mutate(async () => {
      const f = this.files.get(id);
      if (!f) throw new Error(`项目不存在: ${id}`);
      if (patch.mainline !== undefined) {
        f.project.mainline = normalizeMainline(patch.mainline, f.nodes.map((n) => n.id));
      }
      f.project = applyProjectPatch(f.project, patch);
      await this.saveFile(f);
      return f.project;
    });
  }

  /* ═══════════ v0.3 层 0:Goal CRUD ═══════════ */

  getActiveGoal(projectId: string): TrajGoal | null {
    const f = this.files.get(projectId);
    if (!f) return null;
    return f.goals.find((g) => g.status === 'active')
      ?? [...f.goals].sort((a, b) => b.version - a.version)[0] ?? null;
  }

  async setGoal(projectId: string, text: string, reason?: string): Promise<{ goal: TrajGoal; revised: boolean }> {
    return this.mutate(async () => {
      const f = this.files.get(projectId);
      if (!f) throw new Error(`项目不存在: ${projectId}`);
      const cur = this.getActiveGoal(projectId);
      if (!cur) {
        const goal = createGoal({ projectId, text });
        f.goals.push(goal);
        f.goalLog.push(createGoalLog({ projectId, type: 'goal_created', description: `目标确立(v1): ${text}` }));
        await this.saveFile(f);
        return { goal, revised: false };
      }
      if (cur.text.trim() === text.trim()) return { goal: cur, revised: false };
      const { superseded, next } = reviseGoal(cur, text, reason ?? '');
      const idx = f.goals.findIndex((g) => g.id === cur.id);
      f.goals.splice(idx, 1, superseded);
      f.goals.push(next);
      // 旧目标下的 active 假设继承到新目标(改 goalVersionId),不自动标 superseded。
      // 目标文本修订不等于假设作废——哪些假设真正失效应由 AI/用户显式判断。
      for (let i = 0; i < f.hypotheses.length; i++) {
        const h = f.hypotheses[i];
        if (h.goalVersionId === cur.id && h.status === 'active') {
          f.hypotheses[i] = { ...h, goalVersionId: next.id, updatedAt: Date.now() };
        }
      }
      f.goalLog.push(createGoalLog({
        projectId,
        type: reason?.trim() ? 'goal_pivoted' : 'goal_revised',
        description: `目标 v${cur.version}→v${next.version}: ${reason?.trim() || text}`,
      }));
      await this.saveFile(f);
      return { goal: next, revised: true };
    });
  }

  /* ═══════════ v0.3 层 1:Hypothesis CRUD ═══════════ */

  async addHypothesis(projectId: string, input: { text: string; track?: string; goalVersionId?: string }): Promise<TrajHypothesis> {
    return this.mutate(async () => {
      const f = this.files.get(projectId);
      if (!f) throw new Error(`项目不存在: ${projectId}`);
      const goal = input.goalVersionId
        ? f.goals.find((g) => g.id === input.goalVersionId && g.status === 'active')
        : this.getActiveGoal(projectId);
      if (!goal) throw new Error('没有活跃目标,请先用 traj_goal_set 确立总目标');
      const hyp = createHypothesis({
        projectId,
        goalVersionId: goal.id,
        text: input.text,
        track: (input.track as TrajTrack) || 'mainline',
      });
      f.hypotheses.push(hyp);
      f.goalLog.push(createGoalLog({ projectId, type: 'hyp_added', description: `添加假设(${hyp.track}): ${input.text}` }));
      await this.saveFile(f);
      return hyp;
    });
  }

  async updateHypothesis(projectId: string, hypId: string, patch: { text?: string; status?: string; track?: string; outcomeReason?: string }): Promise<TrajHypothesis> {
    return this.mutate(async () => {
      const f = this.files.get(projectId);
      if (!f) throw new Error(`项目不存在: ${projectId}`);
      const idx = f.hypotheses.findIndex((h) => h.id === hypId);
      if (idx < 0) throw new Error(`假设不存在: ${hypId}`);
      const prev = f.hypotheses[idx];
      const next = applyHypothesisPatch(prev, {
        text: patch.text,
        status: patch.status as TrajHypStatus,
        track: patch.track as TrajTrack,
        outcomeReason: patch.outcomeReason,
      });
      f.hypotheses.splice(idx, 1, next);
      if (patch.status && patch.status !== prev.status) {
        const logType = patch.status === 'validated' ? 'hyp_validated'
          : patch.status === 'falsified' ? 'hyp_falsified'
          : patch.status === 'superseded' ? 'hyp_pivoted' : 'hyp_track_changed';
        f.goalLog.push(createGoalLog({
          projectId, type: logType,
          description: `假设「${prev.text.slice(0, 30)}」→ ${patch.status}${patch.outcomeReason ? `: ${patch.outcomeReason}` : ''}`,
        }));
      }
      if (patch.track && patch.track !== prev.track) {
        f.goalLog.push(createGoalLog({
          projectId, type: 'hyp_track_changed',
          description: `假设「${prev.text.slice(0, 30)}」轨迹 ${prev.track} → ${patch.track}`,
        }));
      }
      await this.saveFile(f);
      return next;
    });
  }

  listHypotheses(projectId: string): TrajHypothesis[] {
    const f = this.files.get(projectId);
    if (!f) return [];
    return [...f.hypotheses].sort((a, b) => a.createdAt - b.createdAt);
  }

  listGoalLog(projectId: string): TrajGoalLog[] {
    const f = this.files.get(projectId);
    if (!f) return [];
    return [...f.goalLog].sort((a, b) => b.ts - a.ts);
  }

  /* ═══════════ v0.2 → v0.3 存量迁移 ═══════════ */

  private migrateIfNeeded(f: TrajProjectFile): boolean {
    if ((f.goals ?? []).length > 0) return false;
    const p = f.project;
    const now = Date.now();

    const rq = p.researchQuestion?.trim() || p.description?.trim();
    if (!rq) return false;

    const goal = createGoal({ projectId: p.id, text: rq }, now);
    f.goals.push(goal);
    f.goalLog.push(createGoalLog({ projectId: p.id, type: 'goal_created', description: `目标确立(v1,从旧格式迁移): ${rq}` }));

    if ((p.mainline ?? []).length > 0) {
      const byId = new Map(f.nodes.map((n) => [n.id, n]));
      for (const nodeId of p.mainline) {
        const node = byId.get(nodeId);
        if (!node) continue;
        const hyp = createHypothesis({ projectId: p.id, goalVersionId: goal.id, text: node.title, track: 'mainline' }, now);
        f.hypotheses.push(hyp);
        node.hypothesisId = hyp.id;
      }
      p.mainline = [];
    }

    const unassigned = f.nodes.filter((n) => !n.hypothesisId);
    if (unassigned.length > 0) {
      const hyp = createHypothesis({ projectId: p.id, goalVersionId: goal.id, text: '未分类(旧格式迁移)', track: 'branch' }, now);
      f.hypotheses.push(hyp);
      for (const n of unassigned) n.hypothesisId = hyp.id;
    }
    return true;
  }

  /** 给节点追加一条实验台账(已有工作/数据/结论)。 */
  async addEntry(
    nodeId: string,
    input: { title?: string; data?: string; conclusion?: string; ts?: number; metrics?: unknown },
  ): Promise<{ node: TrajNode; entry: TrajEntry }> {
    return this.mutate(async () => {
      const file = this.resolveFileForNode(nodeId);
      if (!file) throw new Error(`节点不存在: ${nodeId}`);
      const idx = file.nodes.findIndex((n) => n.id === nodeId);
      const entry = createEntry(input);
      const next = applyNodePatch(file.nodes[idx], {
        entries: [...(file.nodes[idx].entries ?? []), entry],
      });
      file.nodes.splice(idx, 1, next);
      await this.saveFile(file);
      return { node: next, entry };
    });
  }

  /** 删除节点上的一条台账。 */
  async removeEntry(nodeId: string, entryId: string): Promise<boolean> {
    return this.mutate(async () => {
      const file = this.resolveFileForNode(nodeId);
      if (!file) return false;
      const idx = file.nodes.findIndex((n) => n.id === nodeId);
      const node = file.nodes[idx];
      if (!node.entries?.some((e) => e.id === entryId)) return false;
      const next = applyNodePatch(node, {
        entries: node.entries.filter((e) => e.id !== entryId),
      });
      file.nodes.splice(idx, 1, next);
      await this.saveFile(file);
      return true;
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.mutate(async () => {
      this.deletedIds.add(id); // 同 id 的在途 saveFile 一律跳过(防复活)
      if (!this.files.delete(id)) return false;
      await unlink(this.filePath(id)).catch(() => {});
      if (this.activeProjectId === id) {
        this.activeProjectId = this.listProjectFiles().sort((a, b) => b.project.updatedAt - a.project.updatedAt)[0]?.project.id ?? null;
        await this.saveActiveMeta();
      }
      return true;
    });
  }

  /* ---------- nodes ---------- */

  /** Resolve the project file a node lives in: explicit projectId wins,
   *  else the file that actually contains the node (ids are globally unique). */
  private resolveFileForNode(nodeId: string, projectId?: string): TrajProjectFile | null {
    if (projectId) {
      const f = this.files.get(projectId);
      if (f && f.nodes.some((n) => n.id === nodeId)) return f;
      return null;
    }
    for (const f of this.files.values()) {
      if (f.nodes.some((n) => n.id === nodeId)) return f;
    }
    return null;
  }

  async addNode(
    input: NodeInput & { parentIds?: string[]; mainline?: boolean },
  ): Promise<TrajNode> {
    return this.mutate(async () => {
      const file = input.projectId ? this.files.get(input.projectId) : this.peekActive();
      if (!file) throw new Error('没有可用项目，请先创建项目');
      if (file.nodes.length >= MAX_NODES) throw new Error(`节点数已达上限（${MAX_NODES}）`);
      const node = createNode({ ...input, projectId: file.project.id });
      file.nodes.push(node);
      const byId = new Set(file.nodes.map((n) => n.id));
      for (const raw of input.parentIds ?? []) {
        const pid = typeof raw === 'string' ? raw.trim() : '';
        if (!pid || pid === node.id || !byId.has(pid)) continue;
        const { edge, existed } = newEdgeValidated(file.nodes, file.edges, { source: pid, target: node.id, kind: 'enables' });
        if (!existed && file.edges.length < MAX_EDGES) file.edges.push(edge);
      }
      if (input.mainline && !file.project.mainline.includes(node.id)) {
        file.project.mainline = [...file.project.mainline, node.id];
      }
      await this.saveFile(file);
      return node;
    });
  }

  async updateNode(id: string, patch: NodePatch, projectId?: string): Promise<TrajNode> {
    return this.mutate(async () => {
      const file = this.resolveFileForNode(id, projectId);
      if (!file) throw new Error(`节点不存在: ${id}`);
      const idx = file.nodes.findIndex((n) => n.id === id);
      const next = applyNodePatch(file.nodes[idx], patch);
      file.nodes.splice(idx, 1, next);
      await this.saveFile(file);
      return next;
    });
  }

  async removeNode(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const file = this.resolveFileForNode(id);
      if (!file) return false;
      file.nodes = file.nodes.filter((n) => n.id !== id);
      file.edges = file.edges.filter((e) => e.source !== id && e.target !== id);
      if (file.project.mainline.includes(id)) {
        file.project.mainline = file.project.mainline.filter((x) => x !== id);
      }
      await this.saveFile(file);
      return true;
    });
  }

  /** Sync single-node lookup across all projects (for tool-side ref merging). */
  getNode(id: string): TrajNode | null {
    for (const f of this.files.values()) {
      const n = f.nodes.find((x) => x.id === id);
      if (n) return n;
    }
    return null;
  }

  /* ---------- edges ---------- */

  async addEdge(
    input: { projectId?: string; source?: string; target?: string; kind?: TrajEdge['kind'] },
  ): Promise<{ edge: TrajEdge; existed: boolean }> {
    return this.mutate(async () => {
      const file = input.projectId ? this.files.get(input.projectId) : this.peekActive();
      if (!file) throw new Error('没有可用项目，请先创建项目');
      if (file.edges.length >= MAX_EDGES) throw new Error(`边数已达上限（${MAX_EDGES}）`);
      const { edge, existed } = newEdgeValidated(file.nodes, file.edges, input);
      if (!existed) {
        file.edges.push(edge);
        await this.saveFile(file);
      }
      return { edge, existed };
    });
  }

  async removeEdge(id: string): Promise<boolean> {
    return this.mutate(async () => {
      for (const f of this.files.values()) {
        const before = f.edges.length;
        f.edges = f.edges.filter((e) => e.id !== id);
        if (f.edges.length !== before) {
          await this.saveFile(f);
          return true;
        }
      }
      return false;
    });
  }

  /* ---------- mainline ---------- */

  async setMainline(nodeIds: unknown, projectId?: string): Promise<TrajProject> {
    return this.mutate(async () => {
      const file = projectId ? this.files.get(projectId) : this.peekActive();
      if (!file) throw new Error('没有可用项目，请先创建项目');
      file.project.mainline = normalizeMainline(nodeIds, file.nodes.map((n) => n.id));
      await this.saveFile(file);
      return file.project;
    });
  }

  /* ---------- stats / overview ---------- */

  stats(): TrajStats {
    let nodes = 0;
    let edges = 0;
    const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 } as TrajStats['counts'];
    for (const f of this.files.values()) {
      nodes += f.nodes.length;
      edges += f.edges.length;
      const c = countsByStatus(f.nodes);
      for (const s of TRAJ_STATUSES) counts[s] += c[s];
    }
    const active = this.peekActive();
    return {
      projects: this.files.size,
      nodes,
      edges,
      counts,
      dir: this.dir,
      activeProjectName: active?.project.name,
    };
  }
}
