import React from 'react';
import { createPortal } from 'react-dom';
import type { TrajEdgeKind, TrajNodeKind, TrajStatus } from '../shared/types';

/* ---------- shared UI primitives styled after DSH's design tokens ---------- */

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
  layer2: 'var(--dsw-alias-bg-layer-2, transparent)',
  purple: '#7c5cff',
  teal: '#0d9488',
} as const;

/**
 * z-index 约定(与 dsh-web-ui 社区惯例对齐,插件家族必须使用同一张表):
 * 抽屉 70(让位于 shell 自身弹层);居中弹窗 200;
 * 悬浮层(toast / HUD)一律 2147483000 —— 略低于 int32 上限,留调试余量。
 */
export const Z = { drawer: 70, modal: 200, float: 2147483000 } as const;

/**
 * One-shot global stylesheet: everything inline styles cannot express
 * (:hover / :focus / scrollbars / keyframes). Rendered once per surface.
 */
export function TrajStyles() {
  return (
    <style>{`
      /* ---- 动效令牌(Material 3 时长/缓动分层;系统"减少动态"可整体关断)---- */
      :root {
        --traj-dur-fast: 140ms;
        --traj-dur: 220ms;
        --traj-dur-slow: 320ms;
        --traj-ease: cubic-bezier(.2, 0, 0, 1);
        --traj-ease-out: cubic-bezier(0, 0, .2, 1);
        --traj-spring: cubic-bezier(.34, 1.3, .64, 1);
      }

      .traj-scroll { scrollbar-width: thin; scrollbar-color: rgba(127,127,127,.28) transparent; }
      .traj-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .traj-scroll::-webkit-scrollbar-track { background: transparent; }
      .traj-scroll::-webkit-scrollbar-thumb {
        background: rgba(127,127,127,.28); border-radius: 999px;
        border: 2px solid transparent; background-clip: content-box;
      }
      .traj-scroll::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.45); background-clip: content-box; }

      .traj-card {
        transition: background .13s ease, border-color .13s ease, box-shadow .13s ease,
          transform var(--traj-dur-fast, 140ms) var(--traj-ease, ease);
      }
      .traj-card:hover { border-color: var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)) !important; }
      .traj-press:active { transform: scale(.97); }

      /* 快捷流转按钮:悬停滑入 */
      .traj-quick {
        opacity: 0; transform: translateX(-4px);
        transition: opacity var(--traj-dur-fast, 140ms) ease, transform var(--traj-dur-fast, 140ms) var(--traj-ease, ease);
      }
      .traj-card:hover .traj-quick, .traj-quick:focus-visible { opacity: 1; transform: none; }

      .traj-input:focus, .traj-select:focus, textarea.traj-input:focus {
        outline: none !important;
        border-color: var(--dsw-alias-state-business-primary, #4d6bfe) !important;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent);
      }
      .traj-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption)); }

      .traj-select option { background: var(--dsw-alias-bg-base, #161616); color: var(--dsw-alias-label-primary); }

      @keyframes trajFadeUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      .traj-fade { animation: trajFadeUp .18s ease both; }

      /* ---- 台账折叠:grid 0fr→1fr,纯 CSS 高度动画(零 JS 测高)---- */
      .traj-fold { display: grid; grid-template-rows: 0fr; }
      .traj-fold > div { overflow: hidden; min-height: 0; }
      .traj-fold-open { grid-template-rows: 1fr; }

      /* ---- 骨架屏基底 ---- */
      .traj-skel {
        position: relative; overflow: hidden; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));
      }
      .traj-skel::after {
        content: ""; position: absolute; inset: 0; transform: translateX(-100%);
        background: linear-gradient(90deg, transparent, rgba(127,127,127,.16), transparent);
      }

      /* ---- v3 动效层:全部包裹 no-preference ---- */
      @media (prefers-reduced-motion: no-preference) {
        /* 清单编排:卡片按序滑入(--i × 45ms,条目重叠不断链) */
        .traj-stagger { animation: traj-in var(--traj-dur) var(--traj-ease) both; animation-delay: calc(var(--i, 0) * 45ms); }
        /* 里程碑圆点 spring 弹入(轻微过冲) */
        .traj-pop { animation: traj-pop var(--traj-dur-slow) var(--traj-spring) both; animation-delay: calc(var(--i, 0) * 45ms); }
        /* 卡片悬停上浮 */
        .traj-card:hover { transform: translateY(-1px); }
        /* 折叠过渡 */
        .traj-fold { transition: grid-template-rows var(--traj-dur-slow) var(--traj-ease); }
        /* 进度头图:进度条 clip-path 展开(合成友好) */
        .traj-bar { animation: traj-bar 600ms var(--traj-ease-out) 90ms both; }
        /* 完成圆点一次性绿波纹 */
        .traj-done-dot::after {
          content: ""; position: absolute; inset: -3px; border-radius: 999px;
          border: 2px solid var(--dsw-alias-state-success-primary, #30a46c);
          animation: traj-ripple 650ms var(--traj-ease-out) both;
        }
        /* 骨架屏微光 */
        .traj-skel::after { animation: traj-shimmer 1.4s ease-in-out infinite; }
        /* 容器:抽屉滑入 / 全页缩放 */
        .traj-slide { animation: traj-slide var(--traj-dur-slow) var(--traj-ease) both; }
        .traj-zoomin { animation: traj-zoomin var(--traj-dur-slow) var(--traj-ease) both; }
        /* 图视图描线(JS 设 dash,过渡在此声明) */
        .traj-draw { transition: stroke-dashoffset 420ms var(--traj-ease); }
      }

      @keyframes traj-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
      @keyframes traj-pop { from { opacity: 0; transform: scale(.55); } to { opacity: 1; transform: scale(1); } }
      @keyframes traj-bar { from { clip-path: inset(0 100% 0 0); } }
      @keyframes traj-ripple { from { transform: scale(.5); opacity: .9; } to { transform: scale(1.6); opacity: 0; } }
      @keyframes traj-shimmer { to { transform: translateX(100%); } }
      @keyframes traj-slide { from { transform: translateX(26px); opacity: .4; } }
      @keyframes traj-zoomin { from { transform: scale(.985); opacity: .5; } }

      /* 打印视图:全页模式打开时 Ctrl+P 只打主线内容(组会材料) */
      @media print {
        body > *:not([data-dsh-surface="fullpage"]) { display: none !important; }
        [data-dsh-surface="fullpage"] > div,
        [data-dsh-surface="fullpage"] > div > div { position: static !important; max-height: none !important; }
        .traj-noprint { display: none !important; }
      }
    `}</style>
  );
}

/** 16px stroke icon set (matches the shell's 1.5px stroke style) */
export function Icon({ d, size = 16, color = 'currentColor', className }: {
  d: string; size?: number; color?: string; className?: string;
}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" className={className}>
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const Icons = {
  close: 'M4 4l8 8M12 4l-8 8',
  chevronDown: 'M4 6l4 4 4-4',
  collapseRight: 'M4.5 4l4 4-4 4M9 4l4 4-4 4',
  refresh: 'M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5V6h-3.5',
  search: 'M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.5 10.5L14 14',
  plus: 'M8 3.5v9M3.5 8h9',
  edit: 'M2.5 13.5l.8-3L11 2.7a1.4 1.4 0 0 1 2 2l-7.8 7.8-3 .8z',
  trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4M9.2 7v4',
  /** roadmap / mainline: horizontal spine with branch dots */
  traj: 'M1.5 8h13M4 8V5.5M8 8V4M12 8V6M4 12h8',
  graph: 'M2.5 13.5h11M3.5 13.5V9.5M8 13.5V5.5M12.5 13.5V3',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.8 4h.01M2.8 8h.01M2.8 12h.01',
  frame: 'M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5',
  /** full-page expand */
  expand: 'M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4',
  /** open in the official right sidebar */
  sidebarRight: 'M2.5 3.5h11v9h-11zM9.5 3.5v9',
  /** pop out to floating window */
  popout: 'M6 2H2v4M9 2h5v5h-2V5.4L8.6 10 7.2 8.6 11.6 4H9V2zM2 8h6v6H6V9.5L2 13.5.8 12.3 4.7 8.4 4 9V8H2z',
  /** dock back into the side chain */
  dock: 'M2 2h12v12H2v-2h10V4H2V2zM7 5l3 3-3 3V9H4V7h3V5z',
  /** presentation screen (story tab) */
  present: 'M2 3.5h12v7.5H2zM6 13.5h4M8 11v2.5',
  /** settings gear */
  settings: 'M8 5.5A2.5 2.5 0 1 1 8 10.5 2.5 2.5 0 0 1 8 5.5zM8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.5 1.5M11.1 11.1l1.5 1.5M12.6 3.4l-1.5 1.5M4.9 11.1l-1.5 1.5',
  flag: 'M3.5 14V2.5h9L10 5.5l2.5 3h-9',
  bulb: 'M8 1.8a4.2 4.2 0 0 1 2.4 7.7c-.5.4-.9 1-.9 1.6v.4h-3v-.4c0-.6-.4-1.2-.9-1.6A4.2 4.2 0 0 1 8 1.8zM6.5 13.5h3M7 15h2',
  play: 'M5.5 3.5l7 4.5-7 4.5v-9z',
  doc: 'M4 1.5h5.5L13 5v9.5H4V1.5zM9.5 1.5V5H13M5.8 8h4.4M5.8 10.5h4.4',
  pen: 'M8 13.5h5.5M10.8 2.7a1.4 1.4 0 0 1 2 2L6 11.5l-3 .8.8-3 7-6.6z',
  dot: 'M8 5.5A2.5 2.5 0 1 1 8 10.5 2.5 2.5 0 0 1 8 5.5z',
  link: 'M6 10L10 6M5.5 11.5l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M10.5 4.5l1-1a2.1 2.1 0 0 1 3 3L12 9a2.1 2.1 0 0 1-3 0',
  folder: 'M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7.5z',
} as const;

/** round icon button with DSH hover fill */
export function IconButton(props: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  size?: number;
  color?: string;
  active?: boolean;
}) {
  const { label, onClick, icon, disabled, size = 26, color, active } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="traj-press"
      style={{
        width: size, height: size, borderRadius: active ? 7 : 999, flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent)' : 'none',
        border: 'none', cursor: disabled ? 'default' : 'pointer',
        color: disabled
          ? 'var(--dsw-alias-label-dimmed, #9a9ea5)'
          : color ?? (active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-label-secondary)'),
        opacity: disabled ? 0.55 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = T.hoverBg; }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = active
          ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent)'
          : 'none';
      }}
    >
      {icon}
    </button>
  );
}

/** small bordered button; heights align on a 26px control rhythm */
export function Btn(props: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger' | 'soft';
  style?: React.CSSProperties;
}) {
  const { children, onClick, disabled, tone = 'default', style } = props;
  const color = tone === 'danger' ? T.danger : tone === 'primary' || tone === 'soft'
    ? T.business : 'var(--dsw-alias-label-primary)';
  const background = tone === 'primary'
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 30%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 20%, transparent))'
    : tone === 'soft'
      ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)'
      : 'none';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="traj-press"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        height: 26, padding: '0 10px',
        border: `1px solid ${tone === 'primary' || tone === 'soft' ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
        background,
        borderRadius: 7, cursor: disabled ? 'default' : 'pointer',
        fontSize: 12, fontWeight: tone === 'primary' ? 600 : 400,
        color, opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap', transition: 'opacity .12s ease', ...style,
      }}
    >
      {children}
    </button>
  );
}

/** labeled text input */
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { style, ...rest } = props;
  return (
    <input
      {...rest}
      className={`traj-input ${rest.className ?? ''}`}
      style={{
        height: 26, display: 'block', width: '100%', boxSizing: 'border-box',
        padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)',
        fontSize: 12, transition: 'border-color .12s ease, box-shadow .12s ease', ...style,
      }}
    />
  );
}

/** multi-line text input */
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { style, ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`traj-input ${rest.className ?? ''}`}
      style={{
        display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical',
        padding: '6px 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)',
        fontSize: 12, lineHeight: 1.55, transition: 'border-color .12s ease, box-shadow .12s ease', ...style,
      }}
    />
  );
}

/** native select dressed with a chevron (appearance none) */
export function Select({ children, style, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', minWidth: 0, ...style }}>
      <select
        {...rest}
        className={`traj-input ${rest.className ?? ''}`}
        style={{
          height: 26, appearance: 'none', WebkitAppearance: 'none', paddingRight: 20,
          borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-primary)',
          fontSize: 11.5, cursor: 'pointer', boxSizing: 'border-box', width: '100%',
          display: 'inline-block', transition: 'border-color .12s ease, box-shadow .12s ease',
        }}
      >
        {children}
      </select>
      <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-caption)' }}>
        <Icon d={Icons.chevronDown} size={11} />
      </span>
    </span>
  );
}

/** search input with magnifier + one-click clear */
export function SearchInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: '1 1 130px', minWidth: 110 }}>
      <span style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-caption)' }}>
        <Icon d={Icons.search} size={12} />
      </span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ paddingLeft: 25, paddingRight: value ? 24 : 8 }} />
      {value && (
        <span style={{ position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)' }}>
          <IconButton label="×" size={17} onClick={() => onChange('')} icon={<Icon d={Icons.close} size={10} />} />
        </span>
      )}
    </span>
  );
}

export const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'block',
  marginBottom: 4, fontWeight: 500, letterSpacing: '.01em',
};

/** form field: label above control */
export function Field({ label, children, hint }: { label: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <span style={labelStyle}>{label}</span>
      {children}
      {hint && <div style={{ fontSize: 10.5, color: T.caption, marginTop: 3, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

/** empty-state block: big glyph + one-line title + soft hint */
export function EmptyState({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="traj-fade" style={{
      flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', padding: '28px 20px', gap: 6,
    }}>
      <span style={{ color: 'var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption))', opacity: .85, marginBottom: 2 }}>
        {icon}
      </span>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.secondary }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: T.caption, lineHeight: 1.65, maxWidth: 260 }}>{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** bordered section card used across detail pages */
export function Section({ title, icon, children, accent, style }: {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      marginTop: 10, borderRadius: 10, border: `1px solid ${accent ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
      background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
      boxShadow: accent ? `inset 3px 0 0 ${accent}` : undefined,
      overflow: 'hidden', ...style,
    }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px 0',
          fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption,
        }}>
          {icon}{title}
        </div>
      )}
      <div style={{ padding: title ? '6px 10px 9px' : '9px 10px', fontSize: 11.5, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/** key/value line for detail metadata grids */
export function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.5, minHeight: 18 }}>
      <span style={{ color: T.caption, flex: 'none', width: 56 }}>{k}</span>
      <span style={{ color: T.secondary, flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

/** tag chip (non-filter decorative by default) */
export function Chip({ label, active, onClick, color }: { label: string; active?: boolean; onClick?: () => void; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid',
        borderColor: active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
          : color ? 'color-mix(in srgb, currentColor 30%, transparent)' : 'var(--dsw-alias-border-l2)',
        background: active ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent)'
          : color ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'none',
        borderRadius: 999, padding: '1px 8px', fontSize: 10.5, cursor: onClick ? 'pointer' : 'default',
        color: color ?? 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', maxWidth: 160,
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {label}
    </button>
  );
}

/* ---------- trajectory-specific color helpers ---------- */

/** 状态色沿 dashboard 语言:蓝=进行 琥珀=警示/受阻 红=异常 绿=完成 */
export function statusColor(status: TrajStatus): string {
  switch (status) {
    case 'todo': return T.caption;
    case 'in_progress': return T.business;
    case 'blocked': return T.warning;
    case 'done': return T.success;
    case 'dropped': return 'var(--dsw-alias-label-dimmed, #9a9ea5)';
    default: return T.caption;
  }
}

export function kindColor(kind: TrajNodeKind): string {
  switch (kind) {
    case 'milestone': return T.business;
    case 'idea': return T.purple;
    case 'experiment': return T.teal;
    case 'paper': return T.warning;
    case 'writing': return T.success;
    default: return T.caption;
  }
}

export function edgeColor(kind: TrajEdgeKind): string {
  switch (kind) {
    case 'enables': return T.business;
    case 'feeds': return T.teal;
    case 'composes': return T.purple;
    default: return T.caption;
  }
}

export const MAINLINE_ACCENT = 'var(--dsw-alias-state-business-primary, #4d6bfe)';

/** truncate long text for graph labels */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** relative time like "3 分钟前" */
export function relTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/* ---------- modal portal (shared by views) ---------- */

/** 某些皮肤的 bg-base/bg-layer-2 是半透明(壁纸透出),弹窗必须垫不透明底。 */
let cachedOpaque: string | null = null;
function opaqueBase(): string {
  if (cachedOpaque) return cachedOpaque;
  for (const el of [document.body, document.documentElement]) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { cachedOpaque = c; return c; }
  }
  cachedOpaque = '#161616';
  return cachedOpaque;
}

export function Modal({ title, onClose, children, width = 480 }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z.modal, background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="traj-fade"
        style={{
          position: 'relative',
          width: `min(${width}px, 90vw)`,
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12, boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.4))',
          color: 'var(--dsw-alias-label-primary)', overflow: 'hidden',
        }}
      >
        {/* 不透明垫底 + 主题色表面(半透明主题下保证弹窗不透底) */}
        <div style={{ position: 'absolute', inset: 0, background: opaqueBase() }} />
        <div style={{ position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-layer-2, transparent)' }} />
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: 'none' }}>
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
            <IconButton label="close" onClick={onClose} icon={<Icon d={Icons.close} size={14} />} />
          </div>
          <div className="traj-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
