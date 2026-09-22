/**
 * 纯状态归约器(P1 执行内核的核心)。
 * 依据 DISPATCH-DESIGN-REVISED.md §4.2 状态归约 / §4.3 终态决策表 / §4.4 取消与完成并发,
 * 并落实 P0 实测修订(docs/runtime-capabilities.md 6 项修订要求)。
 *
 * 纯函数:输入持久化事件与当前记录,返回新记录;不做 I/O、不发副作用。
 * 副作用(中断、drain、回写)由 service 按归约前后的状态差决定。
 */
import type { DispatchEvent, DispatchRecord, OutcomeKind, ReasonCode } from './types.js';

/** 异常型 stopReason(§4.3:未知原因默认异常分支,新原因不得落入成功);completed/aborted 非异常。 */
const ABNORMAL_STOP: Record<string, ReasonCode | undefined> = {
  error: 'RUN_ERROR',
  'max-tokens': 'RUN_MAX_TOKENS',
  refusal: 'RUN_REFUSAL',
};

function abnormalReason(stopReason: string): ReasonCode | undefined {
  if (stopReason === 'completed' || stopReason === 'aborted') return undefined;
  return ABNORMAL_STOP[stopReason] ?? 'RUN_UNKNOWN_STOP';
}

function audit(d: DispatchRecord, at: number, type: string, actor: string, detail?: string): void {
  d.audit.push({ at, type, actor, detail });
  if (d.audit.length > 200) d.audit.splice(0, d.audit.length - 200);
}

function findRun(d: DispatchRecord, runId: string) {
  return d.runtime.observedRuns.find((r) => r.runId === runId);
}

/** §4.5(P1 口径):终局即释放三占用;所有权按接管与否标记。 */
function finish(d: DispatchRecord, kind: OutcomeKind, reasonCode: ReasonCode, summary: string, at: number): void {
  d.phase = 'finished';
  d.endedAt = at;
  d.result = { kind, reasonCode, summary: summary.slice(0, 500), decidedAt: at };
  d.reservation = { targetHeld: false, workspaceHeld: false, executionSlotHeld: false };
  d.ownership.state = d.ownership.state === 'revoked' ? 'revoked' : 'released';
  if (d.ownership.workerWrites === 'enabled') d.ownership.workerWrites = 'disabled';
  // §5.6:领取过的尝试终态即挂起回写(服务层异步 finalize);从未领取的保持 not_ready
  d.writeback = d.ownership.epoch !== undefined
    ? { operationId: d.writeback.operationId, state: 'pending', attempts: 0 }
    : d.writeback;
  audit(d, at, 'finished', 'reducer', `${kind}/${reasonCode}`);
}

/** 结算:终局运行证据 + 报告/取消状态 → §4.3 决策表。 */
function settle(d: DispatchRecord, at: number): void {
  if (d.phase === 'finished') return;
  const lastRun = d.runtime.observedRuns[d.runtime.observedRuns.length - 1];
  const end = lastRun?.observedEndAt;
  const cancelEffective = !!d.cancel?.effective;
  const report = d.report;

  // 尚无终止证据 → 维持 settling/cancelling 等待(§4.3 最后一行)
  if (!end && !(cancelEffective && !lastRun)) return;

  if (end) {
    const abnormal = abnormalReason(end.stopReason);
    if (abnormal) {
      // 异常终止:保留报告,不将异常覆盖为成功,也不用取消掩盖错误(§4.3/§4.4)
      finish(d, 'failed', abnormal, report ? `运行异常:${end.stopReason};报告已保留` : `运行异常:${end.stopReason}`, at);
      return;
    }
    if (end.stopReason === 'completed') {
      if (report && !report.supersededByCancel) {
        if (report.outcome === 'done') finish(d, 'done', 'RESULT_SUBMITTED', report.summary, at);
        else if (report.outcome === 'blocked') finish(d, 'blocked', 'TASK_BLOCKED', report.summary, at);
        else finish(d, 'failed', 'TASK_FAILED', report.summary, at);
        return;
      }
      if (report && report.supersededByCancel) {
        // §4.4:取消生效后的 completed 运行只算部分提交 → 等静止后按 aborted 收尾
        return;
      }
      // 正常结束但无报告(§4.3)
      finish(d, 'failed', 'REPORT_MISSING', '执行者未提交 dispatch_report 即正常结束', at);
      return;
    }
    if (end.stopReason === 'aborted') {
      // §4.3:aborted 需"已确认当前工作停止"——静止确认事件另行到达后由 settleFromQuiescence 收尾
      return;
    }
    finish(d, 'failed', 'RUN_UNKNOWN_STOP', `未识别的 stopReason:${end.stopReason}`, at);
    return;
  }
}

/** 静止确认后的收尾(取消/aborted 路径;P0 发现 4:队列静止是取消完成的必要条件)。 */
function settleFromQuiescence(d: DispatchRecord, at: number): void {
  if (d.phase === 'finished') return;
  const lastRun = d.runtime.observedRuns[d.runtime.observedRuns.length - 1];
  const end = lastRun?.observedEndAt;
  if (d.takeover) {
    finish(d, 'aborted', 'TAKEOVER_SUPERSEDED', '人工接管,自动收尾停止', at);
    return;
  }
  if (d.cancel?.effective) {
    const abnormal = end ? abnormalReason(end.stopReason) : undefined;
    if (abnormal) {
      // 已有明确运行错误:保留 failed,取消只作为附加事实(§4.4)
      finish(d, 'failed', abnormal, `运行异常:${end?.stopReason}(取消记录在案)`, at);
      return;
    }
    finish(d, 'aborted', 'CANCELLED_BEFORE_FINALIZATION', d.cancel.reason ? `取消:${d.cancel.reason}` : '取消生效并确认静止', at);
    return;
  }
  if (end?.stopReason === 'aborted') {
    finish(d, 'aborted', 'ABORTED_STOPPED', '非取消原因中断且已确认静止', at);
    return;
  }
  // §7.7:操作员确认静止(非自动证明)时,报告按其申报结果收尾、无报告按未汇报收尾
  if (d.runtime.quiescence === 'operator_confirmed' && !d.cancel?.effective) {
    const report = d.report;
    if (report && !report.supersededByCancel) {
      const map = { done: 'RESULT_SUBMITTED', blocked: 'TASK_BLOCKED', failed: 'TASK_FAILED' } as const;
      finish(d, report.outcome, map[report.outcome], `${report.summary}(操作员确认静止)`, at);
      return;
    }
    if (!report) {
      finish(d, 'failed', 'REPORT_MISSING', '操作员确认停止但无最终报告', at);
      return;
    }
  }
  // 有静止但证据仍不足(如从未观察到运行)→ 保持待核验,不猜终态
}

/** 归约一条规范化事件;返回新记录(输入不变)。未知事件在持久层之前就应被拒绝。 */
export function reduceDispatch(prev: DispatchRecord, ev: DispatchEvent): DispatchRecord {
  const d: DispatchRecord = structuredClone(prev);
  d.revision += 1;
  const at = ev.at;

  switch (ev.type) {
    case 'claim-ok': {
      if (d.phase !== 'preparing') {
        audit(d, at, 'claim-ok-ignored', 'target', `phase=${d.phase}`);
        return d;
      }
      d.ownership.epoch = ev.epoch;
      d.ownership.state = 'owned';
      d.ownership.workerWrites = 'enabled';
      d.source.taskFingerprint = ev.taskFingerprint;
      audit(d, at, 'claim-ok', 'target', `epoch=${ev.epoch}`);
      return d;
    }

    case 'claim-conflict': {
      if (d.phase !== 'preparing') {
        audit(d, at, 'claim-conflict-ignored', 'target', `phase=${d.phase}`);
        return d;
      }
      audit(d, at, 'claim-conflict', 'target', ev.detail);
      finish(d, 'failed', 'CLAIM_CONFLICT', `目标领取冲突:${ev.detail}`, at);
      return d;
    }

    case 'start-intent': {
      if (d.phase !== 'preparing' || d.ownership.state !== 'owned') {
        audit(d, at, 'start-intent-ignored', 'service', `phase=${d.phase} ownership=${d.ownership.state}`);
        return d;
      }
      d.phase = 'starting';
      d.startIntent = { mayHaveExecuted: true, persistedAt: at };
      audit(d, at, 'start-intent', 'service', 'mayHaveExecuted=true');
      return d;
    }

    case 'start-accepted': {
      if (d.runtime.childSessionId !== ev.childId) {
        audit(d, at, 'start-accepted-foreign-child', 'runtime', `childId=${ev.childId}`);
        return d;
      }
      d.runtime.messageId = ev.messageId;
      d.acceptedAt = at;
      // T05/T06:回执不倒退阶段;取消已生效时不得恢复执行授权
      if (d.phase === 'preparing' || d.phase === 'starting') {
        d.phase = d.cancel?.effective ? 'cancelling' : 'queued';
        if (d.cancel?.effective) audit(d, at, 'accepted-after-cancel', 'reducer', '保持 cancelling');
      } else {
        audit(d, at, 'start-accepted-late', 'reducer', `phase=${d.phase}`);
      }
      audit(d, at, 'start-accepted', 'runtime', `messageId=${ev.messageId}`);
      return d;
    }

    case 'start-rejected': {
      // P0 实测:startContinuable 承诺"更早失败完全回滚、不留 id"——拒绝即未执行证明
      if (d.phase !== 'starting' || d.runtime.messageId) {
        audit(d, at, 'start-rejected-ignored', 'runtime', `phase=${d.phase}`);
        return d;
      }
      audit(d, at, 'start-rejected', 'runtime', ev.detail.slice(0, 200));
      finish(d, 'failed', 'START_REJECTED', `启动被运行时拒绝(已回滚):${ev.detail.slice(0, 200)}`, at);
      return d;
    }

    case 'run-started': {
      if (d.phase === 'finished') {
        audit(d, at, 'run-started-after-finish', 'runtime', `runId=${ev.runId}(已终局,仅记录)`);
        if (!findRun(d, ev.runId)) d.runtime.observedRuns.push({ runId: ev.runId, observedStartAt: at });
        return d;
      }
      if (!findRun(d, ev.runId)) d.runtime.observedRuns.push({ runId: ev.runId, observedStartAt: at });
      if (d.phase === 'preparing' || d.phase === 'starting' || d.phase === 'queued') {
        d.phase = d.cancel?.effective ? 'cancelling' : 'running';
        if (d.cancel?.effective) audit(d, at, 'run-started-during-cancel', 'reducer', '保持 cancelling');
      } else if (d.phase === 'settling' || d.phase === 'reconciling') {
        // T15:报告后/核验中出现新执行周期——保留事实,不改归因
        audit(d, at, 'unexpected-new-run', 'runtime', `runId=${ev.runId}`);
      }
      return d;
    }

    case 'run-ended': {
      let run = findRun(d, ev.runId);
      if (!run) {
        // 缺 start 的 end(T12):按已知身份记录,不猜顺序
        run = { runId: ev.runId, observedEndAt: { observedAt: at, stopReason: ev.stopReason } };
        d.runtime.observedRuns.push(run);
        audit(d, at, 'end-without-start', 'runtime', `runId=${ev.runId}`);
      } else {
        run.observedEndAt = run.observedEndAt ?? { observedAt: at, stopReason: ev.stopReason };
        if (run.observedEndAt.stopReason !== ev.stopReason) {
          audit(d, at, 'end-stopreason-mismatch', 'runtime', `${run.observedEndAt.stopReason}→${ev.stopReason}(保留首个)`);
        }
      }
      if (d.phase === 'finished') {
        audit(d, at, 'run-ended-after-finish', 'runtime', `runId=${ev.runId}(已终局,仅记录)`);
        return d;
      }
      if (d.phase === 'running' || d.phase === 'queued' || d.phase === 'starting' || d.phase === 'reconciling') {
        d.phase = 'settling';
      }
      // cancelling 保持 cancelling;settling 保持
      settle(d, at);
      return d;
    }

    case 'progress': {
      if (d.runtime.childSessionId !== ev.fromChild) {
        audit(d, at, 'progress-foreign-child', 'worker', `from=${ev.fromChild}`);
        return d;
      }
      d.lastProgressAt = at;
      audit(d, at, 'progress', 'worker', `seq=${ev.sequence}`);
      return d;
    }

    case 'report': {
      if (d.phase === 'finished' || d.ownership.workerWrites === 'revoked') {
        // 迟到报告:仅隔离审计,不进入决策(§5.2)
        audit(d, at, 'late-report-quarantined', 'reducer', `hash=${ev.report.hash.slice(0, 12)}`);
        return d;
      }
      if (d.report) {
        if (d.report.hash === ev.report.hash) {
          audit(d, at, 'report-idempotent-hit', 'worker', '同内容重发,返回原回执');
          return d;
        }
        audit(d, at, 'report-conflict-rejected', 'worker', '第二次不同内容的最终报告不覆盖第一份');
        return d;
      }
      d.report = ev.report;
      // §5.2:报告持久化即封闭新增任务性写入(worker_only)
      d.ownership.workerWrites = 'disabled';
      if (d.cancel?.effective) {
        d.report.supersededByCancel = true;
        audit(d, at, 'report-after-cancel', 'reducer', '保留为部分提交');
        // 取消路径:settling 等静止
      } else if (d.phase === 'running' || d.phase === 'queued' || d.phase === 'starting' || d.phase === 'reconciling') {
        d.phase = 'settling';
      }
      settle(d, at);
      return d;
    }

    case 'cancel-requested': {
      if (d.phase === 'finished') {
        // §4.4 第一分支:完成条件先持久化 → 取消记录为过晚,不改结果
        audit(d, at, 'cancel-too-late', 'user', `result=${d.result?.reasonCode}`);
        return d;
      }
      d.cancel = { requestedAt: at, requestedBy: ev.by, reason: ev.reason, effective: true };
      if (d.ownership.workerWrites === 'enabled') d.ownership.workerWrites = 'disabled';
      if (d.phase !== 'cancelling') {
        d.lastKnownPhase = d.phase;
        d.phase = 'cancelling';
      }
      audit(d, at, 'cancel-requested', ev.by, ev.reason.slice(0, 120));
      // 已有终止证据的,立即尝试结算(aborted 分支需静止,由 quiescence 事件收)
      settle(d, at);
      return d;
    }

    case 'quiescence-confirmed': {
      d.runtime.quiescence = ev.operator ? 'operator_confirmed' : 'confirmed';
      d.runtime.quiescenceEvidence = ev.evidence.slice(0, 200);
      audit(d, at, 'quiescence-confirmed', ev.operator ? 'operator' : 'runtime', ev.evidence.slice(0, 120));
      const canSettle = d.phase === 'settling' || d.phase === 'cancelling' || d.phase === 'reconciling'
        || (ev.operator && d.phase !== 'finished');
      if (canSettle) settleFromQuiescence(d, at);
      return d;
    }

    case 'takeover': {
      d.takeover = { requestedAt: at, actor: ev.actor, reason: ev.reason };
      d.ownership.state = 'revoked';
      d.ownership.workerWrites = 'revoked';
      if (d.phase !== 'finished') {
        d.lastKnownPhase = d.phase;
        d.phase = 'cancelling';
      }
      audit(d, at, 'takeover', ev.actor, ev.reason.slice(0, 120));
      return d;
    }

    case 'budget-exceeded': {
      audit(d, at, 'budget-exceeded', 'system', ev.kind);
      if (d.phase === 'finished') return d;
      // §7.6:记录超限并请求停止——转为取消语义,终局归因按停止证据
      if (!d.cancel) {
        d.cancel = { requestedAt: at, requestedBy: 'system', reason: `BUDGET_EXCEEDED:${ev.kind}`, effective: true };
        if (d.ownership.workerWrites === 'enabled') d.ownership.workerWrites = 'disabled';
        if (d.phase !== 'cancelling') {
          d.lastKnownPhase = d.phase;
          d.phase = 'cancelling';
        }
        settle(d, at);
      }
      return d;
    }

    case 'reconcile-unresolved': {
      if (d.phase === 'finished') return d;
      // 知识不足,不是新执行周期;不清除取消/报告/终止事实(§4.2)
      if (d.phase !== 'reconciling') d.lastKnownPhase = d.phase;
      d.phase = 'reconciling';
      audit(d, at, 'reconcile-unresolved', 'reconciler', ev.detail.slice(0, 160));
      return d;
    }

    case 'late-report-quarantined': {
      audit(d, at, 'late-report-quarantined', 'service', ev.detail.slice(0, 160));
      return d;
    }

    default: {
      const never: never = ev;
      void never;
      return d;
    }
  }
}
