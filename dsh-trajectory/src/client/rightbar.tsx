/**
 * 官方右侧 Sidebar(0.1.5+)的「研究主线」页签。
 *
 * 姿势与 dsh-scholar 的论文速查一致(照官方 sidebar-files 两阶段注册):
 *  1. ctx.sidebarRightTabs.register(定义) —— 页类型,extension 带
 *  2. ctx.slots.inject('sidebar.right.pane.tab', ...) —— body
 *
 * body = 当前会话工作区绑定主线的常驻摘要:研究问题 → 主线有序节点(状态点+
 * 最新台账结论片段)→ 待推进计数。30s 轻轮询跟随 agent 维护;会话的 cwd 经
 * useSessions 标准钩子取得(官方 FilesBody 同款),作为 ?ws= 传给 /traj/overview。
 * 旧宿主无 sidebarRightTabs/sidebarRight 时静默跳过,入口按钮隐藏。
 */
import React from 'react';
import { api } from './api';

const NS = 'dsh-trajectory';
const TAB_ID = 'dsh-trajectory';
export const MAINLINE_TAB_KIND = 'dsh-trajectory.mainline';

let svc: { openTab(kind: string, options?: { params?: unknown }): void } | null = null;

export function rightbarAvailable(): boolean {
  return svc !== null;
}

/** 在右侧栏跟随当前工作区的研究主线;服务缺席时静默 no-op。 */
export function openMainlineInRightbar(): void {
  try {
    svc?.openTab(MAINLINE_TAB_KIND, undefined);
  } catch {
    /* 无 seat 时忽略 */
  }
}

/* ---------- 数据 ---------- */

type TFunc = (key: string, params?: Record<string, unknown>) => string;

interface TrajNodeLite {
  id: string;
  title: string;
  kind?: string;
  status: string;
  detail?: string;
  entries?: { id: string; ts: number; title: string; data?: string; conclusion?: string }[];
}
interface ProjectFile {
  project: { id: string; name: string; researchQuestion?: string; mainline: string[] };
  nodes: TrajNodeLite[];
}

const STATUS_COLOR: Record<string, string> = {
  done: 'var(--dsw-alias-state-success-primary, #30a46c)',
  in_progress: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  blocked: 'var(--dsw-alias-state-danger-primary, #e5484d)',
  todo: 'var(--dsw-alias-label-caption, #8f8f8f)',
  dropped: 'var(--dsw-alias-label-dimmed, #6f6f6f)',
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------- body ---------- */

function MainlineTabBody(props: { useTabInfo: () => { tab: any }; t: TFunc; sessionId?: string; useSessions?: (sel: (s: any) => any) => any }) {
  const { t, sessionId, useSessions } = props;
  // cwd → ?ws=;取不到(无会话钩子)则回落全局活跃项目
  const cwd = useSessions ? useSessions((s: any) => s?.byId?.[sessionId ?? '']?.cwd) : undefined;

  const [file, setFile] = React.useState<ProjectFile | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ activeProjectId: string | null }>(`/traj/overview${cwd ? `?ws=${encodeURIComponent(cwd)}` : ''}`)
        .then((ov) => (ov.activeProjectId
          ? api<ProjectFile>(`/traj/projects/${encodeURIComponent(ov.activeProjectId)}`)
          : Promise.resolve(null)))
        .then((f) => { if (alive) { setFile(f); setErr(''); } })
        .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    };
    load();
    const timer = setInterval(load, 30_000); // 轻轮询跟随 agent 维护(host 内存读)
    return () => { alive = false; clearInterval(timer); };
  }, [cwd]);

  if (err) {
    return <div style={{ padding: '14px', fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>;
  }
  if (!file) {
    return (
      <div style={{ padding: '14px', fontSize: 12, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.8 }}>
        {t('rightbar.noProject')}
      </div>
    );
  }

  const { project, nodes } = file;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mainline = project.mainline.map((id) => byId.get(id)).filter(Boolean) as TrajNodeLite[];
  const open = nodes.filter((n) => n.status === 'todo' || n.status === 'in_progress' || n.status === 'blocked');
  const branch = open.filter((n) => !project.mainline.includes(n.id));

  const Item = ({ n, idx }: { n: TrajNodeLite; idx: number }) => {
    const last = n.entries?.[n.entries.length - 1];
    return (
      <div style={{ display: 'flex', gap: 9, padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))' }}>
        <span style={{
          width: 18, flex: 'none', textAlign: 'center', fontSize: 10.5, lineHeight: '20px',
          color: n.status === 'done' ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-state-business-primary)',
        }}>{idx}</span>
        <span style={{ width: 8, height: 8, borderRadius: 99, flex: 'none', marginTop: 6, background: STATUS_COLOR[n.status] ?? 'var(--dsw-alias-label-caption)' }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12, lineHeight: 1.5, color: n.status === 'done' ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsh-alias-label-primary, var(--dsw-alias-label-primary))',
            textDecorationLine: n.status === 'dropped' ? 'line-through' : 'none',
          }}>{n.title}</div>
          {last?.conclusion && (
            <div style={{ marginTop: 3, fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-caption)' }}>
              <span style={{ opacity: 0.75 }}>{fmtDate(last.ts)} · </span>{last.conclusion}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%', overflow: 'auto' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{project.name}</div>
        <div style={{ marginTop: 3, fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>
          {t('rightbar.openCount', {
            todo: open.filter((n) => n.status === 'todo').length,
            doing: open.filter((n) => n.status === 'in_progress').length,
            blocked: open.filter((n) => n.status === 'blocked').length,
          })}
        </div>
      </div>

      {project.researchQuestion && (
        <div style={{ fontSize: 12, lineHeight: 1.7, padding: '8px 10px', borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)', borderLeft: '3px solid var(--dsw-alias-state-business-primary)' }}>
          <span style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.rq')}: </span>{project.researchQuestion}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 2 }}>{t('rightbar.mainlineTitle')}</div>
      {mainline.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.emptyMainline')}</div>
      )}
      {mainline.map((n, i) => <Item key={n.id} n={n} idx={i + 1} />)}

      {branch.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 6 }}>{t('rightbar.branchTitle')}</div>
          {branch.map((n, i) => <Item key={n.id} n={n} idx={i + 1} />)}
        </>
      )}

      <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption))', marginTop: 'auto', paddingTop: 8 }}>
        {t('rightbar.hint')}
      </div>
    </div>
  );
}

/* ---------- 注册 ---------- */

export function registerTrajRightbar(ctx: any): void {
  // ctx.inject 子插件:服务缺席时父插件(抽屉/入口)照常工作,仅右栏页签不注册
  // ——旧宿主优雅降级(与 dsh-scholar 同款)。
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    svc = ctx2.sidebarRight;
    const t = ctx2.locale.bind(NS);
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: MAINLINE_TAB_KIND,
      title: () => t('rightbar.title'),
      guide: [{
        order: 61,
        title: () => t('rightbar.title'),
        description: () => t('rightbar.guideDesc'),
      }],
    }), 'dsh-trajectory: rightbar mainline tab type');
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, MainlineTabBody)), 'dsh-trajectory: rightbar mainline tab body');
    return () => { svc = null; };
  });
}
