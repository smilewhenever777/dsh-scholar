/**
 * 反馈组件(Wave 1):自绘 ConfirmModal(取代 window.prompt)与 toast(取代 window.alert)。
 * 模式抄 dsh-scholar:opaqueBase 双层底防半透明皮肤、useModalFocus 栈式焦点圈、
 * toast 顶部胶囊 2.5s 自动消失(portal 到 body,浮于一切遮罩之上)。
 */
import React from 'react';
import { createPortal } from 'react-dom';

/* ---------- 焦点管理(栈式,跨插件共享 window.__dshModalStack) ---------- */

interface FocusHandle { restore: () => void }
const stack: FocusHandle[] = (globalThis as { __dshModalStack?: FocusHandle[] }).__dshModalStack ?? [];
(globalThis as { __dshModalStack?: FocusHandle[] }).__dshModalStack = stack;

/** 打开 modal 时挂载:圈禁 Tab、Esc 只关栈顶、卸载恢复触发元素。 */
export function useModalFocus(onClose: () => void) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handle: FocusHandle = { restore: () => { try { previous?.focus(); } catch { /* 已卸载 */ } } };
    stack.push(handle);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button');
    first?.focus();
    const keydown = (ev: KeyboardEvent) => {
      if (stack[stack.length - 1] !== handle) return;
      if (ev.key === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); onClose(); return; }
      if (ev.key !== 'Tab' || !ref.current) return;
      const focusables = [...ref.current.querySelectorAll<HTMLElement>('input, textarea, select, button, [href]')].filter((el) => !el.disabled);
      if (!focusables.length) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === firstEl) { ev.preventDefault(); lastEl.focus(); }
      else if (!ev.shiftKey && document.activeElement === lastEl) { ev.preventDefault(); firstEl.focus(); }
    };
    const focusin = (ev: FocusEvent) => {
      if (stack[stack.length - 1] !== handle || !ref.current) return;
      if (ev.target instanceof Node && ref.current.contains(ev.target)) return;
      // 焦点逃逸到背景:拉回弹窗内
      const focusables = [...ref.current.querySelectorAll<HTMLElement>('input, textarea, select, button')].filter((el) => !el.disabled);
      (focusables[0] ?? ref.current).focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin, true);
      const index = stack.indexOf(handle);
      if (index >= 0) stack.splice(index, 1);
      handle.restore();
    };
  }, [onClose]);
  return ref;
}

/* ---------- 不透明垫底(防半透明皮肤透壁纸,抄 scholar Modal) ---------- */

function opaqueBase(): string {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor;
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg);
    if (match && (match[4] === undefined || Number(match[4]) > 0.98)) {
      return `rgb(${match[1]},${match[2]},${match[3]})`;
    }
  }
  return 'var(--dsw-alias-bg-base, #161616)';
}

/* ---------- ConfirmModal(多行输入 + 字数,取代 prompt) ---------- */

export interface ConfirmRequest {
  title: string;
  description?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  danger?: boolean;
  requireText?: boolean;
  maxLength?: number;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

export function ConfirmModal(props: ConfirmRequest) {
  const [text, setText] = React.useState(props.initial ?? '');
  const maxLength = props.maxLength ?? 2000;
  const ref = useModalFocus(props.onClose);
  const empty = props.requireText !== false && !text.trim();
  return createPortal(
    <>
      <button type="button" aria-label="关闭" onClick={props.onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 2147483101, border: 0, padding: 0, cursor: 'default', background: 'rgba(0,0,0,.32)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={props.title}
        style={{
          position: 'fixed', left: '50%', top: '18vh', transform: 'translateX(-50%)',
          width: 'min(440px, 92vw)', zIndex: 2147483102,
          borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
          background: opaqueBase(), boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.4))',
          padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10,
        }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{props.title}</div>
        {props.description && <div style={{ fontSize: 11.5, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' }}>{props.description}</div>}
        <textarea
          value={text}
          maxLength={maxLength}
          placeholder={props.placeholder ?? ''}
          onChange={(ev) => setText(ev.target.value)}
          style={{
            width: '100%', minHeight: 72, resize: 'vertical', borderRadius: 8, padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
            color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <span style={{ marginRight: 'auto', fontSize: 10, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>{text.length}/{maxLength}</span>
          <button type="button" onClick={props.onClose}
            style={btnStyle(false)}>取消</button>
          <button type="button" disabled={empty}
            onClick={() => { if (!empty) props.onConfirm(text.trim()); }}
            style={btnStyle(props.danger ? 'danger' : true, empty)}>{props.confirmText ?? '确认'}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

function btnStyle(tone: boolean | 'danger', disabled?: boolean): React.CSSProperties {
  const danger = tone === 'danger';
  const primary = tone === true;
  const color = danger ? 'var(--dsw-alias-state-error-primary, #e5484d)'
    : primary ? '#fff' : 'var(--dsw-alias-label-secondary)';
  return {
    height: 26, padding: '0 12px', borderRadius: 7, border: 0, cursor: disabled ? 'default' : 'pointer',
    fontSize: 12, fontWeight: 600, color, opacity: disabled ? 0.45 : 1,
    background: danger ? 'var(--dsw-alias-state-error-primary, #e5484d)'
      : primary ? 'var(--dsw-alias-state-business-primary, #4d6bfe)'
      : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))',
  };
}

/* ---------- toast(顶部胶囊,portal 到 body,浮于遮罩之上) ---------- */

export type ToastTone = 'info' | 'success' | 'error' | 'warn';
interface ToastItem { id: number; text: string; tone: ToastTone }

let toastSeq = 0;
const toastListeners = new Set<() => void>();
let toastItems: ToastItem[] = [];

export function showToast(text: string, tone: ToastTone = 'info') {
  const item: ToastItem = { id: ++toastSeq, text, tone };
  toastItems = [...toastItems.slice(-2), item];
  for (const fn of toastListeners) fn();
  setTimeout(() => {
    toastItems = toastItems.filter((x) => x.id !== item.id);
    for (const fn of toastListeners) fn();
  }, 2600);
}

export function ToastHost() {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    toastListeners.add(force);
    return () => { toastListeners.delete(force); };
  }, [force]);
  if (!toastItems.length) return null;
  return createPortal(
    <div style={{ position: 'fixed', top: 'calc(var(--dsh-desktop-titlebar-inset, 0px) + 10px)', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483000, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', pointerEvents: 'none' }}>
      {toastItems.map((item) => {
        const color = item.tone === 'error' ? 'var(--dsw-alias-state-error-primary, #e5484d)'
          : item.tone === 'warn' ? 'var(--dsw-alias-state-warn-primary, #f5a524)'
          : item.tone === 'success' ? 'var(--dsw-alias-state-success-primary, #30a46c)'
          : 'var(--dsw-alias-state-business-primary, #4d6bfe)';
        return <div key={item.id} role="status"
          style={{
            maxWidth: '70vw', borderRadius: 999, padding: '6px 14px', fontSize: 12, lineHeight: 1.5,
            background: opaqueBase(), border: `1px solid ${color}`,
            boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.25))',
            color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all',
          }}>{item.text}</div>;
      })}
    </div>,
    document.body,
  );
}
