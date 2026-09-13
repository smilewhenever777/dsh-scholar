import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

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
 * z-index 约定（与 dsh-web-ui 社区惯例对齐，两个插件必须使用同一张表）：
 * 抽屉 70（让位于 shell 自身弹层）；居中弹窗 200；
 * 悬浮层（toast / HUD）一律 2147483000 —— 略低于 int32 上限，留调试余量。
 */
export const Z = { drawer: 70, modal: 200, float: 2147483000 } as const;

/**
 * One-shot global stylesheet: everything inline styles cannot express
 * (:hover / :focus / scrollbars / keyframes). Rendered once per surface.
 */
export function SchStyles() {
  return (
    <style>{`
      .sch-scroll { scrollbar-width: thin; scrollbar-color: rgba(127,127,127,.28) transparent; }
      .sch-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .sch-scroll::-webkit-scrollbar-track { background: transparent; }
      .sch-scroll::-webkit-scrollbar-thumb {
        background: rgba(127,127,127,.28); border-radius: 999px;
        border: 2px solid transparent; background-clip: content-box;
      }
      .sch-scroll::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.45); background-clip: content-box; }

      .sch-card { transition: background .13s ease, border-color .13s ease, box-shadow .16s ease, transform .16s ease; }
      .sch-card:hover { border-color: var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)) !important; transform: translateY(-1px); box-shadow: var(--dsw-shadow-lv2, 0 4px 14px rgba(0,0,0,.12)); }
      .sch-press:active { transform: scale(.985); }
      .sch-list .sch-card { animation: schFadeUp .22s ease both; }
      .sch-list .sch-card:nth-child(2) { animation-delay: .025s; }
      .sch-list .sch-card:nth-child(3) { animation-delay: .05s; }
      .sch-list .sch-card:nth-child(n+4) { animation-delay: .07s; }
      .sch-skeleton {
        border-radius: 12px; margin-bottom: 10px;
        background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)) 25%, var(--dsw-alias-bg-layer-2, rgba(127,127,127,.15)) 37%, var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08)) 63%);
        background-size: 480px 100%;
        animation: schShimmer 1.3s linear infinite;
      }
      @keyframes schShimmer { from { background-position: -240px 0; } to { background-position: 240px 0; } }

      .sch-input:focus, .sch-select:focus, textarea.sch-input:focus {
        outline: none !important;
        border-color: var(--dsw-alias-state-business-primary, #4d6bfe) !important;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent);
      }
      .sch-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption)); }

      .sch-select option { background: var(--dsw-alias-bg-base, #161616); color: var(--dsw-alias-label-primary); }

      @keyframes schFadeUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      .sch-fade { animation: schFadeUp .18s ease both; }

      @keyframes schSpin { to { transform: rotate(360deg); } }
      .sch-spin { animation: schSpin .8s linear infinite; }
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
  chevronRight: 'M6 4l4 4-4 4',
  collapseRight: 'M4.5 4l4 4-4 4M9 4l4 4-4 4',
  refresh: 'M13.5 8A5.5 5.5 0 1 1 8 2.5M13.5 2.5V6h-3.5',
  search: 'M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.5 10.5L14 14',
  plus: 'M8 3.5v9M3.5 8h9',
  edit: 'M2.5 13.5l.8-3L11 2.7a1.4 1.4 0 0 1 2 2l-7.8 7.8-3 .8z',
  trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4M9.2 7v4',
  back: 'M9.5 3.5L5 8l4.5 4.5',
  book: 'M2.5 3.5A1.5 1.5 0 0 1 4 2h9.5v11H4a1.5 1.5 0 0 0-1.5 1.5v-11zM4 2v11',
  graph: 'M2.5 13.5h11M3.5 13.5V9.5M8 13.5V5.5M12.5 13.5V3',
  cards: 'M2.5 4h5v8h-5zM8.5 4h5v5h-5zM8.5 10.5h5v1.5h-5z',
  link: 'M6 10L10 6M5.5 11.5l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M10.5 4.5l1-1a2.1 2.1 0 0 1 3 3L12 9a2.1 2.1 0 0 1-3 0',
  filter: 'M2.5 4h11M4.5 8h7M6.5 12h3',
  external: 'M6.5 9.5L13 3M13 7V3H9M11.5 13h-8A.5.5 0 0 1 3 12.5v-8A.5.5 0 0 1 3.5 4H7',
  sparkle: 'M8 2l1.2 3.3L12.5 6 9.2 7.2 8 10.5 6.8 7.2 3.5 6l3.3-.7L8 2zM12.5 10l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z',
  doc: 'M4 1.5h5.5L13 5v9.5H4V1.5zM9.5 1.5V5H13M5.8 8h4.4M5.8 10.5h4.4',
  bulb: 'M8 1.8a4.2 4.2 0 0 1 2.4 7.7c-.5.4-.9 1-.9 1.6v.4h-3v-.4c0-.6-.4-1.2-.9-1.6A4.2 4.2 0 0 1 8 1.8zM6.5 13.5h3M7 15h2',
  grid: 'M3 3h4.5v4.5H3zM8.5 3H13v4.5H8.5zM3 8.5h4.5V13H3zM8.5 8.5H13V13H8.5z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.8 4h.01M2.8 8h.01M2.8 12h.01',
  /** grouped/layers icon (bookshelf group view) */
  stack: 'M8 2l6 3-6 3-6-3 6-3zM3.5 8.5L8 11l4.5-2.5M3.5 11.5L8 14l4.5-2.5',
  /** fit-view corners (graph toolbar) */
  frame: 'M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5',
  /** full-window expand / restore */
  expand: 'M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4',
} as const;

/** round icon button with DSH hover fill */
export function IconButton(props: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  size?: number;
  color?: string;
  /** toggled look (filter buttons etc.) */
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
      className="sch-press"
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
      className="sch-press"
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
      className={`sch-input ${rest.className ?? ''}`}
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
      className={`sch-input ${rest.className ?? ''}`}
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
        className={`sch-input ${rest.className ?? ''}`}
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
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
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
    <div className="sch-fade" style={{
      flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', padding: '28px 20px', gap: 6,
    }}>
      <span style={{ color: 'var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption))', opacity: .85, marginBottom: 2 }}>
        {icon}
      </span>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.secondary }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: T.caption, lineHeight: 1.65, maxWidth: 250 }}>{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** removable chip for "active filters" rows */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 999, padding: '2px 4px 2px 8px',
      fontSize: 10.5, color: T.business, flex: 'none',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 32%, transparent)',
      maxWidth: 200,
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <IconButton label="×" size={15} onClick={onRemove} icon={<Icon d={Icons.close} size={9} color="inherit" />} />
    </span>
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
      <span style={{ color: T.caption, flex: 'none', width: 52 }}>{k}</span>
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

/** importance stars ⭐1-5 */
export function Stars({ value, onChange, size = 11 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1, color: T.warning, cursor: onChange ? 'pointer' : 'default' }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          onClick={onChange ? (e) => { e.stopPropagation(); onChange(i); } : undefined}
          style={{ opacity: i <= value ? 1 : 0.25, fontSize: size, lineHeight: 1 }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

/** status color for cards */
export function statusColor(status: string): string {
  switch (status) {
    case 'validated': return T.success;
    case 'adopted': return T.business;
    case 'dropped': return T.caption;
    default: return T.warning;
  }
}

/** category color for cards */
export function categoryColor(category: string): string {
  switch (category) {
    case 'method': return T.business;
    case 'theory': return T.purple;
    case 'dataset': return T.success;
    case 'evaluation': return T.warning;
    case 'engineering': return T.teal;
    default: return T.caption;
  }
}

/** edge color for the knowledge graph */
export function edgeColor(kind: string): string {
  switch (kind) {
    case 'proposes': return T.business;
    case 'improves': return T.success;
    case 'extends': return T.purple;
    case 'builds_on': return T.warning;
    case 'compares': return T.danger;
    case 'uses': return T.teal;
    default: return T.caption;
  }
}

/** truncate long text for graph labels */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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

/** 叠放 Modal 的栈:Esc 只关最顶层那一个。 */
const modalStack: symbol[] = [];

export function Modal({ title, onClose, children, width = 480 }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(Symbol('scholar-modal'));
  /** onClose 常是内联箭头函数——用 ref 承接,避免 effect 随父组件每次渲染重启 */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = idRef.current;
    modalStack.push(id);
    /** 关闭时把焦点还给打开弹窗的触发元素 */
    const trigger = document.activeElement;
    // 打开即聚焦第一个表单控件(无控件则聚焦弹窗本体)
    const first = boxRef.current?.querySelector<HTMLElement>('input, textarea, select');
    (first ?? boxRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modalStack[modalStack.length - 1] !== id) return; // 只响应最顶层
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
  }, []);

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z.modal, background: 'rgba(0,0,0,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="sch-fade"
        style={{
          position: 'relative',
          width: `min(${width}px, 90vw)`,
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 12, boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.4))',
          color: 'var(--dsw-alias-label-primary)', overflow: 'hidden',
        }}
      >
        {/* 不透明垫底 + 主题色表面(半透明皮肤下保证弹窗不透底) */}
        <div style={{ position: 'absolute', inset: 0, background: opaqueBase() }} />
        <div style={{ position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-layer-2, transparent)' }} />
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: 'none' }}>
            <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
            <IconButton label="close" onClick={onClose} icon={<Icon d={Icons.close} size={14} />} />
          </div>
          <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px' }}>{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
