/**
 * dsh-dispatch client entry(P4):
 * 注册 locale 字典 + 官方右侧 Sidebar「任务派发」页签(order 63)。
 * 旧宿主无 sidebarRightTabs/sidebarRight 时静默降级(仅无页签,host 半不受影响)。
 */
import { zh, en } from './locales';
import { registerDispatchRightbar } from './rightbar';
import { WorkbenchOverlay, WorkbenchTrigger } from './workbench';

const NS = 'dsh-dispatch';
const APPLY_FLAG = '__dshDispatchClientApplied';

export const inject = ['slots', 'locale'];

export function apply(ctx: any): void {
  const g = globalThis as Record<string, unknown>;
  if (g[APPLY_FLAG]) return;
  g[APPLY_FLAG] = true;
  ctx.effect(() => () => { g[APPLY_FLAG] = false; }, 'dsh-dispatch: apply guard');
  // 字典重复注册要容忍(fiber 重挂顺序不保证,与 dsh-trajectory 同款)
  try {
    ctx.locale.register(NS, { zh, en });
  } catch { /* already registered by a previous apply */ }
  registerDispatchRightbar(ctx);
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-dispatch-workbench', order: 13, locale: NS,
  }, WorkbenchTrigger));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-dispatch-workbench', order: 120, locale: NS,
  }, WorkbenchOverlay));
}
