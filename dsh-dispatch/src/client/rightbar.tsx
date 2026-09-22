/**
 * 官方右侧 Sidebar 的「任务派发」页签(P4,guide order 63)。
 *
 * 布局照 r2 §8:进行中卡片(标题/状态文案/耗时/取消/接管/核验/解除)+ 历史折叠区 +
 * 点节点标题深链跳 trajectory;详情按 §8.3 展示快照/执行者/模型/时间/报告/证据/
 * 停止原因/节点同步/安全占用。轮询 §8.4:页签可见时约 10s,页面隐藏时暂停
 * (宿主对账独立继续)。全部文本按纯文本渲染(§8.4 安全渲染)。
 */
import React from 'react';
import { api } from './api';

const NS = 'dsh-dispatch';
const TAB_ID = 'dsh-dispatch';
export const PANEL_TAB_KIND = 'dsh-dispatch.panel';

type TFunc = (key: string, params?: Record<string, unknown>) => string;

interface ListEntry {
  id: string;
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
  settling: 'var(--dsw-alias-state-warning-primary, #e5a100)',
  cancelling: 'var(--dsw-alias-state-warning-primary, #e5a100)',
  reconciling: 'var(--dsw-alias-state-warning-primary, #e5a100)',
};

function post(t: TFunc, path: string, body: unknown, refresh: () => void, done?: (msg: string) => void) {
  api(path, { method: 'POST', body: JSON.stringify(body) })
    .then(() => { refresh(); done?.(''); })
    .catch((e) => { window.alert(String(e instanceof Error ? e.message : e)); void t; });
}

function DispatchCard({ t, d, refresh }: { t: TFunc; d: ListEntry; refresh: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<StatusDetail | null>(null);
  const kind = d.phase === 'finished' ? d.result?.split('/')[0] : d.phase;
  const dotColor = d.phase === 'finished'
    ? (kind === 'done' ? 'var(--dsw-alias-state-success-primary, #30a46c)' : kind === 'blocked' ? 'var(--dsw-alias-state-danger-primary, #e5484d)' : 'var(--dsw-alias-label-dimmed, #6f6f6f)')
    : (PHASE_COLOR[d.phase] ?? 'var(--dsw-alias-label-caption)');

  const loadDetail = () => {
    setOpen((v) => !v);
    if (!detail) api<StatusDetail>(`/dispatch/status/${encodeURIComponent(d.id)}`).then(setDetail).catch(() => setDetail(null));
  };

  const Btn = ({ act, label, primary }: { act: string; label: string; primary?: boolean }) => (
    <button
      type="button"
      className="dsh-dispatch-press"
      onClick={() => {
        if (act === 'detail') {
          loadDetail();
        } else if (act === 'cancel') {
          post(t, '/dispatch/cancel', { dispatchId: d.id, by: 'ui', reason: '用户取消' }, refresh);
        } else if (act === 'takeover') {
          const reason = window.prompt(t('confirm.takeover'), 'manual') ?? '';
          if (reason === '') return;
          post(t, '/dispatch/takeover', { dispatchId: d.id, actor: 'ui', reason }, refresh);
        } else if (act === 'reconcile') {
          post(t, '/dispatch/reconcile', {}, refresh);
        } else if (act === 'resolve') {
          const evidence = window.prompt(t('confirm.resolve'), '已人工核查会话与进程') ?? '';
          if (evidence === '') return;
          post(t, '/dispatch/resolve', { dispatchId: d.id, operator: 'ui', evidence }, refresh);
        }
      }}
      style={{
        flex: 'none', height: 20, padding: '0 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10.5,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        background: primary ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))',
        color: primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
      }}
    >{label}</button>
  );

  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, flex: 'none', background: dotColor }} />
        <button
          type="button"
          title={t('detail.goNode')}
          onClick={() => window.dispatchEvent(new CustomEvent('dsh-dispatch-nav', { detail: { projectId: d.node.projectId, nodeId: d.node.nodeId } }))}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--dsh-alias-label-primary, var(--dsw-alias-label-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{d.title}</button>
        <span style={{ flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>
          {d.phase !== 'finished' ? `${t('panel.elapsed')} ${fmtElapsed(d.createdAt)}` : fmtTime(d.endedAt)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{phaseText(t, d)}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {d.allowedActions.includes('cancel') && <Btn act="cancel" label={t('btn.cancel')} primary />}
        {d.allowedActions.includes('takeover') && d.phase !== 'finished' && <Btn act="takeover" label={t('btn.takeover')} />}
        {d.allowedActions.includes('reconcile') && <Btn act="reconcile" label={t('btn.reconcile')} />}
        {d.allowedActions.includes('resolve') && <Btn act="resolve" label={t('btn.resolve')} />}
        <Btn act="detail" label={open ? t('btn.hideDetail') : t('btn.detail')} />
      </div>
      {open && (
        <div style={{ fontSize: 10.5, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 3, wordBreak: 'break-all' }}>
          {!detail && <span>…</span>}
          {detail && (
            <>
              <div><b>{t('detail.node')}</b> {detail.source.snapshot.nodeTitle}({detail.source.snapshot.nodeKind ?? '—'})</div>
              {detail.source.snapshot.nodeDetail && <div style={{ whiteSpace: 'pre-wrap', maxHeight: 84, overflow: 'auto' }}>{detail.source.snapshot.nodeDetail}</div>}
              <div><b>{t('detail.executor')}</b> {detail.runtime.childSessionId.slice(0, 18)}…</div>
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

function PanelBody(props: { useTabInfo: () => { tab: any }; t: TFunc; sessionId?: string; useSessions?: (sel: (s: any) => any) => any }) {
  const { t, sessionId, useSessions } = props;
  const cwd = useSessions ? useSessions((s: any) => s?.byId?.[sessionId ?? '']?.cwd) : undefined;
  const [list, setList] = React.useState<ListEntry[] | null>(null);
  const [err, setErr] = React.useState('');
  const [showHistory, setShowHistory] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return; // §8.4:页面隐藏暂停 UI 轮询(宿主对账独立)
      api<{ dispatches: ListEntry[] }>(`/dispatch/list${cwd ? `?ws=${encodeURIComponent(cwd)}` : ''}`)
        .then((r) => { if (alive) { setList(r.dispatches); setErr(''); } })
        .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    };
    load();
    const timer = setInterval(load, 10_000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [cwd]);

  if (err) return <div style={{ padding: 14, fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>;
  if (!cwd) return <div style={{ padding: 14, fontSize: 12, lineHeight: 1.8, color: 'var(--dsw-alias-label-caption)' }}>{t('panel.noWs')}</div>;
  if (!list) return <div style={{ padding: 14, fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>{t('panel.loading')}</div>;

  const active = list.filter((d) => d.phase !== 'finished');
  const history = list.filter((d) => d.phase === 'finished');
  const refresh = () => {
    api<{ dispatches: ListEntry[] }>(`/dispatch/list${cwd ? `?ws=${encodeURIComponent(cwd)}` : ''}`)
      .then((r) => setList(r.dispatches))
      .catch(() => undefined);
  };

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%', overflow: 'auto' }}>
      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('panel.active')}({active.length})</div>
      {active.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.8 }}>{t('panel.empty')}</div>
      )}
      {active.map((d) => <DispatchCard key={d.id} t={t} d={d} refresh={refresh} />)}

      {history.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="dsh-dispatch-press"
            style={{ alignSelf: 'flex-start', marginTop: 4, height: 20, padding: '0 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10.5, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))', color: 'var(--dsw-alias-label-secondary)' }}
          >{showHistory ? t('panel.hideHistory') : `${t('panel.showHistory')}(${history.length})`}</button>
          {showHistory && history.map((d) => <DispatchCard key={d.id} t={t} d={d} refresh={refresh} />)}
        </>
      )}
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
