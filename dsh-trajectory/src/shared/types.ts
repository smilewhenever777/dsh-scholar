/** dsh-trajectory shared data model (used by both host and client halves).
 *
 *  v0.3 三层结构:Goal(总目标,版本化)→ Hypothesis(子假设,可演化)→ Experiment(实验,挂台账)。
 *  旧 v0.2 的平铺节点(mainline + kind)通过迁移函数升级。
 */

export const TRAJ_NODE_KINDS = ['milestone', 'idea', 'experiment', 'paper', 'writing', 'other'] as const;
export type TrajNodeKind = (typeof TRAJ_NODE_KINDS)[number];

export const TRAJ_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const;
export type TrajStatus = (typeof TRAJ_STATUSES)[number];

export const TRAJ_EDGE_KINDS = ['enables', 'feeds', 'composes'] as const;
export type TrajEdgeKind = (typeof TRAJ_EDGE_KINDS)[number];

/* ═══════════════ 层 0:总目标(版本化,演化留痕) ═══════════════ */

export const TRAJ_GOAL_STATUS = ['active', 'superseded'] as const;
export type TrajGoalStatus = (typeof TRAJ_GOAL_STATUS)[number];

export interface TrajGoal {
  id: string;                // g_<base36><rand>
  projectId: string;
  /** 目标陈述(一句话) */
  text: string;
  /** 版本号,从 1 递增;同一项目同一时刻只有一个 active */
  version: number;
  status: TrajGoalStatus;
  /** 何时被替代(superseded 时填写) */
  supersededAt?: number;
  /** 为什么变了(pivot 原因) */
  supersededReason?: string;
  createdAt: number;
}

/* ═══════════════ 层 1:子假设(可分解、可证否、可标轨迹) ═══════════════ */

export const TRAJ_HYP_STATUS = ['active', 'validated', 'falsified', 'superseded', 'parked'] as const;
export type TrajHypStatus = (typeof TRAJ_HYP_STATUS)[number];

export const TRAJ_TRACKS = ['mainline', 'branch', 'detour', 'returned'] as const;
export type TrajTrack = (typeof TRAJ_TRACKS)[number];

export interface TrajHypothesis {
  id: string;                // h_<base36><rand>
  projectId: string;
  /** 归属的目标版本(goal v2 下的假设,goal v3 换目标后可能被 superseded) */
  goalVersionId: string;
  /** 假设陈述(要验证什么) */
  text: string;
  status: TrajHypStatus;
  /** 轨迹标签:主线 / 探索分支 / 已偏离 / 已回归 */
  track: TrajTrack;
  /** 为什么被证否/搁置/替代 */
  outcomeReason?: string;
  createdAt: number;
  updatedAt: number;
}

/* ═══════════════ 层 2:实验(服务某个假设,挂台账) ═══════════════ */

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
  /** 指标名,如 "数据集A mAP50-95" */
  name: string;
  /** 本方法取值 */
  value: number;
  /** 对照基线(如 BASE Naive Add),省略则无对比 */
  baseline?: number;
  /** 单位,如 "pp" / "%" / "" */
  unit?: string;
}

/** 实验台账:一条已有工作记录(实验数据/决策/结论)。 */
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
  /** v0.3:归属哪个假设;空 = 未分配(迁移兼容) */
  hypothesisId?: string;
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

/* ═══════════════ 演化日志(目标/假设的变化记录) ═══════════════ */

export const TRAJ_LOG_TYPES = [
  'goal_created', 'goal_revised', 'goal_pivoted',
  'hyp_added', 'hyp_validated', 'hyp_falsified', 'hyp_pivoted',
  'hyp_track_changed', 'experiment_added', 'experiment_completed',
] as const;
export type TrajLogType = (typeof TRAJ_LOG_TYPES)[number];

export interface TrajGoalLog {
  id: string;                // l_<base36><rand>
  projectId: string;
  ts: number;
  type: TrajLogType;
  /** 人类可读的变化描述(含原因) */
  description: string;
}

/* ═══════════════ 项目(聚合根) ═══════════════ */

export interface TrajProject {
  id: string; // p_<base36><rand>
  name: string;
  description?: string;
  /** v0.2 兼容:旧版静态研究问题(迁移时转为 Goal v1;此后不再使用) */
  researchQuestion?: string;
  /** v0.2 兼容:旧版主线节点 id 列表(迁移时转为 mainline Hypothesis;此后不再使用) */
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
  goals: TrajGoal[];
  hypotheses: TrajHypothesis[];
  goalLog: TrajGoalLog[];
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
  activeProjectId: string | null;
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
