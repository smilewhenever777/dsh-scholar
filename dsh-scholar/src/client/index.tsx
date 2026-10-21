import { PanelHeader } from '../../../shared-client/src/Workbench';
import { PanelMenu } from '../../../shared-client/src/PanelMenu';
import { clampDockWidth, DOCK_TOP, bindDesktopServices, toggleOfficialSidebar, registerDockPanel, installDockLayout } from '../../../shared-client/src/desktop';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { zh, en } from './locales';
import { PaperLibraryView } from './PaperLibraryView';
import { ScholarReadEntry } from './DeepreadLauncher';
import { ReadProgressBanner } from './ReadProgressBanner';
import { BookshelfView } from './BookshelfView';
import { GraphView } from './GraphView';
import { ScholarSettings } from './SettingsSection';
import { Icon, IconButton, Icons, SchStyles, T, Z } from './ui';
import { api } from './api';
import { clampFloat } from '../../../shared-client/src/index';
import { navBus, useNav, type TabId, type TFunc } from './nav';
import { registerScholarRightbar } from './rightbar';
import { DocumentPreview, installDocumentPreview } from './DocumentPreview';

const NS = 'scholar';

/** Client services this plugin needs (merged into ctx by the runtime). */
export const inject = ['slots', 'locale'];

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

/* ---------- library stats for tab badges ---------- */
export interface ScholarCounts { papers: number; cards: number }
const statsBus = {
  counts: { papers: 0, cards: 0 } as ScholarCounts,
  listeners: new Set<() => void>(),
  getSnapshot: () => statsBus.counts,
  subscribe(listener: () => void) {
    statsBus.listeners.add(listener);
    return () => { statsBus.listeners.delete(listener); };
  },
  set(counts: ScholarCounts) {
    if (statsBus.counts.papers !== counts.papers || statsBus.counts.cards !== counts.cards) {
      statsBus.counts = counts;
      for (const l of statsBus.listeners) l();
    }
  },
};
function useCounts(): ScholarCounts {
  return useSyncExternalStore(statsBus.subscribe, statsBus.getSnapshot);
}

/* ---------- left sidebar trigger ---------- */
function Trigger({ t, wide }: { t: TFunc; wide?: boolean }) {
  const mode = usePanelMode();
  const counts = useCounts();
  const active = mode === 'open' || mode === 'float';
  const badge = counts.papers + counts.cards;
  return (
    <>
      <SchStyles />
      <button
        type="button"
        data-dsh-plugin="dsh-scholar"
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
          <Icon d={Icons.book} size={16} />
          {badge > 0 && (
            <span
              style={{
                position: 'absolute', top: -5, right: -8, minWidth: 13, height: 13, borderRadius: 999,
                padding: '0 3px', boxSizing: 'border-box',
                background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                color: '#fff', fontSize: 9, lineHeight: '13px', textAlign: 'center',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </span>
        {wide && <span>{t('nav.label')}</span>}
      </button>
    </>
  );
}

/* ---------- right-docked collapsible drawer (shell.overlay entry) ---------- */
const DRAWER_MIN = 300;
const DRAWER_MAX = 680;
const DRAWER_DEFAULT = 440;

/** 浮动窗口几何夹取:不越出视口、不小于可读下限 */

/** 官方右侧栏是布局内占位而非 overlay:抽屉应让位于它,不能盖在它上面。
 *  测法:直接扫描「右缘贴窗口右沿、高度>70%视口」的布局列,取最宽者的右缘缺口。
 *  (旧测法从输入框向上找列,在桌面端 0.1.7 首页布局下输入框祖先列高度不足半屏,
 *  恒返回 0,抽屉贴右盖住顶栏「打开右侧边栏」与官方右栏。)
 *  插件自己的面([data-dsh-plugin])排除;右栏收起成图标列(~34px)也算;
 *  宽度上限 60% 视口防止把主对话列误判成右栏。 */
function officialRightInset(): number {
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    let best = 0;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.closest('[data-dsh-plugin]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 28 || r.width > vw * 0.6 || r.height <= vh * 0.7) continue;
      if (Math.abs(vw - r.right) > 8 || r.x < vw * 0.4) continue;
      // 桌面端关闭右栏时面板盒子仍在原位、被主内容盖住——列内取点做命中测试,
      // 命中到列外说明视觉上不存在,跳过。取点左右各一点:右点会被我们自己的
      // 右舷抽屉盖住(自致盲),左点在抽屉左缘之外仍能命中列本体,任一命中即可见
      const py = Math.round(Math.min(r.top + r.height / 2, vh - 2));
      const probe = (px: number) => { const hit = document.elementFromPoint(px, py); return !!hit && (el.contains(hit) || hit.contains(el)); };
      if (!probe(Math.round(Math.min(vw - 2, r.right - Math.min(r.width / 2, 40)))) && !probe(Math.round(Math.min(vw - 2, r.x + Math.min(r.width / 2, 40))))) continue;
      best = Math.max(best, Math.round(vw - r.x));
    }
    return best;
  } catch {
    return 0;
  }
}

/** 找官方顶栏的「打开/收起右侧边栏」按钮(桌面端 DOM 里同时存在隐藏的
 *  收起钮停在屏外,只认可见的那颗)。贴右满高抽屉会盖住它,但 .click()
 *  不受遮挡影响,抽屉头部用这颗真按钮提供等价开关入口。 */
function findOfficialSidebarToggle(): HTMLButtonElement | null {
  try {
    const list = Array.from(document.querySelectorAll('button')).filter(b => {
      if (!/右侧边栏|right sidebar/i.test(b.getAttribute('aria-label') || '')) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.x >= 0 && r.x < window.innerWidth && getComputedStyle(b).visibility !== 'hidden';
    });
    // 优先收起钮:右栏开启时与屏外隐藏的打开钮共存,语义随实际状态走
    return list.find(b => /收起/.test(b.getAttribute('aria-label') || '')) ?? list[0] ?? null;
  } catch {
    return null;
  }
}
// 状态按测量判定:官方两颗开关钮的可见性/文案在桌面端语义不稳,但 inset>0 即右栏可见
function officialSidebarOpen(): boolean {
  return officialRightInset() > 0;
}



// 宽度上限按原生导航和对话最小宽度计算，不再强制预留 1100px。
function clampW(w: number): number { return clampDockWidth(w);
}

function Drawer({ t }: { t: TFunc }) {
  const mode = usePanelMode();
  const dockTop = DOCK_TOP;
  const nav = useNav();
  const counts = useCounts();
  const [width, setWidth] = useState(DRAWER_DEFAULT);
  const [full, setFull] = useState(false);

  useEffect(() => registerDockPanel('dsh-scholar', (mode) => panelBus.set(mode ?? 'rail'), 34), []);
  useEffect(() => installDockLayout(), []);
  const [dragging, setDragging] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const dragOrigin = useRef({ x: 0, w: DRAWER_DEFAULT });

  // 浮动窗口几何:fixed 定位 + 头部拖拽 + 角柄缩放,localStorage 记忆(与 dashboard 同款模板)
  const floatGeomRef = useRef({ x: 0, y: 0, w: 420, h: 560 });
  const [floatGeom, setFloatGeom] = useState(() => {
    const base = clampFloat({ x: window.innerWidth - 920, y: 100, w: 420, h: Math.min(560, window.innerHeight - 180) });
    try {
      const saved = JSON.parse(localStorage.getItem('sch-float-geom') ?? '');
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
  const saveFloatGeom = () => { try { localStorage.setItem('sch-float-geom', JSON.stringify(floatGeomRef.current)); } catch {} };
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

  // keep the tab badges fresh — only while the drawer is visible:
  // closed 不轮询;页面隐藏跳过本轮;连续失败退避 30s→60s→120s 封顶,成功即重置
  useEffect(() => {
    if (mode === 'closed') return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const BACKOFFS = [30000, 60000, 120000];
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(run, BACKOFFS[Math.min(failures, BACKOFFS.length - 1)]);
    };
    const run = () => {
      if (stopped) return;
      if (document.hidden) { schedule(); return; }
      void api<{ papers: number; cards: number }>('/scholar/stats')
        .then((s) => {
          if (stopped) return;
          statsBus.set({ papers: s.papers, cards: s.cards });
          failures = 0;
        })
        .catch(() => {
          if (!stopped) failures = Math.min(failures + 1, BACKOFFS.length - 1);
        })
        .finally(() => { if (!stopped) schedule(); });
    };
    run(); // 打开抽屉立即刷一次（侧栏 Trigger 徽标随之更新）
    const onVisibility = () => {
      if (!document.hidden && !stopped) {
        if (timer) clearTimeout(timer);
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode]);

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

  // publish our footprint so sibling right-docked panels (server dashboard)
  // can dock around us: [conversation | dashboard | scholar]
  // full 模式实际占满 100vw、rail 实际宽 34(见下方 rail 渲染),如实发布
  const selfW = mode === 'open' ? (full ? window.innerWidth : width) : mode === 'rail' ? 34 : 0;


  useEffect(() => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number; overlay?: boolean }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-scholar': { open: mode === 'open' || mode === 'rail', width: selfW, overlay: mode === 'open' && full } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change', { detail: { id: 'dsh-scholar' } }));
  }, [mode, selfW, full]);
  useEffect(() => () => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number; overlay?: boolean }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-scholar': { open: false, width: 0 } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change', { detail: { id: 'dsh-scholar' } }));
  }, []);

  const tabs: { id: TabId; label: string; icon: string; badge?: number }[] = [
    { id: 'papers', label: t('tab.papers'), icon: Icons.book, badge: counts.papers },
    { id: 'graph', label: t('tab.graph'), icon: Icons.graph },
    { id: 'cards', label: t('tab.cards'), icon: Icons.cards, badge: counts.cards },
  ];

  return (
    <>
      <SchStyles />
      {mode !== 'closed' && (
        <div data-dsh-plugin="dsh-scholar" data-dsh-surface="drawer" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: mode === 'float' ? 115 : Z.drawer }}>
          {mode === 'rail' && (
            <div
              data-dsh-part="drawer-rail"
              style={{
                position: 'absolute', top: dockTop, right: 0, bottom: 0, width: 34, pointerEvents: 'auto',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '10px 0',
                borderLeft: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
                backdropFilter: 'blur(16px) saturate(1.08)', WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
              }}
            >
              <IconButton
                label={t('nav.title')}
                onClick={() => panelBus.set('open')}
                icon={<Icon d={Icons.book} size={14} />}
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
              className="sch-fade dshwb-surface"
              data-dsh-part="drawer-panel"
              style={{
                ...(mode === 'float'
                  ? { position: 'fixed' as const, top: floatGeom.y, left: floatGeom.x, width: floatGeom.w, height: floatGeom.h, pointerEvents: 'auto' as const, zIndex: 2, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))', overflow: 'hidden' }
                  : { position: 'absolute' as const, top: dockTop, right: 0, bottom: 0, width, pointerEvents: 'auto' as const, ...(full ? { left: 0, width: '100vw' } : {}) }),
                display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)',
                backdropFilter: 'blur(16px) saturate(1.08)', WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
                borderLeft: '1px solid var(--dsw-alias-border-l2)',
                boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))',
                color: 'var(--dsw-alias-label-primary)',
              }}
            >
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
              {/* resize handle */}
              {mode !== 'float' && (
<div
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
              </div>
              )}

              {/* body = left icon rail + content column */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                {/* icon rail */}
                <nav className="dshwb-nav" style={{
                  width: 46, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  padding: '10px 0', borderRight: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                }}>
                  {tabs.map(({ id, icon }) => {
                    const active = nav.tab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        title={tabs.find((x) => x.id === id)?.label}
                        onClick={() => navBus.go(id)}
                        className="sch-press"
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
                        {/* badge */}
                        {(() => {
                          const b = tabs.find((x) => x.id === id)?.badge ?? 0;
                          if (!b) return null;
                          return (
                            <span style={{
                              position: 'absolute', top: -3, right: -3, minWidth: 14, height: 14, borderRadius: 999,
                              padding: '0 3px', boxSizing: 'border-box', background: active
                                ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
                                : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.35))',
                              color: '#fff', fontSize: 8.5, lineHeight: '14px', textAlign: 'center',
                              fontVariantNumeric: 'tabular-nums',
                            }}>{b > 99 ? '99+' : b}</span>
                          );
                        })()}
                      </button>
                    );
                  })}
                  <span style={{ flex: 1 }} />
                  {/* view counter caption */}
                  <span style={{ writingMode: 'vertical-rl', fontSize: 9.5, letterSpacing: 2.5, color: 'var(--dsw-alias-label-caption)', userSelect: 'none', paddingBottom: 6 }}>
                    {t('nav.title')}
                  </span>
                </nav>

                {/* content */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {/* content header: current view name + window controls */}
                  <PanelHeader icon={<Icon d={tabs.find(x => x.id === nav.tab)?.icon ?? Icons.book} size={15} />}
                    title={tabs.find(x => x.id === nav.tab)?.label ?? t('nav.title')} count={nav.tab === 'papers' && counts.papers > 0 ? counts.papers : nav.tab === 'cards' && counts.cards > 0 ? counts.cards : undefined}
                    onPointerDown={mode === 'float' ? onFloatDragDown : undefined}
                    onPointerMove={mode === 'float' ? onFloatDragMove : undefined}
                    onPointerUp={mode === 'float' ? onFloatDragUp : undefined}
                    style={{ cursor: mode === 'float' ? (floatMoving ? 'grabbing' : 'grab') : undefined, userSelect: floatMoving ? 'none' : undefined, touchAction: mode === 'float' ? 'none' : undefined }}
>
                      <PanelMenu label={t('drawer.more')} actions={[
                        ...(mode !== 'float' ? [
                          { label: t('drawer.officialSidebar'), run: toggleOfficialSidebar },
                          { label: full ? t('drawer.restore') : t('drawer.expand'), run: () => setFull(!full) },
                          { label: t('drawer.float'), run: () => { setFull(false); panelBus.set('float'); } },
                        ] : [{ label: t('drawer.dock'), run: () => { setFull(false); panelBus.set('open'); } }]),
                      ]} />
                      {mode !== 'float' && <IconButton label={t('drawer.collapse')} onClick={() => { setFull(false); panelBus.set('rail'); }} icon={<Icon d={Icons.collapseRight} size={15} />} />}
                      <IconButton label={t('drawer.close')} onClick={() => panelBus.set('closed')} icon={<Icon d={Icons.close} size={15} />} />

                  </PanelHeader>
                  {/* 后台精读实时进度（轮询 /scholar/read/status，完成广播刷新） */}
                  <ReadProgressBanner t={t} />
                  {/* views */}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {nav.tab === 'papers' && <PaperLibraryView t={t} />}
                    {nav.tab === 'graph' && <GraphView t={t} />}
                    {nav.tab === 'cards' && <BookshelfView t={t} />}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * apply-guard：client 工厂在同一页面可能被加载两次（新旧 bundle 混合加载），
 * 先 claim 者胜；fiber 卸载时释放旗标，支持热替换（dsh-web-ui 同款惯例）。
 */
const APPLY_FLAG = '__dshScholarApplied';

/** Client plugin entry. */
export function apply(ctx: any) {
  const g = globalThis as Record<string, unknown>;
  if (g[APPLY_FLAG]) return;
  g[APPLY_FLAG] = true;
  ctx.effect(() => () => { g[APPLY_FLAG] = false; }, 'dsh-scholar: apply guard');
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-scholar: dictionaries');
  // 跨插件深链(dsh-trajectory 等同族插件):CustomEvent 约定打开抽屉并定位论文/卡片
  const onDeepLink = (ev: Event) => {
    try {
      const d = (ev as CustomEvent<{ paperId?: string | null; cardId?: string | null }>).detail ?? {};
      panelBus.set('open');
      if (d.paperId) navBus.go('papers', d.paperId);
      else if (d.cardId) navBus.go('cards', null, d.cardId);
    } catch { /* defensive: deep link must never crash the shell */ }
  };
  window.addEventListener('dsh-scholar-nav', onDeepLink);
  ctx.effect(() => () => window.removeEventListener('dsh-scholar-nav', onDeepLink), 'dsh-scholar: deep-link listener');
  // 官方右侧 Sidebar 页签(0.1.5+):旧宿主无该服务时静默跳过
  registerScholarRightbar(ctx);
  bindDesktopServices(ctx);
  ctx.effect(installDocumentPreview, 'dsh-scholar: desktop document links');
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-scholar-document-preview', order: 120 }, DocumentPreview));
  // 对话输入框左侧 📚 精读入口（单/多篇精读任务面板）
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-scholar-read',
    order: 60,
    locale: NS,
  }, ScholarReadEntry));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-scholar',
    order: 11,
    locale: NS,
  }, Trigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-scholar-drawer',
    order: 90,
    locale: NS,
  }, Drawer));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-scholar',
    // 与 dsh-server-dashboard（100）错开：设置页固定「服务器 → 学者」，
    // 与侧栏入口顺序一致，不能两插件同为 10（顺序未定义）
    order: 110,
    label: () => ctx.locale.bind(NS)('settings.nav'),
    locale: NS,
  }, ScholarSettings));
}
