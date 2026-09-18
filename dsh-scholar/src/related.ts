/**
 * dsh-scholar — 相关论文发现（OpenAlex 公开 API，host 侧纯抓取，无 LLM）。
 *
 * 给定库内一篇论文：解析其 OpenAlex work →
 *   similar    = work.related_works（OpenAlex 相似推荐，可能为空）
 *   citations  = filter=cites:W…（被引，按被引数降序 top 8）
 *   references = work.referenced_works（本篇引用，取前 12）
 * 每条结果与本地库去重（arXiv id / DOI / 归一化标题），标注 libraryPaperId。
 *
 * 模块级缓存：paperId → 报告，TTL 10 分钟、上限 30 条（防详情页反复打开打爆 API）。
 */
import { getText } from './metadata.js';
import type { GraphEdge, Paper } from './shared/types.js';

const OA = 'https://api.openalex.org';
const FIELDS = 'id,display_name,publication_year,cited_by_count,doi,authorships,primary_location';
const TIMEOUT = 12_000;
const TTL_MS = 10 * 60 * 1000;

export interface RelatedWork {
  openalexId: string;
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  citedBy: number;
  authors: string[];
  /** 命中本地库时为对应论文 id */
  libraryPaperId?: string;
}

export interface RelatedReport {
  openalexId?: string;
  similar: RelatedWork[];
  citations: RelatedWork[];
  references: RelatedWork[];
  fetchedAt: number;
  /** 非致命说明（如 OpenAlex 未收录本篇） */
  note?: string;
}

/* ---------- OpenAlex 原始结构（只声明用到的字段） ---------- */
interface OaWork {
  id?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  doi?: string | null;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string };
  related_works?: string[];
  referenced_works?: string[];
}

/** 从 OpenAlex work 提取 arXiv id：10.48550/arxiv.XXX DOI 或 arxiv.org/abs/ 链接 */
export function arxivFromWork(w: OaWork): string | undefined {
  const doi = w.doi ?? '';
  const m = /^https?:\/\/(?:dx\.)?doi\.org\/10\.48550\/arxiv\.(.+)$/i.exec(doi);
  if (m) return m[1].toLowerCase();
  const url = w.primary_location?.landing_page_url ?? '';
  const am = /arxiv\.org\/abs\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z-]+)?\/[0-9]{7})/i.exec(url);
  if (am) return am[1].replace(/v\d+$/i, '').toLowerCase();
  return undefined;
}

/** OpenAlex work → 紧凑 RelatedWork（纯函数，冒烟可测） */
export function parseOpenalexWork(w: OaWork): RelatedWork | null {
  if (!w || !w.id || !w.display_name) return null;
  const wi = w.id.split('/').pop() ?? '';
  const doiUrl = w.doi ?? '';
  return {
    openalexId: wi,
    title: w.display_name,
    year: w.publication_year,
    venue: w.primary_location?.source?.display_name || undefined,
    doi: doiUrl.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined,
    arxivId: arxivFromWork(w),
    citedBy: w.cited_by_count ?? 0,
    authors: (w.authorships ?? [])
      .map((a) => a.author?.display_name ?? '')
      .filter(Boolean)
      .slice(0, 5),
  };
}

/** 标题归一化（小写、去非字母数字）用于精确匹配 */
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/** 从 title.search 结果里挑最像的一条：精确归一化命中优先，否则第一条 */
export function pickBestWork(title: string, results: OaWork[]): OaWork | null {
  if (!results.length) return null;
  const want = normTitle(title);
  return results.find((r) => normTitle(r.display_name ?? '') === want) ?? results[0];
}

/** 本地库索引：arXiv / DOI / 归一化标题 → 论文 id */
function buildLibraryIndex(papers: Paper[]): { arxiv: Map<string, string>; doi: Map<string, string>; title: Map<string, string> } {
  const arxiv = new Map<string, string>();
  const doi = new Map<string, string>();
  const title = new Map<string, string>();
  for (const p of papers) {
    if (p.arxivId) arxiv.set(p.arxivId.toLowerCase(), p.id);
    if (p.doi) doi.set(p.doi.toLowerCase(), p.id);
    title.set(normTitle(p.title), p.id);
  }
  return { arxiv, doi, title };
}

function annotate(work: RelatedWork, idx: ReturnType<typeof buildLibraryIndex>): RelatedWork {
  const hit =
    (work.arxivId && idx.arxiv.get(work.arxivId)) ||
    (work.doi && idx.doi.get(work.doi.toLowerCase() ?? '')) ||
    idx.title.get(normTitle(work.title));
  return hit ? { ...work, libraryPaperId: hit } : work;
}

async function oaGet(path: string, proxy?: string): Promise<any> {
  await throttle();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${OA}${path}${openalexContact ? `${sep}mailto=${encodeURIComponent(openalexContact)}` : ''}`;
  try {
    const text = await getText(url, TIMEOUT, proxy);
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 429/Rate limit：等 3s 重试一次（匿名池滑动窗口短，一次退避通常足够）
    if (/429|rate limit/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 3000));
      await throttle();
      const text2 = await getText(url, TIMEOUT, proxy);
      return JSON.parse(text2);
    }
    throw err;
  }
}

/* ---------- 限速：OpenAlex 匿名池对瞬时并发很敏感（实测并发 4 直接 429），
 * 全局串行队列 + 350ms 最小间隔（≈3 req/s）；mailto 进 polite pool 可进一步放宽。 */
let openalexContact: string | undefined;
let lastReqAt = 0;
let oaQueue: Promise<void> = Promise.resolve();

export function setOpenalexContact(email?: string): void {
  openalexContact = email?.trim() || undefined;
}

function throttle(): Promise<void> {
  const run = oaQueue.then(async () => {
    const wait = lastReqAt + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
  });
  oaQueue = run.catch(() => {});
  return run;
}

/** 批量取 work 详情（单批 ≤ perPage，默认 50） */
async function fetchWorks(ids: string[], proxy?: string, perPage = 50): Promise<RelatedWork[]> {
  if (!ids.length) return [];
  const raw = (await oaGet(
    `/works?filter=openalex:${ids.join('|')}&per_page=${perPage}&select=${FIELDS}`,
    proxy,
  )) as { results?: OaWork[] };
  const out: RelatedWork[] = [];
  for (const w of raw.results ?? []) {
    const parsed = parseOpenalexWork(w);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** 解析库内论文在 OpenAlex 的 work（三级：论文 DOI → arXiv DOI → 标题搜索兜底） */
async function resolveWork(paper: Paper, proxy?: string): Promise<OaWork | null> {
  const RESOLVE_FIELDS = 'id,display_name,publication_year,related_works,referenced_works';
  // OpenAlex 以 10.48550/arxiv.<id> 收录 arXiv 预印本；直查命中率远高于标题搜索
  //（2026 新预印本标题搜索常不命中，arXiv DOI 却已建档）
  for (const doi of [paper.doi, paper.arxivId ? `10.48550/arxiv.${paper.arxivId}` : undefined]) {
    if (!doi) continue;
    try {
      const byDoi = (await oaGet(
        `/works/https://doi.org/${encodeURIComponent(doi)}?select=${RESOLVE_FIELDS}`,
        proxy,
      )) as OaWork;
      if (byDoi?.id) return byDoi;
    } catch { /* 该 DOI 未收录 → 下一级 */ }
  }
  const q = paper.title.replace(/[：""]/g, ' ').trim().slice(0, 200);
  const raw = (await oaGet(
    `/works?filter=title.search:${encodeURIComponent(q)}&per_page=5&select=${RESOLVE_FIELDS}`,
    proxy,
  )) as { results?: OaWork[] };
  return pickBestWork(paper.title, raw.results ?? []);
}

/* ---------- 模块级缓存 ---------- */
const cache = new Map<string, RelatedReport>();

export async function getRelatedReport(paper: Paper, library: Paper[], proxy?: string): Promise<RelatedReport> {
  let raw = cache.get(paper.id);
  if (!raw || Date.now() - raw.fetchedAt >= TTL_MS) {
    raw = await buildRawReport(paper, proxy);
    if (cache.size > 30) {
      // 简单逐出：删最早写入的键
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    cache.set(paper.id, raw);
  }
  // 与库的匹配标注每次请求现算、不进缓存：入库/删除后立即反映，
  // 不受 TTL 拖累（否则刚入库的论文在缓存期内还会显示"＋入库"）
  const idx = buildLibraryIndex(library);
  return {
    ...raw,
    similar: raw.similar.map((w) => annotate(w, idx)),
    citations: raw.citations.map((w) => annotate(w, idx)),
    references: raw.references.map((w) => annotate(w, idx)),
  };
}

/** 拉 OpenAlex 三路结果（不做库内标注——标注是读取期语义） */
async function buildRawReport(paper: Paper, proxy?: string): Promise<RelatedReport> {
  const report: RelatedReport = { similar: [], citations: [], references: [], fetchedAt: Date.now() };

  let work: OaWork | null = null;
  try {
    work = await resolveWork(paper, proxy);
  } catch {
    work = null;
  }
  if (!work?.id) {
    report.note = 'OpenAlex 未收录这篇论文（或网络不可达）';
    return report;
  }
  report.openalexId = work.id.split('/').pop();
  const wid = work.id.split('/').pop() ?? '';

  // 三个来源并行；任一失败只损失该列表，不拖垮整份报告
  const [similar, citations, references] = await Promise.all([
    // related_works 是 id 数组，需二次批量取详情
    fetchWorks((work.related_works ?? []).map((r) => r.split('/').pop() ?? '').filter(Boolean).slice(0, 8), proxy).catch(() => [] as RelatedWork[]),
    oaGet(`/works?filter=cites:${wid}&sort=cited_by_count:desc&per_page=8&select=${FIELDS}`, proxy)
      .then((raw: { results?: OaWork[] }) => (raw.results ?? []).map(parseOpenalexWork).filter(Boolean) as RelatedWork[])
      .catch(() => [] as RelatedWork[]),
    fetchWorks((work.referenced_works ?? []).map((r) => r.split('/').pop() ?? '').filter(Boolean).slice(0, 12), proxy).catch(() => [] as RelatedWork[]),
  ]);

  report.similar = similar;
  report.citations = citations;
  report.references = references;
  return report;
}

/* ---------- 引用关系图谱同步（只在两端都已入库的论文间产 cites 边） ---------- */

export interface CiteSyncResult {
  scanned: number;
  resolved: number;
  addedEdges: GraphEdge[];
  /** OpenAlex 未收录的库内论文（id+标题） */
  misses: { id: string; title: string }[];
}

/** 简单并发池：n 路顺序领取任务，保序写回结果 */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/** work 解析缓存（30 分钟）：重复点同步按钮不重打 API */
const workCache = new Map<string, { at: number; work: OaWork | null }>();

async function resolveWorkCached(paper: Paper, proxy?: string): Promise<OaWork | null> {
  const hit = workCache.get(paper.id);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.work;
  let work: OaWork | null = null;
  try { work = await resolveWork(paper, proxy); } catch { work = null; }
  // 只缓存成功解析：失败（限流抖动/未收录）不缓存，下次点击立即重试
  if (work?.id) {
    if (workCache.size > 100) {
      const first = workCache.keys().next().value;
      if (first) workCache.delete(first);
    }
    workCache.set(paper.id, { at: Date.now(), work });
  }
  return work;
}

/**
 * 全库引用扫描：
 * 1) 逐篇解析 OpenAlex work（并发 4，带缓存）；
 * 2) 汇总全部 referenced_works，按 100/批取详情；
 * 3) 与库去重（arXiv/DOI/归一化标题，排除自引），已存在的 cites 边跳过。
 * 幂等：重复执行不会产生重复边。
 */
export async function citeSyncPatch(papers: Paper[], existingEdges: GraphEdge[], proxy?: string): Promise<CiteSyncResult> {
  const idx = buildLibraryIndex(papers);
  const existing = new Set(existingEdges.filter((e) => e.kind === 'cites').map((e) => `${e.source}|${e.target}`));

  const resolved = await pool(papers, 2, async (p) => ({ p, work: await resolveWorkCached(p, proxy) }));
  const misses = resolved.filter((r) => !r.work?.id).map((r) => ({ id: r.p.id, title: r.p.title }));

  // 汇总所有引用目标，一次批量取详情（比逐篇取省一个数量级的请求）
  const refIds = new Set<string>();
  for (const r of resolved) {
    for (const ref of r.work?.referenced_works ?? []) {
      const wid = ref.split('/').pop();
      if (wid) refIds.add(wid);
    }
  }
  const details = new Map<string, RelatedWork>();
  const ids = [...refIds];
  for (let i = 0; i < ids.length; i += 100) {
    const list = await fetchWorks(ids.slice(i, i + 100), proxy, 100).catch(() => [] as RelatedWork[]);
    for (const w of list) details.set(w.openalexId, w);
  }

  const added: GraphEdge[] = [];
  for (const r of resolved) {
    if (!r.work?.id) continue;
    for (const ref of r.work.referenced_works ?? []) {
      const wid = ref.split('/').pop();
      const w = wid ? details.get(wid) : undefined;
      if (!w) continue;
      const hit =
        (w.arxivId && idx.arxiv.get(w.arxivId)) ||
        (w.doi && idx.doi.get(w.doi.toLowerCase())) ||
        idx.title.get(normTitle(w.title));
      if (!hit || hit === r.p.id) continue; // 不在库 / 自引 → 跳过
      const key = `${r.p.id}|${hit}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push({ source: r.p.id, target: hit, kind: 'cites' });
    }
  }
  return { scanned: papers.length, resolved: resolved.length - misses.length, addedEdges: added, misses };
}
