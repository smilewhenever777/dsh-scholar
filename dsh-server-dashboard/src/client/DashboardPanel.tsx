import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ServerSnapshot, GpuInfo, MetricSeries } from './types';
import { Dot, SectionHeader, MetricBlock, Icon, Icons, IconButton, Sparkline, LogView, LiveText, ProcTable, T, relTime } from './ui';
import { focusBus } from './focus';
import { TEMP_HOT, TEMP_WARM, UTIL_SATURATED, DISK_WARN } from './thresholds';

type TFunc = (key: string, params?: Record<string, unknown>) => string;

/** shared EMA (TensorBoard-style smoothing) — alpha 0.35 ≈ TB smoothing 0.65 */
function emaPts(pts: { t: number; v: number }[], on: boolean): { t: number; v: number }[] {
  if (!on || pts.length < 4) return pts;
  const a = 0.35;
  let acc = pts[0].v;
  return pts.map((p) => {
    acc = a * p.v + (1 - a) * acc;
    return { t: p.t, v: acc };
  });
}

/** CSV download + clipboard copy for chart data (long format: series,ts,value) */
function ExportButtons({ getRows, filename, t }: {
  getRows: () => { name: string; points: { t: number; v: number }[] }[];
  filename: string;
  t: TFunc;
}) {
  const [copied, setCopied] = useState(false);
  const csv = () => {
    const lines = ['series,timestamp,value'];
    for (const r of getRows()) for (const p of r.points) lines.push(`"${r.name.replace(/"/g, '""')}",${p.t},${p.v}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const copy = async () => {
    const lines = ['series\ttimestamp\tvalue'];
    for (const r of getRows()) for (const p of r.points) lines.push(`${r.name}\t${p.t}\t${p.v}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable (http origin) */ }
  };
  const btn: React.CSSProperties = {
    flex: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: '0 3px',
    fontSize: 11, lineHeight: '16px', height: 16, borderRadius: 4, color: 'var(--dsw-alias-label-caption)',
  };
  return (
    <>
      <button type="button" title={t('chart.exportCsv')} onClick={csv} style={btn}>⬇</button>
      <button type="button" title={copied ? t('chart.copied') : t('chart.copy')} onClick={() => void copy()} style={{ ...btn, color: copied ? T.success : btn.color }}>{copied ? '✓' : '⧉'}</button>
    </>
  );
}

/** hover-lift + click-to-zoom wrapper around a chart plot */
function Zoomable({ onOpen, title, children }: { onOpen: (rect: DOMRect) => void; title?: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // clicks on inner controls (legend chips, S toggle, exports, metric
        // select) must NOT open the lightbox — they bubble up from here
        if ((e.target as HTMLElement).closest('button, select, input')) return;
        onOpen(e.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(e.currentTarget.getBoundingClientRect()); }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        cursor: 'zoom-in', borderRadius: 8, transition: 'transform .18s ease, box-shadow .18s ease',
        transform: hover ? 'scale(1.012) translateY(-1px)' : 'none',
        boxShadow: hover ? '0 4px 14px rgba(0,0,0,.22)' : 'none',
      }}
    >
      {children}
    </div>
  );
}

/** fullscreen chart lightbox with a FLIP zoom from the origin rect — the
 *  "silky" enlargement the user asked for: measure final box, start the card
 *  scaled down at the thumbnail's position, spring to identity on next frame */
function ChartLightbox({ origin, title, onClose, children }: {
  origin: DOMRect;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);
  const flipTo = (el: HTMLElement) => {
    const f = el.getBoundingClientRect();
    const dx = origin.x + origin.width / 2 - (f.x + f.width / 2);
    const dy = origin.y + origin.height / 2 - (f.y + f.height / 2);
    const scale = Math.max(0.05, origin.width / f.width);
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  };
  // closing transform is captured into STATE (not written imperatively): the
  // setGrown(false) re-render would otherwise strip style keys React owns and
  // wipe the exit animation in the same frame
  const [closingTransform, setClosingTransform] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef(0);
  useLayoutEffect(() => {
    // layout effect (pre-paint) so the first frame never flashes at full size
    const el = contentRef.current;
    if (!el) return;
    const t = flipTo(el);
    el.style.transform = t;
    el.style.opacity = '0.35';
    rafRef.current = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    cancelAnimationFrame(rafRef.current); // mid-entry Escape: kill the pending grow so it doesn't flash open after us
    const el = contentRef.current;
    setClosingTransform(el ? flipTo(el) : 'scale(.05)');
    setGrown(false);
    closeTimer.current = setTimeout(onClose, 260);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cardTransition = grown
    ? 'transform .3s cubic-bezier(.22,.9,.26,1), opacity .25s ease'
    : 'transform .26s cubic-bezier(.3,.7,.3,1), opacity .22s ease';
  const cardTransform = closingTransform ?? undefined;
  const cardOpacity = grown ? '1' : undefined;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        onClick={close}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)', transition: 'opacity .22s ease', opacity: grown ? 1 : 0 }}
      />
      <div
        ref={contentRef}
        style={{
          position: 'relative', width: 'min(78vw, 900px)', maxHeight: '80vh', overflow: 'auto',
          background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 14, padding: '12px 14px 14px', boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.5))',
          transformOrigin: 'center',
          transition: cardTransition,
          ...(grown ? { transform: 'none' } : {}),
          ...(cardTransform !== undefined && !grown ? { transform: cardTransform, opacity: '0' } : {}),
          ...(cardOpacity !== undefined ? { opacity: cardOpacity } : {}),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          <span style={{ flex: 1 }} />
          <IconButton label="✕" onClick={close} icon={<Icon d={Icons.close} size={14} />} />
        </div>
        {typeof children === 'function' ? (children as () => React.ReactNode)() : children}
      </div>
    </div>,
    document.body,
  );
}
/** per-component hook: openLightbox(rect, title, content-or-renderfn) + portal.
 *  Passing a FUNCTION keeps the enlarged chart live — it re-renders with fresh
 *  poll data instead of freezing at click-time. */
function useChartLightbox() {
  const [state, setState] = useState<{ origin: DOMRect; title: React.ReactNode; content: React.ReactNode | (() => React.ReactNode) } | null>(null);
  const openLightbox = (origin: DOMRect, title: React.ReactNode, content: React.ReactNode | (() => React.ReactNode)) => setState({ origin, title, content });
  const lightbox = state
    ? <ChartLightbox origin={state.origin} title={state.title} onClose={() => setState(null)}>{typeof state.content === 'function' ? state.content() : state.content}</ChartLightbox>
    : null;
  return { openLightbox, lightbox };
}

/** 占位 GPU 判定:部分主机 ok 但 nvidia-smi 拿不到数据(index null/无名/全零)。
 *  这种条目渲染出来只会是 "GPUnull · 0% · 0°C · 0.0/0G" 噪音,统一过滤
 *  (与右侧栏 GPU 页签同一谓词)。 */
function hasGpuData(g: GpuInfo): boolean {
  return !!g.name || g.memoryTotalMiB > 0 || g.tempC > 0 || g.utilPercent > 0;
}

/* ---------- interactive chart ---------- */

const PALETTE = ['#4d6bfe', '#30a46c', '#f5a524', '#e5484d', '#8e4ec6', '#12a594', '#d6409f', '#9099ac'];

function SeriesChart({ series, t, big, exportName }: { series: MetricSeries[]; t: TFunc; big?: boolean; exportName?: string }) {
  const height = big ? 240 : 76;
  const plotLeft = 8;
  const plotRight = 8;
  const plotTop = 8;
  const plotBottom = 10;
  // legend 行(约 16px 高 + 4px 间距)在 svg 之上:tooltip 相对整个容器定位,需要补上这段偏移
  const legendH = 20;
  // fill the drawer width (300–520px) instead of a fixed 248px
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(248);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w > 60) setWidth(Math.max(200, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotW = width - plotLeft - plotRight;
  const plotH = height - plotTop - plotBottom;
  const maxPoints = 200;
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<{ mx: number; ratio: number } | null>(null);
  // EMA smoothing (TensorBoard-style): tames per-iteration zigzag so the trend
  // reads at a glance; toggleable because raw values matter when debugging
  const [smooth, setSmooth] = useState(true);
  // legend hover focus: dim every OTHER curve while one is hovered
  const [focusName, setFocusName] = useState<string | null>(null);

  const drawn = orderedSeries(series);
  // default visibility: only the top-3 priority metrics start visible; the rest
  // stay in the legend (hidden) so an 8-series log reads as a trend, not a wall
  // (hooks 必须先于下面的条件 return —— 原实现把 initRef/useEffect 留在 return
  // 之后,series 从有到空时 hooks 调用顺序违规)
  const initRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setHidden((h) => {
      const next = { ...h };
      let changed = false;
      drawn.forEach((s, i) => {
        if (initRef.current.has(s.name)) return;
        initRef.current.add(s.name);
        if (i >= 3 && next[s.name] !== true) {
          next[s.name] = true;
          changed = true;
        }
      });
      return changed ? next : h;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn.map((s) => s.name).join('|')]);

  if (drawn.length === 0) return null;
  const visible = drawn.filter((s) => !hidden[s.name]);
  const colorOf = (i: number) => PALETTE[i % PALETTE.length];

  const toggle = (name: string) => {
    setHidden((h) => {
      const next = { ...h, [name]: !h[name] };
      if (drawn.filter((s) => !next[s.name]).length === 0) return h; // keep ≥1 visible
      return next;
    });
  };

  /** decimate dense per-iteration data: ~80 draw points small / ~180 enlarged.
   *  抽稀保尾:filter 后强制补回最后一个点,右端"当前值"始终是最新的 */
  const drawPts = (s: MetricSeries) => {
    const pts = emaPts(s.points.slice(-maxPoints), smooth);
    const step = Math.max(1, Math.ceil(pts.length / (big ? 180 : 80)));
    if (step <= 1) return pts;
    const out = pts.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  };
  const slice = (s: MetricSeries) => drawPts(s);
  // per-series stats computed ONCE per render (O(n) total) — the old code
  // re-ran EMA+decimation inside yOf for EVERY point of every path (O(n²))
  const statsCache = new Map<string, { pts: { t: number; v: number }[]; min: number; max: number }>();
  const statsOf = (s: MetricSeries) => {
    let st = statsCache.get(s.name);
    if (!st) {
      const pts = slice(s);
      const vals = pts.map((p) => p.v);
      let min = Math.min(...vals);
      let max = Math.max(...vals);
      if (min === max) { min -= 1; max += 1; }
      st = { pts, min, max };
      statsCache.set(s.name, st);
    }
    return st;
  };
  // per-series normalized y (independent scales — loss ~26 and lr ~4e-4 both readable)
  const yOf = (s: MetricSeries, v: number) => {
    const { min, max } = statsOf(s);
    return plotTop + plotH - ((v - min) / (max - min)) * plotH;
  };
  const pathOf = (s: MetricSeries) => {
    const pts = slice(s);
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(plotLeft + (i / (pts.length - 1)) * plotW).toFixed(1)},${yOf(s, p.v).toFixed(1)}`).join('');
  };
  const valueAt = (s: MetricSeries, ratio: number) => {
    const pts = slice(s);
    const n = pts.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    // x 与折线顶点同式 i/(n-1):圆点精确落在曲线上,而不是悬在两个采样点之间
    return { p: pts[i], x: plotLeft + (n > 1 ? i / (n - 1) : 0) * plotW, y: yOf(s, pts[i].v) };
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = Math.max(plotLeft, Math.min(plotLeft + plotW, e.clientX - r.left));
    setHover({ mx, ratio: (mx - plotLeft) / plotW });
  };

  const hoverRows = (hover ? visible.map((s, i) => ({ name: s.name, color: colorOf(drawn.indexOf(s)), v: valueAt(s, hover.ratio).p.v })) : []).slice(0, 5);
  const hoverExtra = hover && visible.length > 5 ? visible.length - 5 : 0;
  const hoverTime = hover && visible[0] ? valueAt(visible[0], hover.ratio).p.t : 0;
  const tooltipLeft = hover ? (hover.mx > width / 2 ? hover.mx - 150 : hover.mx + 10) : 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {/* legend chips: click toggles visibility, hover focuses (others dim);
          the ½-smooth switch governs every curve at once */}
      <div
        style={{
          display: 'flex', gap: '3px 10px', marginBottom: 4, overflowX: 'auto', scrollbarWidth: 'thin',
          paddingBottom: 1, maxWidth: '100%', alignItems: 'center',
        }}
      >
        {drawn.map((s, i) => (
          <button
            key={s.name}
            type="button"
            onClick={() => toggle(s.name)}
            onMouseEnter={() => setFocusName(s.name)}
            onFocus={() => setFocusName(s.name)}
            onMouseLeave={() => setFocusName((cur) => (cur === s.name ? null : cur))}
            onBlur={() => setFocusName((cur) => (cur === s.name ? null : cur))}
            title={hidden[s.name] ? t('chart.show', { name: s.name }) : t('chart.hide', { name: s.name })}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none',
              padding: 0, cursor: 'pointer', opacity: hidden[s.name] ? 0.5 : focusName && focusName !== s.name ? 0.35 : 1, flex: 'none', whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 7, background: colorOf(i), display: 'inline-block' }} />
            <span
              title={s.name}
              style={{
                fontSize: 10, color: hidden[s.name] ? 'var(--dsw-alias-label-caption)' : 'var(--dsw-alias-label-secondary)',
                textDecoration: hidden[s.name] ? 'line-through' : 'none',
                maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {s.name}
            </span>
          </button>
        ))}
        {visible.length >= 2 && (
          <button
            type="button"
            onClick={() => setSmooth((v) => !v)}
            title={t('chart.smoothHint')}
            style={{
              flex: 'none', marginLeft: 'auto', border: `1px solid ${smooth ? T.business : T.borderL2}`,
              background: smooth ? `color-mix(in srgb, ${T.business} 12%, transparent)` : 'none',
              color: smooth ? T.business : 'var(--dsw-alias-label-caption)',
              borderRadius: 999, fontSize: 9.5, padding: '0 8px', height: 16, cursor: 'pointer',
            }}
          >
            S
          </button>
        )}
        {exportName && (
          <ExportButtons
            filename={`dash-${exportName}-${new Date().toISOString().slice(0, 10)}.csv`}
            getRows={() => drawn.map((s) => ({ name: s.name, points: s.points.slice(-maxPoints) }))}
            t={t}
          />
        )}
      </div>
      {/* plot */}
      <svg
        width={width}
        height={height}
        style={{ display: 'block', background: T.trackFill, borderRadius: 6, cursor: 'crosshair', touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* grid: 3 horizontal dashed lines */}
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} x1={plotLeft} x2={plotLeft + plotW} y1={plotTop + plotH * r} y2={plotTop + plotH * r}
            stroke="var(--dsw-alias-label-caption)" strokeOpacity={0.18} strokeWidth={1} strokeDasharray="3 4" />
        ))}
        {/* scale hint: min/max of the top-priority visible curve (tinted with
            its color so the ownership is unambiguous at a glance) */}
        {visible.length > 0 && (() => {
          const pts = slice(visible[0]);
          const vals = pts.map((p) => p.v);
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          if (min === max) return null;
          const color = colorOf(drawn.indexOf(visible[0]));
          return (
            <>
              <text x={plotLeft + 2} y={plotTop + 8} fontSize={8.5} fill={color} opacity={0.65}>{fmt(max)}</text>
              <text x={plotLeft + 2} y={plotTop + plotH - 1} fontSize={8.5} fill={color} opacity={0.65}>{fmt(min)}</text>
            </>
          );
        })()}
        {visible.map((s) => (
          <path
            key={s.name}
            d={pathOf(s)}
            fill="none"
            stroke={colorOf(drawn.indexOf(s))}
            strokeWidth={1.5}
            strokeLinejoin="round"
            opacity={focusName && focusName !== s.name ? 0.18 : 1}
          />
        ))}
        {/* current value pinned at each curve's right end — read the trend without hovering */}
        {visible.map((s) => {
          const at = valueAt(s, 1);
          const y = Math.max(plotTop + 7, Math.min(plotTop + plotH - 2, at.y - 3));
          return (
            <text
              key={`lbl-${s.name}`}
              x={plotLeft + plotW - 2}
              y={y}
              textAnchor="end"
              fill={colorOf(drawn.indexOf(s))}
              fontSize={9}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmt(at.p.v)}
            </text>
          );
        })}
        {hover && (() => {
          // 十字线吸附到索引网格(与圆点/折线顶点严格同 x),不再用原始鼠标坐标
          const x = visible[0] ? valueAt(visible[0], hover.ratio).x : hover.mx;
          return (
            <>
              <line x1={x} x2={x} y1={plotTop} y2={plotTop + plotH} stroke="var(--dsw-alias-label-caption)" strokeWidth={1} />
              {visible.map((s) => {
                const at = valueAt(s, hover.ratio);
                return <circle key={s.name} cx={at.x} cy={at.y} r={2.6} fill={colorOf(drawn.indexOf(s))} stroke="var(--dsw-alias-bg-base)" strokeWidth={1} />;
              })}
            </>
          );
        })()}
      </svg>
      {/* time-span caption */}
      <div style={{ marginTop: 2, fontSize: 9.5, color: 'var(--dsw-alias-label-caption)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {fmtSpan(drawn, t)}
      </div>
      {/* hover tooltip */}
      {hover && hoverRows.length > 0 && (
        <div
          style={{
            position: 'absolute', top: plotTop - 2 + legendH, left: tooltipLeft, zIndex: 3, pointerEvents: 'none',
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #2a2a2a))',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 8px',
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.2))', fontSize: 10.5, lineHeight: 1.6,
            minWidth: 130, maxWidth: 160,
          }}
        >
          <div style={{ color: 'var(--dsw-alias-label-caption)', marginBottom: 1 }}>{new Date(hoverTime).toLocaleTimeString()}</div>
          {hoverRows.map((row) => (
            <div key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: row.color, display: 'inline-block', flex: 'none' }} />
              <span title={row.name} style={{ flex: 1, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
              <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{fmt(row.v)}</span>
            </div>
          ))}
          {hoverExtra > 0 && (
            <div style={{ color: 'var(--dsw-alias-label-caption)', fontSize: 9.5 }}>{t('chart.more', { count: visible.length })}</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- multi-GPU overlay (TensorBoard-style run comparison) ---------- */

/** compare the SAME metric across a host's GPUs on one shared y-axis — the
 *  "did one shard fall behind" question answered without flipping sections */
function GpuOverlayChart({ gpus, hostName, t, big }: { gpus: GpuInfo[]; hostName: string; t: TFunc; big?: boolean }) {
  const height = big ? 240 : 150;
  const plotLeft = 8;
  const plotRight = 8;
  const plotTop = 8;
  const plotBottom = 12;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w > 60) setWidth(Math.max(200, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotW = width - plotLeft - plotRight;
  const plotH = height - plotTop - plotBottom;
  const [smooth, setSmooth] = useState(true);
  const [hiddenG, setHiddenG] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<{ mx: number; ratio: number } | null>(null);
  const [metric, setMetric] = useState<string>('');

  // metric picker: names available on ≥1 GPU, loss-like first
  const names = [...new Set(gpus.flatMap((g) => (g.series ?? []).map((s) => s.name)))].sort((a, b) => metricScore(a) - metricScore(b) || a.localeCompare(b));
  const chosen = names.includes(metric) ? metric : (names[0] ?? '');
  const groups = gpus
    .map((g, i) => {
      const s = (g.series ?? []).find((x) => x.name === chosen);
      return s && s.points.length >= 2 ? { label: `GPU${g.index}`, color: PALETTE[i % PALETTE.length], series: s } : null;
    })
    .filter((g): g is { label: string; color: string; series: MetricSeries } => !!g);
  if (groups.length === 0 || !chosen) return null;
  const visible = groups.filter((g) => !hiddenG[g.label]);

  const sliceOf = (s: MetricSeries) => {
    const pts = emaPts(s.points.slice(-200), smooth);
    const step = Math.max(1, Math.ceil(pts.length / (big ? 180 : 120)));
    if (step <= 1) return pts;
    const out = pts.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]); // keep newest sample at the right edge
    return out;
  };
  // shared y-scale across all VISIBLE groups (same metric ⇒ same unit ⇒ comparable)
  let minY = Infinity;
  let maxY = -Infinity;
  for (const g of visible) {
    for (const p of sliceOf(g.series)) {
      if (p.v < minY) minY = p.v;
      if (p.v > maxY) maxY = p.v;
    }
  }
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const yOf = (v: number) => plotTop + plotH - ((v - minY) / (maxY - minY)) * plotH;
  const pathOf = (s: MetricSeries) => {
    const pts = sliceOf(s);
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(plotLeft + (i / Math.max(1, pts.length - 1)) * plotW).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
  };
  const valueAt = (s: MetricSeries, ratio: number) => {
    const pts = sliceOf(s);
    const n = pts.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    return pts[i].v;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = Math.max(plotLeft, Math.min(plotLeft + plotW, e.clientX - r.left));
    setHover({ mx, ratio: (mx - plotLeft) / plotW });
  };
  const toggleG = (label: string) => {
    setHiddenG((h) => {
      const next = { ...h, [label]: !h[label] };
      if (groups.filter((g) => !next[g.label]).length === 0) return h; // keep ≥1
      return next;
    });
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {/* metric picker + GPU legend + smooth + export */}
      <div style={{ display: 'flex', gap: '3px 8px', marginBottom: 4, alignItems: 'center', overflowX: 'auto', scrollbarWidth: 'thin', paddingBottom: 1, maxWidth: '100%' }}>
        <select
          value={chosen}
          onChange={(e) => setMetric(e.target.value)}
          title={t('chart.pickMetric')}
          style={{
            flex: 'none', maxWidth: 110, fontSize: 10, padding: '1px 4px', borderRadius: 6,
            border: `1px solid ${T.borderL2}`, background: 'var(--dsw-alias-bg-layer-2, transparent)',
            color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
          }}
        >
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {groups.map((g) => (
          <button
            key={g.label}
            type="button"
            onClick={() => toggleG(g.label)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none',
              padding: 0, cursor: 'pointer', opacity: hiddenG[g.label] ? 0.4 : 1, flex: 'none', whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 7, background: g.color, display: 'inline-block' }} />
            <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary)', textDecoration: hiddenG[g.label] ? 'line-through' : 'none' }}>{g.label}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setSmooth((v) => !v)}
          title={t('chart.smoothHint')}
          style={{
            flex: 'none', border: `1px solid ${smooth ? T.business : T.borderL2}`,
            background: smooth ? `color-mix(in srgb, ${T.business} 12%, transparent)` : 'none',
            color: smooth ? T.business : 'var(--dsw-alias-label-caption)',
            borderRadius: 999, fontSize: 9.5, padding: '0 8px', height: 16, cursor: 'pointer',
          }}
        >
          S
        </button>
        <ExportButtons
          filename={`dash-${hostName}-${chosen}-${new Date().toISOString().slice(0, 10)}.csv`}
          getRows={() => groups.map((g) => ({ name: g.label + ':' + chosen, points: g.series.points.slice(-200) }))}
          t={t}
        />
      </div>
      {/* plot: shared-axis curves + crosshair with per-GPU values */}
      <svg width={width} height={height} style={{ display: 'block', background: T.trackFill, borderRadius: 6, cursor: 'crosshair', touchAction: 'none' }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((r) => (
          <line key={r} x1={plotLeft} x2={plotLeft + plotW} y1={plotTop + plotH * r} y2={plotTop + plotH * r}
            stroke="var(--dsw-alias-label-caption)" strokeOpacity={0.18} strokeWidth={1} strokeDasharray="3 4" />
        ))}
        <text x={plotLeft + 2} y={plotTop + 8} fontSize={8.5} fill="var(--dsw-alias-label-caption)" opacity={0.7}>{fmt(maxY)}</text>
        <text x={plotLeft + 2} y={plotTop + plotH - 2} fontSize={8.5} fill="var(--dsw-alias-label-caption)" opacity={0.7}>{fmt(minY)}</text>
        {visible.map((g) => (
          <path key={g.label} d={pathOf(g.series)} fill="none" stroke={g.color} strokeWidth={1.6} strokeLinejoin="round" />
        ))}
        {visible.map((g) => {
          const pts = sliceOf(g.series);
          const n = pts.length;
          const i = Math.max(0, Math.min(n - 1, Math.round((hover?.ratio ?? 1) * (n - 1))));
          const x = plotLeft + (n > 1 ? i / (n - 1) : 0) * plotW;
          return <circle key={`e-${g.label}`} cx={x} cy={yOf(pts[i].v)} r={2.8} fill={g.color} stroke="var(--dsw-alias-bg-base)" strokeWidth={1} />;
        })}
        {hover && <line x1={hover.mx} x2={hover.mx} y1={plotTop} y2={plotTop + plotH} stroke="var(--dsw-alias-label-caption)" strokeWidth={1} />}
      </svg>
      {/* crosshair value table */}
      {hover && visible.length > 0 && (
        <div style={{
          position: 'absolute', top: plotTop + 20, left: hover.mx > width / 2 ? hover.mx - 140 : hover.mx + 10, zIndex: 3, pointerEvents: 'none',
          background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #2a2a2a))', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 8, padding: '5px 8px', boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.2))', fontSize: 10.5, lineHeight: 1.6, minWidth: 110,
        }}>
          {visible.map((g) => (
            <div key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, background: g.color, display: 'inline-block', flex: 'none' }} />
              <span style={{ flex: 1, color: 'var(--dsw-alias-label-secondary)' }}>{g.label}</span>
              <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{fmt(valueAt(g.series, hover.ratio))}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 2, fontSize: 9.5, color: 'var(--dsw-alias-label-caption)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {chosen} · {t('chart.overlayShared')}
      </div>
    </div>
  );
}

/* ---------- gpu block (per-GPU experiment: processes / log / curves) ---------- */

/** 指标优先级打分:loss 结尾 0 > 含 loss 1 > epoch 2 > 其余 3 ——
 *  折线排序(orderedSeries)与主机卡摘要条共用同一打分,口径不再漂移 */
function metricScore(name: string): number {
  return /(^|_)loss$/.test(name) ? 0 : /loss/i.test(name) ? 1 : name === 'epoch' ? 2 : 3;
}

/** order series for the row sparkline: loss-first, then epoch, then the rest */
function orderedSeries(series: MetricSeries[]): MetricSeries[] {
  return series.filter((s) => s.points.length >= 2).sort((a, b) => metricScore(a.name) - metricScore(b.name));
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '?';
  // 极小非零值(lr 一类指标)用科学计数,0.0000 掩盖数量级不可读
  if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(1);
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/** "最近 N 分钟/小时/天" caption for the chart's x coverage */
function fmtSpan(series: MetricSeries[], t: TFunc): string {
  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.t < minT) minT = p.t;
      if (p.t > maxT) maxT = p.t;
    }
  }
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) return '';
  const minutes = Math.round((maxT - minT) / 60_000);
  if (minutes < 1) return t('chart.span.now');
  if (minutes < 60) return t('chart.span.min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? t('chart.span.hourMin', { h: hours, m: rest }) : t('chart.span.hour', { h: hours });
  return t('chart.span.day', { d: Math.floor(hours / 24), h: hours % 24 });
}

function GpuBlock({ gpu, staleMinutes, t, focusIndex }: { gpu: GpuInfo; staleMinutes?: number; t: TFunc; focusIndex?: number }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const [sparkIdx, setSparkIdx] = useState(0);
  const gpuName = `GPU${gpu.index}`;
  const { openLightbox, lightbox } = useChartLightbox();
  // heatmap cell click → this row springs open
  useEffect(() => {
    if (focusIndex === gpu.index) setOpen(true);
  }, [focusIndex, gpu.index]);
  const procs = gpu.processes;
  const hasLog = gpu.log !== undefined;
  const series = gpu.series ?? [];
  // latest-ref: the lightbox thunk must read CURRENT series on re-render, not the click-time closure
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const hasSeries = series.some((s) => s.points.length >= 2);
  const sparkCandidates = orderedSeries(series);
  const spark = sparkCandidates.length > 0 ? sparkCandidates[sparkIdx % sparkCandidates.length] : undefined;
  const idle = gpu.utilPercent < 5 && procs.length === 0;
  const expandable = procs.length > 0 || hasLog;
  const hot = gpu.tempC >= TEMP_HOT || gpu.utilPercent >= UTIL_SATURATED;
  const tempTone = gpu.tempC >= TEMP_HOT ? 'hot' : gpu.tempC >= TEMP_WARM ? 'warm' : undefined;
  // F23:停滞判定用宿主盖章的增量新鲜度(远程时钟偏移免疫);分钟数取本机观测的 changeAt
  const idleMin = gpu.log && gpu.log.mtimeMs > 0 ? Math.floor((Date.now() - (gpu.log.changeAt ?? Date.now())) / 60_000) : 0;
  const stalled = gpu.log?.fresh === false;
  const toggleTab = (x: string) => setTab((cur) => (cur === x ? null : x));
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清掉"已复制"回退计时器,避免打已卸载组件
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const copyLogPath = (path: string) => {
    navigator.clipboard?.writeText(path).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable (http origin) — title still shows the path */ });
  };
  const tempPillStyle: React.CSSProperties = {
    flex: 'none', minWidth: 30, textAlign: 'center', padding: '1px 6px', borderRadius: 999,
    fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
    background: tempTone === 'hot'
      ? `color-mix(in srgb, ${T.danger} 18%, transparent)`
      : tempTone === 'warm'
        ? `color-mix(in srgb, ${T.warning} 18%, transparent)`
        : T.hoverBg,
    color: tempTone === 'hot' ? T.danger : tempTone === 'warm' ? T.warning : 'var(--dsw-alias-label-caption)',
  };
  return (
    <div style={{ opacity: idle ? 0.5 : 1, transition: 'opacity .3s', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => { if (expandable) setOpen((v) => !v); }}
        title={expandable ? t('gpu.expandHint') : undefined}
        style={{
          display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 2px', width: '100%', minWidth: 0, overflow: 'hidden',
          border: 'none', background: 'none', cursor: expandable ? 'pointer' : 'default',
          borderRadius: 6, color: 'inherit', font: 'inherit', textAlign: 'inherit',
        }}
        onMouseEnter={(e) => { if (expandable) (e.currentTarget as HTMLElement).style.background = T.hoverBg; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
      >
        {/* row 1: identity + sparkline + primary metric + temp pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
          <span
            aria-hidden
            style={{
              width: 14, flex: 'none', display: 'inline-flex', justifyContent: 'center',
              color: 'var(--dsw-alias-label-caption)', transition: 'transform .12s',
              transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', opacity: expandable ? 1 : 0.35,
            }}
          >
            <Icon d={Icons.chevronDown} size={10} />
          </span>
          <span
            style={{ flex: '1 1 auto', minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}
            title={gpu.name}
          >
            GPU{gpu.index} {gpu.name}
          </span>
          {spark && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); if (sparkCandidates.length > 1) setSparkIdx((i) => i + 1); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setSparkIdx((i) => i + 1); } }}
              title={sparkCandidates.length > 1 ? t('gpu.switchMetric', { name: spark.name }) : spark.name}
              style={{ display: 'inline-flex', flex: 'none', cursor: sparkCandidates.length > 1 ? 'pointer' : 'default' }}
            >
              <Sparkline series={spark} />
            </span>
          )}
          {idle ? (
            <span
              style={{
                flex: 'none', minWidth: 32, textAlign: 'center', padding: '1px 6px', borderRadius: 999,
                fontSize: 10, fontWeight: 500, background: T.hoverBg, color: 'var(--dsw-alias-label-caption)',
              }}
            >
              {t('gpu.idle')}
            </span>
          ) : (
            <span
              style={{
                flex: 'none', minWidth: 32, textAlign: 'right', fontSize: 13, fontWeight: 600,
                fontVariantNumeric: 'tabular-nums', color: hot ? T.danger : 'var(--dsw-alias-label-primary)',
              }}
            >
              <LiveText>{`${gpu.utilPercent}%`}</LiveText>
            </span>
          )}
          <span style={tempPillStyle}><LiveText>{gpu.tempC > 0 ? `${gpu.tempC}°` : '—'}</LiveText></span>
        </div>
        {/* dual scan bars: utilization (solid) + memory (translucent) — a busy
            card reads at a glance without parsing the numbers */}
        <div style={{ paddingLeft: 20, paddingRight: 2, display: 'flex', flexDirection: 'column', gap: 2, margin: '1px 0 1px' }}>
          <div style={{ height: 3, borderRadius: 2, background: T.trackFill, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, gpu.utilPercent))}%`, borderRadius: 2, background: hot ? T.danger : T.business, opacity: 0.85, transition: 'width .4s ease' }} />
          </div>
          <div style={{ height: 3, borderRadius: 2, background: T.trackFill, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, gpu.memoryTotalMiB > 0 ? (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100 : 0)}%`, borderRadius: 2, background: (gpu.memoryTotalMiB > 0 && gpu.memoryUsedMiB / gpu.memoryTotalMiB > 0.9) ? T.danger : T.business, opacity: 0.4, transition: 'width .4s ease' }} />
          </div>
        </div>
        {/* row 2: secondary meta + trend/stall status (both ends may truncate
            in half-width grid columns) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box', paddingLeft: 20, minWidth: 0 }}>
          <span style={{ flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
            {(gpu.memoryUsedMiB / 1024).toFixed(1)}/{(gpu.memoryTotalMiB / 1024).toFixed(0)}G · {gpu.powerW > 0 ? `${Math.round(gpu.powerW)}W` : '—'}
          </span>
          <span style={{ flex: '1 1 0', minWidth: 2 }} />
          {stalled && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 500, color: T.warning, whiteSpace: 'nowrap' }}>
              <span aria-hidden>⏸</span>
              {t('gpu.stalled', { min: idleMin })}
            </span>
          )}
          {!stalled && spark && (
            <span style={{ flex: '0 1 auto', fontSize: 10, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', display: 'inline-flex', gap: 4, overflow: 'hidden', minWidth: 0 }}>
              <span title={spark.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{spark.name}</span>
              <span style={{ flex: 'none' }}>{fmt(spark.points[spark.points.length - 1].v)}</span>
            </span>
          )}
        </div>
      </button>
      {open && (
        <div style={{
          margin: '2px 2px 6px 6px', paddingLeft: 10, paddingRight: 8, paddingTop: 4, paddingBottom: 6,
          borderLeft: `2px solid ${T.business}`, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
          borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            <SectionHeader label={t('proc.header')} count={String(procs.length)} open={tab === 'proc'} onClick={() => toggleTab('proc')} />
            {hasLog && <SectionHeader label={t('log.header')} open={tab === 'log'} onClick={() => toggleTab('log')} />}
            {hasSeries && <SectionHeader label={t('chart.header')} open={tab === 'chart'} onClick={() => toggleTab('chart')} />}
          </div>
          {tab === 'proc' && (
            <div style={{ paddingTop: 2 }}>
              {procs.length === 0 ? (
                <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('proc.empty')}</span>
              ) : (
                <ProcTable procs={procs} t={t} />
              )}
            </div>
          )}
          {tab === 'log' && gpu.log && (
            <div style={{ width: '100%' }}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => copyLogPath(gpu.log!.path)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyLogPath(gpu.log!.path); } }}
                title={copied ? t('log.copied') : `${gpu.log.path} · ${t('log.copyPath')}`}
                style={{
                  fontSize: 10, color: 'var(--dsw-alias-label-caption)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', marginBottom: 3, cursor: 'pointer', width: 'fit-content', maxWidth: '100%',
                }}
              >
                {copied ? `✓ ${t('log.copied')}` : gpu.log.path}
              </div>
              <LogView lines={gpu.log.lines} t={t} readFailed={gpu.log.mtimeMs === 0} />
            </div>
          )}
          {tab === 'chart' && hasSeries && (
            <div style={{ width: '100%' }}>
              <Zoomable
                title={t('chart.enlarge')}
                onOpen={(rect) => openLightbox(rect, `${gpuName} · ${series.find((s) => s.points.length >= 2)?.name ?? 'chart'}`, () => <SeriesChart series={seriesRef.current} t={t} big exportName={`gpu${gpu.index}`} />)}
              >
                <SeriesChart series={series} t={t} exportName={`gpu${gpu.index}`} />
              </Zoomable>
            </div>
          )}
          {!hasLog && procs.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('gpu.noLog')}</span>
          )}
        </div>
      )}
      {lightbox}
    </div>
  );
}

/* ---------- host card ---------- */

interface HostAnomalies {
  any: boolean;
  offline: boolean;
  hot: number;
  stalled: number;
  diskFull: number;
  logStalled: boolean;
}

function hostAnomalies(snap: ServerSnapshot | undefined, staleMinutes?: number): HostAnomalies {
  // a host with no snapshot yet (first poll still in flight) counts as offline-not-yet-known
  if (!snap || !snap.ok) return { any: true, offline: true, hot: 0, stalled: 0, diskFull: 0, logStalled: false };
  let hot = 0;
  let stalled = 0;
  for (const g of snap.gpus ?? []) {
    if (g.tempC >= TEMP_HOT || g.utilPercent >= UTIL_SATURATED) hot++;
    if (g.log?.fresh === false) stalled++;
  }
  const diskFull = (snap.base?.disks ?? []).filter((d) => d.usedPercent > DISK_WARN).length;
  const logStalled = snap.log?.fresh === false;
  return { any: hot + stalled + diskFull > 0 || logStalled, offline: false, hot, stalled, diskFull, logStalled };
}

function HostCard({ snap, displayName, collapsed, staleMinutes, t, focused, focusGpuIndex, onRetry, pinned, onTogglePin, archived, onToggleArchive, wideGpuGrid }: {
  snap: ServerSnapshot | undefined;
  displayName: string;
  collapsed: boolean;
  staleMinutes?: number;
  t: TFunc;
  /** toast/heatmap focus: scroll into view + flash the border */
  focused?: boolean;
  /** expand this GPU row after revealing */
  focusGpuIndex?: number;
  onRetry?: (hostId: string) => void;
  /** pinned state + quick toggle from the card header */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** archived: user tucked this host into 其他服务器 (offline won't float it back) */
  archived?: boolean;
  onToggleArchive?: () => void;
  /** drawer is wide enough for two GPU columns */
  wideGpuGrid?: boolean;
}) {
  const [section, setSection] = useState<string | null>(null);
  const [forced, setForced] = useState<boolean | null>(null);
  const [showAllDisks, setShowAllDisks] = useState(false);
  const [chartMode, setChartMode] = useState<'split' | 'overlay'>('split');
  const { openLightbox, lightbox } = useChartLightbox();
  // latest-refs: lightbox thunks read CURRENT data on re-render, not click-time closures
  const liveSeries = useRef(snap?.series);
  liveSeries.current = snap?.series;
  const liveGpus = useRef(snap?.gpus);
  liveGpus.current = snap?.gpus;
  const cardRef = useRef<HTMLDivElement>(null);
  const toggle = (s: string) => setSection((cur) => (cur === s ? null : s));
  const anom = hostAnomalies(snap, staleMinutes);
  const open = forced ?? anom.any;
  const cardStyle: React.CSSProperties = {
    padding: 0, borderRadius: 10, background: T.cardBg,
    border: `1px solid ${anom.any ? `color-mix(in srgb, ${T.warning} 45%, transparent)` : T.borderL1}`,
    flex: 'none', overflow: 'hidden',
    animation: focused ? 'dsh-dash-flash 2.2s ease-out 1' : undefined,
  };
  useEffect(() => {
    if (!focused) return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setForced(true); // a focus action always reveals the body
  }, [focused]);

  if (!snap || !snap.ok) {
    return (
      <div ref={cardRef} style={{ ...cardStyle, opacity: archived ? 0.5 : 0.7, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Dot tone="err" size={7} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName}>{displayName}</span>
          {onRetry && snap && (
            <IconButton
              label={t('host.retry')}
              size={22}
              onClick={() => onRetry(snap.hostId)}
              icon={<Icon d={Icons.refresh} size={12} />}
            />
          )}
          {onTogglePin && (
            <span
              role="button"
              tabIndex={0}
              title={pinned ? t('host.unpin') : t('host.pin')}
              onClick={() => onTogglePin()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTogglePin(); } }}
              style={{
                flex: 'none', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', borderRadius: 6,
                color: pinned ? T.business : 'var(--dsw-alias-label-caption)',
                opacity: pinned ? 1 : 0.55, background: 'none',
              }}
            >
              📌
            </span>
          )}
          {onToggleArchive && (
            <span
              role="button"
              tabIndex={0}
              title={archived ? t('host.restore') : t('host.archive')}
              onClick={() => onToggleArchive()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleArchive(); } }}
              style={{
                flex: 'none', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', borderRadius: 6,
                color: archived ? T.business : 'var(--dsw-alias-label-caption)',
                opacity: archived ? 1 : 0.55, background: 'none',
              }}
            >
              {archived ? '📤' : '📥'}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)', marginTop: 4, paddingLeft: 13, lineHeight: 1.5 }}>
          {snap
            ? /authentication methods failed/i.test(snap.error ?? '')
              ? <span style={{ color: T.warning }}>{t('host.authRejected')}</span>
              : (snap.error ?? t('host.offlineMsg'))
            : t('host.connecting')}
        </div>
      </div>
    );
  }

  const gpus = (snap.gpus ?? []).filter(hasGpuData);
  const gpuUnavailable = (snap.gpus?.length ?? 0) > 0 && gpus.length === 0;
  const procs = gpus.flatMap((g) => g.processes.map((p) => ({ ...p, gpu: g.index })));
  const hasSeries = (snap.series ?? []).some((s) => s.points.length >= 2);
  // summary strip: latest values of the most informative metrics
  // (与折线排序共用 metricScore,loss/epoch 优先级不再两套口径)
  const summary = (snap.series ?? [])
    .filter((s) => s.points.length > 0)
    .sort((a, b) => metricScore(a.name) - metricScore(b.name))
    .slice(0, 5)
    .map((s) => ({ name: s.name, v: s.points[s.points.length - 1].v }));

  // one-line status for the collapsed card
  const activeExps = gpus.filter((g) => g.processes.length > 0).length;
  const statusParts: { text: string; bad: boolean }[] = [];
  if (gpus.length > 0) statusParts.push({ text: t('host.gpuCards', { count: gpus.length }), bad: false });
  if (anom.hot > 0) statusParts.push({ text: t('host.hotGpus', { count: anom.hot }), bad: true });
  if (anom.stalled > 0) statusParts.push({ text: t('host.stalledExps', { count: anom.stalled }), bad: true });
  if (anom.diskFull > 0) statusParts.push({ text: t('host.diskWarn', { count: anom.diskFull }), bad: true });
  if (anom.logStalled) statusParts.push({ text: t('host.logStalled'), bad: true });
  if (!anom.any) {
    if (activeExps > 0) statusParts.push({ text: t('host.runningExps', { count: activeExps }), bad: false });
    if (statusParts.length === 1) statusParts.push({ text: t('host.allGood'), bad: false });
  }

  return (
    <div ref={cardRef} style={cardStyle}>
      {/* header (click to expand/collapse) */}
      <button
        type="button"
        onClick={() => setForced(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '10px 12px',
          border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'inherit',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = T.hoverBg; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
      >
        <Dot tone="ok" size={8} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' }}>
          {displayName}
        </span>
        {snap.at ? (
          <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
            {relTime(snap.at, t)}
          </span>
        ) : null}
        {onTogglePin && (
          <span
            role="button"
            tabIndex={0}
            title={pinned ? t('host.unpin') : t('host.pin')}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onTogglePin(); } }}
            style={{
              flex: 'none', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', borderRadius: 6,
              color: pinned ? T.business : 'var(--dsw-alias-label-caption)',
              opacity: pinned ? 1 : 0.55,
              background: 'none',
            }}
          >
            📌
          </span>
        )}
        {onToggleArchive && (
          <span
            role="button"
            tabIndex={0}
            title={archived ? t('host.restore') : t('host.archive')}
            onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleArchive(); } }}
            style={{
              flex: 'none', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', borderRadius: 6,
              color: archived ? T.business : 'var(--dsw-alias-label-caption)',
              opacity: archived ? 1 : 0.55,
              background: 'none',
            }}
          >
            {archived ? '📤' : '📥'}
          </span>
        )}
        {archived && (
          <span title={t('host.archivedTag')} style={{ flex: 'none', fontSize: 9.5, padding: '1px 6px', borderRadius: 999, background: T.hoverBg, color: 'var(--dsw-alias-label-caption)' }}>
            {t('host.archivedTag')}
          </span>
        )}
        <span
          aria-hidden
          style={{ display: 'inline-flex', color: 'var(--dsw-alias-label-caption)', transition: 'transform .12s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          <Icon d={Icons.chevronDown} size={12} />
        </span>
      </button>

      {/* collapsed: one-line status — anomalies read as amber chips, neutral as caption text */}
      {!open && (
        <div style={{ padding: '0 12px 9px 26px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 10px', fontSize: 11 }}>
          {statusParts.map((p) => p.bad ? (
            <span key={p.text} style={{
              padding: '1px 8px', borderRadius: 999, fontSize: 10, fontWeight: 500,
              background: `color-mix(in srgb, ${T.warning} 16%, transparent)`, color: T.warning,
            }}>
              {p.text}
            </span>
          ) : (
            <span key={p.text} style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{p.text}</span>
          ))}
        </div>
      )}

      {/* expanded body */}
      {open && (
        <div style={{ padding: '0 12px 10px' }}>

      {/* training summary strip */}
      {summary.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginBottom: 6, fontSize: 11 }}>
          {summary.map((m) => (
            <span
              key={m.name}
              title={`${m.name} ${m.v}`}
              style={{ color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{m.name}</span>{' '}
              <LiveText>{Number.isInteger(m.v) ? String(m.v) : m.v.toFixed(4)}</LiveText>
            </span>
          ))}
        </div>
      )}

      {/* base metrics */}
      {snap.base && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 4, alignItems: 'flex-end' }}>
          <MetricBlock label="CPU" value={`${snap.base.cpuPercent}%`} percent={snap.base.cpuPercent} tone={snap.base.cpuPercent > DISK_WARN ? 'warn' : 'normal'} />
          <MetricBlock
            label={t('base.memory')}
            value={`${(snap.base.memUsedMiB / 1024).toFixed(1)}/${(snap.base.memTotalMiB / 1024).toFixed(0)}G`}
            percent={(snap.base.memUsedMiB / Math.max(1, snap.base.memTotalMiB)) * 100}
            tone={snap.base.memUsedMiB / Math.max(1, snap.base.memTotalMiB) > 0.9 ? 'warn' : 'normal'}
          />
          {snap.base.load1 !== undefined && (
            <span
              title={t('base.load')}
              style={{ flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums', paddingBottom: 2, whiteSpace: 'nowrap' }}
            >
              {t('base.load')} {snap.base.load1.toFixed(2)}
            </span>
          )}
        </div>
      )}
      {snap.base && (() => {
        // only root and nearly-full mounts earn a slot; the rest collapse
        const disks = snap.base.disks ?? [];
        const primary = disks.filter((d) => d.mount === '/' || d.usedPercent >= 70);
        const rest = disks.filter((d) => !(d.mount === '/' || d.usedPercent >= 70));
        const shown = showAllDisks ? disks : primary;
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'flex-end' }}>
            {shown.map((d) => (
              <MetricBlock
                key={d.mount}
                label={d.mount}
                value={`${d.usedPercent}%`}
                percent={d.usedPercent}
                tone={d.usedPercent > DISK_WARN ? 'warn' : 'normal'}
                flexBasis="calc(50% - 5px)"
              />
            ))}
            {rest.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAllDisks((v) => !v)}
                style={{
                  border: 'none', background: 'none', cursor: 'pointer', padding: '2px 6px',
                  fontSize: 10, color: 'var(--dsw-alias-label-caption)', borderRadius: 6,
                }}
                title={showAllDisks ? undefined : rest.map((d) => d.mount).join(' ')}
              >
                {showAllDisks ? '−' : '+'}{rest.length} {t('disk.mounts')}
              </button>
            )}
          </div>
        );
      })()}

      {/* gpu blocks — two columns when the drawer is wide. Tracks must be
          minmax(0,1fr): plain 1fr sizes to min-content, and a GpuRow's
          non-shrinking children (sparkline/percent/temp pill) push the second
          column past the card edge where overflow-hidden crops it */}
      {gpus.length > 0 && (
        <div style={{
          marginTop: 6, borderTop: `1px solid ${T.borderL2}`, paddingTop: 2,
          display: 'grid', gridTemplateColumns: wideGpuGrid ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', columnGap: 10,
        }}>
          {gpus.map((g) => <GpuBlock key={g.index} gpu={g} staleMinutes={staleMinutes} t={t} focusIndex={focusGpuIndex} />)}
        </div>
      )}
      {gpuUnavailable && (
        <div title={t('host.gpuUnavailableHint')} style={{
          marginTop: 6, fontSize: 10.5, color: 'var(--dsw-alias-label-caption)', lineHeight: 1.6,
          borderTop: `1px solid ${T.borderL2}`, paddingTop: 6,
        }}>
          {t('host.gpuUnavailable')}
        </div>
      )}

      {/* collapsible sections */}
      {!collapsed && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 2, borderTop: `1px solid ${T.borderL2}`, paddingTop: 6 }}>
          <SectionHeader label={t('proc.header')} count={String(procs.length)} open={section === 'proc'} onClick={() => toggle('proc')} />
          {snap.log && <SectionHeader label={t('log.header')} open={section === 'log'} onClick={() => toggle('log')} />}
          {hasSeries && <SectionHeader label={t('chart.header')} open={section === 'chart'} onClick={() => toggle('chart')} />}

          {section === 'proc' && (
            <div style={{ width: '100%', paddingTop: 2 }}>
              {procs.length === 0 ? (
                <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{t('proc.empty')}</span>
              ) : (
                <ProcTable procs={procs} showGpu t={t} />
              )}
            </div>
          )}
          {section === 'log' && snap.log && (
            <div style={{ width: '100%', marginTop: 2 }}>
              <LogView lines={snap.log.lines} t={t} readFailed={snap.log.mtimeMs === 0} />
            </div>
          )}
          {section === 'chart' && hasSeries && (() => {
            // overlay makes sense when ≥2 GPUs of this host carry curves
            const gpusWithSeries = (snap.gpus ?? []).filter((g) => (g.series ?? []).some((s) => s.points.length >= 2));
            const canOverlay = gpusWithSeries.length >= 2;
            return (
              <div style={{ width: '100%' }}>
                {canOverlay && (
                  <div style={{ display: 'inline-flex', border: `1px solid ${T.borderL2}`, borderRadius: 7, overflow: 'hidden', marginBottom: 4 }}>
                    {(['split', 'overlay'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setChartMode(m)}
                        style={{
                          border: 'none', padding: '1px 10px', fontSize: 10, cursor: 'pointer',
                          background: chartMode === m ? `color-mix(in srgb, ${T.business} 14%, transparent)` : 'none',
                          color: chartMode === m ? T.business : 'var(--dsw-alias-label-caption)',
                        }}
                      >
                        {t(m === 'split' ? 'chart.split' : 'chart.overlay')}
                      </button>
                    ))}
                  </div>
                )}
                {chartMode === 'overlay' && canOverlay ? (
                  <Zoomable title={t('chart.enlarge')} onOpen={(rect) => openLightbox(rect, `${displayName} · ${t('chart.overlay')}`, () => <GpuOverlayChart gpus={liveGpus.current ?? []} hostName={displayName} t={t} big />)}>
                    <GpuOverlayChart gpus={snap.gpus ?? []} hostName={displayName} t={t} />
                  </Zoomable>
                ) : (
                  <Zoomable title={t('chart.enlarge')} onOpen={(rect) => openLightbox(rect, `${displayName} · ${t('chart.header')}`, () => <SeriesChart series={liveSeries.current ?? []} t={t} big exportName={displayName} />)}>
                    <SeriesChart series={snap.series ?? []} t={t} exportName={displayName} />
                  </Zoomable>
                )}
              </div>
            );
          })()}
        </div>
      )}
        </div>
      )}
      {lightbox}
    </div>
  );
}

/* ---------- fleet overview: one row per host, one colored cell per GPU ---------- */

/** aggregate fleet counters for the badge line above the heatmap */
function fleetCounts(hosts: { id: string }[], snapshots: Record<string, ServerSnapshot>, staleMinutes?: number) {
  let running = 0;
  let idle = 0;
  let anomalous = 0;
  let offline = 0;
  for (const h of hosts) {
    const s = snapshots[h.id];
    if (!s || !s.ok) {
      offline++;
      continue;
    }
    if (hostAnomalies(s, staleMinutes).any) anomalous++;
    for (const g of (s.gpus ?? []).filter(hasGpuData)) {
      if (g.processes.length > 0) running++;
      else idle++;
    }
  }
  return { running, idle, anomalous, offline };
}

function FleetOverview({ hosts, snapshots, staleMinutes, t, onPick }: {
  hosts: { id: string; name: string; pinned: boolean; archived?: boolean }[];
  snapshots: Record<string, ServerSnapshot>;
  staleMinutes?: number;
  t: TFunc;
  onPick: (hostId: string, gpuIndex?: number) => void;
}) {
  if (hosts.length === 0) return null;
  const c = fleetCounts(hosts, snapshots, staleMinutes);
  const badges = [
    { n: c.running, tone: T.success, label: t('fleet.running'), key: 'r' },
    { n: c.anomalous + c.offline, tone: c.offline > 0 ? T.danger : T.warning, label: t('fleet.anomalous'), key: 'a' },
    { n: c.idle, tone: 'var(--dsw-alias-label-caption)', label: t('fleet.idle'), key: 'i' },
  ];
  return (
    <div style={{ flex: 'none', paddingBottom: 6, borderBottom: `1px solid ${T.borderL2}`, marginBottom: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: 'var(--dsw-alias-label-caption)', letterSpacing: 1 }}>{t('overview.title')}</span>
        <span style={{ flex: 1 }} />
        {badges.filter((b) => b.n > 0).map((b) => (
          <span
            key={b.key}
            title={`${b.label} ${b.n}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 7px', height: 15,
              borderRadius: 999, fontSize: 9.5, fontVariantNumeric: 'tabular-nums',
              background: `color-mix(in srgb, ${b.tone} 14%, transparent)`, color: b.tone,
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: 5, background: b.tone }} />{b.n}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {hosts.map((h) => {
          const s = snapshots[h.id];
          const offline = !s || !s.ok;
          return (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: h.archived ? 0.45 : 1 }}>
              <span
                role="button"
                tabIndex={0}
                title={h.archived ? `${h.name || h.id} · ${t('host.archivedTag')}` : (h.name || h.id)}
                onClick={() => onPick(h.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(h.id); } }}
                style={{
                  width: 66, flex: 'none', fontSize: 9.5, lineHeight: '18px', color: offline ? T.danger : 'var(--dsw-alias-label-caption)',
                  cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {h.archived ? '📥 ' : ''}{h.name || h.id}
              </span>
              {offline ? (
                <span style={{
                  flex: 1, fontSize: 9.5, lineHeight: '16px', color: T.danger, textAlign: 'center',
                  background: `color-mix(in srgb, ${T.danger} 12%, transparent)`, borderRadius: 4,
                }}>
                  {t('overview.offline')}
                </span>
              ) : (
                <div style={{ flex: 1, display: 'flex', gap: 3 }}>
                  {(s.gpus ?? []).filter(hasGpuData).map((g) => {
                    const hot = g.tempC >= TEMP_HOT || g.utilPercent >= UTIL_SATURATED;
                    const stalled = g.log && g.log.mtimeMs > 0 && staleMinutes !== undefined
                      && Date.now() - g.log.mtimeMs >= staleMinutes * 60_000;
                    const bg = hot
                      ? `color-mix(in srgb, ${T.danger} 55%, transparent)`
                      : g.utilPercent >= 60
                        ? `color-mix(in srgb, ${T.business} 42%, transparent)`
                        : g.utilPercent >= 5
                          ? `color-mix(in srgb, ${T.business} 20%, transparent)`
                          : T.trackFill;
                    return (
                      <button
                        key={g.index}
                        type="button"
                        title={`GPU${g.index} · ${g.utilPercent}% · ${g.tempC}°C · ${(g.memoryUsedMiB / 1024).toFixed(1)}/${(g.memoryTotalMiB / 1024).toFixed(0)}G`}
                        onClick={() => onPick(h.id, g.index)}
                        style={{
                          flex: 1, minWidth: 0, height: 18, borderRadius: 4, padding: 0, position: 'relative',
                          border: `1px solid ${hot ? T.danger : 'transparent'}`, background: bg, cursor: 'pointer',
                          color: 'var(--dsw-alias-label-primary)', fontSize: 9, fontVariantNumeric: 'tabular-nums',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {g.utilPercent}
                        {stalled && (
                          <span style={{
                            position: 'absolute', top: -2.5, right: -2.5, width: 6, height: 6, borderRadius: 6,
                            background: T.warning, border: '1px solid var(--dsw-alias-bg-base)',
                          }} />
                        )}
                      </button>
                      );
                    })}
                  {(s.gpus ?? []).length > 0 && (s.gpus ?? []).every((g) => !hasGpuData(g)) && (
                    <span title={t('host.gpuUnavailableHint')} style={{
                      flex: 1, fontSize: 9.5, lineHeight: '16px', color: 'var(--dsw-alias-label-caption)', textAlign: 'center',
                      background: T.trackFill, borderRadius: 4,
                    }}>
                      —
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- panel root ---------- */

interface PinHostRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: string;
  credentialRef: string;
  identityFile: string;
  logPath: string;
  pinned: boolean;
  archived?: boolean;
}

/** flip one host's archived flag through the config route (read → flip → PUT) */
async function toggleArchivedHost(hostId: string): Promise<void> {
  const res = await fetch('/dash/config', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = (await res.json()).config as { hosts: PinHostRow[]; refreshIntervalS: number; staleMinutes: number; alertIdleMin: number };
  const hosts = cfg.hosts.map((h) => (h.id === hostId ? { ...h, archived: !h.archived } : h));
  const put = await fetch('/dash/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hosts, refreshIntervalS: cfg.refreshIntervalS, staleMinutes: cfg.staleMinutes, alertIdleMin: cfg.alertIdleMin }),
  });
  if (!put.ok) throw new Error(`HTTP ${put.status}`);
}

async function togglePinnedHost(hostId: string): Promise<void> {
  const res = await fetch('/dash/config', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = (await res.json()).config as { hosts: PinHostRow[]; refreshIntervalS: number; staleMinutes: number };
  const hosts = cfg.hosts.map((h) => (h.id === hostId ? { ...h, pinned: !h.pinned } : h));
  const put = await fetch('/dash/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hosts, refreshIntervalS: cfg.refreshIntervalS, staleMinutes: cfg.staleMinutes }),
  });
  if (!put.ok) throw new Error(`HTTP ${put.status}`);
}

export interface DashboardPanelProps {
  /** host list snapshot (id, name, pinned) — lightweight, from the snapshot endpoint */
  hosts: { id: string; name: string; pinned: boolean; archived?: boolean }[];
  /** full snapshots keyed by host id */
  snapshots: Record<string, ServerSnapshot>;
  /** staleness threshold (minutes) for the per-GPU "stalled" badge */
  staleMinutes?: number;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** retry one offline host now (clears its failure backoff server-side) */
  onRetryHost?: (hostId: string) => void;
  /** called after a pin toggle so the drawer re-polls immediately */
  onPinToggled?: () => void;
}

export function DashboardPanel({ hosts, snapshots, staleMinutes, t, onRetryHost, onPinToggled }: DashboardPanelProps) {
  // toast/heatmap focus: reveal + flash the host card for ~2.5s, optionally
  // expanding one GPU row
  const focus = useSyncExternalStore(focusBus.subscribe, focusBus.getSnapshot);
  const focusId = focus?.hostId ?? null;
  const focusGpu = focus?.gpuIndex;
  useEffect(() => {
    if (!focus) return;
    const id = setTimeout(() => focusBus.set(null), 2500);
    return () => clearTimeout(id);
  }, [focus]);
  // panel width — a wide drawer (>420px content) fits two GPU columns
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      setWide(w >= 420);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // main area: anomalous hosts come first (never buried in the accordion),
  // then ALL pinned hosts (no slot cap); only healthy unpinned hosts fold
  // into "其他服务器". ARCHIVED hosts stay folded no matter what — the user
  // explicitly put them away (offline boxes used to force their way back in)
  const active = hosts.filter((h) => !h.archived);
  const anomalous = active.filter((h) => hostAnomalies(snapshots[h.id], staleMinutes).any);
  const pinned = active.filter((h) => h.pinned);
  const main: typeof hosts = [];
  const seen = new Set<string>();
  for (const h of [...anomalous, ...pinned]) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    main.push(h);
  }
  const others = hosts.filter((h) => !seen.has(h.id));
  const [showOthers, setShowOthers] = useState(false);
  // focusing a host hidden in the accordion opens the accordion first
  useEffect(() => {
    if (focusId && others.some((h) => h.id === focusId)) setShowOthers(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);
  const retry = onRetryHost;
  const togglePin = async (hostId: string) => {
    try {
      await togglePinnedHost(hostId);
      onPinToggled?.();
    } catch {
      // config route unreachable — the next poll keeps the old state
    }
  };
  const toggleArchive = async (hostId: string) => {
    try {
      await toggleArchivedHost(hostId);
      onPinToggled?.(); // reuse the immediate re-poll
    } catch {
      // config route unreachable — the next poll keeps the old state
    }
  };
  const pickFromOverview = (hostId: string, gpuIndex?: number) => {
    focusBus.set({ hostId, gpuIndex });
  };
  // an archived host that IS anomalous deserves a hint in the section header
  const othersAnomaly = others.filter((h) => hostAnomalies(snapshots[h.id], staleMinutes).any).length;

  return (
    <div ref={rootRef} style={{ padding: '8px 10px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' }}>
      {hosts.length === 0 && (
        <div style={{ marginTop: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <span aria-hidden style={{ fontSize: 30, opacity: 0.35 }}>🖥️</span>
          <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-caption)', maxWidth: 240 }}>{t('panel.empty')}</span>
        </div>
      )}
      <FleetOverview hosts={hosts} snapshots={snapshots} staleMinutes={staleMinutes} t={t} onPick={pickFromOverview} />
      {main.map((h) => <HostCard key={h.id} snap={snapshots[h.id]} displayName={h.name || h.id} collapsed={false} staleMinutes={staleMinutes} t={t} focused={focusId === h.id} focusGpuIndex={focusId === h.id ? focusGpu : undefined} onRetry={retry} pinned={h.pinned} onTogglePin={() => void togglePin(h.id)} archived={false} onToggleArchive={() => void toggleArchive(h.id)} wideGpuGrid={wide} />)}
      {others.length > 0 && (
        <div style={{ flex: 'none' }}>
          <SectionHeader
            label={othersAnomaly > 0
              ? `${t('other.collapsed', { count: others.length })}${t('other.anomalySuffix', { count: othersAnomaly })}`
              : t('other.collapsed', { count: others.length })}
            open={showOthers}
            onClick={() => setShowOthers((v) => !v)}
          />
          {showOthers && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
              {others.map((h) => <HostCard key={h.id} snap={snapshots[h.id]} displayName={h.name || h.id} collapsed staleMinutes={staleMinutes} t={t} focused={focusId === h.id} focusGpuIndex={focusId === h.id ? focusGpu : undefined} onRetry={retry} pinned={h.pinned} onTogglePin={() => void togglePin(h.id)} archived={!!h.archived} onToggleArchive={() => void toggleArchive(h.id)} wideGpuGrid={wide} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
