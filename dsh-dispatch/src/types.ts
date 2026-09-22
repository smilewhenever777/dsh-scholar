/**
 * dsh-dispatch 内部数据契约(P1 执行内核)。
 * 依据 DISPATCH-DESIGN-REVISED.md §4.1 + P0 实测修订(docs/runtime-capabilities.md)。
 * 这是项目内部模型,不是 SDK 类型。
 */

/* ================= 阶段 / 结果 / 回写 ================= */

/** 执行阶段:知识按持久化事件推进,不猜测。 */
export type DispatchPhase =
  | 'preparing'    // 已持久化派发意图与预留身份,尚未领取目标
  | 'starting'     // 已越过副作用边界(mayHaveExecuted=true),startContinuable 进行中
  | 'queued'       // 宿主已接受初始消息(回执在手);P0 实测该窗口极短
  | 'running'      // 观察到本尝试的执行周期(subagent/start)
  | 'cancelling'   // 取消意图已持久化,等待停止证据与队列静止(P0 发现 4)
  | 'settling'     // 结果证据已齐或终局运行已结束,正在收尾
  | 'reconciling'  // 证据不完整(重启/观察失败),不猜终态、保留占用
  | 'finished';    // result 已判定

export type OutcomeKind = 'done' | 'failed' | 'blocked' | 'aborted';

export type WritebackState =
  | 'not_ready'          // P1:无 trajectory 接入(P2 起为 pending)
  | 'pending'
  | 'applied'
  | 'skipped_superseded'
  | 'skipped_deleted'
  | 'error';

/** 稳定 reasonCode——不允许用自由文本代替可判定归因。 */
export type ReasonCode =
  | 'RESULT_SUBMITTED'
  | 'TASK_BLOCKED'
  | 'TASK_FAILED'
  | 'REPORT_MISSING'
  | 'RUN_ERROR'
  | 'RUN_MAX_TOKENS'
  | 'RUN_REFUSAL'
  | 'RUN_UNKNOWN_STOP'
  | 'ABORTED_STOPPED'                 // 非取消原因的 aborted 且已确认静止
  | 'CANCELLED_BEFORE_FINALIZATION'   // 取消生效后停止
  | 'CANCELLED_TOO_LATE'              // 完成条件先持久化,取消记录为过晚(不改结果)
  | 'BUDGET_EXCEEDED'                 // 触发停止的原因;终局归因仍按停止证据
  | 'START_REJECTED'                  // startContinuable 拒绝(P0 实测:拒绝即完整回滚)
  | 'CLAIM_CONFLICT'                  // 目标领取冲突(节点被占/指纹不符)
  | 'TAKEOVER_SUPERSEDED';            // 人工接管,不再自动收尾

/* ================= 证据 / 快照 ================= */

export interface EvidenceRef {
  kind: 'log' | 'artifact' | 'metric' | 'command' | 'code_change';
  ref: string;
  summary?: string;
}

export interface TaskSnapshot {
  /** 内存目标(P1 测试)或 trajectory 读取后的规范化任务卡;来源字段 source 记录出处。 */
  source: 'memory' | 'trajectory';
  projectId: string;
  nodeId: string;
  nodeTitle: string;
  nodeKind?: string;
  nodeDetail?: string;
  goalText?: string;
  goalVersion?: number;
  hypothesisText?: string;
  entriesCount?: number;
  contract?: {
    deliverables?: string;
    completionCriteria?: string;
    allowed?: string;
    forbidden?: string;
    evidenceRequired?: string;
    blockedWhen?: string;
  };
}

/* ================= 运行观察 ================= */

export interface ObservedRun {
  runId: string;
  observedStartAt?: number;
  observedEndAt?: { observedAt: number; stopReason: string };
}

/* ================= 派发记录(持久化形态,schemaVersion 2) ================= */

export interface WorkerReport {
  hash: string;
  submittedByChildSessionId: string;
  runId?: string;
  runAssociation: 'verified' | 'unresolved';
  outcome: 'done' | 'failed' | 'blocked';
  summary: string;
  evidence: EvidenceRef[];
  nextHint?: string;
  receivedAt: number;
  /** §4.4:取消生效后到达的报告只保留为部分提交。 */
  supersededByCancel?: boolean;
}

export interface DispatchRecord {
  schemaVersion: 2;
  revision: number;
  id: string;
  request: {
    actorScope: string;
    idempotencyKey: string;
    payloadHash: string;
  };
  targetType: 'traj_node';
  targetRef: {
    projectId: string;
    nodeId: string;
    workspaceId: string;
    canonicalRoot: string;
  };
  source: {
    taskFingerprint: string;
    snapshot: TaskSnapshot;
    promptText?: string;
    promptHash?: string;
    protocolVersion: string;
  };
  runtime: {
    sponsorSessionId: string;
    childSessionId: string;
    messageId?: string;
    observedRuns: ObservedRun[];
    /** 队列静止确认(P0 发现 4:中断不清除 parked 工作,取消完成必须见静止)。 */
    quiescence: 'unconfirmed' | 'confirmed' | 'operator_confirmed';
    quiescenceEvidence?: string;
  };
  ownership: {
    epoch?: number;
    state: 'pending' | 'owned' | 'revoked' | 'released';
    workerWrites: 'disabled' | 'enabled' | 'revoked';
  };
  reservation: {
    targetHeld: boolean;
    workspaceHeld: boolean;
    executionSlotHeld: boolean;
  };
  startIntent: {
    mayHaveExecuted: boolean;
    persistedAt?: number;
  };
  phase: DispatchPhase;
  lastKnownPhase?: DispatchPhase;
  report?: WorkerReport;
  /** 人工/宿主判定的最终结果;设置后 phase 必为 finished。 */
  result?: {
    kind: OutcomeKind;
    reasonCode: ReasonCode;
    summary: string;
    decidedAt: number;
  };
  writeback: {
    operationId: string;
    state: WritebackState;
    attempts: number;
    lastErrorCode?: string;
  };
  cancel?: { requestedAt: number; requestedBy: string; reason: string; effective: boolean };
  takeover?: { requestedAt: number; actor: string; reason: string };
  createdAt: number;
  acceptedAt?: number;
  lastProgressAt?: number;
  endedAt?: number;
  limits: {
    maxWallMs: number;
  };
  effectiveConfig: {
    provider: string;
    modelProvider: string;
    model: string;
    toolPolicyVersion: string;
  };
  audit: Array<{ at: number; type: string; actor: string; detail?: string }>;
}

/* ================= 归约器输入:规范化事件 ================= */

export type DispatchEvent =
  | { type: 'claim-ok'; at: number; epoch: number; taskFingerprint: string }
  | { type: 'claim-conflict'; at: number; detail: string }
  | { type: 'start-intent'; at: number }
  | { type: 'start-accepted'; at: number; childId: string; messageId: string }
  | { type: 'start-rejected'; at: number; detail: string }
  | { type: 'run-started'; at: number; runId: string }
  | { type: 'run-ended'; at: number; runId: string; stopReason: string }
  | { type: 'progress'; at: number; sequence: number; fromChild: string }
  | {
      type: 'report';
      at: number;
      fromChild: string;
      report: WorkerReport;
    }
  | { type: 'cancel-requested'; at: number; by: string; reason: string }
  | { type: 'quiescence-confirmed'; at: number; evidence: string; operator?: boolean }
  | { type: 'takeover'; at: number; actor: string; reason: string }
  | { type: 'budget-exceeded'; at: number; kind: string }
  | { type: 'reconcile-unresolved'; at: number; detail: string }
  | { type: 'late-report-quarantined'; at: number; detail: string };

/* ================= 服务层错误码(REST 稳定 code) ================= */

export type ServiceErrorCode =
  | 'VALIDATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NODE_OCCUPIED'
  | 'WORKSPACE_OCCUPIED'
  | 'CAPACITY_EXCEEDED'
  | 'NOT_FOUND'
  | 'STORE_READONLY'
  | 'DEPENDENCY_MISSING'
  | 'WRONG_STATE'
  | 'UNAUTHORIZED_WORKER'
  | 'REPORT_CONFLICT'
  | 'INTERNAL';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly httpStatus: number;
  constructor(code: ServiceErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 派发是否仍持有任何资源占用(§4.5:finished 不等于全部释放,但 P1 无回写故等价)。 */
export function holdsAnyReservation(d: DispatchRecord): boolean {
  return d.reservation.targetHeld || d.reservation.workspaceHeld || d.reservation.executionSlotHeld;
}

/** 尝试是否处于"可能仍在执行"区间(服务副作用判断用)。 */
export function attemptActive(d: DispatchRecord): boolean {
  return ['preparing', 'starting', 'queued', 'running', 'cancelling', 'settling', 'reconciling'].includes(d.phase);
}
