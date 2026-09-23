/**
 * 官方右侧 Sidebar 的「任务派发」页签(P4,guide order 63;Wave 1 交互修复)。
 *
 * - 工作台摘要 + 打开入口;旧 trajectory 派发:进行中卡片 + 历史折叠
 * - Wave 1 修复:Btn 提升到模块层(轮询不再卸载重建按钮)、详情展开期间跟随刷新、
 *   alert/prompt 换成 toast/ConfirmModal、执行者显示模型而非裸会话 ID 片段
 * - 轮询 §8.4:页签可见时约 10s,页面隐藏暂停(宿主对账独立);纯文本安全渲染
 */
import React from 'react';
import { api } from './api';
import { openWorkbench } from './workbench';
import { ConfirmModal, ToastHost, showToast, type ConfirmRequest } from './feedback';

const NS = 'dsh-dispatch';
const TAB_ID = 'dsh-dispatch';
export const PANEL_TAB_KIND = 'dsh-dispatch.panel';

type TFunc = (key: string, params?: Record<string, unknown>) => string;

interface ListEntry {
  id: string;
  targetType?: string;
  phase: string;
  node: { projectId: string; nodeId: string };
  ws?: string;
  title: string;
  result: string | null;
  writebackState: string;
  hasReport: boolean;
  createdAt: number;
  endedAt: number | null;
  allowedActions: string[];
}

interface StatusDetail {
  id: string;
  phase: string;
  result: { kind: string; reasonCode: string; summary: string; decidedAt: number } | null;
  report: { outcome: string; summary: string; evidence: { kind: string; ref: string; summary?: string }[]; nextHint?: string; receivedAt: number } | null;
  runtime: { childSessionId: string; observedRuns: { runId: string; observedEndAt?: { stopReason: string } }[]; quiescence: string };
  reservation: { targetHeld: boolean; workspaceHeld: boolean; executionSlotHeld: boolean };
  takeover?: { actor: string } | null;
  cancel?: { reason: string } | null;
  writeback: { state: string; attempts: number; lastErrorCode?: string };
  effectiveConfig: { modelProvider: string; model: string };
  createdAt: number;
  acceptedAt?: number;
  endedAt?: number;
  allowedActions: string[];
  source: { snapshot: { nodeTitle: string; nodeDetail?: string; nodeKind?: string }; taskFingerprint: string; promptHash?: string };
}

function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtElapsed(from: number, to?: number | null): string {
  const ms = (to ?? Date.now()) - from;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function phaseText(t: TFunc, d: ListEntry): string {
  if (d.phase === 'finished') {
    if (['pending', 'error'].includes(d.writebackState)) return t('st.pendingSync');
    if (d.result?.startsWith('done/')) return t('st.done');
    if (d.result?.startsWith('blocked/')) return t('st.blocked');
    if (d.result?.startsWith('failed/')) return t('st.failed');
    return t('st.aborted');
  }
  if (d.phase === 'settling') return d.hasReport ? t('st.settlingReport') : t('st.settling');
  const map: Record<string, string> = {
    preparing: t('st.preparing'),
    starting: t('st.starting'),
    queued: t('st.queued'),
    running: t('st.running'),
    cancelling: t('st.cancelling'),
    reconciling: t('st.reconciling'),
  };
  return map[d.phase] ?? d.phase;
}

const PHASE_COLOR: Record<string, string> = {
  running: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  queued: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  starting: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  preparing: 'var(--dsw-alias-label-caption, #8f8f8f)',
  settling: 'var(--dsw-alias-state-warn-primary, #f5a524)',
  cancelling: 'var(--dsw-alias-state-warn-primary, #f5a524)',
  reconciling: 'var(--dsw-alias-state-warn-primary, #f5a524)',
};

/** Wave 1:提升到模块层——轮询 setList 重渲染不再卸载重建按钮(焦点/点击不再丢失)。 */
function CardBtn({ act, label, primary, onAction }: { act: string; label: string; primary?: boolean; onAction: (act: string) => void }) {
  return (
    <button
      type="button"
      className="dsh-dispatch-press"
      onClick={() => onAction(act)}
      style={{
        flex: 'none', height: 20, padding: '0 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10.5,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        background: primary ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))',
        color: primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
      }}
    >{label}</button>
  );
}

function DispatchCard({ t, d, refreshTick, refresh }: { t: TFunc; d: ListEntry; refreshTick: number; refresh: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<StatusDetail | null>(null);
  const kind = d.phase === 'finished' ? d.result?.split('/')[0] : d.phase;
  const dotColor = d.phase === 'finished'
    ? (kind === 'done' ? 'var(--dsw-alias-state-success-primary, #30a46c)' : kind === 'blocked' ? 'var(--dsw-alias-state-danger-primary, #e5484d)' : 'var(--dsw-alias-label-dimmed, #6f6f6f)')
    : (PHASE_COLOR[d.phase] ?? 'var(--dsw-alias-label-caption)');

  // Wave 1:详情展开期间跟随面板轮询刷新(不再是一次性快照)
  React.useEffect(() => {
    if (!open) return;
    api<StatusDetail>(`/dispatch/status/${encodeURIComponent(d.id)}`)
      .then(setDetail)
      .catch(() => undefined);
  }, [open, d.id, refreshTick]);

  const onAction = (act: string) => {
    if (act === 'detail') {
      setOpen((v) => !v);
      return;
    }
    if (act === 'cancel') {
      api('/dispatch/cancel', { method: 'POST', body: JSON.stringify({ dispatchId: d.id, by: 'ui', reason: '用户取消' }) })
        .then(() => { showToast('取消请求已受理;完成以静止确认为准。', 'info'); refresh(); })
        .catch((e) => showToast(String(e instanceof Error ? e.message : e), 'error'));
      return;
    }
    if (act === 'reconcile') {
      api('/dispatch/reconcile', { method: 'POST', body: '{}' })
        .then(() => { showToast('已触发一次状态核验。', 'info'); refresh(); })
        .catch((e) => showToast(String(e instanceof Error ? e.message : e), 'error'));
      return;
    }
    if (act === 'takeover' || act === 'resolve') {
      window.dispatchEvent(new CustomEvent('dsh-dispatch-ask', {
        detail: { act, dispatchId: d.id } as AskPayload,
      }));
    }
  };

  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, flex: 'none', background: dotColor }} />
        <button
          type="button"
          title={t('detail.goNode')}
          onClick={() => window.dispatchEvent(new CustomEvent('dsh-dispatch-nav', { detail: { projectId: d.node.projectId, nodeId: d.node.nodeId } }))}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{d.title}</button>
        <span style={{ flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>
          {d.phase !== 'finished' ? `${t('panel.elapsed')} ${fmtElapsed(d.createdAt)}` : fmtTime(d.endedAt)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{phaseText(t, d)}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {d.allowedActions.includes('cancel') && <CardBtn act="cancel" label={t('btn.cancel')} primary onAction={onAction} />}
        {d.allowedActions.includes('takeover') && d.phase !== 'finished' && <CardBtn act="takeover" label={t('btn.takeover')} onAction={onAction} />}
        {d.allowedActions.includes('reconcile') && <CardBtn act="reconcile" label={t('btn.reconcile')} onAction={onAction} />}
        {d.allowedActions.includes('resolve') && <CardBtn act="resolve" label={t('btn.resolve')} onAction={onAction} />}
        <CardBtn act="detail" label={open ? t('btn.hideDetail') : t('btn.detail')} onAction={onAction} />
      </div>
      {open && (
        <div style={{ fontSize: 10.5, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 3, wordBreak: 'break-all' }}>
          {!detail && <span>…</span>}
          {detail && (
            <>
              <div><b>{t('detail.node')}</b> {detail.source.snapshot.nodeTitle}({detail.source.snapshot.nodeKind ?? '—'})</div>
              {detail.source.snapshot.nodeDetail && <div style={{ whiteSpace: 'pre-wrap', maxHeight: 84, overflow: 'auto' }}>{detail.source.snapshot.nodeDetail}</div>}
              <div><b>{t('detail.model')}</b> {detail.effectiveConfig.modelProvider}/{detail.effectiveConfig.model}</div>
              <div><b>{t('detail.times')}</b> {fmtTime(detail.createdAt)} → {fmtTime(detail.endedAt ?? null)}</div>
              <div><b>{t('detail.stop')}</b> {detail.runtime.observedRuns.at(-1)?.observedEndAt?.stopReason ?? (detail.result?.reasonCode ?? '—')}</div>
              <div><b>{t('detail.report')}</b> {detail.report ? `${detail.report.outcome}:${detail.report.summary.slice(0, 160)}${detail.report.summary.length > 160 ? '…' : ''}` : t('detail.none')}</div>
              {detail.report?.evidence?.length ? (
                <div><b>{t('detail.evidence')}</b>
                  {detail.report.evidence.map((e, i) => <div key={i} style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>[{e.kind}] {e.ref}</div>)}
                </div>
              ) : null}
              <div><b>{t('detail.sync')}</b> {detail.writeback.state}{detail.writeback.lastErrorCode ? `(${detail.writeback.lastErrorCode.slice(0, 60)})` : ''}</div>
              <div>
                <b>{t('detail.reservation')}</b>{' '}
                {detail.reservation.targetHeld || detail.reservation.workspaceHeld || detail.reservation.executionSlotHeld
                  ? t('detail.held')
                  : t('detail.released')}
              </div>
              {detail.takeover && <div>🤚 {t('btn.takeover')}: {detail.takeover.actor}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface AskPayload { act: 'takeover' | 'resolve'; dispatchId: string }

function PanelBody(props: { useTabInfo: () => { tab: any }; t: TFunc; sessionId?: string; useSessions?: (sel: (s: any) => any) => any }) {
  const { t, sessionId, useSessions } = props;
  const cwd = useSessions ? useSessions((s: any) => s?.byId?.[sessionId ?? '']?.cwd) : undefined;
  const [list, setList] = React.useState<ListEntry[] | null>(null);
  const [err, setErr] = React.useState('');
  const [showHistory, setShowHistory] = React.useState(false);
  const [workbench, setWorkbench] = React.useState<{ counts: Record<string, number>; tasks: { id: string; title: string; status: string }[] } | null>(null);
  const [tick, setTick] = React.useState(0);
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null);

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return; // §8.4:页面隐藏暂停 UI 轮询(宿主对账独立)
      api<{ dispatches: ListEntry[] }>(`/dispatch/list${cwd ? `?ws=${encodeURIComponent(cwd)}` : ''}`)
        .then((r) => { if (alive) { setList(r.dispatches); setErr(''); setTick((n) => n + 1); } })
        .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
      api<{ counts: Record<string, number>; tasks: { id: string; title: string; status: string }[] }>('/dispatch/workbench/overview')
        .then((value) => { if (alive) setWorkbench(value); }).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 10_000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [cwd]);

  // Wave 1:卡片操作经 CustomEvent 请求接管/解除(面板自身是独立 React root,经事件解耦)
  React.useEffect(() => {
    const onAsk = (ev: Event) => {
      const payload = (ev as CustomEvent<AskPayload>).detail;
      if (!payload) return;
      const t2 = t;
      if (payload.act === 'takeover') {
        setConfirmReq({
          title: t2('confirm.takeover'),
          description: '接管会撤销执行者写权限并请求停止;迟到的报告不会再改动节点。',
          confirmText: t2('btn.takeover'), danger: true,
          onConfirm: (reason) => {
            setConfirmReq(null);
            api('/dispatch/takeover', { method: 'POST', body: JSON.stringify({ dispatchId: payload.dispatchId, actor: 'ui', reason }) })
              .then(() => { showToast('已接管;正在请求执行者停止。', 'info'); setTick((n) => n + 1); })
              .catch((e) => showToast(String(e instanceof Error ? e.message : e), 'error'));
          },
          onClose: () => setConfirmReq(null),
        });
      } else {
        setConfirmReq({
          title: t2('confirm.resolve'),
          description: '人工确认停止并收尾(操作员责任);请先核查会话与进程已停止。',
          confirmText: t2('btn.resolve'),
          onConfirm: (evidence) => {
            setConfirmReq(null);
            api('/dispatch/resolve', { method: 'POST', body: JSON.stringify({ dispatchId: payload.dispatchId, operator: 'ui', evidence }) })
              .then(() => { showToast('已按人工核验收尾。', 'success'); setTick((n) => n + 1); })
              .catch((e) => showToast(String(e instanceof Error ? e.message : e), 'error'));
          },
          onClose: () => setConfirmReq(null),
        });
      }
    };
    window.addEventListener('dsh-dispatch-ask', onAsk as EventListener);
    return () => window.removeEventListener('dsh-dispatch-ask', onAsk as EventListener);
  }, [t]);

  const legacy = (list ?? []).filter((d) => d.targetType !== 'workbench_task');
  const active = legacy.filter((d) => d.phase !== 'finished');
  const history = legacy.filter((d) => d.phase === 'finished');
  const refresh = () => {
    api<{ dispatches: ListEntry[] }>(`/dispatch/list${cwd ? `?ws=${encodeURIComponent(cwd)}` : ''}`)
      .then((r) => { setList(r.dispatches); setTick((n) => n + 1); })
      .catch(() => undefined);
  };

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%', overflow: 'auto' }}>
      <ToastHost />
      {confirmReq && <ConfirmModal {...confirmReq} />}
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>AI 团队工作台</div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginBottom: 8 }}>
          {workbench ? `执行中 ${workbench.counts.in_progress ?? 0} · 待验收 ${workbench.counts.in_review ?? 0} · 受阻 ${workbench.counts.blocked ?? 0}` : '加载工作台摘要…'}
        </div>
        <button type="button" onClick={openWorkbench} className="dsh-dispatch-press"
          style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '5px 9px', cursor: 'pointer' }}>打开工作台 →</button>
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {!cwd && <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>当前会话没有 trajectory 工作区；工作台仍可独立使用。</div>}
      {cwd && !list && <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('panel.loading')}</div>}
      {cwd && <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 8 }}>旧 trajectory 派发</div>}
      {cwd && <>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('panel.active')}({active.length})</div>
      {active.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.8 }}>{t('panel.empty')}</div>
      )}
      {active.map((d) => <DispatchCard key={d.id} t={t} d={d} refreshTick={tick} refresh={refresh} />)}

      {history.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="dsh-dispatch-press"
            style={{ alignSelf: 'flex-start', marginTop: 4, height: 20, padding: '0 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10.5, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))', color: 'var(--dsw-alias-label-secondary)' }}
          >{showHistory ? t('panel.hideHistory') : `${t('panel.showHistory')}(${history.length})`}</button>
          {showHistory && history.map((d) => <DispatchCard key={d.id} t={t} d={d} refreshTick={tick} refresh={refresh} />)}
        </>
      )}
      </>}
    </div>
  );
}

export function registerDispatchRightbar(ctx: any): void {
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    const t = ctx2.locale.bind(NS);
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: PANEL_TAB_KIND,
      title: () => t('tab.title'),
      guide: [{
        order: 63,
        title: () => t('tab.title'),
        description: () => t('tab.guideDesc'),
      }],
    }), 'dsh-dispatch: rightbar panel tab type');
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, PanelBody)), 'dsh-dispatch: rightbar panel tab body');
  });
}
