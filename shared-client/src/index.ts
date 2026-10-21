/**
 * dsh-plugin-shared-client —— 插件间共享的浏览器侧小工具(Phase E2)。
 * 消费方 bundler(tsdown/esbuild)直接编译本 TS 源;各插件 client tsconfig 已放开 rootDir。
 * api = 共享 JSON 请求助手(错误携带 .status/.code + 超时);
 * clampFloat = scholar/trajectory/dashboard 三份抽屉钳制的真实语义(带最小尺寸);
 * hubLoop = /hub/events 长轮询统一版(statusbar/morning/cockpit)。
 */

/** 同源 JSON fetch 助手。非 2xx 抛错携带 .status/.code,便于 UI 做 409 等友好映射。 */
export async function api<T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(rest.headers as Record<string, string> | undefined) },
    signal: rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string };
    const err = new Error(b.error ? `${b.error}${b.code ? `(${b.code})` : ''}` : `HTTP ${res.status}`);
    (err as Error & { status?: number; code?: string }).status = res.status;
    (err as Error & { status?: number; code?: string }).code = b.code;
    throw err;
  }
  return body as T;
}

/** 查询串助手(undefined/null/空串跳过)。 */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 浮动抽屉视口钳制(带最小尺寸;scholar/trajectory/dashboard Drawer 的统一版)。 */
export function clampFloat(g: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rootStyle = getComputedStyle(document.documentElement);
  const titlebar = document.documentElement.hasAttribute('data-fullscreen') ? 0 : Math.max(0,
    Number.parseFloat(rootStyle.getPropertyValue('--dsh-desktop-titlebar-inset')) ||
    Number.parseFloat(rootStyle.getPropertyValue('--dsh-windows-titlebar-height')) ||
    (document.documentElement.dataset.platform === 'darwin' ? 48 : 0));
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const w = Math.min(Math.max(1, vw - 16), Math.max(300, finite(g.w, 420)));
  const h = Math.min(Math.max(1, vh - titlebar - 16), Math.max(220, finite(g.h, 560)));
  return {
    x: Math.max(8, Math.min(finite(g.x, 8), vw - w - 8)),
    y: Math.max(titlebar + 8, Math.min(finite(g.y, titlebar + 8), vh - h - 8)),
    w, h,
  };
}

/** 长轮询循环构造器(statusbar/morning/cockpit 的 /hub/events 消费统一版)。 */
export function hubLoop(handlers: {
  onEvents: (events: Array<{ seq: number; at: number; actor: string; kind: string; source: string; subject: string; payload?: unknown }>) => void;
  onReset?: () => void;
}): { stop(): void } {
  let since = 0;
  let alive = true;
  void (async () => {
    while (alive) {
      try {
        const res = await fetch(`/hub/events?since=${since}&wait=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (!alive) return;
        if (!res.ok) { await new Promise(r => setTimeout(r, 8000)); continue; }
        const data = await res.json() as { events: Array<{ seq: number; at: number; actor: string; kind: string; source: string; subject: string; payload?: unknown }>; nextSeq: number };
        if (typeof data.nextSeq === 'number' && data.nextSeq < since) { since = 0; handlers.onReset?.(); }
        if (data.events?.length) {
          since = data.events[data.events.length - 1].seq;
          handlers.onEvents(data.events);
        }
      } catch { if (alive) await new Promise(r => setTimeout(r, 5000)); }
    }
  })();
  return { stop: () => { alive = false; } };
}
