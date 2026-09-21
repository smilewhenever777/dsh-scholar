import { useEffect, useRef } from 'react';

type Entry = { id: symbol; box: HTMLElement };
// Shared across independently bundled Scholar and Trajectory clients.
const shared = globalThis as typeof globalThis & { __dshModalStack?: Entry[] };
const stack = shared.__dshModalStack ??= [];
export function useModalFocus(onClose: () => void) {
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const layer = useRef(stack.length);
  closeRef.current = onClose;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const entry = { id: Symbol('dsh-modal'), box };
    const trigger = document.activeElement;
    stack.push(entry);
    const top = () => stack.at(-1) === entry;
    const items = () => [...box.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0);
    const first = () => items()[0] ?? box;
    (box.querySelector<HTMLElement>('[autofocus], input:not([disabled]), textarea:not([disabled])') ?? first()).focus();
    const key = (e: KeyboardEvent) => {
      if (!top() || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); }
      if (e.key === 'Tab') {
        const all = items(), current = document.activeElement;
        if (!all.length || !box.contains(current) || (e.shiftKey ? current === all[0] || current === box : current === all.at(-1))) {
          e.preventDefault(); (e.shiftKey ? all.at(-1) ?? box : first()).focus();
        }
      }
    };
    const focus = (e: FocusEvent) => { if (top() && !box.contains(e.target as Node)) first().focus(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    return () => {
      const wasTop = top();
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
      if (wasTop) {
        if (trigger instanceof HTMLElement && trigger.isConnected && (!stack.length || stack.at(-1)!.box.contains(trigger))) trigger.focus();
        else stack.at(-1)?.box.focus();
      }
    };
  }, []);
  return { boxRef, layer: layer.current };
}
