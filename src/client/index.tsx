import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { zh, en } from './locales';
import { PaperLibraryView } from './PaperLibraryView';
import { BookshelfView } from './BookshelfView';
import { GraphView } from './GraphView';
import { ScholarSettings } from './SettingsSection';
import { Icon, IconButton, Icons, SchStyles, T, Z } from './ui';
import { api } from './api';
import { navBus, useNav, type TabId, type TFunc } from './nav';
import { registerScholarRightbar } from './rightbar';

const NS = 'scholar';

/** Client services this plugin needs (merged into ctx by the runtime). */
export const inject = ['slots', 'locale'];

/* ---------- drawer open state (trigger button ⇄ right drawer) ---------- */
type PanelMode = 'open' | 'rail' | 'closed';
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
  const active = mode === 'open';
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
const DRAWER_MIN = 340;
const DRAWER_MAX = 680;
const DRAWER_DEFAULT = 440;

/** 官方右侧栏(0.1.5)是布局内占位而非 overlay:抽屉应让位于它,不能盖在它上面。
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

function clampW(w: number): number {  return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, w));
}

function Drawer({ t }: { t: TFunc }) {
  const mode = usePanelMode();
  const nav = useNav();
  const counts = useCounts();
  const [width, setWidth] = useState(DRAWER_DEFAULT);
  const [full, setFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const dragOrigin = useRef({ x: 0, w: DRAWER_DEFAULT });

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

  // 官方右侧栏是布局内占位(非 overlay):抽屉让位于它而不是盖在上面。
  // 右栏开关不发 dock-change,靠 1s 轻轮询跟随;关闭/浮出成窗时 inset=0。
  const [officialInset, setOfficialInset] = useState(() => officialRightInset());
  useEffect(() => {
    const read = () => setOfficialInset((cur) => {
      const next = officialRightInset();
      return cur === next ? cur : next;
    });
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-scholar': { open: mode !== 'closed', width: selfW } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change'));
  }, [mode, selfW]);
  useEffect(() => () => {
    const w = window as unknown as { __dshDock?: Record<string, { open: boolean; width: number }> };
    w.__dshDock = { ...(w.__dshDock ?? {}), 'dsh-scholar': { open: false, width: 0 } };
    window.dispatchEvent(new CustomEvent('dsh-dock-change'));
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
        <div data-dsh-plugin="dsh-scholar" data-dsh-surface="drawer" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: Z.drawer }}>
          {mode === 'rail' && (
            <div
              data-dsh-part="drawer-rail"
              style={{
                position: 'absolute', top: 'var(--dsh-desktop-titlebar-inset, 0px)', right: officialInset, bottom: 0, width: 34, pointerEvents: 'auto',
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
          {mode === 'open' && (
            <div
              className="sch-fade"
              data-dsh-part="drawer-panel"
              style={{
                position: 'absolute', top: 'var(--dsh-desktop-titlebar-inset, 0px)', right: officialInset, bottom: 0, width, pointerEvents: 'auto',
                ...(full ? { left: 0, width: '100vw' } : {}),
                display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)',
                backdropFilter: 'blur(16px) saturate(1.08)', WebkitBackdropFilter: 'blur(16px) saturate(1.08)',
                borderLeft: '1px solid var(--dsw-alias-border-l2)',
                boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))',
                color: 'var(--dsw-alias-label-primary)',
              }}
            >
              {/* resize handle */}
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
              {/* body = left icon rail + content column */}
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                {/* icon rail */}
                <nav style={{
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
                  <div className="sch-fade" key={nav.tab} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px', flex: 'none',
                  }}>
                    <span aria-hidden style={{
                      width: 4, alignSelf: 'stretch', borderRadius: 2, flex: 'none',
                      background: 'linear-gradient(180deg, var(--dsw-alias-state-business-primary, #4d6bfe), transparent)',
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '.015em' }}>
                      {tabs.find((x) => x.id === nav.tab)?.label}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', marginTop: 1 }}>
                      {nav.tab === 'papers' && counts.papers > 0 && t('paper.count', { count: counts.papers })}
                      {nav.tab === 'cards' && counts.cards > 0 && t('card.count', { count: counts.cards })}
                    </span>
                    <span style={{ flex: 1 }} />
                    <IconButton label={full ? t('drawer.restore') : t('drawer.expand')} active={full} onClick={() => setFull(!full)} icon={<Icon d={Icons.expand} size={15} />} />
                    <IconButton label={t('drawer.collapse')} onClick={() => { setFull(false); panelBus.set('rail'); }} icon={<Icon d={Icons.collapseRight} size={15} />} />
                    <IconButton label={t('drawer.close')} onClick={() => panelBus.set('closed')} icon={<Icon d={Icons.close} size={15} />} />
                  </div>
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
  // 官方右侧 Sidebar 页签(0.1.5+):旧宿主无该服务时静默跳过
  registerScholarRightbar(ctx);
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
