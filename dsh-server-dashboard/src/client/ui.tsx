import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GpuProcessInfo } from './types';

type TFunc = (key: string, params?: Record<string, unknown>) => string;

/** full GPU process table: memory-desc by default (the trainer belongs on
 *  top), click the header to flip to PID order; optional GPU column */
export function ProcTable({ procs, showGpu = false, t }: { procs: (GpuProcessInfo & { gpu?: number })[]; showGpu?: boolean; t: TFunc }) {
  const [byMem, setByMem] = useState(true);
  const sorted = [...procs].sort((a, b) => (byMem ? b.memoryMiB - a.memoryMiB : a.pid - b.pid));
  const tdBase: React.CSSProperties = {
    padding: '2px 6px 2px 0', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top',
  };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
      <thead>
        <tr>
          <th colSpan={showGpu ? 5 : 4} style={{ textAlign: 'left', fontWeight: 400 }}>
            <button
              type="button"
              onClick={() => setByMem((v) => !v)}
              title={byMem ? t('proc.memOrderHint') : t('proc.pidOrderHint')}
              style={{
                border: 'none', background: 'none', padding: '0 0 2px', cursor: 'pointer', userSelect: 'none',
                fontSize: 9.5, color: 'var(--dsw-alias-label-caption)', borderRadius: 4,
              }}
            >
              {byMem ? `▾ ${t('proc.memFirst')}` : `⇅ ${t('proc.byPid')}`}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={`${p.gpu ?? ''}-${p.pid}`}>
            {showGpu && <td style={tdBase}>GPU{p.gpu}</td>}
            <td style={{ ...tdBase, color: 'var(--dsw-alias-label-primary)' }}>{p.pid}</td>
            <td style={tdBase}>{p.user}</td>
            <td style={{ ...tdBase, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }} title={p.cmd ?? p.name}>{p.cmd ?? p.name}</td>
            <td style={{ ...tdBase, textAlign: 'right' }}>{(p.memoryMiB / 1024).toFixed(1)}G</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- shared UI primitives styled after DSH's design tokens ---------- */

/** "5 秒前" style relative time — reads faster than an absolute clock stamp */
export function relTime(at: number, t: (key: string, params?: Record<string, unknown>) => string): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return t('rel.now');
  if (s < 60) return t('rel.sec', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('rel.min', { n: m });
  return new Date(at).toLocaleTimeString();
}

/** text that flashes briefly when its content changes — the poll refresh
 *  otherwise swaps numbers silently and the eye can't tell what moved */
export function LiveText({ children, style }: { children: string; style?: React.CSSProperties }) {
  const prev = useRef(children);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current !== children) {
      prev.current = children;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(id);
    }
  }, [children]);
  return (
    <span style={{
      ...style,
      borderRadius: 4,
      padding: '0 2px',
      margin: '0 -2px',
      animation: flash ? 'dsh-dash-numflash .7s ease-out' : undefined,
    }}>
      {children}
    </span>
  );
}

export const T = {
  primary: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  tertiary: 'var(--dsw-alias-label-tertiary)',
  caption: 'var(--dsw-alias-label-caption)',
  success: 'var(--dsw-alias-state-success-primary, #30a46c)',
  warning: 'var(--dsw-alias-state-warn-primary, #f5a524)',
  danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
  business: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  hoverBg: 'var(--dsw-alias-interactive-bg-hover)',
  cardBg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
  trackFill: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.22))',
} as const;

/**
 * z-index 约定（与 dsh-web-ui 社区惯例对齐，两个插件必须使用同一张表）：
 * 抽屉 70（让位于 shell 自身弹层）；居中弹窗 200；
 * 悬浮层（toast / HUD）一律 2147483000 —— 略低于 int32 上限，留调试余量。
 */
export const Z = { drawer: 70, modal: 200, float: 2147483000 } as const;

/** status dot: green / amber / red / gray */
export function Dot({ tone = 'gray', size = 8 }: { tone?: 'ok' | 'warn' | 'err' | 'gray'; size?: number }) {
  const color = tone === 'ok' ? T.success : tone === 'warn' ? T.warning : tone === 'err' ? T.danger : 'var(--dsw-alias-label-caption)';
  return <span style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block' }} />;
}

/** thin rounded progress bar */
export function Meter({ percent, tone, height = 7 }: { percent: number; tone?: 'normal' | 'warn' | 'hot'; height?: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const color = tone === 'hot' ? T.danger : tone === 'warn' ? T.warning : T.business;
  return (
    <div style={{ position: 'relative', height, borderRadius: height / 2, background: T.trackFill, flex: 1, minWidth: 30, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, width: `${p}%`, borderRadius: height / 2, background: color, transition: 'width .4s ease' }} />
    </div>
  );
}

/** 16px stroke icon set (matches the shell's 1.5px stroke style) */
export function Icon({ d, size = 16, color = 'currentColor' }: { d: string; size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none">
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export const Icons = {
  refresh: 'M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5V6h-3.5',
  collapseRight: 'M4.5 4l4 4-4 4M9 4l4 4-4 4',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronDown: 'M4 6l4 4 4-4',
  /** monitor glyph (sidebar trigger) */
  monitor: 'M2 3.5h12v7.5H2zM6 13.5h4M8 11v2.5',
  /** full-window expand / restore */
  expand: 'M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4',
  /** pop out to floating window */
  popout: 'M6 2H2v4M9 2h5v5h-2V5.4L8.6 10 7.2 8.6 11.6 4H9V2zM2 8h6v6H6V9.5L2 13.5.8 12.3 4.7 8.4 4 9V8H2z',
  /** open in the official right sidebar */
  sidebarRight: 'M2.5 3.5h11v9h-11zM9.5 3.5v9',
  /** dock back into the side chain */
  dock: 'M2 2h12v12H2v-2h10V4H2V2zM7 5l3 3-3 3V9H4V7h3V5z',
} as const;

/** round icon button with DSH hover fill */
export function IconButton(props: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  size?: number;
  color?: string;
}) {
  const { label, onClick, icon, disabled, size = 26, color } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: size, height: size, borderRadius: 999, flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--dsw-alias-label-dimmed, #9a9ea5)' : color ?? 'var(--dsw-alias-label-secondary)',
        opacity: disabled ? 0.55 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = T.hoverBg; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
    >
      {icon}
    </button>
  );
}

/** collapsible section header: chevron + label + optional count, DSH hover row */
export function SectionHeader(props: {
  label: string;
  count?: string;
  open: boolean;
  onClick: () => void;
}) {
  const { label, count, open, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none',
        cursor: 'pointer', borderRadius: 6, padding: '3px 8px 3px 5px', fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)', transition: 'background .12s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = T.hoverBg; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex', transition: 'transform .12s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          color: 'var(--dsw-alias-label-caption)',
        }}
      >
        <Icon d={Icons.chevronDown} size={12} />
      </span>
      <span>{label}</span>
      {count !== undefined && <span style={{ color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </button>
  );
}

/** metric block: caption label + value + bar (used by CPU/memory/disk rows) */
export function MetricBlock(props: {
  label: string;
  value: string;
  percent: number;
  tone?: 'normal' | 'warn' | 'hot';
  flexBasis?: string;
}) {
  const { label, value, percent, tone, flexBasis } = props;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: flexBasis !== undefined ? `0 1 ${flexBasis}` : 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <LiveText style={{ fontSize: 11, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</LiveText>
      </div>
      <Meter percent={percent} tone={tone} height={6} />
    </div>
  );
}

/** tiny trend line for the GPU row: loss-like metrics go green when improving */
export function Sparkline({ series, width = 76, height = 20 }: { series: MetricSeriesLike; width?: number; height?: number }) {
  const pts = series.points.slice(-40);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.v);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const x = (i: number) => (i / (pts.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / (max - min)) * (height - 5) - 2.5;
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const isLoss = /loss/i.test(series.name);
  // window-mean trend: compare the mean of the last K samples vs the first K —
  // robust against per-iteration noise (a single spike must not flip the color)
  const k = Math.max(3, Math.min(10, Math.floor(vals.length / 4)));
  const mean = (slice: number[]) => slice.reduce((a, b) => a + b, 0) / slice.length;
  const improved = isLoss ? mean(vals.slice(-k)) < mean(vals.slice(0, k)) : mean(vals.slice(-k)) >= mean(vals.slice(0, k));
  const color = isLoss ? (improved ? T.success : T.danger) : T.business;
  return (
    <svg width={width} height={height} style={{ display: 'block', flex: 'none' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** minimal point series shape (compatible with MetricSeries) */
export interface MetricSeriesLike {
  name: string;
  points: { t: number; v: number }[];
}

/** log line tone: errors read red, warnings amber, the rest neutral.
 *  在词边界之外再排除路径段(/nan/、/error/)与 warn.log 这类文件名——
 *  日志里的路径/目录名不再被误着色 */
const ERR_LINE = /(?<![/\\])(error|exception|traceback|failed|fatal|nan|cuda out of memory)(?![\w/\\])(?!\.log\b)/i;
const WARN_LINE = /(?<![/\\])(warning|warn|deprecated|fallback)(?![\w/\\])(?!\.log\b)/i;
/** metric name=value pairs whose numbers get tinted (loss/acc/lr/epoch/...) */
const METRIC_PAIR = /((?:loss|acc|lr|epoch|map|iou|f1|prec|rec|mem|grad)[\w]*\s*[=:]\s*)(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;

function logLineNodes(line: string, key: number): React.ReactNode {
  if (ERR_LINE.test(line)) {
    return <div key={key} style={{ color: T.danger }}>{line}</div>;
  }
  if (WARN_LINE.test(line)) {
    return <div key={key} style={{ color: T.warning }}>{line}</div>;
  }
  // tint metric values inside neutral lines
  METRIC_PAIR.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = METRIC_PAIR.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(<span key={`${key}-${m.index}`}>{m[1]}<span style={{ color: T.business }}>{m[2]}</span></span>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return <div key={key}>{out.length ? out : line}</div>;
}

/** log tail viewer: sticks to the bottom as new lines arrive; manual scroll-up
 *  releases the stick until the user returns near the bottom. */
export function LogView({ lines, maxHeight = 168, t, readFailed = false }: {
  lines: string[];
  maxHeight?: number;
  t: TFunc;
  /** mtimeMs===0:远端 stat/读取失败——区别于"日志为空"提示 */
  readFailed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const segs = lines.flatMap((l) => l.split(/\r+/)).map((s) => s.trim()).filter(Boolean).slice(-20);
  const nodes = segs.map((s, i) => logLineNodes(s, i));
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [nodes]);
  return (
    <div style={{ width: '100%' }}>
      {nodes.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--dsw-alias-label-caption)', marginBottom: 2 }}>{t('log.tailHint')}</div>
      )}
      <div
        ref={ref}
        onScroll={onScroll}
        style={{
          margin: 0, fontSize: 10.5, fontFamily: 'var(--ds-font-family-code, monospace)',
          lineHeight: 1.55, maxHeight, overflow: 'auto', background: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,.08))',
          borderRadius: 8, padding: '8px 10px', color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}
      >
        {nodes.length ? nodes : readFailed ? t('log.readFailed') : t('log.emptyShort')}
      </div>
    </div>
  );
}
