/** dsh-scholar shared data model (used by both host and client halves). */

export type PaperSource = 'agent' | 'manual';

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /** AI 一句话总结（对话中生成） */
  summary?: string;
  tags: string[];
  /** 1–5 */
  importance?: number;
  /** 附件相对路径（attachments/<file>） */
  pdfPath?: string;
  source: PaperSource;
  notes?: string;
  /** 收集分区（多重归属，引用 collections.json 的 id） */
  collectionIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** 论文收集分区（Zotero 式多重归属；存于 collections.json） */
export interface PaperCollection {
  id: string; // col_<base36><rand>
  name: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export const CARD_CATEGORIES = ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

export const CARD_STATUSES = ['pending', 'validated', 'adopted', 'dropped'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export interface IdeaCard {
  id: string;
  title: string;
  /** 创新点描述 */
  insight: string;
  /** 来源论文 id（可空） */
  paperId?: string;
  category: CardCategory;
  tags: string[];
  /** 1–5 */
  importance: number;
  status: CardStatus;
  notes?: string;
  /** 卡片间关联（P2） */
  relatedCardIds?: string[];
  /** 通俗表达：一句大白话讲清这个想法 */
  plain?: string;
  /** 简易流程步骤（每步一句，渲染为纵向流程图） */
  steps?: string[];
  createdAt: number;
  updatedAt: number;
}

export type GraphNodeKind = 'paper' | 'concept';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

export const GRAPH_EDGE_KINDS = ['proposes', 'improves', 'extends', 'builds_on', 'compares', 'uses'] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ScholarStats {
  papers: number;
  cards: number;
  nodes: number;
  edges: number;
  dir: string;
  /** 已入库但尚未入图的论文（id+title） */
  unsynced?: { id: string; title: string }[];
  /** init 时跳过的损坏文件清单（相对路径），可能不存在于旧响应 */
  corruptFiles?: string[];
}

export interface ScholarConfig {
  paperDir: string;
  defaultTags?: string[];
  /** Optional outbound HTTP(S) proxy for metadata fetching, e.g. http://127.0.0.1:7890 */
  fetchProxy?: string;
}

export type PaperSort = 'createdAt' | 'year' | 'title';

export interface PaperQuery {
  q?: string;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
  importance?: number;
  collection?: string;
  sort?: PaperSort;
}

export type CardSort = 'createdAt' | 'importance' | 'title';

export interface CardQuery {
  q?: string;
  category?: CardCategory;
  tag?: string;
  importance?: number;
  status?: CardStatus;
  paperId?: string;
  sort?: CardSort;
}
