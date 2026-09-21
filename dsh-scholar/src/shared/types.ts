/** dsh-scholar shared data model (used by both host and client halves). */

export type PaperSource = 'agent' | 'manual';

/** 阅读状态工作流（ReadPaper 式）：想读 → 在读 → 读过；缺省视为 want */
export const READ_STATUSES = ['want', 'reading', 'done'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

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
  /** 阅读状态（缺省 = want） */
  readStatus?: ReadStatus;
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
  /** 证据摘录：来源论文的关键原文 + 定位（如 §3.2 / Fig.3），让卡片自包含 */
  evidence?: string;
  createdAt: number;
  updatedAt: number;
}

/** idea = Idea 卡片节点（第三类：想法），label = 卡片标题 */
export type GraphNodeKind = 'paper' | 'concept' | 'idea';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

/** cites = OpenAlex 客观引用关系（文献学事实）；derives_from = 想法→来源论文；related = 卡片间关联 */
export const GRAPH_EDGE_KINDS = ['proposes', 'improves', 'extends', 'builds_on', 'compares', 'uses', 'cites', 'derives_from', 'related'] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** R04:自动同步所有者(卡片 id)——仅 cardSync 生成的边携带;prune 差集
   * 只动自己拥有的 auto 边,kg_extract/手工边(无 auto)永不删除 */
  auto?: string;
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
  /** Optional contact email for the OpenAlex polite pool (higher rate limits) */
  openalexEmail?: string;
  /** 研究方向：对话精读 focus 的锚点（首读不用，复读/对比/迁移时拼入） */
  researchFocus?: string;
  /** VLM 读图：auto（模型支持才启用）| off */
  vlmFigures?: 'auto' | 'off';
}

export type PaperSort = 'createdAt' | 'year' | 'title';

export interface PaperQuery {
  q?: string;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
  importance?: number;
  collection?: string;
  /** 只看未归入任何分区的论文 */
  unfiled?: boolean;
  readStatus?: ReadStatus;
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
