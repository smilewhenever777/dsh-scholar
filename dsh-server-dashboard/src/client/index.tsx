import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';
import { zh, en } from './locales';
import { DashboardPanel } from './DashboardPanel';
import { ServerDashboardSettings } from './SettingsSection';
import { Icon, IconButton, Icons, relTime } from './ui';
import { focusBus } from './focus';
import { TEMP_HOT, UTIL_SATURATED } from './thresholds';
import { registerDashboardRightbar, rightbarAvailable, openGpuInRightbar } from './rightbar';
import type { ServerSnapshot } from './types';

// 跨插件停靠让位协议的全局足迹表(与 dsh-scholar/dsh-trajectory 约定一致)
declare global {
	interface Window {
		__dshDock?: Record<string, { open: boolean; width: number }>;
	}
}



const Fragment = React.Fragment;
const jsx = React.createElement;
export const inject = ['slots', 'locale'];
const NS = 'serverDashboard';

/** Client services this plugin needs (merged into ctx by the runtime). */

interface SnapshotResponse {
  hosts: { id: string; name: string; pinned: boolean; archived?: boolean }[];
  snapshots: Record<string, ServerSnapshot>;
  refreshIntervalS?: number;
  staleMinutes?: number;
}

/* ---------- shared panel open state (trigger button ⇄ right drawer) ---------- */
type PanelMode = 'open' | 'rail' | 'closed' | 'float';
// exported for rightbar.tsx(「打开完整看板」唤起抽屉);ESM 循环引用安全:点击时才解引用
export const panelBus = {
  mode: 'closed' as PanelMode,
  listeners: new Set<() => void>(),
  getSnapshot(): PanelMode {
    return panelBus.mode;
  },
  subscribe(listener: () => void) {
    panelBus.listeners.add(listener);
    return () => {
      panelBus.listeners.delete(listener);
    };
  },
  set(next: PanelMode) {
    if (panelBus.mode !== next) {
      panelBus.mode = next;
      for (const listener of panelBus.listeners) listener();
    }
  },
};
function usePanelMode(): PanelMode {
  return useSyncExternalStore(panelBus.subscribe, panelBus.getSnapshot);
}

/* ---------- aggregate anomaly status (poll writes, sidebar badge reads) ---------- */
interface DashStatus {
  hosts: number;
  offline: number;
  hot: number;
  stalled: number;
}
const statusBus = {
  state: { hosts: 0, offline: 0, hot: 0, stalled: 0 } as DashStatus,
  listeners: new Set<() => void>(),
  getSnapshot(): DashStatus {
    return statusBus.state;
  },
  subscribe(listener: () => void) {
    statusBus.listeners.add(listener);
    return () => {
      statusBus.listeners.delete(listener);
    };
  },
  set(next: DashStatus) {
    const cur = statusBus.state;
    if (next.hosts !== cur.hosts || next.offline !== cur.offline || next.hot !== cur.hot || next.stalled !== cur.stalled) {
      statusBus.state = next;
      for (const listener of statusBus.listeners) listener();
    }
  },
};
function useDashStatus(): DashStatus {
  return useSyncExternalStore(statusBus.subscribe, statusBus.getSnapshot);
}

/** per-host staleness ledger: last log mtime/size + notified flag (module-local so it survives re-renders) */
interface StaleState {
  mtimeMs: number;
  size: number;
  notified: boolean;
}
const staleLedger = new Map<string, StaleState>();

/** OS-level notification — the only channel that reaches the user when the DSH
 *  window is minimized/backgrounded (industry consensus: never rely on the tab
 *  being visible). Permission is requested on first drawer open (a click). */
function notifyOS(body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden) return; // visible tab already gets the in-app toast
    const n = new Notification('服务器看板', { body, tag: 'dsh-dash-' + Date.now(), silent: false } as NotificationOptions & { tag: string });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* Notification ctor can throw on some platforms — never break polling */ }
}

/** session-scoped alert history for the bell dropdown (capped, newest first) */
interface AlertCenterEntry {
  id: number;
  at: number;
  kind: 'crash' | 'offline' | 'hot' | 'stall';
  hostId: string;
  hostName: string;
  gpuIndex?: number;
  min?: number;
}
const alertCenter = {
  items: [] as AlertCenterEntry[],
  seq: 0,
  listeners: new Set<() => void>(),
  push(e: Omit<AlertCenterEntry, 'id'>) {
    alertCenter.items.unshift({ ...e, id: ++alertCenter.seq });
    if (alertCenter.items.length > 30) alertCenter.items.length = 30;
    for (const l of [...alertCenter.listeners]) l();
  },
  clear() {
    alertCenter.items = [];
    for (const l of [...alertCenter.listeners]) l();
  },
};
/** stallNotice keys already toasted (`hostId@at`) — a notice may ride several
 *  cached responses while the host is in backoff; toast it exactly once */
const notifiedNotices = new Set<string>();

/**
 * Degraded-frame guard: when one SSH command stream dies mid-poll (`free -m`
 * losing its output is the reliable tell → memTotal parses as 0), don't let
 * that frame wipe the panel with fake zeros — fall back to the previous good
 * base/log/series for the affected host. Only provably-blanked fields are
 * restored; everything genuinely fresh (timestamps, processes) stays.
 */
function mergeDegradedFrame(
  body: SnapshotResponse,
  prev: SnapshotResponse | null | undefined,
): SnapshotResponse {
  if (!prev) return body;
  let touched = false;
  const merged: SnapshotResponse = { ...body, snapshots: { ...body.snapshots } };
  for (const [id, cur] of Object.entries(body.snapshots)) {
    if (!cur?.ok || !cur.base) continue;
    if (!(cur.base.memTotalMiB === 0 && cur.base.memUsedMiB === 0)) continue;
    const old = prev.snapshots[id];
    if (!old?.ok || !old.base || !(old.base.memTotalMiB > 0)) continue;
    merged.snapshots[id] = {
      ...cur,
      base: {
        ...cur.base,
        memUsedMiB: old.base.memUsedMiB,
        memTotalMiB: old.base.memTotalMiB,
        cpuPercent: cur.base.cpuPercent > 0 ? cur.base.cpuPercent : old.base.cpuPercent,
        disks: cur.base.disks.length > 0 ? cur.base.disks : old.base.disks,
        load1: cur.base.load1 ?? old.base.load1,
      },
      log: cur.log && cur.log.lines.length > 0 ? cur.log : old.log ?? cur.log,
      series: cur.series && cur.series.length > 0 ? cur.series : old.series,
      // nvidia-smi 流整帧死掉时 cur.gpus 为空——直接回退上一帧 GPU 网格,
      // 否则面板 GPU 卡片会闪烁消失
      gpus: cur.gpus && cur.gpus.length > 0
        ? cur.gpus.map((g, i) => {
          const og = old.gpus?.[i];
          if (!og) return g;
          return {
            ...g,
            log: g.log ?? og.log,
            series: g.series && g.series.length > 0 ? g.series : og.series,
            processes: g.processes.length > 0 ? g.processes : og.processes,
          };
        })
        : old.gpus,
    };
    touched = true;
  }
  return touched ? merged : body;
}

type TFunc = (key: string, params?: Record<string, unknown>) => string;

interface DashToast {
  id: number;
  hostId: string;
  hostName: string;
  minutes: number;
  /** GPU index when a per-GPU experiment stalled; undefined = host-level log */
  gpuIndex?: number;
  /** SSE instant alert text — when present it replaces the stale template */
  text?: string;
}

/** 同屏 toast 上限:超出挤掉最旧,告警风暴不盖住整个界面 */
const TOAST_MAX = 3;

function useDashboard(t: TFunc) {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hostError, setHostError] = useState(false);
  const [toasts, setToasts] = useState<DashToast[]>([]);
  const [lastFetchAt, setLastFetchAt] = useState(0);
  const mountedRef = useRef(true);
  const toastSeq = useRef(0);
  const prevBody = useRef<SnapshotResponse | null>(null);
  /** toast 自动消失计时器:dismiss/挤掉/卸载时都要清,防止打已卸载组件 */
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // 长轮询循环的闭包只建一次,词典函数必须经 ref 取最新值(语言切换后生效)
  const tRef = useRef(t);
  tRef.current = t;

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    if (mountedRef.current) setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  /** 追加 toast:封顶 TOAST_MAX(挤掉最旧)并登记自动消失计时器 */
  const pushToasts = useCallback((add: DashToast[]) => {
    if (add.length === 0) return;
    setToasts((cur) => {
      const next = [...cur, ...add].slice(-TOAST_MAX);
      // 被挤掉的旧 toast 顺手清掉计时器(clearTimeout/delete 均幂等,StrictMode 重放安全)
      for (const x of cur) {
        if (!next.includes(x)) {
          const timer = toastTimers.current.get(x.id);
          if (timer) {
            clearTimeout(timer);
            toastTimers.current.delete(x.id);
          }
        }
      }
      return next;
    });
    for (const toast of add) {
      const timer = setTimeout(() => {
        toastTimers.current.delete(toast.id);
        if (mountedRef.current) setToasts((cur) => cur.filter((x) => x.id !== toast.id));
      }, 12000);
      toastTimers.current.set(toast.id, timer);
    }
  }, []);

  // 卸载(含热替换)时清掉全部 toast 计时器
  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) clearTimeout(timer);
    toastTimers.current.clear();
  }, []);

  // force=true bypasses the host-side failure backoff (manual refresh button);
  // hostId narrows it to one host (the offline card's retry button)
  const fetchingRef = useRef(false);
  const refresh = useCallback(async (force = false, hostId?: string) => {
    if (fetchingRef.current) return; // in-flight poll: never overlap (stale-response races)
    fetchingRef.current = true;
    setRefreshing(true);
    const qs = force ? (hostId ? `?force=1&host=${encodeURIComponent(hostId)}` : '?force=1') : '';
    try {
      // 30s 硬超时:半死连接不许挂住面板(旧实现 fetch 无超时)
      const res = await fetch(`/dash/snapshots${qs}`, {
        headers: { accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as SnapshotResponse;
      // degraded-frame guard BEFORE anything consumes the data
      const body = mergeDegradedFrame(raw, prevBody.current);
      prevBody.current = body;
      if (mountedRef.current) {
        setData(body);
        setHostError(false);
        setLastFetchAt(Date.now());
      }
      // experiment-finished detection: log mtime/size unchanged for staleMinutes —
      // both the host-level log and each GPU's own log
      const staleMs = (body.staleMinutes ?? 10) * 60_000;
      const now = Date.now();
      const nextToasts: DashToast[] = [];
      const liveKeys = new Set<string>();
      const checkStale = (key: string, hostId2: string, hostName: string, gpuIndex: number | undefined, log: { mtimeMs: number; size: number; fresh?: boolean }) => {
        liveKeys.add(key);
        const prev = staleLedger.get(key);
        if (prev && log.mtimeMs === prev.mtimeMs && log.size === prev.size) {
          // F23/R13:宿主盖章 fresh 优先;未盖章回退旧启发式
          const toastStale = log.fresh === false || (log.fresh === undefined && now - log.mtimeMs >= staleMs);
          if (!prev.notified && toastStale) {
            prev.notified = true;
            // toast 里的"已 N 分钟"用实际 now−mtime,而非配置阈值本身
            nextToasts.push({ id: ++toastSeq.current, hostId: hostId2, hostName, minutes: Math.max(1, Math.round((now - log.mtimeMs) / 60_000)), gpuIndex });
          }
        } else {
          staleLedger.set(key, { mtimeMs: log.mtimeMs, size: log.size, notified: false });
        }
      };
      for (const host of body.hosts) {
        const s = body.snapshots[host.id];
        if (!s || !s.ok) continue;
        if (s.log && s.log.mtimeMs > 0) checkStale(`h:${host.id}`, host.id, host.name, undefined, s.log);
        for (const g of s.gpus ?? []) {
          if (g.log && g.log.mtimeMs > 0) checkStale(`h:${host.id}:g${g.index}`, host.id, host.name, g.index, g.log);
        }
        // one-shot host notice: the host auto-cleared a stalled log this poll
        if (s.stallNotice) {
          const key = `${host.id}@${s.stallNotice.at}`;
          if (!notifiedNotices.has(key)) {
            notifiedNotices.add(key);
            if (notifiedNotices.size > 40) {
              for (const k of [...notifiedNotices.keys()].slice(0, 20)) notifiedNotices.delete(k);
            }
            nextToasts.push({ id: ++toastSeq.current, hostId: host.id, hostName: host.name, minutes: s.stallNotice.minutes });
          }
        }
      }
      for (const key of [...staleLedger.keys()]) {
        if (!liveKeys.has(key)) staleLedger.delete(key); // host removed / log gone
      }
      if (nextToasts.length) pushToasts(nextToasts);
      // aggregate anomaly status for the sidebar badge
      const status: DashStatus = { hosts: body.hosts.length, offline: 0, hot: 0, stalled: 0 };
      for (const host of body.hosts) {
        const s = body.snapshots[host.id];
        if (!s || !s.ok) {
          status.offline++;
          continue;
        }
        for (const g of s.gpus ?? []) {
          if (g.tempC >= TEMP_HOT || g.utilPercent >= UTIL_SATURATED) status.hot++;
          if (g.log && g.log.mtimeMs > 0 && (g.log.fresh === false || (g.log.fresh === undefined && now - g.log.mtimeMs >= staleMs))) status.stalled++;
        }
      }
      statusBus.set(status);
    } catch {
      if (mountedRef.current) setHostError(true); // keep last data; header shows the offline banner
    } finally {
      fetchingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // instant alerts: long-poll /dash/events (hanging GET, 25s idle timeout).
    // (Browser fetch cannot send an Upgrade header, so raw SSE is unreachable.)
    // since=0 首连只建立游标基线(服务端不下发历史事件),此后按 last 递增——
    // 页面刷新/宿主重启不会重放几小时前的旧告警(P1-15 客户端侧)。
    const sinceRef = { current: 0 };
    let stopped = false; // effect 已卸载
    let looping = false; // 单循环守卫(visibilitychange 恢复时防双循环)
    let failures = 0; // 连续失败数 → 指数退避
    let inFlight: AbortController | null = null; // 隐藏/卸载时立即掐断挂起的 GET
    let wake: (() => void) | null = null; // 提前打断重试等待

    const onEvents = (events: any[]) => {
      for (const msg of events) {
        if (!mountedRef.current) continue;
        if (msg?.type === 'stall') {
          pushToasts([{ id: ++toastSeq.current, hostId: msg.hostId, hostName: msg.hostName, minutes: msg.minutes ?? 10 }]);
          notifyOS(`${msg.hostName}: ${tRef.current('log.stale', { minutes: msg.minutes ?? 10 })}`);
          alertCenter.push({ at: Date.now(), kind: 'stall', hostId: msg.hostId, hostName: msg.hostName, min: msg.minutes ?? 10 });
        } else if (msg?.type === 'gpu-crash') {
          pushToasts([{ id: ++toastSeq.current, hostId: msg.hostId, hostName: msg.hostName, minutes: msg.minutes ?? 5, gpuIndex: msg.gpuIndex, text: `${msg.hostName} · GPU${msg.gpuIndex}: ${tRef.current('alert.crash', { min: msg.minutes ?? 5 })}` }]);
          notifyOS(`${msg.hostName} · GPU${msg.gpuIndex}: ${tRef.current('alert.crash', { min: msg.minutes ?? 5 })}`);
          alertCenter.push({ at: Date.now(), kind: 'crash', hostId: msg.hostId, hostName: msg.hostName, gpuIndex: msg.gpuIndex, min: msg.minutes ?? 5 });
        } else if (msg?.type === 'host-status' && msg.level !== 'ok') {
          const key = msg.level === 'offline' ? 'panel.sse.offline' : 'panel.sse.hot';
          pushToasts([{ id: ++toastSeq.current, hostId: msg.hostId, hostName: msg.hostName, minutes: 0, text: `${msg.hostName}: ${tRef.current(key)}` }]);
          notifyOS(`${msg.hostName}: ${tRef.current(key)}`);
          alertCenter.push({ at: Date.now(), kind: msg.level === 'offline' ? 'offline' : 'hot', hostId: msg.hostId, hostName: msg.hostName });
        }
      }
    };

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const id = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(id); wake = null; resolve(); };
    });

    const runLoop = async () => {
      if (looping) return;
      looping = true;
      try {
        // tab 隐藏时切换为 60s 低频轮询而不是完全退出:OS 通知
        // (notifyOS) 恰恰只在 hidden 时才发,彻底退出会让系统通知死路;
        // 低频仍保持偶发等待者,host watcher 间歇采样,SSH 密度可控
        while (!stopped) {
          const hidden = document.visibilityState === 'hidden';
          if (hidden) await sleep(60_000);
          if (stopped) break;
          const ac = new AbortController();
          inFlight = ac;
          // 30s 硬上限兜底宿主 25s 空闲超时,半死连接挂不住循环
          const hardStop = setTimeout(() => ac.abort(), 30_000);
          try {
            const res = await fetch(`/dash/events?since=${sinceRef.current}`, { headers: { accept: 'application/json' }, signal: ac.signal });
            if (!res.ok) throw new Error('http');
            const body = await res.json();
            sinceRef.current = body.last ?? sinceRef.current;
            onEvents(body.events ?? []);
            failures = 0; // 成功即重置退避
          } catch {
            if (stopped) break;
            // 隐藏期失败:等下一轮低频周期,不做快速重试(省资源)
            if ((document.visibilityState as string) === 'hidden') continue;
            failures++;
            // 指数退避 3s→6s→…封顶 30s,+0~1s 随机抖动防齐步重连
            await sleep(Math.min(30_000, 3_000 * 2 ** (failures - 1)) + Math.floor(Math.random() * 1000));
          } finally {
            clearTimeout(hardStop);
            if (inFlight === ac) inFlight = null;
          }
        }
      } finally {
        looping = false;
      }
    };

    // tab 可见性联动:隐藏→abort 在途请求并让循环条件退出;可见→立即恢复
    const onVisibility = () => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        inFlight?.abort();
        wake?.();
      } else {
        wake?.(); // 提前结束退避等待,让既有循环立刻续跑
        void runLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void runLoop();

    // P1-14: cleanup 复位挂载标记 + abort 在途 fetch,杜绝热替换后双循环、
    // 事件双份 toast、setToasts 打已卸载组件
    return () => {
      stopped = true;
      mountedRef.current = false;
      inFlight?.abort();
      wake?.();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
return {
		data,
		refreshing,
		refresh,
		toasts,
		hostError,
		lastFetchAt,
		dismissToast
	};
}
function useAnomalySummary(t: TFunc) {
	const status = useDashStatus();
	const anomalies = status.offline + status.hot + status.stalled;
	return {
		title: anomalies > 0 ? [
			status.offline ? t("nav.sumOffline", { count: status.offline }) : "",
			status.hot ? t("nav.sumHot", { count: status.hot }) : "",
			status.stalled ? t("nav.sumStalled", { count: status.stalled }) : ""
		].filter(Boolean).join(" · ") : status.hosts > 0 ? t("nav.sumOk") : void 0,
		anomalies,
		hosts: status.hosts
	};
}
function StatusGlyph({ t }: { t: TFunc }) {
	const { anomalies, hosts } = useAnomalySummary(t);
	const color = anomalies > 0 ? "var(--dsw-alias-state-warn-primary, #f5a524)" : "var(--dsw-alias-state-success-primary, #30a46c)";
	return /* @__PURE__ */ (0, React.createElement)("span", {
		"aria-hidden": true,
		style: {
			position: "relative",
			display: "inline-flex"
		},
		children: [/* @__PURE__ */ (0, React.createElement)(Icon, {
			d: Icons.monitor,
			size: 16
		}), hosts > 0 && /* @__PURE__ */ (0, React.createElement)("span", { style: {
			position: "absolute",
			top: -2,
			right: -5,
			width: 8,
			height: 8,
			borderRadius: 8,
			background: color,
			border: "1.5px solid var(--dsw-alias-bg-base)",
			boxShadow: "var(--dsw-shadow-lv1, 0 1px 3px rgba(0,0,0,.2))",
			animation: anomalies > 0 ? "dsh-dash-pulse 2.4s ease-out infinite" : void 0
		} })]
	});
}
function Trigger({ t, wide }: { t: TFunc; wide?: boolean }) {
	const mode = usePanelMode();
	const { title } = useAnomalySummary(t);
	const active = mode === "open" || mode === "float";
	return /* @__PURE__ */ (0, React.createElement)("button", {
		type: "button",
		"data-dsh-plugin": "dsh-server-dashboard",
		"data-dsh-part": "sidebar-entry",
		onClick: () => panelBus.set(active ? "closed" : "open"),
		title: title ? `${t("nav.title")} — ${title}` : t("nav.title"),
		style: {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			height: 28,
			background: active ? "color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent)" : "none",
			border: 0,
			cursor: "pointer",
			color: active ? "var(--dsw-alias-state-business-primary, #4d6bfe)" : "var(--dsw-alias-label-secondary)",
			padding: "0 7px",
			borderRadius: 8,
			fontSize: 12,
			width: wide ? void 0 : "auto",
			boxShadow: active ? "inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 35%, transparent)" : "none",
			transition: "background .12s ease, color .12s ease"
		},
		onMouseEnter: (e) => {
			if (!active) e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
		},
		onMouseLeave: (e) => {
			if (!active) e.currentTarget.style.background = "none";
		},
		children: [/* @__PURE__ */ (0, React.createElement)(StatusGlyph, { t }), wide && /* @__PURE__ */ (0, React.createElement)("span", { children: t("nav.label") })]
	});
}
const DRAWER_MIN = 300;
const DRAWER_MAX = 520;
const DRAWER_DEFAULT = 360;
/** 浮动窗口几何夹取:不越出视口、不小于可读下限 */
function clampFloat(g: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
	const vw = window.innerWidth, vh = window.innerHeight;
	return {
		x: Math.max(8, Math.min(g.x, vw - 80)),
		y: Math.max(8, Math.min(g.y, vh - 60)),
		w: Math.max(300, Math.min(g.w, vw - 16)),
		h: Math.max(220, Math.min(g.h, vh - 16)),
	};
}
/** collapsed-rail width, published so sibling panels can dock around us */
const RAIL_W = 32;
function publishDock(id: string, fp: { open: boolean; width: number }) {
	const w = window;
	w.__dshDock = {
		...w.__dshDock ?? {},
		[id]: fp
	};
	window.dispatchEvent(new CustomEvent("dsh-dock-change"));
}
function outerFootprint(selfId: string) {
	const w = window;
	// 让位宽度 = 所有非 self 且 open 的足迹之和(三面板同开时依次让位,不重叠)
	let open = false;
	let width = 0;
	for (const [id, fp] of Object.entries(w.__dshDock ?? {})) {
		if (id === selfId) continue;
		if (fp?.open) {
			open = true;
			width += fp?.width ?? 0;
		}
	}
	return { open, width };
}
/** 官方右侧栏(0.1.5)是布局内占位而非 overlay:抽屉应让位于它,不能盖在它上面。
 *  测法:从聊天输入框向上找第一棵「右缘离窗口右沿 ≥16px 且高度过半屏」的列,
 *  其右缘缺口即右侧栏宽度;右栏关闭或浮出成窗(浮窗不占布局位)时列级祖先都贴满
 *  宽度 → 返回 0。16px 阈值同时排除窗口滚动条宽度。 */
function officialRightInset(): number {
	try {
		const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
		if (!input) return 0;
		let el = input.parentElement;
		const vw = window.innerWidth;
		while (el && el !== document.body) {
			const r = el.getBoundingClientRect();
			if (r.height > window.innerHeight * .5 && vw - r.right >= 16) return Math.round(vw - r.right);
			el = el.parentElement;
		}
		return 0;
	} catch {
		return 0;
	}
}
/** clamp with a RELATIVE cap: the drawer must never swallow a narrow window —
*  at most 60% of the viewport, and never past the absolute max. 窄窗(<500px)
*  时 60% 上限优先于绝对最小宽,抽屉不会吞掉整个窗口 */
function clampW(w: number): number {
	const relative = typeof window === "undefined" ? DRAWER_MAX : Math.floor(window.innerWidth * .6);
	const min = Math.min(DRAWER_MIN, relative);
	return Math.max(min, Math.min(Math.max(min, Math.min(DRAWER_MAX, relative)), w));
}
function Drawer({ t }: { t: TFunc }) {
	const mode = usePanelMode();
	const { data, refreshing, refresh, toasts, hostError, lastFetchAt, dismissToast } = useDashboard(t);
	const desiredW = React.useRef((() => {
		const saved = Number(localStorage.getItem("dsh-dash-drawer-w"));
		return Number.isFinite(saved) && saved > 0 ? saved : DRAWER_DEFAULT;
	})());
	const [width, setWidth] = React.useState(() => clampW(desiredW.current));
	const [dragging, setDragging] = React.useState(false);
	const [handleHover, setHandleHover] = React.useState(false);
	const [dashFull, setDashFull] = React.useState(false);
	// 浮动窗口几何:fixed 定位 + 头部拖拽 + 角柄缩放,localStorage 记忆
	const FLOAT_MIN_W = 300, FLOAT_MIN_H = 220; // referenced by clampFloat below
	const floatGeomRef = React.useRef({ x: 0, y: 0, w: 380, h: 520 });
	const [floatGeom, setFloatGeom] = React.useState(() => {
		const base = clampFloat({ x: window.innerWidth - 400, y: 80, w: 380, h: Math.min(560, window.innerHeight - 160) });
		try {
			const saved = JSON.parse(localStorage.getItem("dsh-dash-float-geom") ?? "");
			if (saved && [saved.x, saved.y, saved.w, saved.h].every((v) => Number.isFinite(v))) return clampFloat(saved);
		} catch {}
		return base;
	});
	React.useEffect(() => { floatGeomRef.current = floatGeom; }, [floatGeom]);
	React.useEffect(() => {
		const onResize = () => setFloatGeom((g) => clampFloat(g));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	const [floatMoving, setFloatMoving] = React.useState(false);
	const floatOrigin = React.useRef({ x: 0, y: 0, g: { x: 0, y: 0, w: 0, h: 0 } });
	const saveFloatGeom = () => {
		try { localStorage.setItem("dsh-dash-float-geom", JSON.stringify(floatGeomRef.current)); } catch {}
	};
	// 头部拖拽(buttons 除外——命中按钮时不启动拖动)
	const onFloatDragDown = React.useCallback((e: React.PointerEvent<Element>) => {
		if ((e.target as HTMLElement).closest?.("button")) return;
		setFloatMoving(true);
		floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
	}, []);
	const onFloatDragMove = React.useCallback((e: React.PointerEvent<Element>) => {
		if (!floatMoving) return;
		const o = floatOrigin.current;
		const next = clampFloat({ ...o.g, x: o.g.x + (e.clientX - o.x), y: o.g.y + (e.clientY - o.y) });
		floatGeomRef.current = next; // 同步写 ref:pointerup 立即持久化时不等 effect
		setFloatGeom(next);
	}, [floatMoving]);
	const onFloatDragUp = React.useCallback(() => {
		if (!floatMoving) return;
		setFloatMoving(false);
		saveFloatGeom();
	}, [floatMoving]);
	// 右下角缩放
	const onFloatResizeDown = React.useCallback((e: React.PointerEvent<Element>) => {
		setFloatMoving(true);
		floatOrigin.current = { x: e.clientX, y: e.clientY, g: floatGeomRef.current };
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
	}, []);
	const onFloatResizeMove = React.useCallback((e: React.PointerEvent<Element>) => {
		if (!floatMoving) return;
		const o = floatOrigin.current;
		const next = clampFloat({ ...o.g, w: o.g.w + (e.clientX - o.x), h: o.g.h + (e.clientY - o.y) });
		floatGeomRef.current = next;
		setFloatGeom(next);
	}, [floatMoving]);
	const dragOrigin = React.useRef({
		x: 0,
		w: DRAWER_DEFAULT
	});
	React.useEffect(() => {
		if (mode === "open" || mode === "float") refresh();
	}, [mode, refresh]);
	// P0-1 自动轮询:面板打开期间按 refreshIntervalS 周期刷新——倒计时归零即拉取,
	// 不再是"手动刷新面板"。refreshIntervalS 随 config 异步到达,依赖数组保证
	// interval 随其变化重建;手动刷新会更新 lastFetchAt,RefreshCountdown 以其
	// 为数据源,倒计时自然重置。关闭(rail/closed)/卸载即清理。
	React.useEffect(() => {
		if ((mode !== "open" && mode !== "float") || !data?.refreshIntervalS || data.refreshIntervalS < 1) return;
		const id = setInterval(() => {
			void refresh();
		}, data.refreshIntervalS * 1000);
		return () => clearInterval(id);
	}, [mode, data?.refreshIntervalS, refresh]);
	const onHandleDown = React.useCallback((e: React.PointerEvent<Element>) => {
		setDragging(true);
		dragOrigin.current = {
			x: e.clientX,
			w: width
		};
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
	}, [width]);
	const onHandleMove = React.useCallback((e: React.PointerEvent<Element>) => {
		if (!dragging) return;
		const next = clampW(dragOrigin.current.w + (dragOrigin.current.x - e.clientX));
		desiredW.current = next;
		setWidth(next);
	}, [dragging]);
	const onHandleUp = React.useCallback(() => {
		setDragging(false);
		try {
			localStorage.setItem("dsh-dash-drawer-w", String(desiredW.current));
		} catch {}
	}, []);
	React.useEffect(() => {
		const onResize = () => setWidth(clampW(desiredW.current));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	const at = useLatestAt(data);
	/** right offset = outer panel's (scholar's) current footprint */
	const [outerW, setOuterW] = React.useState(() => outerFootprint("server-dashboard").open ? outerFootprint("server-dashboard").width : 0);
	React.useEffect(() => {
		const read = () => {
			const fp = outerFootprint("server-dashboard");
			setOuterW(fp.open ? fp.width : 0);
		};
		read();
		window.addEventListener("dsh-dock-change", read);
		window.addEventListener("resize", read);
		return () => {
			window.removeEventListener("dsh-dock-change", read);
			window.removeEventListener("resize", read);
		};
	}, []);
	// 官方右侧栏占位宽(打开时让位;右栏开关不发 dock-change,靠 1s 轻轮询跟随)
	const [officialInset, setOfficialInset] = React.useState(() => officialRightInset());
	React.useEffect(() => {
		const read = () => setOfficialInset((cur) => {
			const next = officialRightInset();
			return cur === next ? cur : next;
		});
		const timer = setInterval(read, 1000);
		return () => clearInterval(timer);
	}, []);
	// 挤压判定:右侧堆叠(官方右栏 + 内侧面板)把可用宽吃光 → 抽屉/rail 改锚左缘保可见
	const squeezed = !dashFull && window.innerWidth - outerW - officialInset < DRAWER_MIN;
	const selfW = mode === "open" ? width : mode === "rail" ? RAIL_W : 0;
	React.useEffect(() => {
		// 拖宽期间不逐帧广播 dock-change(事件风暴会联动其他面板重排),
		// pointerup 后 dragging 翻回 false 时发布一次最终宽度
		if (dragging) return;
		// float 态退出右舷停靠链(让其他面板收回空间)
		publishDock("server-dashboard", {
			open: mode === "open" || mode === "rail",
			width: selfW
		});
	}, [mode, selfW, dragging]);
	React.useEffect(() => () => publishDock("server-dashboard", {
		open: false,
		width: 0
	}), []);
	React.useEffect(() => {
		const onResize = () => {
			// 让位收缩只改渲染宽度:desiredW 始终保留用户拖拽结果,
			// 外部面板(outerW)/官方右侧栏(officialInset)打开时收缩到可用宽度,
			// 关闭归零时恢复 desiredW,不再"只缩不涨"(原实现单调收缩)
			const avail = window.innerWidth - outerW - officialInset - 280;
			setWidth(clampW(Math.min(desiredW.current, Math.max(avail, 0))));
		};
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [outerW, officialInset]);
	return /* @__PURE__ */ (0, React.createElement)(Fragment, { children: [mode !== "closed" && /* @__PURE__ */ (0, React.createElement)("div", {
		"data-dsh-plugin": "dsh-server-dashboard",
		"data-dsh-surface": "drawer",
		style: {
			position: "absolute",
			inset: 0,
			pointerEvents: "none",
			// float 态提层到 115:必须压过全部右舷抽屉(scholar 90/trajectory 110),
			// 仍低于宿主模态(200)。wrapper 是 stacking context,子元素 z 只在层内生效
			zIndex: mode === "float" ? 115 : 70
		},
		children: [mode === "rail" && /* @__PURE__ */ (0, React.createElement)("div", {
			"data-dsh-part": "drawer-rail",
			style: {
				position: "absolute",
					top: "var(--dsh-desktop-titlebar-inset, 0px)",
					...(squeezed ? { left: 0, right: "auto" } : { right: outerW + officialInset }),
					bottom: 0,
					width: 32,
				pointerEvents: "auto",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 2,
				padding: "10px 0",
				borderLeft: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-base)",
				backdropFilter: "blur(16px) saturate(1.08)"
			},
			children: [
				/* @__PURE__ */ (0, React.createElement)(IconButton, {
					label: t("nav.title"),
					onClick: () => panelBus.set("open"),
					icon: /* @__PURE__ */ (0, React.createElement)(StatusGlyph, { t })
				}),
				/* @__PURE__ */ (0, React.createElement)("span", {
					style: {
						writingMode: "vertical-rl",
						fontSize: 10.5,
						color: "var(--dsw-alias-label-caption)",
						userSelect: "none",
						letterSpacing: 3,
						padding: "6px 0"
					},
					children: t("nav.title")
				}),
				/* @__PURE__ */ (0, React.createElement)("span", { style: { flex: 1 } }),
				/* @__PURE__ */ (0, React.createElement)(IconButton, {
					label: t("drawer.close"),
					onClick: () => panelBus.set("closed"),
					size: 22,
					icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
						d: Icons.close,
						size: 13
					})
				})
			]
			}), (mode === "open" || mode === "float") && /* @__PURE__ */ (0, React.createElement)("div", {
				"data-dsh-part": "drawer-panel",
				style: mode === "float" ? {
					position: "fixed",
					left: floatGeom.x,
					top: floatGeom.y,
					width: floatGeom.w,
					height: floatGeom.h,
					zIndex: 2,
					borderRadius: 12,
					border: "1px solid var(--dsw-alias-border-l2)",
					boxShadow: "var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))",
					overflow: "hidden",
					pointerEvents: "auto",
					display: "flex",
					flexDirection: "column",
					background: "var(--dsw-alias-bg-base)",
					backdropFilter: "blur(16px) saturate(1.08)",
					color: "var(--dsw-alias-label-primary)"
				} : {
					position: "absolute",
					top: "var(--dsh-desktop-titlebar-inset, 0px)",
					// 挤压兜底:右栏+内侧面板把可用宽吃光(<DRAWER_MIN)时改锚左缘——
					// 宁可盖住会话侧栏,也不能让抽屉整块出屏(否则又是"消失但占位")
					...(squeezed ? { left: 0, right: "auto" } : { right: dashFull ? 0 : outerW + officialInset, left: dashFull ? 0 : "auto" }),
					bottom: 0,
					width: dashFull ? "100vw" : width,
					pointerEvents: "auto",
					display: "flex",
					flexDirection: "column",
					background: "var(--dsw-alias-bg-base)",
					backdropFilter: "blur(16px) saturate(1.08)",
					borderLeft: "1px solid var(--dsw-alias-border-l2)",
					boxShadow: "var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))",
					color: "var(--dsw-alias-label-primary)"
				},
			children: [
				// 浮动态:右下角缩放柄(替代停靠态的左缘拉宽)
				mode === "float" && /* @__PURE__ */ (0, React.createElement)("div", {
					onPointerDown: onFloatResizeDown,
					onPointerMove: onFloatResizeMove,
					onPointerUp: onFloatDragUp,
					title: t("drawer.resize"),
					style: {
						position: "absolute",
						right: 0,
						bottom: 0,
						width: 18,
						height: 18,
						cursor: "nwse-resize",
						zIndex: 3,
						userSelect: "none",
						touchAction: "none",
						display: "flex",
						alignItems: "flex-end",
						justifyContent: "flex-end",
						padding: 2,
						color: "var(--dsh-alias-label-caption, var(--dsw-alias-label-caption))"
					},
					children: /* @__PURE__ */ (0, React.createElement)("svg", {
						width: 9,
						height: 9,
						viewBox: "0 0 10 10",
						"aria-hidden": true,
						children: [/* @__PURE__ */ (0, React.createElement)("path", {
							d: "M9 1v8H1M9 5v4M5 9H1",
							stroke: "currentColor",
							strokeWidth: 1.4,
							fill: "none",
							strokeLinecap: "round"
						})]
					})
				}),
				mode !== "float" && /* @__PURE__ */ (0, React.createElement)("div", {
					onPointerDown: onHandleDown,
					onPointerMove: onHandleMove,
					onPointerUp: onHandleUp,
					onMouseEnter: () => setHandleHover(true),
					onMouseLeave: () => setHandleHover(false),
					title: t("drawer.resize"),
					style: {
						position: "absolute",
						left: -4,
						top: 0,
						bottom: 0,
						width: 9,
						cursor: "col-resize",
						zIndex: 2,
						userSelect: "none",
						touchAction: "none",
						display: "flex",
						justifyContent: "center"
					},
					children: /* @__PURE__ */ (0, React.createElement)("span", { style: {
						width: 3,
						borderRadius: 2,
						margin: "10px 0",
						flex: "none",
						background: "var(--dsw-alias-border-l3, var(--dsw-alias-label-caption))",
						opacity: dragging || handleHover ? 1 : 0,
						transition: "opacity .15s"
					} })
				}),
				/* @__PURE__ */ (0, React.createElement)("div", {
					onPointerDown: mode === "float" ? onFloatDragDown : undefined,
					onPointerMove: mode === "float" ? onFloatDragMove : undefined,
					onPointerUp: mode === "float" ? onFloatDragUp : undefined,
					style: {
						display: "flex",
						alignItems: "center",
						gap: 2,
						padding: "8px 6px 8px 12px",
						borderBottom: "1px solid var(--dsw-alias-border-l2)",
						flex: "none",
						cursor: mode === "float" ? (floatMoving ? "grabbing" : "grab") : undefined,
						userSelect: floatMoving ? "none" : undefined,
						touchAction: mode === "float" ? "none" : undefined
					},
					children: [
						/* @__PURE__ */ (0, React.createElement)("span", {
							"aria-hidden": true,
							style: {
								display: "inline-flex",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.monitor,
								size: 15
							})
						}),
						/* @__PURE__ */ (0, React.createElement)("span", {
							style: {
								fontWeight: 600,
								fontSize: 13,
								marginLeft: 6,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: t("nav.title")
						}),
						/* @__PURE__ */ (0, React.createElement)("span", { style: { flex: 1 } }),
						/* @__PURE__ */ (0, React.createElement)("span", {
							style: {
								fontSize: 10,
								color: "var(--dsw-alias-label-caption)",
								whiteSpace: "nowrap",
								marginRight: 4,
								display: "inline-flex",
								alignItems: "center",
								gap: 4
							},
							children: [
								hostError && /* @__PURE__ */ (0, React.createElement)("span", {
									title: t("panel.hostError"),
									style: { color: "var(--dsw-alias-state-warn-primary, #f5a524)" },
									children: "⚠"
								}),
								at ? t("panel.updatedAt", { time: relTime(at, t) }) : hostError ? t("panel.hostError") : "",
								!hostError && at > 0 && data?.refreshIntervalS && /* @__PURE__ */ (0, React.createElement)(RefreshCountdown, {
									lastAt: lastFetchAt || at,
									intervalS: data.refreshIntervalS,
									t
								})
							]
						}),
						/* @__PURE__ */ (0, React.createElement)(AlertBell, { t }),
						/* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("panel.refresh"),
							onClick: () => void refresh(true),
							disabled: refreshing,
							icon: /* @__PURE__ */ (0, React.createElement)("span", {
								style: {
									display: "inline-flex",
									animation: refreshing ? "dsh-dash-spin 0.9s linear infinite" : void 0
								},
								children: /* @__PURE__ */ (0, React.createElement)(Icon, {
									d: Icons.refresh,
									size: 15
								})
							})
						}),
						mode !== "float" && /* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: dashFull ? t("drawer.restore") : t("drawer.expand"),
							onClick: () => setDashFull(!dashFull),
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.expand,
								size: 15
							})
						}),
						mode !== "float" && /* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("drawer.float"),
							onClick: () => {
								setDashFull(false);
								panelBus.set("float");
							},
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.popout,
								size: 15
							})
						}),
						mode === "float" && /* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("drawer.dock"),
							onClick: () => {
								setDashFull(false);
								panelBus.set("open");
							},
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.dock,
								size: 15
							})
						}),
						rightbarAvailable() && /* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("rightbar.follow"),
							onClick: () => openGpuInRightbar(),
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.sidebarRight,
								size: 15
							})
						}),
						/* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("drawer.collapse"),
							onClick: () => {
								setDashFull(false);
								panelBus.set("rail");
							},
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.collapseRight,
								size: 15
							})
						}),
						/* @__PURE__ */ (0, React.createElement)(IconButton, {
							label: t("drawer.close"),
							onClick: () => {
								setDashFull(false);
								panelBus.set("closed");
							},
							icon: /* @__PURE__ */ (0, React.createElement)(Icon, {
								d: Icons.close,
								size: 15
							})
						})
					]
				}),
				/* @__PURE__ */ (0, React.createElement)("div", {
					style: {
						flex: 1,
						minHeight: 0,
						display: "flex",
						flexDirection: "column"
					},
					children: [hostError && /* @__PURE__ */ (0, React.createElement)("div", {
						style: {
							flex: "none",
							margin: "8px 10px 0",
							padding: "7px 10px",
							borderRadius: 8,
							fontSize: 11.5,
							lineHeight: 1.5,
							display: "flex",
							alignItems: "center",
							gap: 8,
							background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 14%, transparent)",
							border: "1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 45%, transparent)",
							color: "var(--dsw-alias-label-primary)"
						},
						children: [
							/* @__PURE__ */ (0, React.createElement)("span", {
								"aria-hidden": true,
								style: { color: "var(--dsw-alias-state-warn-primary, #f5a524)" },
								children: "⚠"
							}),
							/* @__PURE__ */ (0, React.createElement)("span", {
								style: { flex: 1 },
								children: t("panel.offlineBanner", { time: at ? new Date(at).toLocaleTimeString() : "—" })
							}),
							/* @__PURE__ */ (0, React.createElement)("button", {
								type: "button",
								onClick: () => void refresh(true),
								disabled: refreshing,
								style: {
									flex: "none",
									border: "1px solid var(--dsw-alias-state-warn-primary, #f5a524)",
									background: "none",
									color: "var(--dsw-alias-state-warn-primary, #f5a524)",
									borderRadius: 6,
									fontSize: 11,
									padding: "2px 10px",
									cursor: refreshing ? "default" : "pointer"
								},
								children: refreshing ? "…" : t("panel.retry")
							})
						]
					}), /* @__PURE__ */ (0, React.createElement)("div", {
						style: {
							flex: 1,
							minHeight: 0
						},
						children: /* @__PURE__ */ (0, React.createElement)(DashboardPanel, {
							hosts: data?.hosts ?? [],
							snapshots: data?.snapshots ?? {},
							staleMinutes: data?.staleMinutes,
							t,
							onRetryHost: (id) => void refresh(true, id),
							onPinToggled: () => void refresh()
						})
					})]
				})
			]
		})]
	}), toasts.length > 0 && (0, ReactDOM.createPortal)(/* @__PURE__ */ (0, React.createElement)("div", {
		style: toastWrap,
		children: toasts.map((toast) => /* @__PURE__ */ (0, React.createElement)("div", {
			key: toast.id,
			role: "button",
			tabIndex: 0,
			title: t("toast.clickToOpen"),
			onClick: () => {
				focusBus.set({ hostId: toast.hostId });
				panelBus.set("open");
				dismissToast(toast.id);
			},
			onKeyDown: (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					focusBus.set({ hostId: toast.hostId });
					panelBus.set("open");
					dismissToast(toast.id);
				}
			},
			style: {
				...toastCard,
				cursor: "pointer",
				pointerEvents: "auto"
			},
			children: toast.text ? toast.text : toast.gpuIndex !== void 0 ? `${toast.hostName} · GPU${toast.gpuIndex}: ${toast.text ?? t("log.stale", { minutes: toast.minutes })}` : `${toast.hostName}: ${toast.text ?? t("log.stale", { minutes: toast.minutes })}`
		}))
	}), document.body)] });
}
/** latest snapshot timestamp across hosts (0 = none yet) */
function useLatestAt(data: { snapshots: Record<string, { at?: number }> } | null | undefined) {
	const [at, setAt] = React.useState(0);
	React.useEffect(() => {
		if (!data) return;
		const times = Object.values(data.snapshots).map((s) => s.at).filter((v): v is number => typeof v === 'number');
		setAt(times.length ? Math.max(...times) : 0);
	}, [data]);
	return at;
}
/** bell + dropdown: the session's alert history (crash / offline / hot / stall).
 *  OS-notification permission rides the bell's mount (a drawer-open click). */
function AlertBell({ t }: { t: TFunc }) {
	const [open, setOpen] = React.useState(false);
	const [, force] = React.useState(0);
	React.useEffect(() => {
		const l = () => force((v) => v + 1);
		alertCenter.listeners.add(l);
		return () => {
			alertCenter.listeners.delete(l);
		};
	}, []);
	const items = alertCenter.items;
	const icon = (k: string) => (k === "crash" ? "💥" : k === "offline" ? "⛔" : k === "hot" ? "🌡" : "⏸");
	const text = (e: AlertCenterEntry) => {
		if (e.kind === "crash") return `${e.hostName} · GPU${e.gpuIndex}: ${t("alert.crash", { min: e.min ?? 5 })}`;
		if (e.kind === "offline") return `${e.hostName}: ${t("alert.offlineLabel")}`;
		if (e.kind === "hot") return `${e.hostName}: ${t("alert.hot")}`;
		return `${e.hostName}: ${t("log.stale", { minutes: e.min ?? 10 })}`;
	};
	return React.createElement(
		"div",
		{ style: { position: "relative", flex: "none" } },
		React.createElement(
			"button",
			{
				type: "button",
				title: t("alert.bell"),
				"aria-label": t("alert.bell"),
					onClick: () => {
			// ask on a REAL user gesture (programmatic drawer-open has none and
			// Chrome silently denies)
			if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
			setOpen((v) => !v);
		},
				style: {
					width: 26, height: 26, borderRadius: 999, border: "none", background: "none",
					cursor: "pointer", color: items.length ? "var(--dsw-alias-state-warn-primary, #f5a524)" : "var(--dsw-alias-label-secondary)",
					display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, padding: 0,
				},
			},
			"🔔",
			items.length > 0 &&
				React.createElement(
					"span",
					{
						style: {
							position: "absolute", top: -1, right: -1, minWidth: 13, height: 13, borderRadius: 8,
							background: "var(--dsw-alias-state-warn-primary, #f5a524)", color: "#fff",
							fontSize: 8.5, lineHeight: "13px", textAlign: "center", padding: "0 3px", fontWeight: 600,
						},
					},
					String(items.length),
				),
		),
		open &&
			React.createElement(
				"div",
				{
					style: {
						position: "absolute", top: 30, right: 0, width: 290, maxHeight: 280, overflowY: "auto",
						background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #2a2a2a))",
						border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10,
						boxShadow: "var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.3))", zIndex: 50, padding: "6px 0",
					},
				},
				React.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", padding: "2px 10px 6px", fontSize: 10.5, color: "var(--dsw-alias-label-caption)" } },
					React.createElement("span", { style: { flex: 1 } }, t("alert.bell")),
					React.createElement(
						"button",
						{
							type: "button",
							onClick: () => alertCenter.clear(),
							style: { border: "none", background: "none", color: "var(--dsw-alias-label-caption)", cursor: "pointer", fontSize: 10.5, padding: 0 },
						},
						t("alert.clear"),
					),
				),
				items.length === 0
					? React.createElement("div", { style: { padding: "8px 12px", fontSize: 11, color: "var(--dsw-alias-label-caption)" } }, t("alert.empty"))
					: items.map((e, i) =>
						React.createElement(
							"button",
							{
								key: e.id,
								type: "button",
								onClick: () => {
									focusBus.set({ hostId: e.hostId, gpuIndex: e.gpuIndex });
									setOpen(false);
								},
								style: {
									display: "flex", gap: 7, width: "100%", padding: "5px 12px", border: "none",
									background: "none", cursor: "pointer", textAlign: "left", alignItems: "baseline",
									color: "var(--dsw-alias-label-secondary)", fontSize: 11, lineHeight: 1.5,
								},
							},
							React.createElement("span", { style: { flex: "none", fontSize: 12 } }, icon(e.kind)),
							React.createElement("span", { style: { flex: 1 } }, text(e)),
							React.createElement(
								"span",
								{ style: { flex: "none", fontSize: 9.5, color: "var(--dsw-alias-label-caption)", fontVariantNumeric: "tabular-nums" } },
								relTime(e.at, t),
							),
						),
					),
			),
	);
}
/** ticking "Ns 后刷新" caption — reassures the user the panel is live */
function RefreshCountdown({ lastAt, intervalS, t }: { lastAt: number; intervalS: number; t: TFunc }) {
	const [, tick] = React.useState(0);
	React.useEffect(() => {
		// tab 隐藏时暂停 1s 倒计时(页面不可见不值得唤醒渲染),可见即恢复
		let id = setInterval(() => tick((v) => v + 1), 1e3);
		const onVisibility = () => {
			clearInterval(id);
			if (document.visibilityState !== "hidden") id = setInterval(() => tick((v) => v + 1), 1e3);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	if (!lastAt) return null;
	const left = Math.max(0, Math.ceil((lastAt + intervalS * 1e3 - Date.now()) / 1e3));
	return /* @__PURE__ */ (0, React.createElement)("span", {
		style: { color: "var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption))" },
		children: [" · ", t("panel.nextRefresh", { s: left })]
	});
}
const toastWrap = {
	position: "fixed",
	top: 16,
	left: "50%",
	transform: "translateX(-50%)",
	// z 约定：悬浮层一律 2147483000（与 dsh-scholar 的 Z.float 同表）
	zIndex: 2147483000,
	display: "flex",
	flexDirection: "column",
	gap: 8,
	alignItems: "center",
	pointerEvents: "none"
};
const toastCard = {
	background: "var(--dsw-alias-bg-layer-2, #2a2a2a)",
	color: "var(--dsw-alias-label-primary)",
	border: "1px solid var(--dsw-alias-state-warn-primary, #f5a524)",
	borderRadius: 10,
	padding: "9px 14px",
	fontSize: 12,
	lineHeight: 1.5,
	boxShadow: "var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.3))",
	maxWidth: 420
};
/** Client plugin entry: register locale dictionaries, the sidebar toggle, the right drawer, and the settings page. */
function apply(ctx: any) {
	// apply-guard：client 工厂同页可能被加载两次，先 claim 者胜；fiber 卸载时释放（热替换可用）
	const g = globalThis as any;
	if (g.__dshDashApplied) return;
	g.__dshDashApplied = true;
	ctx.effect(() => () => { g.__dshDashApplied = false; }, "server-dashboard: apply guard");
	// 状态条联动：dsh-statusbar 的异常段点击后打开看板并直达主机卡
	ctx.effect(() => {
		const onFocus = (e: Event) => {
			const hostId = (e as CustomEvent).detail?.hostId;
			panelBus.set("open");
			if (hostId) focusBus.set({ hostId });
		};
		window.addEventListener("dsh-statusbar-focus", onFocus);
		return () => window.removeEventListener("dsh-statusbar-focus", onFocus);
	}, "server-dashboard: statusbar focus link");
	if (typeof document !== "undefined" && !document.querySelector("style[data-plugin=dsh-server-dashboard]")) {
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-server-dashboard";
		tag.textContent = "@keyframes dsh-dash-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.45)}50%{box-shadow:0 0 0 5px rgba(245,158,11,0)}}@keyframes dsh-dash-spin{to{transform:rotate(360deg)}}@keyframes dsh-dash-flash{0%,100%{box-shadow:none}30%{box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 55%, transparent)}}@keyframes dsh-dash-numflash{0%{background-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 32%, transparent)}100%{background-color:transparent}}";
		document.head.appendChild(tag);
	}
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "server-dashboard: dictionaries");
	// 官方右侧栏「GPU 监控」页签(0.1.5+;旧宿主无服务时静默跳过)
	registerDashboardRightbar(ctx);
	ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
		name: "sidebar.footer.action",
		id: "server-dashboard",
		order: 10,
		locale: NS
	}, Trigger));
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "server-dashboard-drawer",
		order: 100,
		locale: NS
	}, Drawer));
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "server-dashboard",
		// order 100:与侧栏/设置分区公约表对齐(原 10 与注释口径不符;shell.overlay 的 100 属另一槽位不受影响)
		order: 100,
		label: () => ctx.locale.bind(NS)("settings.nav"),
		locale: NS
	}, ServerDashboardSettings));
}

//#endregion

export { apply };
