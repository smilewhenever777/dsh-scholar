/**
 * 官方右侧 Sidebar(0.1.5+)的「论文速查」页签。
 *
 * 两阶段注册(照 dsh-client-ui-sidebar-files 的官方姿势):
 *  1. ctx.sidebarRightTabs.register(定义) —— 静态类型声明(页类型:无 patterns,
 *     由 openTab(kind) 打开;priority 默认 extension,最高优先级带)
 *  2. ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
 *       { name, key: 定义id, locale: NS }, Body)) —— body 组件 props 拿
 *     useTabInfo(读 tab.navigation.params/revision/actions)与 t
 *
 * body 双模:无 params = 迷你检索(防抖拉 /scholar/papers);params.id = 论文速览
 * (与对话并排阅读,不遮会话)。旧宿主无 sidebarRightTabs/sidebarRight 服务时
 * 静默跳过(特性检测),入口按钮同步隐藏。
 */
import React from 'react';
import type { Paper } from '../shared/types';
import { api, qs } from './api';

const NS = 'scholar';
/** 注册 id = 包名(tab 系统里实现的身份,也是 body 注册的 key) */
const TAB_ID = 'dsh-scholar-desk';
export const PAPER_TAB_KIND = 'dsh-scholar.paper';

/* ---------- openTab 服务句柄(apply 时注入,旧宿主为 null) ---------- */
let svc: { openTab(kind: string, options?: { params?: unknown }): void } | null = null;

/** 入口可用性(PaperLibraryView 据此显示/隐藏「右侧栏打开」)。 */
export function rightbarAvailable(): boolean {
  return svc !== null;
}

/** 在右侧栏打开一篇论文(id 省略 = 打开检索模式);服务缺席时静默 no-op。 */
export function openPaperInRightbar(id?: string): void {
  try {
    svc?.openTab(PAPER_TAB_KIND, id ? { params: { id } } : undefined);
  } catch {
    /* 服务未挂载(无会话 seat)——忽略 */
  }
}

/* ---------- body ---------- */

type PaperLite = Pick<Paper, 'id' | 'title'> & { year?: number; importance?: number; tags?: string[] };

function Stars({ n }: { n: number }) {
  return <span style={{ color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', fontSize: 11, letterSpacing: 1 }}>{'★'.repeat(n)}</span>;
}

function PaperTabBody({ useTabInfo, t }: { useTabInfo: () => { tab: any }; t: (key: string, params?: Record<string, unknown>) => string }) {
  const { tab } = useTabInfo();
  const nav = tab?.navigation;
  const paramsId: string | undefined = nav?.params?.id;
  const revision: number = nav?.revision ?? 0;

  const [selectedId, setSelectedId] = React.useState<string | null>(paramsId ?? null);
  // 再次导航到本 tab(带 params)即切入对应论文
  React.useEffect(() => {
    if (paramsId) setSelectedId(paramsId);
  }, [paramsId, revision]);

  if (selectedId) {
    return <PaperDetail id={selectedId} t={t} onBack={() => setSelectedId(null)} />;
  }
  return <PaperSearch t={t} onPick={setSelectedId} />;
}

function PaperSearch({ t, onPick }: { t: (key: string, params?: Record<string, unknown>) => string; onPick: (id: string) => void }) {
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [list, setList] = React.useState<PaperLite[] | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  React.useEffect(() => {
    let alive = true;
    setErr('');
    api<{ papers: PaperLite[] }>(`/scholar/papers${qs({ q: debounced, limit: 8 })}`)
      .then((d) => { if (alive) setList(d.papers ?? []); })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { alive = false; };
  }, [debounced]);

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('rightbar.searchPh')}
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12, borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', outline: 'none' }}
      />
      {err && <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {list && list.length === 0 && !err && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', padding: '8px 2px' }}>
          {debounced ? t('rightbar.noResult') : t('rightbar.empty')}
        </div>
      )}
      {list?.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p.id)}
          style={{ textAlign: 'left', cursor: 'pointer', display: 'block', width: '100%', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
            fontSize: 12, lineHeight: 1.5 }}
        >
          <div style={{ fontWeight: 600 }}>{p.title}</div>
          <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--dsw-alias-label-caption)', fontSize: 11 }}>
            {p.year ? <span>{p.year}</span> : null}
            {p.importance ? <Stars n={p.importance} /> : null}
            {(p.tags ?? []).slice(0, 3).map((tg) => <span key={tg}>#{tg}</span>)}
          </div>
        </button>
      ))}
    </div>
  );
}

function PaperDetail({ id, t, onBack }: { id: string; t: (key: string, params?: Record<string, unknown>) => string; onBack: () => void }) {
  const [paper, setPaper] = React.useState<Paper | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setErr(''); setPaper(null);
    api<{ paper: Paper }>(`/scholar/papers/${encodeURIComponent(id)}`)
      .then((d) => { if (alive) setPaper(d.paper); })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { alive = false; };
  }, [id]);

  const link = { color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', textDecorationLine: 'underline', fontSize: 12 } as const;

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9, minHeight: '100%', overflow: 'auto' }}>
      <button type="button" onClick={onBack} style={{ alignSelf: 'flex-start', cursor: 'pointer', border: 0, background: 'none',
        color: 'var(--dsw-alias-label-caption)', fontSize: 11, padding: 0 }}>{t('rightbar.back')}</button>
      {err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {!paper && !err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>…</div>}
      {paper && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.55 }}>{paper.title}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>
            {paper.year ? <span>{paper.year}</span> : null}
            {paper.venue ? <span>· {paper.venue}</span> : null}
            {paper.importance ? <Stars n={paper.importance} /> : null}
          </div>
          {paper.authors.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.6 }}>{paper.authors.join(', ')}</div>
          )}
          {paper.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {paper.tags.map((tg) => (
                <span key={tg} style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 999,
                  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' }}>#{tg}</span>
              ))}
            </div>
          )}
          {paper.summary && (
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)',
              borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 9 }}>{paper.summary}</div>
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>
            {paper.pdfPath && (
              <a style={link} href={`/scholar/papers/${encodeURIComponent(paper.id)}/pdf`} target="_blank" rel="noreferrer noopener">{t('rightbar.openPdf')}</a>
            )}
            {paper.arxivId && (
              <a style={link} href={`https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}`} target="_blank" rel="noreferrer noopener">arXiv</a>
            )}
            {paper.url && /^(https?:)/i.test(paper.url) && (
              <a style={link} href={paper.url} target="_blank" rel="noreferrer noopener">{t('rightbar.openLink')}</a>
            )}
            {paper.doi && (
              <a style={link} href={`https://doi.org/${encodeURIComponent(paper.doi)}`} target="_blank" rel="noreferrer noopener">DOI</a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- 注册(apply 时调用;旧宿主无该服务时静默跳过) ---------- */

export function registerScholarRightbar(ctx: any): void {
  // 用 ctx.inject 子插件而非静态 inject:服务缺席时父插件(抽屉/入口)照常工作,
  // 仅右栏页签不注册——旧宿主优雅降级。package.json 的 dsh.client.inject
  // 已声明 '@deepseek-ai/dsh-client-ui-sidebar-right' 保证图序(服务先于我们到达)。
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    svc = ctx2.sidebarRight;
    const t = ctx2.locale.bind(NS);
    // 阶段一:静态类型声明(页类型,extension 带;title thunk 每次使用时重读,语言切换自动跟随)
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: PAPER_TAB_KIND,
      title: () => t('rightbar.tabTitle'),
      guide: [{
        order: 60,
        title: () => t('rightbar.tabTitle'),
        description: () => t('rightbar.guideDesc'),
      }],
    }), 'dsh-scholar: rightbar paper tab type');
    // 阶段二:body 注册(key = 定义 id;locale 选项让框架给组件注入 t)
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, PaperTabBody)), 'dsh-scholar: rightbar paper tab body');
    return () => { svc = null; };
  });
}
