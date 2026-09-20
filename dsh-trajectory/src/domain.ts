/**
 * dsh-trajectory — domain helpers shared by routes and agent tools:
 * create/merge semantics for projects, nodes, edges and the mainline.
 * Pure functions; all I/O happens in TrajStore.
 */
import { randomUUID } from 'node:crypto';
import type {
  TrajEdge, TrajEdgeKind, TrajEntry, TrajGoal, TrajGoalLog, TrajGoalLog as GoalLog, TrajHypothesis, TrajHypStatus,
  TrajMetric, TrajNode, TrajNodeKind, TrajNodeRefs, TrajProject, TrajStatus, TrajTrack,
} from './shared/types.js';
import { TRAJ_EDGE_KINDS, TRAJ_HYP_STATUS, TRAJ_LOG_TYPES, TRAJ_NODE_KINDS, TRAJ_STATUSES, TRAJ_TRACKS } from './shared/types.js';

export const MAX_PROJECTS = 20;
export const MAX_NODES = 500;
export const MAX_EDGES = 1500;

/* ---------- id generators (pure; prefix keeps namespaces disjoint) ---------- */

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}
export function newNodeId(): string {
  return `n_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}
export function newEdgeId(): string {
  return `e_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}
export function newGoalId(): string {
  return `g_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}
export function newHypothesisId(): string {
  return `h_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}
export function newLogId(): string {
  return `l_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/* ---------- workspace binding ---------- */

/**
 * 规范化工作区绑定键(cwd):反斜杠→正斜杠、去尾斜杠、小写比较值。
 * 返回值用于存储与比较;显示名用 basename。
 */
export function normalizeWorkspaceKey(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 键比较(Windows 大小写不敏感兜底;linux 常规路径不受影响)。 */
export function wsKeyEquals(a: string, b: string): boolean {
  return normalizeWorkspaceKey(a).toLowerCase() === normalizeWorkspaceKey(b).toLowerCase();
}

/** 工作区目录名(作默认项目名)。 */
export function wsBasename(raw: string): string {
  const norm = normalizeWorkspaceKey(raw);
  return norm.split('/').pop() || norm;
}

/* ---------- projects ---------- */

export function createProject(
  input: { name?: string; description?: string; workspaceKey?: string },
  now = Date.now(),
): TrajProject {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('项目名称不能为空');
  return {
    id: newProjectId(),
    name,
    description: input.description?.trim() || undefined,
    mainline: [],
    status: 'active',
    workspaceKey: input.workspaceKey ? normalizeWorkspaceKey(input.workspaceKey) : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyProjectPatch(
  existing: TrajProject,
  patch: { name?: string; description?: string; status?: TrajProject['status']; researchQuestion?: string },
  now = Date.now(),
): TrajProject {
  const next: TrajProject = { ...existing, updatedAt: now };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('项目名称不能为空');
    next.name = name;
  }
  if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
  if (patch.researchQuestion !== undefined) next.researchQuestion = patch.researchQuestion.trim() || undefined;
  if (patch.status === 'active' || patch.status === 'archived') next.status = patch.status;
  return next;
}

/* ---------- entries(实验台账) ---------- */

export function newEntryId(): string {
  return `t_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/** 规范化结构化指标:数值必须有限,负值/零合法(baseline 差值可为负)。 */
export function normalizeMetrics(raw: unknown): TrajMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: TrajMetric[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    // null/undefined 显式排除:Number(null)===0 会把缺值静默记成 0
    const value = r.value === null || r.value === undefined ? NaN : Number(r.value);
    if (!name || !Number.isFinite(value)) continue;
    const metric: TrajMetric = { name, value };
    const baseline = Number(r.baseline);
    if (r.baseline !== undefined && r.baseline !== null && r.baseline !== '' && Number.isFinite(baseline)) {
      metric.baseline = baseline;
    }
    if (typeof r.unit === 'string' && r.unit.trim()) metric.unit = r.unit.trim();
    out.push(metric);
  }
  return out;
}

export function createEntry(
  input: { title?: string; data?: string; conclusion?: string; ts?: number; metrics?: unknown },
  now = Date.now(),
): TrajEntry {
  const title = (input.title ?? '').trim();
  if (!title) throw new Error('台账标题不能为空');
  const metrics = normalizeMetrics(input.metrics);
  const entry: TrajEntry = {
    id: newEntryId(),
    ts: typeof input.ts === 'number' && Number.isFinite(input.ts) && input.ts > 0 ? input.ts : now,
    title,
    data: input.data?.trim() || undefined,
    metrics: metrics.length ? metrics : undefined,
    conclusion: input.conclusion?.trim() || undefined,
  };
  return entry;
}

/* ---------- nodes ---------- */

function normalizeRefs(raw: unknown): TrajNodeRefs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };
  const refs: TrajNodeRefs = {
    cardId: str(r.cardId),
    cardLabel: str(r.cardLabel),
    paperId: str(r.paperId),
    paperLabel: str(r.paperLabel),
    hostId: str(r.hostId),
    logPath: str(r.logPath),
    cmdPattern: str(r.cmdPattern),
  };
  const hasAny = Object.values(refs).some(Boolean);
  return hasAny ? refs : undefined;
}

export interface NodeInput {
  projectId?: string;
  kind?: TrajNodeKind;
  title?: string;
  status?: TrajStatus;
  detail?: string;
  refs?: unknown;
  tags?: string[];
}

export function createNode(
  input: Omit<NodeInput, 'projectId'> & { projectId: string },
  now = Date.now(),
): TrajNode {
  const title = (input.title ?? '').trim();
  if (!title) throw new Error('节点标题不能为空');
  const kind = input.kind && TRAJ_NODE_KINDS.includes(input.kind) ? input.kind : 'other';
  const status = input.status && TRAJ_STATUSES.includes(input.status) ? input.status : 'todo';
  const node: TrajNode = {
    id: newNodeId(),
    projectId: input.projectId,
    kind,
    title,
    status,
    detail: input.detail?.trim() || undefined,
    refs: normalizeRefs(input.refs),
    tags: [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))],
    createdAt: now,
    updatedAt: now,
  };
  if (!node.tags?.length) delete node.tags;
  if (!node.detail) delete node.detail;
  if (!node.refs) delete node.refs;
  return node;
}

export interface NodePatch {
  title?: string;
  kind?: TrajNodeKind;
  status?: TrajStatus;
  detail?: string;
  refs?: unknown;
  tags?: string[];
  /** 实验台账(整体替换;addEntry/removeEntry 组合使用) */
  entries?: TrajEntry[];
}

/** Merge only the provided fields onto an existing node. */
export function applyNodePatch(existing: TrajNode, patch: NodePatch, now = Date.now()): TrajNode {
  const next: TrajNode = { ...existing, updatedAt: now };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('节点标题不能为空');
    next.title = title;
  }
  if (patch.kind !== undefined && TRAJ_NODE_KINDS.includes(patch.kind)) next.kind = patch.kind;
  if (patch.status !== undefined && TRAJ_STATUSES.includes(patch.status)) next.status = patch.status;
  if (patch.detail !== undefined) {
    next.detail = patch.detail.trim() || undefined;
    if (!next.detail) delete next.detail;
  }
  if (patch.refs !== undefined) {
    const refs = normalizeRefs(patch.refs);
    if (refs) next.refs = refs;
    else delete next.refs;
  }
  if (patch.tags !== undefined) {
    next.tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))];
    if (!next.tags.length) delete next.tags;
  }
  if (patch.entries !== undefined) {
    const entries = Array.isArray(patch.entries) ? patch.entries.filter((e): e is TrajEntry => !!e && typeof e === 'object') : [];
    if (entries.length) next.entries = entries;
    else delete next.entries;
  }
  if (!next.title) throw new Error('节点标题不能为空');
  return next;
}

/* ---------- edges ---------- */

/**
 * Validate a model/user-supplied edge against the node set of ONE project
 * (nodes and edges live in the same project file, so same-project is
 * structural). Throws with a readable message on violation.
 */
export function validateEdge(
  nodes: Iterable<TrajNode>,
  input: { source?: string; target?: string; kind?: TrajEdgeKind },
): { source: string; target: string; kind: TrajEdgeKind } {
  const source = (input.source ?? '').trim();
  const target = (input.target ?? '').trim();
  const kind = input.kind && TRAJ_EDGE_KINDS.includes(input.kind) ? input.kind : 'enables';
  if (!source || !target) throw new Error('边的 source/target 不能为空');
  if (source === target) throw new Error('边不能自环(source = target)');
  const ids = new Set([...nodes].map((n) => n.id));
  if (!ids.has(source)) throw new Error(`起点节点不存在: ${source}`);
  if (!ids.has(target)) throw new Error(`终点节点不存在: ${target}`);
  return { source, target, kind };
}

export function newEdgeValidated(
  nodes: Iterable<TrajNode>,
  existing: TrajEdge[],
  input: { source?: string; target?: string; kind?: TrajEdgeKind },
  now = Date.now(),
): { edge: TrajEdge; existed: boolean } {
  const v = validateEdge(nodes, input);
  const hit = existing.find((e) => e.source === v.source && e.target === v.target && e.kind === v.kind);
  if (hit) return { edge: hit, existed: true };
  assertEdgeAcyclic(nodes, existing, v);
  return { edge: { id: newEdgeId(), ...v }, existed: false };
}

/**
 * 写入侧成环检测:新增 source→target 前,从 target 出发沿现有边 DFS,
 * 若能回到 source 则拒绝(消息含成环路径节点名)。DAG 语义由写入侧保证;
 * 历史数据中的成环边由客户端检测提示(见 TrajGraphView)。
 */
export function assertEdgeAcyclic(
  nodes: Iterable<TrajNode>,
  edges: TrajEdge[],
  v: { source: string; target: string },
): void {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  if (!adj.has(v.target)) return; // target 无出边:不可能回到 source
  const title = new Map([...nodes].map((n) => [n.id, n.title]));
  // BFS/DFS 皆可(只需存在性 + 一条回溯路径);prev 记录前驱用于重建路径
  const prev = new Map<string, string | undefined>([[v.target, undefined]]);
  const queue = [v.target];
  let met = false;
  while (!met && queue.length) {
    const cur = queue.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (next === v.source) {
        prev.set(v.source, cur);
        met = true;
        break;
      }
      if (!prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!met) return;
  const path: string[] = []; // target → … → source
  let cur: string | undefined = v.source;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  const names = [v.source, ...path].map((id) => title.get(id) ?? id);
  throw new Error(`拒绝建边:会构成依赖环(${names.join(' → ')} → ${names[0]}),请检查节点依赖方向`);
}

/* ---------- mainline ---------- */

/** Dedupe and drop ids that no longer resolve to nodes; preserves order. */
export function normalizeMainline(ids: unknown, nodeIds: Iterable<string>): string[] {
  const known = new Set(nodeIds);
  const out: string[] = [];
  if (!Array.isArray(ids)) return out;
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Open statuses = 未完成(注入摘要与徽标计数只看这些)。 */
export const OPEN_STATUSES: readonly TrajStatus[] = ['todo', 'in_progress', 'blocked'];

export function countsByStatus(nodes: Iterable<TrajNode>): Record<TrajStatus, number> {
  const counts: Record<TrajStatus, number> = { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 };
  for (const n of nodes) if (TRAJ_STATUSES.includes(n.status)) counts[n.status] += 1;
  return counts;
}


/* ═══════════════ v0.3 层 0:总目标(版本化) ═══════════════ */

export function createGoal(input: { projectId: string; text: string; version?: number }, now = Date.now()): TrajGoal {
  const text = (input.text ?? '').trim();
  if (!text) throw new Error('目标陈述不能为空');
  return {
    id: newGoalId(),
    projectId: input.projectId,
    text,
    version: input.version ?? 1,
    status: 'active',
    createdAt: now,
  };
}

/** 修订目标:旧目标标 superseded,新目标 version+1。 */
export function reviseGoal(
  existing: TrajGoal,
  newText: string,
  reason: string,
  now = Date.now(),
): { superseded: TrajGoal; next: TrajGoal } {
  const text = newText.trim();
  if (!text) throw new Error('新目标陈述不能为空');
  const superseded: TrajGoal = {
    ...existing,
    status: 'superseded',
    supersededAt: now,
    supersededReason: reason?.trim() || undefined,
  };
  const next: TrajGoal = createGoal({ projectId: existing.projectId, text, version: existing.version + 1 }, now);
  return { superseded, next };
}

/* ═══════════════ v0.3 层 1:子假设 ═══════════════ */

export function createHypothesis(
  input: { projectId: string; goalVersionId: string; text: string; track?: TrajTrack },
  now = Date.now(),
): TrajHypothesis {
  const text = (input.text ?? '').trim();
  if (!text) throw new Error('假设陈述不能为空');
  const track = input.track && TRAJ_TRACKS.includes(input.track) ? input.track : 'mainline';
  return {
    id: newHypothesisId(),
    projectId: input.projectId,
    goalVersionId: input.goalVersionId,
    text,
    status: 'active',
    track,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyHypothesisPatch(
  existing: TrajHypothesis,
  patch: { text?: string; status?: TrajHypStatus; track?: TrajTrack; outcomeReason?: string },
  now = Date.now(),
): TrajHypothesis {
  const next: TrajHypothesis = { ...existing, updatedAt: now };
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) throw new Error('假设陈述不能为空');
    next.text = text;
  }
  if (patch.status !== undefined && TRAJ_HYP_STATUS.includes(patch.status)) next.status = patch.status;
  if (patch.track !== undefined && TRAJ_TRACKS.includes(patch.track)) next.track = patch.track;
  if (patch.outcomeReason !== undefined) next.outcomeReason = patch.outcomeReason.trim() || undefined;
  return next;
}

/* ═══════════════ 演化日志 ═══════════════ */

export function createGoalLog(
  input: { projectId: string; type: TrajGoalLog['type']; description: string },
  now = Date.now(),
): TrajGoalLog {
  const description = (input.description ?? '').trim();
  if (!description) throw new Error('日志描述不能为空');
  return { id: newLogId(), projectId: input.projectId, ts: now, type: input.type, description };
}
