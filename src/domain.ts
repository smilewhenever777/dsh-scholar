/**
 * dsh-scholar — domain helpers shared by routes and agent tools:
 * create/merge semantics for papers and idea cards.
 * Pure functions; all I/O happens in PaperStore.
 */
import type { CardCategory, CardStatus, IdeaCard, Paper, PaperSource } from './shared/types.js';
import { CARD_CATEGORIES, CARD_STATUSES } from './shared/types.js';
import { newCardId, paperIdFor } from './store.js';
import { parseArxivId } from './metadata.js';

export interface PaperPatch {
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  notes?: string;
  /** collection membership (ids); replacing the whole list when provided */
  collectionIds?: string[];
}

/**
 * 归一化 arXiv id 变体（裸 id 带 v2 / arXiv: 前缀 / abs、pdf 链接 → 裸 id），
 * 消掉同一论文因写法不同分裂成两条的去重漏洞；非 arXiv 形态原样返回。
 */
export function normalizeArxivId(input: string | undefined): string | undefined {
  const s = input?.trim();
  if (!s) return input;
  return parseArxivId(s) ?? input;
}

/** Build a new Paper (id from arXiv id or title slug, timestamps filled). */
export function createPaper(input: PaperPatch & { source: PaperSource }, now = Date.now()): Paper {
  const title = (input.title ?? '').trim();
  if (!title) throw new Error('论文标题不能为空');
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  return {
    id: paperIdFor(title, normalizeArxivId(input.arxivId)),
    title,
    authors: [...(input.authors ?? [])],
    year: input.year,
    venue: input.venue?.trim() || undefined,
    arxivId: normalizeArxivId(input.arxivId)?.trim() || undefined,
    doi: input.doi?.trim() || undefined,
    url: input.url?.trim() || undefined,
    abstract: input.abstract,
    summary: input.summary,
    tags,
    importance: input.importance,
    source: input.source,
    notes: input.notes,
    collectionIds: input.collectionIds?.length ? [...new Set(input.collectionIds)] : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Merge only the provided fields onto an existing paper. */
export function applyPaperPatch(existing: Paper, patch: PaperPatch, now = Date.now()): Paper {
  const next: Paper = { ...existing, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.authors !== undefined) next.authors = [...patch.authors];
  if (patch.year !== undefined) next.year = patch.year;
  if (patch.venue !== undefined) next.venue = patch.venue.trim() || undefined;
  if (patch.arxivId !== undefined) next.arxivId = normalizeArxivId(patch.arxivId)?.trim() || undefined;
  if (patch.doi !== undefined) next.doi = patch.doi.trim() || undefined;
  if (patch.url !== undefined) next.url = patch.url.trim() || undefined;
  if (patch.abstract !== undefined) next.abstract = patch.abstract;
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.tags !== undefined) next.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
  if (patch.importance !== undefined) next.importance = patch.importance;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.collectionIds !== undefined) {
    const ids = [...new Set(patch.collectionIds.filter((x): x is string => typeof x === 'string' && !!x))];
    if (ids.length === 0) delete next.collectionIds;
    else next.collectionIds = ids;
  }
  if (!next.title) throw new Error('论文标题不能为空');
  return next;
}

/** First duplicate hit by arXiv id (normalized), DOI, or normalized title. */
export function findDuplicate(
  papers: Iterable<Paper>,
  patch: { title?: string; arxivId?: string; doi?: string },
): Paper | undefined {
  const titleKey = patch.title?.trim().toLowerCase();
  const arxiv = normalizeArxivId(patch.arxivId)?.trim().toLowerCase();
  const doi = patch.doi?.trim().toLowerCase();
  for (const p of papers) {
    if (arxiv && p.arxivId && p.arxivId.toLowerCase() === arxiv) return p;
    if (doi && p.doi && p.doi.toLowerCase() === doi) return p;
    if (titleKey && p.title.trim().toLowerCase() === titleKey) return p;
  }
  return undefined;
}

export interface CardPatch {
  title?: string;
  insight?: string;
  paperId?: string;
  category?: CardCategory;
  tags?: string[];
  importance?: number;
  status?: CardStatus;
  notes?: string;
  /** related idea cards (ids); replacing the whole list when provided */
  relatedCardIds?: string[];
  /** plain-language one-liner */
  plain?: string;
  /** flow steps, one sentence each */
  steps?: string[];
}

function normalizeSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((x) => String(x).trim()).filter(Boolean);
}

export function createCard(input: CardPatch, now = Date.now()): IdeaCard {
  const title = (input.title ?? '').trim();
  const insight = (input.insight ?? '').trim();
  if (!title) throw new Error('卡片标题不能为空');
  if (!insight) throw new Error('卡片内容（创新点）不能为空');
  const category = input.category && CARD_CATEGORIES.includes(input.category) ? input.category : 'other';
  const status = input.status && CARD_STATUSES.includes(input.status) ? input.status : 'pending';
  return {
    id: newCardId(),
    title,
    insight,
    paperId: input.paperId || undefined,
    category,
    tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
    importance: input.importance ?? 3,
    status,
    notes: input.notes,
    relatedCardIds: input.relatedCardIds?.length ? [...new Set(input.relatedCardIds)] : undefined,
    plain: input.plain?.trim() || undefined,
    steps: normalizeSteps(input.steps),
    createdAt: now,
    updatedAt: now,
  };
}

export function applyCardPatch(existing: IdeaCard, patch: CardPatch, now = Date.now()): IdeaCard {
  const next: IdeaCard = { ...existing, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.insight !== undefined) next.insight = patch.insight.trim();
  if (patch.paperId !== undefined) next.paperId = patch.paperId || undefined;
  if (patch.category !== undefined && CARD_CATEGORIES.includes(patch.category)) next.category = patch.category;
  if (patch.tags !== undefined) next.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
  if (patch.importance !== undefined) next.importance = patch.importance;
  if (patch.status !== undefined && CARD_STATUSES.includes(patch.status)) next.status = patch.status;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.relatedCardIds !== undefined) {
    const ids = [...new Set(patch.relatedCardIds.filter((x): x is string => typeof x === 'string' && !!x))];
    if (ids.length === 0) delete next.relatedCardIds;
    else next.relatedCardIds = ids;
  }
  if (patch.plain !== undefined) next.plain = patch.plain.trim() || undefined;
  if (patch.steps !== undefined) {
    const st = normalizeSteps(patch.steps);
    if (st.length === 0) delete next.steps;
    else next.steps = st;
  }
  if (!next.title) throw new Error('卡片标题不能为空');
  if (!next.insight) throw new Error('卡片内容（创新点）不能为空');
  return next;
}
