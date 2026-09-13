/**
 * dsh-scholar — local JSON file storage.
 *
 * Layout under the configured paper directory:
 *   papers/<id>.json     one Paper per file
 *   cards/<id>.json      one IdeaCard per file
 *   graph.json           KnowledgeGraph (nodes + edges)
 *   attachments/         PDF attachments (reserved, P2)
 *
 * All writes are atomic (tmp file + rename). Loads tolerate corrupt files
 * (skipped with a warning) so a single bad write never breaks the library.
 */
import { mkdir, readdir, readFile, writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CardQuery, GraphEdge, GraphEdgeKind, GraphNode, IdeaCard, KnowledgeGraph, Paper, PaperCollection, PaperQuery,
} from './shared/types.js';
import { GRAPH_EDGE_KINDS } from './shared/types.js';
export const EMPTY_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };

const MAX_GRAPH_NODES = 2000;
const MAX_GRAPH_EDGES = 5000;

/** Filesystem-safe id derived from a paper title (stable across runs). */
export function slugifyTitle(title: string): string {
  const base = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'paper';
  const hash = createHash('sha1').update(title.trim().toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** Paper id: arXiv id when present (also the dedupe key), else title slug. */
export function paperIdFor(title: string, arxivId?: string): string {
  const id = arxivId?.trim();
  if (id) return id.replace(/[^A-Za-z0-9._-]/g, '_');
  return slugifyTitle(title);
}

/**
 * Canonical concept node id (prefix keeps concept and paper ids disjoint).
 * Idempotent: an already-canonical id (`cpt_…`) is preserved, so the model
 * can reference existing concepts verbatim; a bare slug (`lora`) becomes
 * `cpt_lora`.
 * CJK 字符保留在 slug 里(概念 id 只存在于 graph.json 与工具参数,不进文件名/URL):
 * 旧规则只留 a-z0-9,纯中文标签会被清空并全部塌缩到 fallback `cpt_concept`,
 * 不同概念被静默合并成同一个节点。
 */
export function conceptId(input: string): string {
  const m = /^cpt_(.+)$/.exec(input.trim());
  const raw = m ? m[1] : input.trim();
  const base = raw.toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'concept';
  return `cpt_${base}`;
}

/** tagSync 用:slug 清空(纯符号/emoji 等)的标签不值得建概念,会被调用方跳过。 */
export function isConceptWorthyTag(tag: string): boolean {
  const cid = conceptId(tag);
  return cid !== 'cpt_concept' || /concept/i.test(tag);
}

export function newCardId(): string {
  return `c_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

export function newCollectionId(): string {
  return `col_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/** Case-insensitive keyword match across a paper's searchable fields. */
function paperMatches(p: Paper, q: string): boolean {
  const s = q.toLowerCase();
  return [p.title, p.summary, p.abstract, p.venue, p.arxivId, p.doi, p.notes]
    .concat(p.authors, p.tags)
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(s));
}

export function filterPapers(all: Paper[], query: PaperQuery): Paper[] {
  let out = all;
  if (query.q) out = out.filter((p) => paperMatches(p, query.q as string));
  // tag 筛选双侧大小写不敏感（面板/模型给出的 tag 大小写与库内不一致时也能命中）
  if (query.tag) {
    const t = String(query.tag).toLowerCase();
    out = out.filter((p) => p.tags.some((tag) => tag.toLowerCase() === t));
  }
  if (query.yearFrom) out = out.filter((p) => (p.year ?? 0) >= (query.yearFrom as number));
  if (query.yearTo) out = out.filter((p) => (p.year ?? 9999) <= (query.yearTo as number));
  if (query.importance) out = out.filter((p) => (p.importance ?? 0) >= (query.importance as number));
  if (query.collection) out = out.filter((p) => (p.collectionIds ?? []).includes(query.collection as string));
  const sort = query.sort ?? 'createdAt';
  out = [...out].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
    return b.createdAt - a.createdAt || a.title.localeCompare(b.title);
  });
  return out;
}

function cardMatches(c: IdeaCard, q: string): boolean {
  const s = q.toLowerCase();
  return [c.title, c.insight, c.notes].some((v) => typeof v === 'string' && v.toLowerCase().includes(s))
    || c.tags.some((tag) => tag.toLowerCase().includes(s));
}

export function filterCards(all: IdeaCard[], query: CardQuery): IdeaCard[] {
  let out = all;
  if (query.q) out = out.filter((c) => cardMatches(c, query.q as string));
  if (query.category) out = out.filter((c) => c.category === query.category);
  if (query.tag) out = out.filter((c) => c.tags.includes(query.tag as string));
  if (query.importance) out = out.filter((c) => c.importance >= (query.importance as number));
  if (query.status) out = out.filter((c) => c.status === query.status);
  if (query.paperId) out = out.filter((c) => c.paperId === query.paperId);
  const sort = query.sort ?? 'createdAt';
  out = [...out].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'importance') return b.importance - a.importance || b.createdAt - a.createdAt;
    return b.createdAt - a.createdAt;
  });
  return out;
}

/** Union of all tags across papers (sorted, deduped). */
export function allPaperTags(papers: Iterable<Paper>): string[] {
  const set = new Set<string>();
  for (const p of papers) for (const tag of p.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function allCardTags(cards: Iterable<IdeaCard>): string[] {
  const set = new Set<string>();
  for (const c of cards) for (const tag of c.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve an edge endpoint against known node ids: an exact id wins;
 * otherwise a bare concept slug ("lora") is canonicalized ("cpt_lora") so
 * model submissions that follow the kg_extract docs still resolve.
 */
function resolveEndpoint(nodes: Map<string, GraphNode>, raw: string): string | undefined {
  if (nodes.has(raw)) return raw;
  const cid = conceptId(raw);
  return nodes.has(cid) ? cid : undefined;
}

/** mergeGraph 的截断统计（容量上限触发时置位，调用方可透传给用户）。 */
export interface GraphMergeStats {
  truncatedNodes: boolean;
  truncatedEdges: boolean;
}

/**
 * Merge a model-submitted node/edge set into the graph.
 * - rebuild: start from an empty base; append: keep existing content
 * - concept ids are canonicalized; paper nodes must be real papers
 * - edges have endpoints resolved canonically, self-loops dropped, deduped
 * - append 模式下旧边并入结果并参与去重（同一 source|kind|target 键的 incoming 边不会重复入库）
 */
export function mergeGraph(
  existing: KnowledgeGraph,
  incoming: { nodes: GraphNode[]; edges: GraphEdge[] },
  mode: 'append' | 'rebuild',
  knownPaperIds: ReadonlySet<string>,
  stats?: GraphMergeStats,
): KnowledgeGraph {
  const base = mode === 'rebuild' ? { nodes: [] as GraphNode[], edges: [] as GraphEdge[] } : existing;
  const nodes = new Map<string, GraphNode>();
  for (const n of base.nodes) nodes.set(n.id, n);

  let truncatedNodes = false;
  for (const raw of incoming.nodes) {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!id || !label) continue;
    let node: GraphNode;
    if (raw.kind === 'paper') {
      if (!knownPaperIds.has(id)) continue; // papers must exist in the library
      node = { id, kind: 'paper', label };
    } else {
      node = { id: conceptId(id), kind: 'concept', label };
    }
    if (nodes.size >= MAX_GRAPH_NODES) { truncatedNodes = true; break; }
    nodes.set(node.id, node);
  }

  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncatedEdges = false;
  // append 必须保留旧边：先把 base.edges 灌入结果与去重集合（rebuild 的 base 为空，行为不变）
  for (const e of base.edges) {
    if (edges.length >= MAX_GRAPH_EDGES) { truncatedEdges = true; break; }
    seen.add(`${e.source}|${e.kind}|${e.target}`);
    edges.push(e);
  }
  for (const raw of incoming.edges) {
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    if (!source || !target || source === target) continue;
    if (!GRAPH_EDGE_KINDS.includes(raw.kind as GraphEdgeKind)) continue;
    const rs = resolveEndpoint(nodes, source);
    const rt = resolveEndpoint(nodes, target);
    if (!rs || !rt || rs === rt) continue; // unknown endpoint or self-loop after resolution
    const key = `${rs}|${raw.kind}|${rt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (edges.length >= MAX_GRAPH_EDGES) { truncatedEdges = true; break; }
    edges.push({ source: rs, target: rt, kind: raw.kind as GraphEdgeKind });
  }

  if (truncatedNodes || truncatedEdges) {
    console.warn(`[dsh-scholar] 图谱超出上限（节点 ${MAX_GRAPH_NODES} / 边 ${MAX_GRAPH_EDGES}），已截断`);
  }
  if (stats) {
    stats.truncatedNodes = truncatedNodes;
    stats.truncatedEdges = truncatedEdges;
  }
  return { nodes: [...nodes.values()], edges };
}

/** Subgraph containing one concept and its 1-hop neighbors (concept filter). */
export function conceptSubgraph(graph: KnowledgeGraph, conceptId: string): KnowledgeGraph {
  const concept = graph.nodes.find((n) => n.id === conceptId);
  if (!concept) return EMPTY_GRAPH;
  const neighbors = new Set<string>([conceptId]);
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (e.source === conceptId || e.target === conceptId) {
      neighbors.add(e.source);
      neighbors.add(e.target);
      edges.push(e);
    }
  }
  return { nodes: graph.nodes.filter((n) => neighbors.has(n.id)), edges };
}

/** Windows 保留设备名（含扩展名前的主干命中也算，如 con.json）。 */
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function safeName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '_');
  // Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，大小写不敏感）不能做文件名主干 → 追加 _
  return WIN_RESERVED.test(s) || WIN_RESERVED.test(s.split('.')[0] ?? '') ? `${s}_` : s;
}
export { safeName };

/**
 * rebuild 保护：现有规模较大（节点+边 > 20）而 incoming 总量不足现有 50% 时拒绝，
 * 防止模型幻觉（rebuild + 少量节点/空数组）一次性清空整个图谱。
 * force=true 显式确认后才放行缩减型 rebuild。
 */
export function assertRebuildAllowed(existing: KnowledgeGraph, incomingTotal: number, force: boolean): void {
  if (force) return;
  const existingTotal = existing.nodes.length + existing.edges.length;
  if (existingTotal <= 20) return;
  if (incomingTotal * 2 >= existingTotal) return;
  throw new Error(
    `拒绝缩减型 rebuild：现有图谱 ${existing.nodes.length} 节点 + ${existing.edges.length} 边（共 ${existingTotal} 项），`
    + `提交仅 ${incomingTotal} 项（不足 50%）。如确要缩小重建请带 force=true 确认，或改用 append 增量合并`,
  );
}

export class PaperStore {
  readonly dir: string;
  papers = new Map<string, Paper>();
  cards = new Map<string, IdeaCard>();
  collections = new Map<string, PaperCollection>();
  graph: KnowledgeGraph = EMPTY_GRAPH;
  /** init 期间跳过的损坏文件清单（相对路径），随 /scholar/stats 暴露给面板告警。 */
  corruptFiles: string[] = [];
  /** 存储目录热切换标记：旧 store 被 dispose 后写操作显式失败，不再写旧目录。 */
  private disposed = false;
  /** 实例级写互斥（promise 链）：串行化所有读-改-写，防止并发覆盖/撕裂文件。 */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 存储目录被切换时由宿主调用；在途请求的后续写操作会显式报错。 */
  dispose(): void {
    this.disposed = true;
  }

  /** 把异步操作串到互斥链上（非重入：持锁期间只能调用私有的 *_unlocked 实现）。 */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('存储目录已切换，请重试');
  }

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'papers'), { recursive: true });
    await mkdir(join(this.dir, 'cards'), { recursive: true });
    await mkdir(join(this.dir, 'attachments'), { recursive: true });

    for (const f of await readdir(join(this.dir, 'papers'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(await readFile(join(this.dir, 'papers', f), 'utf8')) as Paper;
        if (p && typeof p.id === 'string' && typeof p.title === 'string' && p.title) {
          this.papers.set(p.id, p);
        }
      } catch (err) {
        this.corruptFiles.push(`papers/${f}`);
        console.warn(`[dsh-scholar] 跳过损坏的论文文件 ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const f of await readdir(join(this.dir, 'cards'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await readFile(join(this.dir, 'cards', f), 'utf8')) as IdeaCard;
        if (c && typeof c.id === 'string' && typeof c.title === 'string' && c.title) {
          this.cards.set(c.id, c);
        }
      } catch (err) {
        this.corruptFiles.push(`cards/${f}`);
        console.warn(`[dsh-scholar] 跳过损坏的卡片文件 ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const g = JSON.parse(await readFile(join(this.dir, 'graph.json'), 'utf8')) as KnowledgeGraph;
      if (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) this.graph = g;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.corruptFiles.push('graph.json');
        console.warn(`[dsh-scholar] graph.json 损坏，从空图谱开始: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.graph = EMPTY_GRAPH;
    }

    // self-heal legacy orphans: cards pointing at papers that no longer exist
    for (const c of [...this.cards.values()]) {
      if (!c.paperId || this.papers.has(c.paperId)) continue;
      const fixed: IdeaCard = { ...c, paperId: undefined, updatedAt: Date.now() };
      this.cards.set(c.id, fixed);
      await this.atomicWrite(this.cardPath(c.id), fixed);
      console.warn(`[dsh-scholar] 卡片 ${c.id} 引用的论文 ${c.paperId} 已不存在，解除关联`);
    }

    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'collections.json'), 'utf8')) as { collections?: PaperCollection[] };
      for (const c of Array.isArray(raw?.collections) ? raw.collections : []) {
        if (c && typeof c.id === 'string' && typeof c.name === 'string' && c.name) {
          this.collections.set(c.id, c);
        }
      }
    } catch { /* first run or corrupt — start empty */ }
  }

  /* ---------- collections ---------- */

  private async saveCollectionsJson(): Promise<void> {
    await this.atomicWrite(join(this.dir, 'collections.json'), {
      collections: [...this.collections.values()],
    });
  }

  /** List collections ordered by creation. */
  listCollections(): PaperCollection[] {
    return [...this.collections.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Create-or-get by trimmed name (case-insensitive match wins so repeated
   * tool/form submissions never fork duplicates). Updates color when given.
   */
  async upsertCollection(name: string, color?: string): Promise<{ collection: PaperCollection; existed: boolean }> {
    this.assertLive();
    return this.withLock(() => this.upsertCollectionUnlocked(name, color));
  }

  private async upsertCollectionUnlocked(name: string, color?: string): Promise<{ collection: PaperCollection; existed: boolean }> {
    const key = name.trim();
    if (!key) throw new Error('分区名称不能为空');
    const hit = this.listCollections().find((c) => c.name.toLowerCase() === key.toLowerCase());
    const now = Date.now();
    if (hit) {
      const next: PaperCollection = { ...hit, color: color ?? hit.color, updatedAt: now };
      this.collections.set(hit.id, next);
      await this.saveCollectionsJson();
      return { collection: next, existed: true };
    }
    const col: PaperCollection = { id: newCollectionId(), name: key, color, createdAt: now, updatedAt: now };
    this.collections.set(col.id, col);
    await this.saveCollectionsJson();
    return { collection: col, existed: false };
  }

  async renameCollection(id: string, patch: { name?: string; color?: string }): Promise<PaperCollection | undefined> {
    this.assertLive();
    return this.withLock(async () => {
      const cur = this.collections.get(id);
      if (!cur) return undefined;
      if (patch.name !== undefined && !patch.name.trim()) throw new Error('分区名称不能为空');
      const next: PaperCollection = {
        ...cur,
        name: patch.name?.trim() || cur.name,
        color: patch.color !== undefined ? (patch.color || undefined) : cur.color,
        updatedAt: Date.now(),
      };
      this.collections.set(id, next);
      await this.saveCollectionsJson();
      return next;
    });
  }

  /** Delete a collection and strip its id from every member paper. */
  async deleteCollection(id: string): Promise<boolean> {
    this.assertLive();
    return this.withLock(async () => {
      if (!this.collections.delete(id)) return false;
      await this.saveCollectionsJson();
      for (const p of this.papers.values()) {
        if (!(p.collectionIds ?? []).includes(id)) continue;
        const next: Paper = { ...p, collectionIds: (p.collectionIds ?? []).filter((x) => x !== id), updatedAt: Date.now() };
        if ((next.collectionIds ?? []).length === 0) delete next.collectionIds;
        this.papers.set(p.id, next);
        await this.atomicWrite(this.paperPath(p.id), next);
      }
      return true;
    });
  }

  /**
   * Resolve collection NAMES (from model/user free text) to ids, creating any
   * that do not exist yet. Returns ids in input order.
   */
  async ensureCollectionNames(names: string[]): Promise<string[]> {
    this.assertLive();
    return this.withLock(async () => {
      const ids: string[] = [];
      for (const raw of names) {
        const n = raw.trim();
        if (!n) continue;
        const existing = this.listCollections().find((c) => c.name.toLowerCase() === n.toLowerCase());
        const id = existing ? existing.id : (await this.upsertCollectionUnlocked(n)).collection.id;
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    });
  }

  /** Keep only collection ids that actually exist. */
  filterExistingCollectionIds(ids: string[]): string[] {
    return [...new Set(ids.filter((id) => this.collections.has(id)))];
  }

  private async atomicWrite(file: string, data: unknown): Promise<void> {
    // 随机后缀：并发写不再共用同一 tmp 名（撕裂体/ENOENT 竞态）
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {}); // rename 失败也要回收 tmp，避免残留
      throw err;
    }
  }

  /* ---------- papers ---------- */

  private paperPath(id: string): string {
    return join(this.dir, 'papers', `${safeName(id)}.json`);
  }

  async upsertPaper(paper: Paper): Promise<Paper> {
    this.assertLive();
    return this.withLock(async () => {
      this.papers.set(paper.id, paper);
      await this.atomicWrite(this.paperPath(paper.id), paper);
      await this.ensurePaperNode(paper);
      return paper;
    });
  }

  /** Keep the graph aware of every library paper: auto-add (or relabel) the
   *  paper node on save, so a newly saved paper never silently vanishes from
   *  the graph view. Relation edges still require AI extraction (kg_extract). */
  /**
   * Heuristic auto-sync (no AI): every paper tag becomes a concept node and
   * the paper links to it with a "uses" edge. Only MISSING pieces are
   * returned; the caller merges them via mergeGraph. Idempotent.
   */
  tagSyncPatch(papers: Paper[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const edgeSeen = new Set(this.graph.edges.map((e) => `${e.source}|${e.kind}|${e.target}`));
    const outNodes: GraphNode[] = [];
    const outEdges: GraphEdge[] = [];
    for (const p of papers) {
      if (p.tags.length === 0) continue;
      if (!nodes.has(p.id)) {
        const pn: GraphNode = { id: p.id, kind: 'paper', label: p.title };
        nodes.set(p.id, pn);
        outNodes.push(pn);
      }
      for (const tag of p.tags) {
        // slug 清空(纯符号/emoji 等)会塌缩到 fallback id——不为它建概念
        if (!isConceptWorthyTag(tag)) continue;
        const cid = conceptId(tag);
        if (!nodes.has(cid)) {
          const cn: GraphNode = { id: cid, kind: 'concept', label: tag };
          nodes.set(cid, cn);
          outNodes.push(cn);
        }
        const key = `${p.id}|uses|${cid}`;
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          outEdges.push({ source: p.id, target: cid, kind: 'uses' });
        }
      }
    }
    return { nodes: outNodes, edges: outEdges };
  }

  private async ensurePaperNode(paper: Paper): Promise<void> {
    const nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const existing = nodes.get(paper.id);
    if (existing && existing.kind === 'paper' && existing.label === paper.title) return;
    if (!existing && nodes.size >= MAX_GRAPH_NODES) return; // graph full — skip silently
    nodes.set(paper.id, { id: paper.id, kind: 'paper', label: paper.title });
    await this.saveGraphUnlocked({ nodes: [...nodes.values()], edges: this.graph.edges });
  }

  async deletePaper(id: string): Promise<boolean> {
    this.assertLive();
    return this.withLock(async () => {
      if (!this.papers.delete(id)) return false;
      await unlink(this.paperPath(id)).catch(() => {});
      await this.removePaperFromGraph(id);
      await this.detachCardsFromPaper(id);
      // also remove any attached PDF so attachments/ never accumulates orphans
      await unlink(join(this.dir, 'attachments', `${safeName(id)}.pdf`)).catch(() => {});
      // 级联清理精读报告（reports/<safeName(id)>-*.html）；目录缺失/读失败静默跳过
      try {
        const prefix = `${safeName(id)}-`;
        for (const f of await readdir(join(this.dir, 'reports'))) {
          if (f.startsWith(prefix)) await unlink(join(this.dir, 'reports', f)).catch(() => {});
        }
      } catch { /* reports 目录不存在或不可读 */ }
      return true;
    });
  }

  /** Clear paperId on cards that referenced a deleted paper (no orphan refs). */
  private async detachCardsFromPaper(paperId: string): Promise<void> {
    for (const card of this.cards.values()) {
      if (card.paperId !== paperId) continue;
      const next: IdeaCard = { ...card, paperId: undefined, updatedAt: Date.now() };
      this.cards.set(card.id, next);
      await this.atomicWrite(this.cardPath(card.id), next);
    }
  }

  private async removePaperFromGraph(id: string): Promise<void> {
    const before = this.graph.nodes.length + this.graph.edges.length;
    const nodes = this.graph.nodes.filter((n) => !(n.kind === 'paper' && n.id === id));
    const edges = this.graph.edges.filter((e) => e.source !== id && e.target !== id);
    if (nodes.length + edges.length !== before) {
      await this.saveGraphUnlocked({ nodes, edges });
    }
  }

  /* ---------- cards ---------- */

  private cardPath(id: string): string {
    return join(this.dir, 'cards', `${safeName(id)}.json`);
  }

  async upsertCard(card: IdeaCard): Promise<IdeaCard> {
    this.assertLive();
    return this.withLock(async () => {
      this.cards.set(card.id, card);
      await this.atomicWrite(this.cardPath(card.id), card);
      return card;
    });
  }

  async deleteCard(id: string): Promise<boolean> {
    this.assertLive();
    return this.withLock(async () => {
      if (!this.cards.delete(id)) return false;
      await unlink(this.cardPath(id)).catch(() => {});
      // strip dangling relations from cards that referenced this one
      for (const card of this.cards.values()) {
        if (!(card.relatedCardIds ?? []).includes(id)) continue;
        const next: IdeaCard = { ...card, relatedCardIds: (card.relatedCardIds ?? []).filter((x) => x !== id), updatedAt: Date.now() };
        if ((next.relatedCardIds ?? []).length === 0) delete next.relatedCardIds;
        this.cards.set(card.id, next);
        await this.atomicWrite(this.cardPath(card.id), next);
      }
      return true;
    });
  }

  /** Keep only card ids that actually exist (for relation fields). */
  filterExistingCardIds(ids: string[]): string[] {
    return [...new Set(ids.filter((x) => this.cards.has(x)))];
  }

  /* ---------- graph ---------- */

  async saveGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    this.assertLive();
    return this.withLock(() => this.saveGraphUnlocked(graph));
  }

  private async saveGraphUnlocked(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    this.graph = graph;
    await this.atomicWrite(join(this.dir, 'graph.json'), graph);
    return graph;
  }

  /**
   * rebuild 专用：先把当前 graph.json 备份为 graph.json.bak（保留一代，可手工恢复），
   * 再整体替换。与 saveGraph 同一把写锁，备份+替换不会与其他写交错。
   */
  async saveGraphRebuild(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    this.assertLive();
    return this.withLock(async () => {
      await copyFile(join(this.dir, 'graph.json'), join(this.dir, 'graph.json.bak')).catch(() => {});
      return this.saveGraphUnlocked(graph);
    });
  }

  stats(): {
    papers: number;
    cards: number;
    nodes: number;
    edges: number;
    unsynced: { id: string; title: string }[];
    corruptFiles: string[];
  } {
    const inGraph = new Set(this.graph.nodes.filter((n) => n.kind === 'paper').map((n) => n.id));
    const unsynced = [...this.papers.values()]
      .filter((p) => !inGraph.has(p.id))
      .map((p) => ({ id: p.id, title: p.title }));
    return {
      papers: this.papers.size,
      cards: this.cards.size,
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      unsynced,
      corruptFiles: this.corruptFiles,
    };
  }
}
