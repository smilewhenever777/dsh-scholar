import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { TrajNode, TrajProjectSummary, TrajProjectFile, TrajStatus } from '../shared/types';
import { zh, en } from './locales';
import { TrajGraphView, type StatusFilter } from './TrajGraphView';
import { TrajListView, TrajStoryView } from './TrajListView';
import { NodeEditorModal, ProjectModal, ProjectSettingsModal } from './NodeEditor';
import { TrajSettings } from './SettingsSection';
import { api, qs } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { Btn, EmptyState, Icon, IconButton, Icons, Select, T, TrajStyles, Z } from './ui';
import { useDashProgress } from './dash';
import { openMainlineInRightbar, registerTrajRightbar, rightbarAvailable } from './rightbar';

// locale 命名空间必须用完整插件名:官方 shell 自带 @deepseek-ai/dsh-client-ui-trajectory
// (会话轨迹导航),裸名 'trajectory' 会和它的字典撞车(单占有主,注册冲突 → 全部 raw key)。
const NS = 'dsh-trajectory';

/** Client services this plugin needs (merged into ctx by the runtime). */
export const inject = ['slots', 'locale', 'sessions', 'workspaces'];

/**
 * shell services captured at apply time (dsh-kanban 同款):
 * sessions.list  → { current, byId: { [id]: { cwd } } }
 * workspaces.list → { items: [{ workspaceId, path, title }], recentWorkspaceId }
 */
const shell: { sessions?: any; workspaces?: any } = {};

interface WsInfo {
  cwd: string;
  title: string;
  items: { workspaceId: string; path: string; title: string }[];
}

const wsBus = {
  info: null as WsInfo | null,
  listeners: new Set<() => void>(),
  getSnapshot: () => wsBus.info,
  subscribe(listener: () => void) {
    wsBus.listeners.add(listener);
    return () => { wsBus.listeners.delete(listener); };
  },
  set(next: WsInfo | null) {
    const cur = wsBus.info;
    if (cur?.cwd !== next?.cwd || cur?.title !== next?.title || cur?.items?.length !== next?.items?.length) {
      wsBus.info = next;
      for (const l of wsBus.listeners) l();
    }
  },
};

/** 官方右侧栏(0.1.5)是布局内占位而非 overlay:抽屉/全页画布应让位于它,不能盖在上面。
 *  测法:从聊天输入框向上找第一棵「右缘离窗口右沿 ≥16px 且高度过半屏」的列,
 *  其右缘缺口即右侧栏宽度;右栏关闭或浮出成窗(浮窗不占布局位)时返回 0。 */
function officialRightInset(): number {
  try {
    const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!input) return 0;
    let el = input.parentElement;
    const vw = window.innerWidth;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.5 && vw - r.right >= 16) return Math.round(vw - r.right);
      el = el.parentElement;
    }
    return 0;
  } catch {
    return 0;
  }
}

function computeWs(): WsInfo | null {  try {
    const s = shell.sessions?.list?.getSnapshot?.();
    const currentId = s?.current;
    const cwd = currentId === undefined || currentId === null ? undefined : s?.byId?.[currentId]?.cwd;
    const w = shell.workspaces?.list?.getSnapshot?.();
    const items = (w?.items ?? []).map((it: any) => ({
      workspaceId: String(it.workspaceId ?? it.path ?? ''),
      path: String(it.path ?? ''),
      title: String(it.title ?? it.path ?? ''),
    })).filter((it: any) => it.path);
    if (typeof cwd === 'string' && cwd) {
      const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
      const hit = items.find((it: any) => it.path.replace(/\\/g, '/') === norm);
      const base = norm.split('/').pop() || norm;
      return { cwd, title: hit?.title ?? base, items };
    }
    const recent = items.find((it: any) => it.workspaceId === w?.recentWorkspaceId) ?? items[0];
    return recent ? { cwd: recent.path, title: recent.title, items } : null;
  } catch {
    return null;
  }
}

function useWsInfo(): WsInfo | null {
  return useSyncExternalStore(wsBus.subscribe, wsBus.getSnapshot);
}

/* ---------- drawer open state (trigger button ⇄ right drawer) ---------- */
type PanelMode = 'open' | 'rail' | 'closed' | 'float';
const panelBus = {
  mode: 'closed' as PanelMode,
  listeners: new Set<() => void>(),
  getSnapshot: () => panelBus.mode,
  subscribe(listener: () => void) {
    panelBus.listeners.add(listener);
    return () => { panelBus.listeners.delete(listener); };
  },
  set(next: PanelMode) {
    if (panelBus.mode !== next) {
      panelBus.mode = next;
      for (const l of panelBus.listeners) l();
    }
  },
};
function usePanelMode(): PanelMode {
  return useSyncExternalStore(panelBus.subscribe, panelBus.getSnapshot);
}

/* ---------- open-items counts for the sidebar badge ---------- */
export interface TrajCounts { open: number; total: number }
const countsBus = {
  counts: { open: 0, total: 0 } as TrajCounts,
  listeners: new Set<() => void>(),
  getSnapshot: () => countsBus.counts,
  subscribe(listener: () => void) {
    countsBus.listeners.add(listener);
    return () => { countsBus.listeners.delete(listener); };
  },
  set(counts: TrajCounts) {
    if (countsBus.counts.open !== counts.open || countsBus.counts.total !== counts.total) {
      countsBus.counts = counts;
      for (const l of countsBus.listeners) l();
    }
  },
};
function useCounts(): TrajCounts {
  return useSyncExternalStore(countsBus.subscribe, countsBus.getSnapshot);
}

/* ---------- left sidebar trigger ---------- */
function Trigger({ t, wide }: { t: TFunc; wide?: boolean }) {
  const mode = usePanelMode();
  const counts = useCounts();
  const ws = useWsInfo();
  const active = mode === 'open';
  const wsRef = useRef(ws);
  wsRef.current = ws;

  // badge = 当前工作区绑定项目的未完成数(ws 切换即刷新)
  useEffect(() => {
    const load = () => {
      const cwd = wsRef.current?.cwd;
      void api<OverviewBody>(`/traj/overview${qs({ ws: cwd })}`)
        .then((r) => {
          const c = r.counts ?? { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 };
          countsBus.set({
            open: (c.todo ?? 0) + (c.in_progress ?? 0) + (c.blocked ?? 0),
            total: Object.values(c).reduce((s, x) => s + (x ?? 0), 0),
          });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [ws?.cwd]);

  return (
    <>
      <TrajStyles />
      <button
        type="button"
        data-dsh-plugin="dsh-trajectory"
        data-dsh-part="sidebar-entry"
        onClick={() => panelBus.set(active ? 'closed' : 'open')}
        title={t('nav.title')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 28,
          background: active
            ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent)' : 'none',
          border: 0, cursor: 'pointer',
          color: active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-label-secondary)',
          padding: '0 7px', borderRadius: 8, fontSize: 12, width: wide ? undefined : 'auto',
          boxShadow: active
            ? 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 35%, transparent)' : 'none',
          transition: 'background .12s ease, color .12s ease',
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}
      >
        <span aria-hidden style={{ position: 'relative', display: 'inline-flex' }}>
          <Icon d={Icons.traj} size={16} />
          {counts.open > 0 && (
            <span
              style={{
                position: 'absolute', top: -5, right: -8, minWidth: 13, height: 13, borderRadius: 999,
                padding: '0 3px', boxSizing: 'border-box',
                background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                color: '#fff', fontSize: 9, lineHeight: '13px', textAlign: 'center',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {counts.open > 99 ? '99+' : counts.open}
            </span>
          )}
        </span>
        {wide && <span>{t('nav.label')}</span>}
      </button>
    </>
  );
}

/* ---------- 组会导出:项目 → Markdown(研究问题/主线演变/台账数据/卡点/下一步) ---------- */

const MD_STATUS_ZH: Record<string, string> = {
  todo: '待办', in_progress: '进行中', blocked: '受阻', done: '完成', dropped: '放弃',
};

function exportProjectMd(file: TrajProjectFile): void {
  const p = file.project;
  const byId = new Map(file.nodes.map((n) => [n.id, n]));
  const mainline = p.mainline.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const mainlineSet = new Set(mainline.map((n) => n.id));
  const doneMain = mainline.filter((n) => n.status === 'done').length;
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const L: string[] = [];
  L.push(`# ${p.name} · 研究主线`);
  L.push('');
  if (p.researchQuestion || p.description) {
    L.push(`> **研究问题**:${p.researchQuestion || p.description}`);
    L.push('');
  }
  if (mainline.length) {
    L.push(`主线完成 ${doneMain}/${mainline.length}(${Math.round((doneMain / mainline.length) * 100)}%)· 共 ${file.nodes.length} 节点 / ${file.nodes.reduce((s, n) => s + (n.entries?.length ?? 0), 0)} 条台账`);
    L.push('');
  }
  L.push('## 主线演变(已发生的工作)');
  L.push('');
  mainline.forEach((n, i) => {
    L.push(`### ${n.status === 'done' ? '✓' : i + 1}. ${n.title}  \`${MD_STATUS_ZH[n.status] ?? n.status}\``);
    L.push('');
    if (n.detail) { L.push(n.detail); L.push(''); }
    for (const e of [...(n.entries ?? [])].sort((a, b) => a.ts - b.ts)) {
      L.push(`- **${fmt(e.ts)} ${e.title}**`);
      if (e.metrics?.length) {
        for (const m of e.metrics) {
          const delta = m.baseline !== undefined ? m.value - m.baseline : null;
          L.push(`  - ${m.name}: ${m.value}${m.unit ?? ''}${m.baseline !== undefined ? `(vs ${m.baseline})` : ''}${delta !== null ? ` **${delta >= 0 ? '+' : ''}${Number(delta.toFixed(4))}${m.unit ?? ''}**` : ''}`);
        }
      }
      if (e.data) L.push(`  - 数据:${e.data}`);
      if (e.conclusion) L.push(`  - 结论:${e.conclusion}`);
    }
    if (n.entries?.length) L.push('');
  });
  const branches = file.nodes.filter((n) => !mainlineSet.has(n.id));
  if (branches.length) {
    L.push('## 分支工作');
    L.push('');
    for (const n of branches) {
      L.push(`- ${n.title} \`${MD_STATUS_ZH[n.status] ?? n.status}\`${n.detail ? ` — ${n.detail}` : ''}`);
    }
    L.push('');
  }
  const blockers = file.nodes.filter((n) => n.status === 'blocked');
  if (blockers.length) {
    L.push('## 当前卡点');
    L.push('');
    for (const n of blockers) L.push(`- **${n.title}**${n.detail ? `:${n.detail}` : ''}`);
    L.push('');
  }
  const todos = file.nodes.filter((n) => n.status === 'todo');
  if (todos.length) {
    L.push('## 下一步(计划)');
    L.push('');
    for (const n of todos) L.push(`- [ ] ${n.title}`);
    L.push('');
  }
  const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `研究主线-${p.name}-${fmt(Date.now())}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- 全页视图(P3 中央沉浸层):盖住中央列,避开侧栏与右舷面板 ---------- */

interface FullPageProps {
  t: TFunc;
  wsTitle: string;
  projectName: string;
  graph: React.ReactNode;
  /** 汇报模式(story)视图;提供时头部出现 看板/汇报 切换 */
  story?: React.ReactNode;
  /** 初始视图:在汇报页签进全页时直接落汇报模式 */
  initialView?: 'board' | 'story';
  /** 提供「导出 Markdown」按钮(组会汇报骨架) */
  onExportMd?: () => void;
  onExit: () => void;
}

function FullPageOverlay({ t, wsTitle, projectName, graph, story, onExportMd, onExit, initialView }: FullPageProps) {
  const [view, setView] = useState<'board' | 'story'>(initialView ?? 'board');
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.dataset.dshPlugin = 'dsh-trajectory';
    el.dataset.dshSurface = 'fullpage';
    document.body.appendChild(el);
    return el;
  });
  const [bounds, setBounds] = useState({ left: 280, right: 0 });

  useEffect(() => {
    const compute = () => {
      let left = 0;
      const entry = document.querySelector('[data-dsh-part="sidebar-entry"]');
      let el: HTMLElement | null = entry as HTMLElement | null;
      for (let i = 0; i < 12 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const r = el.getBoundingClientRect();
        if (r.height > window.innerHeight * 0.7 && r.left <= 4) { left = r.right; break; }
      }
      let right = officialRightInset();
      const dock = (window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> }).__dshDock ?? {};
      // 全页画布右边界 = 官方右侧栏占位 + 全部停靠列总宽:自己的 rail(全页期间 32px)
      // + 内侧的 scholar + 外侧的 dashboard(dashboard 停在本面板 rail 左侧,画布必须再让出它)
      for (const [id, v] of Object.entries(dock)) {
        if (v?.open && v.width > 0) right += v.width;
      }
      setBounds((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('dsh-dock-change', compute);
    const timer = setInterval(compute, 1000);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onExit(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('dsh-dock-change', compute);
      window.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [onExit]);

  useEffect(() => () => { host.remove(); }, [host]);

  // 全页期间锁定 body 滚动(防背景页面随滚轮/键盘滚动),退出恢复
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // 某些皮肤的 bg-base 是半透明(让壁纸透出),全页视图必须不透明:
  // 垫一层 body/html 的实底色,再叠主题底色
  const [opaqueBase, setOpaqueBase] = useState('#161616');
  useEffect(() => {
    const pick = () => {
      for (const el of [document.body, document.documentElement]) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { setOpaqueBase(c); return; }
      }
    };
    pick();
  }, []);

  return createPortal(
    <div
      className="traj-zoomin"
      style={{
        position: 'fixed', top: 0, left: bounds.left, right: bounds.right, bottom: 0,
        zIndex: 80, display: 'flex', flexDirection: 'column',
      }}
    >
      {/* 不透明垫底(防半透明主题透出下层) */}
      <div style={{ position: 'absolute', inset: 0, background: opaqueBase, zIndex: 0 }} />
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1, display: 'flex', flexDirection: 'column',
        background: 'var(--dsw-alias-bg-base)',
        borderLeft: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
      }}>
        <TrajStyles />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', flex: 'none',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
        }}>
          <span aria-hidden style={{
            width: 4, alignSelf: 'stretch', borderRadius: 2, flex: 'none',
            background: 'linear-gradient(180deg, var(--dsw-alias-state-business-primary, #4d6bfe), transparent)',
          }} />
          <span style={{ fontWeight: 700, fontSize: 14 }}>{t('nav.title')}</span>
          <span style={{ fontSize: 11.5, color: T.secondary }}>
            {wsTitle}{projectName ? ` · ${projectName}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <span className="traj-noprint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {story && (
            <Btn tone={view === 'story' ? 'primary' : 'default'} onClick={() => setView(view === 'story' ? 'board' : 'story')}>
              <Icon d={Icons.doc} size={12} /> {view === 'story' ? t('story.board') : t('story.present')}
            </Btn>
          )}
          {onExportMd && (
            <Btn onClick={onExportMd}><Icon d={Icons.doc} size={12} /> {t('story.exportMd')}</Btn>
          )}
          <Btn onClick={onExit}><Icon d={Icons.close} size={12} /> {t('fullpage.exit')}</Btn>
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view === 'story' ? story : graph}
        </div>
      </div>
    </div>,
    host,
  );
}

/* ---------- right-docked collapsible drawer (shell.overlay entry) ---------- */
const DRAWER_MIN = 360;
const DRAWER_MAX = 720;
const DRAWER_DEFAULT = 480;

/** 浮动窗口几何夹取:不越出视口、不小于可读下限(与 dashboard/scholar 同款模板) */
function clampFloat(g: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  return {
    x: Math.max(8, Math.min(g.x, vw - 80)),
    y: Math.max(8, Math.min(g.y, vh - 60)),
    w: Math.max(300, Math.min(g.w, vw - 16)),
    h: Math.max(220, Math.min(g.h, vh - 16)),
  };
}
function clampW(w: number): number {
  return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, w));
}

interface OverviewBody {
  activeProjectId: string | null;
  ws?: string;
  wsBound?: boolean;
  projects: TrajProjectSummary[];
  counts?: Record<TrajStatus, number>;
}

function Drawer({ t }: { t: TFunc }) {
  const mode = usePanelMode();
  const nav = useNav();
  const counts = useCounts();
  const ws = useWsInfo();
  const [width, setWidth] = useState(DRAWER_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const dragOrigin = useRef({ x: 0, w: DRAWER_DEFAULT });

  // 浮动窗口几何:fixed 定位 + 头部拖拽 + 角柄缩放,localStorage 记忆
  const floatGeomRef = useRef({ x: 0, y: 0, w: 440, h: 580 });
  const [floatGeom, setFloatGeom] = useState(() => {
    // 默认位与 scholar 浮窗级联错开,避免首开两窗重叠
    const base = clampFloat({ x: window.innerWidth - 560, y: 140, w: 440, h: Math.min(560, window.innerHeight - 220) });
    try {
      const saved = JSON.parse(localStorage.getItem('traj-float-geom') ?? '');
      if (saved && Number.isFinite(saved.x)) return clampFloat(saved);
    } catch {}
    return base;
  });
  useEffect(() => { floatGeomRef.current = floatGeom; }, [floatGeom]);
  useEffect(() => {
    const onResize = () => setFloatGeom((g) => clampFloat(g));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [floatMoving, setFloatMoving] = useState(false);
  const floatOrigin = useRef({ x: 0, y: 0, g: { x: 0, y: 0, w: 0, h: 0 } });
  const saveFloatGeom = () => { try { localStorage.setItem('traj-float-geom', JSON.stringify(floatGeomRef.current)); } catch {} };
  const onFloatDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest?.('button')) return;
    setFloatMoving(true);
    floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, []);
  const onFloatDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!floatMoving) return;
    const o = floatOrigin.current;
    const next = clampFloat({ ...o.g, x: o.g.x + (e.clientX - o.x), y: o.g.y + (e.clientY - o.y) });
    floatGeomRef.current = next;
    setFloatGeom(next);
  }, [floatMoving]);
  const onFloatDragUp = useCallback(() => { if (!floatMoving) return; setFloatMoving(false); saveFloatGeom(); }, [floatMoving]);
  const onFloatResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setFloatMoving(true);
    floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, []);
  const onFloatResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!floatMoving) return;
    const o = floatOrigin.current;
    const next = clampFloat({ ...o.g, w: o.g.w + (e.clientX - o.x), h: o.g.h + (e.clientY - o.y) });
    floatGeomRef.current = next;
    setFloatGeom(next);
  }, [floatMoving]);

  const [overview, setOverview] = useState<OverviewBody | null>(null);
  const [file, setFile] = useState<TrajProjectFile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [fullPage, setFullPage] = useState(false);
  /** 进入全页前的抽屉形态,退出全页(Esc/按钮)时恢复(而非固定回 rail) */
  const preFullPage = useRef<PanelMode>('closed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ node: TrajNode | null } | null>(null);
  const [projectModal, setProjectModal] = useState(false);
  const [projectSettings, setProjectSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TrajNode | null>(null);

  const wsKey = ws?.cwd ?? '';
  const activeId = overview?.activeProjectId ?? null;
  const wsBound = overview?.wsBound ?? false;
  // 可收养的未绑定项目(绑定到当前工作区)
  const adoptable = useMemo(
    () => (overview?.projects ?? []).filter((p) => !p.workspaceKey),
    [overview],
  );

  // 请求序号守卫:工作区/项目快速切换时丢弃乱序返回的过期响应
  const overviewSeq = useRef(0);
  const fileSeq = useRef(0);
  const loadOverview = useCallback(async (wsCwd: string) => {
    const seq = ++overviewSeq.current;
    try {
      const r = await api<OverviewBody>(`/traj/overview${qs({ ws: wsCwd })}`);
      if (seq !== overviewSeq.current) return; // 过期响应
      setOverview(r);
      const c = r.counts ?? { todo: 0, in_progress: 0, blocked: 0, done: 0, dropped: 0 };
      countsBus.set({
        open: (c.todo ?? 0) + (c.in_progress ?? 0) + (c.blocked ?? 0),
        total: Object.values(c).reduce((s, x) => s + (x ?? 0), 0),
      });
    } catch { /* host absent — badge stays empty */ }
  }, []);

  const loadFile = useCallback(async (pid: string | null) => {
    if (!pid) { setFile(null); return; }
    const seq = ++fileSeq.current;
    try {
      const r = await api<TrajProjectFile>(`/traj/projects/${encodeURIComponent(pid)}`);
      if (seq !== fileSeq.current) return; // 过期响应
      setFile(r);
      setLoadError('');
    } catch (e) {
      if (seq !== fileSeq.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void loadOverview(wsKey); }, [wsKey, loadOverview]);
  useEffect(() => { void loadFile(activeId); }, [activeId, loadFile]);

  // agent 在对话中维护主线时,打开的抽屉/全页视图要能跟着变:轻轮询(host 内存读,便宜)。
  // 抽屉完全关闭且不在全页时停轮询;rail 只剩徽标,overview 降为 30s。
  useEffect(() => {
    if ((mode === 'closed' && !fullPage) || !wsKey) return;
    const interval = mode === 'open' || fullPage ? 10000 : 30000;
    const timer = setInterval(() => { void loadOverview(wsKey); }, interval);
    return () => clearInterval(timer);
  }, [mode, fullPage, wsKey, loadOverview]);
  useEffect(() => {
    if ((mode !== 'open' && mode !== 'float' && !fullPage) || !activeId) return; // rail 下图谱不可见不刷;float 浮窗可见要刷
    const timer = setInterval(() => { void loadFile(activeId); }, 10000);
    return () => clearInterval(timer);
  }, [mode, fullPage, activeId, loadFile]);

  /** after any mutation: refresh project file + overview counts */
  const refresh = useCallback(async () => {
    await Promise.all([loadOverview(wsKey), loadFile(activeId)]);
  }, [loadOverview, loadFile, wsKey, activeId]);

  // 全页视图存活期间抽屉可能被收起:进度轮询只要抽屉非关闭或全页开着就继续
  const live = useDashProgress(file?.nodes ?? [], mode !== 'closed' || fullPage);

  /* 全页视图进出:进入时记下当前抽屉形态并收为 rail;退出(Esc/按钮)恢复原形态 */
  const enterFullPage = useCallback(() => {
    preFullPage.current = mode;
    setFullPage(true);
    if (mode === 'open') panelBus.set('rail');
  }, [mode]);
  const exitFullPage = useCallback(() => {
    setFullPage(false);
    panelBus.set(preFullPage.current);
  }, []);

  /* drawer chrome interactions */
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(true);
    dragOrigin.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [width]);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setWidth(clampW(dragOrigin.current.w + (dragOrigin.current.x - e.clientX)));
  }, [dragging]);
  const onHandleUp = useCallback(() => setDragging(false), []);

  // 链式让位:右舷停靠链为 scholar(最内,right:0) ← trajectory ← server-dashboard(最外)。
  // 每个面板只对「比自己更靠内」的面板让位——trajectory 内侧只有 scholar。
  // 不能对 server-dashboard 让位:dashboard 同时也对本面板让位,互相把对方计入
  // 偏移会形成循环约束,三面板同开时两者区间互相包含、低 z 者被整块盖住(看板"消失")。
  // 另让位官方右侧栏(布局内占位,不能盖):其开关不发 dock-change,靠 1s 轻轮询跟随。
  const [dockOffset, setDockOffset] = useState(0);
  useEffect(() => {
    const INNER_PANELS = new Set(['dsh-scholar']);
    const compute = () => {
      const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> };
      const dock = w.__dshDock ?? {};
      let off = officialRightInset();
      for (const [id, v] of Object.entries(dock)) {
        if (id === 'dsh-trajectory') continue;
        if (INNER_PANELS.has(id) && v?.open && v.width > 0) off += v.width;
      }
      setDockOffset((cur) => (cur === off ? cur : off));
    };
    compute();
    const timer = setInterval(compute, 1000);
    window.addEventListener('dsh-dock-change', compute);
    return () => {
      clearInterval(timer);
      window.removeEventListener('dsh-dock-change', compute);
    };
  }, []);

  // publish footprint so sibling right-docked panels can dock around us
  const selfW = mode === 'open' ? width : mode === 'rail' ? 32 : 0;
  useEffect(() => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-trajectory': { open: mode === 'open' || mode === 'rail', width: selfW } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change'));
  }, [mode, selfW]);
  useEffect(() => () => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-trajectory': { open: false, width: 0 } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change'));
  }, []);

  /* mutations */
  /** 为当前工作区创建并绑定主线(名字缺省 = 工作区目录名) */
  const createForWs = async (name?: string, description?: string) => {
    try {
      await api('/traj/projects', {
        method: 'POST',
        body: JSON.stringify({ ws: wsKey, name, description }),
      });
      await refresh();
    } catch { /* ignore */ }
  };
  /** 收养:把未绑定的既有项目绑到当前工作区 */
  const adoptProject = async (pid: string) => {
    try {
      await api(`/traj/projects/${encodeURIComponent(pid)}`, {
        method: 'PUT',
        body: JSON.stringify({ bindWs: wsKey }),
      });
      await refresh();
    } catch { /* ignore */ }
  };
  const setStatus = async (node: TrajNode, status: TrajStatus) => {
    try {
      await api(`/traj/nodes/${encodeURIComponent(node.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      await refresh();
    } catch { /* ignore */ }
  };
  const doDelete = async (node: TrajNode) => {
    setConfirmDelete(null);
    if (selectedId === node.id) setSelectedId(null);
    try {
      await api(`/traj/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      await refresh();
    } catch { /* ignore */ }
  };
  /** 删除节点上的一条实验台账(带确认) */
  const deleteEntry = async (nodeId: string, entryId: string) => {
    if (!window.confirm(t('entry.deleteConfirm'))) return;
    try {
      await api(`/traj/nodes/${encodeURIComponent(nodeId)}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
      await refresh();
    } catch { /* ignore */ }
  };
  const toggleMainline = async (node: TrajNode) => {
    if (!file) return;
    const next = file.project.mainline.includes(node.id)
      ? file.project.mainline.filter((x) => x !== node.id)
      : [...file.project.mainline, node.id];
    try {
      await api(`/traj/projects/${encodeURIComponent(file.project.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ mainline: next }),
      });
      await refresh();
    } catch { /* ignore */ }
  };

  const tabs: { id: 'graph' | 'list' | 'story'; label: string; icon: string }[] = [
    { id: 'graph', label: t('tab.graph'), icon: Icons.traj },
    { id: 'list', label: t('tab.list'), icon: Icons.list },
    { id: 'story', label: t('tab.story'), icon: Icons.present },
  ];

  return (
    <>
      <TrajStyles />
      {mode !== 'closed' && (
        <div data-dsh-plugin="dsh-trajectory" data-dsh-surface="drawer" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: mode === 'float' ? 115 : Z.drawer }}>
          {mode === 'rail' && (
            <div
              data-dsh-part="drawer-rail"
              style={{
                position: 'absolute', top: 'var(--dsh-desktop-titlebar-inset, 0px)', right: dockOffset, bottom: 0, width: 34, pointerEvents: 'auto',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '10px 0',
                borderLeft: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
                backdropFilter: 'blur(16px) saturate(1.08)', WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
              }}
            >
              <IconButton
                label={t('nav.title')}
                onClick={() => panelBus.set('open')}
                icon={<Icon d={Icons.traj} size={14} />}
              />
              <span style={{ writingMode: 'vertical-rl', fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', userSelect: 'none', letterSpacing: 3, padding: '6px 0' }}>
                {t('nav.title')}
              </span>
              <span style={{ flex: 1 }} />
              <IconButton
                label={t('drawer.close')}
                onClick={() => panelBus.set('closed')}
                size={22}
                icon={<Icon d={Icons.close} size={13} />}
              />
            </div>
          )}
          {(mode === 'open' || mode === 'float') && (
            <div
              className="traj-slide"
              data-dsh-part="drawer-panel"
              style={{
                ...(mode === 'float'
                  ? { position: 'fixed' as React.CSSProperties['position'], top: floatGeom.y, left: floatGeom.x, width: floatGeom.w, height: floatGeom.h, pointerEvents: 'auto' as const, zIndex: 2, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))', overflow: 'hidden', display: 'flex' as const, flexDirection: 'column' as const, background: 'var(--dsw-alias-bg-base)' }
                  : { position: 'absolute' as React.CSSProperties['position'], top: 'var(--dsh-desktop-titlebar-inset, 0px)', right: dockOffset, bottom: 0, width, pointerEvents: 'auto' as const }),
                display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)',
                backdropFilter: 'blur(16px) saturate(1.08)', WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
                borderLeft: '1px solid var(--dsw-alias-border-l2)',
                boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))',
                color: 'var(--dsw-alias-label-primary)',
              }}
            >
              {/* resize handle */}
              {mode === 'float' && (
                <div
                  onPointerDown={onFloatResizeDown}
                  onPointerMove={onFloatResizeMove}
                  onPointerUp={onFloatDragUp}
                  title={t('drawer.resize')}
                  style={{ position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize', zIndex: 3, userSelect: 'none', touchAction: 'none', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 2, color: 'var(--dsw-alias-label-caption)' }}
                >
                  <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden><path d="M9 1v8H1M9 5v4M5 9H1" stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round" /></svg>
                </div>
              )}
                {mode !== 'float' && (<div
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onMouseEnter={() => setHandleHover(true)}
                onMouseLeave={() => setHandleHover(false)}
                title={t('drawer.resize')}
                style={{
                  position: 'absolute', left: -4, top: 0, bottom: 0, width: 9, cursor: 'col-resize',
                  zIndex: 2, userSelect: 'none', touchAction: 'none', display: 'flex', justifyContent: 'center',
                }}
              >
                <span
                  style={{
                    width: 3, borderRadius: 2, margin: '10px 0', flex: 'none',
                    background: 'var(--dsw-alias-border-l3, var(--dsw-alias-label-caption))',
                    opacity: dragging || handleHover ? 1 : 0,
                    transition: 'opacity .15s',
                  }}
                />
              </div>)}

              {/* body = left icon rail + content column */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <nav style={{
                  width: 46, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  padding: '10px 0', borderRight: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                }}>
                  {tabs.map(({ id, icon, label }) => {
                    const active = nav.tab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        title={label}
                        onClick={() => {
                          navBus.go(id);
                          if (id === 'story') enterFullPage();
                        }}
                        className="traj-press"
                        style={{
                          position: 'relative', width: 34, height: 34, borderRadius: 9,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          border: 'none', cursor: 'pointer',
                          background: active
                            ? 'linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 26%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent))'
                            : 'transparent',
                          color: active
                            ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
                            : 'var(--dsw-alias-label-secondary)',
                          boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 38%, transparent)' : 'none',
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = T.hoverBg; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Icon d={icon} size={17} />
                        {id === 'list' && counts.open > 0 && (
                          <span style={{
                            position: 'absolute', top: -3, right: -3, minWidth: 14, height: 14, borderRadius: 999,
                            padding: '0 3px', boxSizing: 'border-box',
                            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.35))',
                            color: '#fff', fontSize: 8.5, lineHeight: '14px', textAlign: 'center',
                            fontVariantNumeric: 'tabular-nums',
                          }}>{counts.open > 99 ? '99+' : counts.open}</span>
                        )}
                      </button>
                    );
                  })}
                  <span style={{ flex: 1 }} />
                  <span style={{ writingMode: 'vertical-rl', fontSize: 9.5, letterSpacing: 2.5, color: 'var(--dsw-alias-label-caption)', userSelect: 'none', paddingBottom: 6 }}>
                    {t('nav.title')}
                  </span>
                </nav>

                {/* content column */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {/* header: view name + window controls */}
                  <div className="traj-fade"
                    onPointerDown={mode === 'float' ? onFloatDragDown : undefined}
                    onPointerMove={mode === 'float' ? onFloatDragMove : undefined}
                    onPointerUp={mode === 'float' ? onFloatDragUp : undefined}
                    style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 4px', flex: 'none',
                    cursor: mode === 'float' ? (floatMoving ? 'grabbing' : 'grab') : undefined,
                    userSelect: floatMoving ? 'none' : undefined,
                    touchAction: mode === 'float' ? 'none' : undefined,
                  }}>
                    <span aria-hidden style={{
                      width: 4, alignSelf: 'stretch', borderRadius: 2, flex: 'none',
                      background: 'linear-gradient(180deg, var(--dsw-alias-state-business-primary, #4d6bfe), transparent)',
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: '.01em' }}>
                      {tabs.find((x) => x.id === nav.tab)?.label}
                    </span>
                    {wsBound && file && (
                      <span style={{ fontSize: 10.5, color: T.caption, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {file.project.name}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <IconButton
                      label={t('graph.fullpage')}
                      onClick={enterFullPage}
                      icon={<Icon d={Icons.expand} size={15} />}
                    />
                    {rightbarAvailable() && (
                      <IconButton
                        label={t('rightbar.follow')}
                        onClick={openMainlineInRightbar}
                        icon={<Icon d={Icons.sidebarRight} size={15} />}
                      />
                    )}
                    {mode !== 'float' && <IconButton label={t('drawer.float')} onClick={() => { setFullPage(false); panelBus.set('float'); }} icon={<Icon d={Icons.popout} size={15} />} />}
                    {mode === 'float' && <IconButton label={t('drawer.dock')} onClick={() => { setFullPage(false); panelBus.set('open'); }} icon={<Icon d={Icons.dock} size={15} />} />}
                    {mode !== 'float' && <IconButton label={t('drawer.collapse')} onClick={() => panelBus.set('rail')} icon={<Icon d={Icons.collapseRight} size={15} />} />}
                    <IconButton label={t('drawer.close')} onClick={() => panelBus.set('closed')} icon={<Icon d={Icons.close} size={15} />} />
                  </div>

                  {/* project bar:当前工作区 + 绑定状态 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px 6px', flex: 'none', minWidth: 0 }}>
                    <span
                      title={wsKey || undefined}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flex: wsBound ? '1 1 auto' : 'none',
                        fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
                        padding: '3px 9px', borderRadius: 8,
                        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
                        border: '1px solid var(--dsw-alias-border-l2)',
                      }}
                    >
                      <Icon d={Icons.folder} size={13} color={T.business} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ws ? ws.title : t('ws.unknown')}
                      </span>
                    </span>
                    {wsBound && file && (
                      <IconButton
                        label={t('pset.title')}
                        onClick={() => setProjectSettings(true)}
                        icon={<Icon d={Icons.settings} size={14} />}
                      />
                    )}
                    {!wsBound && ws && (
                      <>
                        <Btn tone="primary" onClick={() => void createForWs()}>
                          <Icon d={Icons.traj} size={11} /> {t('ws.create')}
                        </Btn>
                        {adoptable.length > 0 && (
                          <Select
                            value=""
                            title={t('ws.adopt')}
                            onChange={(e) => { const pid = e.target.value; if (pid) void adoptProject(pid); }}
                            style={{ flex: 'none', maxWidth: 130 }}
                          >
                            <option value="">{t('ws.adopt')}…</option>
                            {adoptable.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </Select>
                        )}
                      </>
                    )}
                    {nav.tab === 'graph' && wsBound && (
                      <Btn tone="soft" disabled={!file} onClick={() => setEditor({ node: null })}>
                        <Icon d={Icons.plus} size={11} /> {t('graph.add')}
                      </Btn>
                    )}
                  </div>

                  {loadError && (
                    <div style={{ padding: '4px 12px 6px', fontSize: 11, color: T.danger }}>{loadError}</div>
                  )}

                  {/* views */}
                  <div key={nav.tab} className="traj-fade" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {!ws ? (
                      /* computeWs 失败:显式错误空态,而非永久 loading */
                      <EmptyState
                        icon={<Icon d={Icons.folder} size={38} />}
                        title={t('ws.unavailable')}
                        hint={t('ws.unavailableHint')}
                      />
                    ) : !overview ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.caption }}>
                        {t('common.loading')}
                      </div>
                    ) : !wsBound ? (
                      <EmptyState
                        icon={<Icon d={Icons.traj} size={38} />}
                        title={t('ws.unbound')}
                        hint={t('ws.hint', { ws: ws.title })}
                        action={
                          <div style={{ display: 'flex', gap: 8 }}>
                            <Btn tone="primary" onClick={() => void createForWs()}>
                              <Icon d={Icons.plus} size={12} /> {t('ws.create')}
                            </Btn>
                            <Btn onClick={() => setProjectModal(true)}>{t('project.new')}</Btn>
                          </div>
                        }
                      />
                    ) : !file ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: T.caption }}>
                        {t('common.loading')}
                      </div>
                    ) : (
                      <>
                        {nav.tab === 'graph' && (
                          <TrajGraphView
                            t={t}
                            file={file}
                            progress={live}
                            filter={filter}
                            onFilter={setFilter}
                            statusFilter={statusFilter}
                            onStatusFilter={setStatusFilter}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                            onEdit={(node) => setEditor({ node })}
                            onAdd={() => setEditor({ node: null })}
                            onStatus={(node, s) => void setStatus(node, s)}
                            onDelete={(node) => setConfirmDelete(node)}
                            onToggleMainline={(node) => void toggleMainline(node)}
                            onFullPage={enterFullPage}
                          />
                        )}
                        {nav.tab === 'list' && (
                          <TrajListView
                            t={t}
                            file={file}
                            progress={live}
                            onOpen={(node) => { setSelectedId(node.id); setEditor({ node }); }}
                            onDelete={(node) => setConfirmDelete(node)}
                            onDeleteEntry={(nodeId, entryId) => void deleteEntry(nodeId, entryId)}
                            onStatus={(node, s) => void setStatus(node, s)}
                          />
                        )}
                        {nav.tab === 'story' && (
                          <TrajStoryView t={t} file={file} progress={live} compact />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 全页视图(中央沉浸层) */}
      {fullPage && ws && (
        <FullPageOverlay
          t={t}
          wsTitle={ws.title}
          projectName={file?.project.name ?? ''}
          onExit={exitFullPage}
          graph={file ? (
            <TrajGraphView
              t={t}
              file={file}
              progress={live}
              filter={filter}
              onFilter={setFilter}
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onEdit={(node) => setEditor({ node })}
              onAdd={() => setEditor({ node: null })}
              onStatus={(node, s) => void setStatus(node, s)}
              onDelete={(node) => setConfirmDelete(node)}
              onToggleMainline={(node) => void toggleMainline(node)}
            />
          ) : null}
          initialView={nav.tab === 'story' ? 'story' : 'board'}
          story={file ? (
            <TrajStoryView t={t} file={file} progress={live} />
          ) : null}
          onExportMd={() => { if (file) exportProjectMd(file); }}
        />
      )}

      {/* modals */}
      {projectSettings && file && (
        <ProjectSettingsModal
          t={t}
          file={file}
          wsKey={wsKey}
          onClose={() => setProjectSettings(false)}
          onChanged={() => { void refresh(); }}
        />
      )}
      {editor && file && (
        <NodeEditorModal
          t={t}
          file={file}
          editing={editor.node}
          onClose={() => setEditor(null)}
          onSaved={() => { void refresh(); }}
        />
      )}
      {projectModal && (
        <ProjectModal
          t={t}
          ws={wsKey}
          onClose={() => setProjectModal(false)}
          onCreated={() => { void refresh(); }}
        />
      )}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: Z.modal, background: 'rgba(0,0,0,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}
        >
          <div className="traj-fade" style={{
            width: 'min(340px, 90vw)', background: 'var(--dsw-alias-bg-layer-2, #1e1e1e)',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 16,
            boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.4))',
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
              {t('node.deleteConfirm')}:{confirmDelete.title}
            </div>
            <div style={{ fontSize: 11, color: T.caption, lineHeight: 1.6, marginBottom: 12 }}>
              {t('common.confirmDelete')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Btn onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Btn>
              <Btn tone="danger" onClick={() => void doDelete(confirmDelete)}>{t('common.delete')}</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * apply-guard: the client factory may be loaded twice on one page (mixed
 * old/new bundles); first claim wins. Released on fiber unmount for hot-swap.
 */
const APPLY_FLAG = '__dshTrajectoryApplied';

/** Client plugin entry. */
export function apply(ctx: any) {
  const g = globalThis as Record<string, unknown>;
  if (g[APPLY_FLAG]) return;
  g[APPLY_FLAG] = true;
  ctx.effect(() => () => { g[APPLY_FLAG] = false; }, 'dsh-trajectory: apply guard');
  // 字典可能在上一次 fiber 已注册(fiber 卸载顺序不保证反注册先于重挂),
  // 重复注册会抛错让整个 loader entry 失败——这里必须容忍重复。
  try {
    ctx.locale.register(NS, { zh, en });
  } catch { /* already registered by a previous apply — fine */ }
  // 官方右侧 Sidebar 页签(0.1.5+):旧宿主无该服务时静默跳过
  registerTrajRightbar(ctx);

  // capture shell services for workspace resolution (kanban pattern)
  try {
    shell.sessions = ctx.get ? ctx.get('sessions') : undefined;
    shell.workspaces = ctx.get ? ctx.get('workspaces') : undefined;
  } catch { shell.sessions = shell.workspaces = undefined; }
  const recomputeWs = () => wsBus.set(computeWs());
  recomputeWs();
  // follow workspace/session switching live
  try {
    const un1 = shell.sessions?.list?.subscribe?.(recomputeWs);
    const un2 = shell.workspaces?.list?.subscribe?.(recomputeWs);
    if (un1 || un2) {
      ctx.effect(() => () => { try { un1?.(); un2?.(); } catch { /* noop */ } }, 'dsh-trajectory: ws watchers');
    }
  } catch { /* polling fallback: Trigger/Drawer re-resolve on their own intervals */ }
  // belt-and-braces: re-resolve periodically in case feeds don't notify
  const wsTimer = setInterval(recomputeWs, 5000);
  ctx.effect(() => () => clearInterval(wsTimer), 'dsh-trajectory: ws timer');

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    // 入口固定排序:服务器 dashboard(10) → 学者(11) → 主线图(12)
    id: 'dsh-trajectory',
    order: 12,
    locale: NS,
  }, Trigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-trajectory-drawer',
    order: 110,
    locale: NS,
  }, Drawer));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-trajectory',
    // 设置分区公约(WORKBENCH-LAYOUT):服务器(100) → 学者(110) → 皮肤中心(120) → 主线图(130)
    order: 130,
    label: () => ctx.locale.bind(NS)('settings.nav'),
    locale: NS,
  }, TrajSettings));
}
