import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PanelAction { label: string; run(): void }

/** Secondary window actions stay reachable without crowding the editor title. */
export function PanelMenu({ label, actions }: { label: string; actions: PanelAction[] }) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (focus = false) => { setPosition(null); if (focus) trigger.current?.focus(); };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', resize);
    };
  }, [position]);
  return <>
    <button ref={trigger} type="button" title={label} aria-label={label} aria-haspopup="menu"
      aria-expanded={!!position} aria-controls={position ? id : undefined}
      onClick={() => {
        if (position) { close(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ top: Math.max(8, Math.min(rect.bottom + 6, innerHeight - actions.length * 34 - 18)), right: Math.max(8, innerWidth - rect.right) });
      }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); trigger.current?.click(); } }}
      style={{ width: 28, height: 28, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 6, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', background: position ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; }}
      onMouseLeave={e => { if (!position) e.currentTarget.style.background = 'transparent'; }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>
    </button>
    {position && createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
      data-dsh-plugin="panel-menu" className="dshwb-menu"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={event => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); event.stopPropagation(); items[next]?.focus(); }
      }}
      style={{ position: 'fixed', ...position, zIndex: 2147483101, minWidth: 176, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', padding: 5, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.16))' }}>
      {actions.map(action => <button key={action.label} role="menuitem" type="button"
        onClick={() => { close(true); action.run(); }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        style={{ display: 'block', width: '100%', minHeight: 34, border: 0, borderRadius: 6, padding: '6px 10px', textAlign: 'left', font: 'inherit', fontSize: 12, color: 'inherit', background: 'transparent', cursor: 'pointer' }}>{action.label}</button>)}
    </div>, document.body)}
  </>;
}
