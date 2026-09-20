/** dsh-trajectory shared data model (used by both host and client halves). */

export const TRAJ_NODE_KINDS = ['milestone', 'idea', 'experiment', 'paper', 'writing', 'other'] as const;
export type TrajNodeKind = (typeof TRAJ_NODE_KINDS)[number];

export const TRAJ_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const;
export type TrajStatus = (typeof TRAJ_STATUSES)[number];

export const TRAJ_EDGE_KINDS = ['enables', 'feeds', 'composes'] as const;
export type TrajEdgeKind = (typeof TRAJ_EDGE_KINDS)[number];

/** 跨插件引用:存 id + 展示标签,不强校验对端存在(scholar/dashboard 独立演进)。 */
export interface TrajNodeRefs {
  /** scholar idea 卡 */
  cardId?: string;
  cardLabel?: string;
  /** scholar 论文 */
  paperId?: string;
  paperLabel?: string;
  /** dashboard 实验绑定(用于实时进度匹配) */
  hostId?: string;
  logPath?: string;
  cmdPattern?: string;
}

/** 结构化指标(Benchling Results 轻量版):可计算的数据资产,渲染对比表/差值着色。 */
export interface TrajMetric {
  /** 指标名,如 "DroneVehicle mAP50-95" */
  name: string;
  /** 本方法取值 */
  value: number;
  /** 对照基线(如 BASE Naive Add),省略则无对比 */
  baseline?: number;
  /** 单位,如 "pp" / "%" / "" */
  unit?: string;
}

/** 实验台账:节点上的一条已有工作记录(实验数据/决策/结论)。 */
export interface TrajEntry {
  id: string; // t_<base36><rand>
  /** 记录时间戳(展示为日期) */
  ts: number;
  /** 做了什么 */
  title: string;
  /** 关键数据(自由文本,兼容旧数据;新数据建议用 metrics) */
  data?: string;
  /** 结构化指标(可选,与 data 并存时优先渲染) */
  metrics?: TrajMetric[];
  /** 结论/判定 */
  conclusion?: string;
}

export interface TrajNode {
  id: string; // n_<base36><rand>
  projectId: string;
  kind: TrajNodeKind;
  title: string;
  status: TrajStatus;
  /** 结论/说明(done 节点应写) */
  detail?: string;
  refs?: TrajNodeRefs;
  tags?: string[];
  /** 实验台账:这条线路上已发生的工作(按时间倒序展示) */
  entries?: TrajEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface TrajEdge {
  id: string; // e_<base36><rand>
  source: string;
  target: string;
  kind: TrajEdgeKind;
}

export interface TrajProject {
  id: string; // p_<base36><rand>
  name: string;
  description?: string;
  /** 研究问题/目标(一句话,梳理视图置顶展示) */
  researchQuestion?: string;
  /** 创新主线:有序节点 id(关键路径,图上高亮脊柱) */
  mainline: string[];
  status: 'active' | 'archived';
  /** 绑定的 DSH 工作区(规范化 cwd,见 domain.normalizeWorkspaceKey);1 工作区 ↔ 1 主线 */
  workspaceKey?: string;
  createdAt: number;
  updatedAt: number;
}

/** 一个项目一个文件的落盘形态。 */
export interface TrajProjectFile {
  project: TrajProject;
  nodes: TrajNode[];
  edges: TrajEdge[];
}

export interface TrajConfig {
  dataDir: string;
}

export interface TrajProjectSummary {
  id: string;
  name: string;
  status: TrajProject['status'];
  workspaceKey?: string;
  nodes: number;
  open: number;
  updatedAt: number;
}

export interface TrajOverview {
  /** 当前解析的项目:有 ws 参数时 = 该工作区绑定项目;否则 = 全局活跃项目 */
  activeProjectId: string | null;
  /** 请求的 ws(规范化后回显);无绑定项目时也回显,便于 UI 判断空态 */
  ws?: string;
  wsBound: boolean;
  projects: TrajProjectSummary[];
  counts: Record<TrajStatus, number>;
  dir: string;
}

export interface TrajStats {
  projects: number;
  nodes: number;
  edges: number;
  counts: Record<TrajStatus, number>;
  dir: string;
  activeProjectName?: string;
}
