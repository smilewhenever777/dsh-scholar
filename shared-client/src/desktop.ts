/** Official Desktop keeps the Web client runtime on a private application origin. */
export function isDesktop(): boolean {
  return window.location.protocol === 'dsh-app:' && window.location.hostname === 'app';
}

// Reserve native window chrome only. The host's overlay inset also includes
// content-header spacing, which leaves an empty band above a docked editor.
export const DOCK_TOP = 'var(--dsh-plugin-dock-top, 0px)';
const dockChromeStyles = `
  :root { --dsh-plugin-dock-top: var(--dsh-frame-chrome-top, var(--dsh-desktop-titlebar-inset, var(--dsh-windows-titlebar-height, 0px))); }
  html[data-platform="darwin"] { --dsh-plugin-dock-top: var(--dsh-frame-chrome-top, var(--dsh-desktop-titlebar-inset, 48px)); }
  html[data-fullscreen] { --dsh-plugin-dock-top: 0px; }
`;

/** Keep a readable editor, native navigation, a 400px conversation and two rails. */
export function clampDockWidth(width: number): number {
  const side = document.querySelector<HTMLElement>('[class*="sidebarCol"]')?.getBoundingClientRect().width ?? 280;
  const cap = Math.max(160, Math.min(1200, window.innerWidth * .7, Math.max(240, window.innerWidth - side - 400 - 68)));
  return Math.max(Math.min(300, cap), Math.min(cap, Number.isFinite(width) ? width : 440));
}

let directoryPicker: (() => Promise<string | null>) | undefined;
let remote: any;
let sidebar: any;
let composerWriter: ((text: string) => 'filled' | 'blocked') | undefined;
/** Optional capabilities never keep the basic plugin pending on an older Web host. */
export function bindDesktopServices(ctx: any): void {
  ctx.inject(['conversation', 'sessions', 'sidebarRight'], (child: any) => {
    if (typeof child.conversation?.input?.for !== 'function' || typeof child.sessions?.scope !== 'function' || !child.sidebarRight?.mounted?.getSnapshot) return;
    const write = (text: string): 'filled' | 'blocked' => {
      const id = child.sidebarRight.mounted.getSnapshot();
      const scope = id ? child.sessions.scope(id) : undefined;
      if (!scope) return 'blocked';
      const input = child.conversation.input.for(scope);
      const value = input.state.getSnapshot();
      if (value.phase !== 'plain' || value.draft.trim() || value.attachmentIds?.length || value.occurrences?.length) return 'blocked';
      input.setDraft(text);
      return 'filled';
    };
    composerWriter = write;
    return () => { if (composerWriter === write) composerWriter = undefined; };
  });
  ctx.inject(['sidebarRight'], (child: any) => {
    const current = child.sidebarRight;
    sidebar = current;
    return () => { if (sidebar === current) sidebar = undefined; };
  });
  ctx.inject(['uiWorkspace'], (child: any) => {
    const picker = typeof child.uiWorkspace?.pickDirectory === 'function' ? () => child.uiWorkspace.pickDirectory() : undefined;
    directoryPicker = picker;
    return () => { if (directoryPicker === picker) directoryPicker = undefined; };
  });
  ctx.inject(['remote', 'remote.session'], (child: any) => {
    const current = child.remote;
    remote = current;
    return () => { if (remote === current) remote = undefined; };
  });
}
/** Undefined means a legacy host; blocked means a known native target must be left intact. */
export function tryFillComposer(text: string): 'filled' | 'blocked' | undefined {
  try { return composerWriter?.(text); }
  catch { return 'blocked'; }
}
export function toggleOfficialSidebar(): void {
  if (typeof sidebar?.toggleExpanded === 'function') { sidebar.toggleExpanded(); return; }
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).filter(button => {
    if (!/右侧边栏|right sidebar/i.test(button.getAttribute('aria-label') ?? '')) return false;
    const r = button.getBoundingClientRect();
    return r.width > 0 && r.x >= 0 && r.x < window.innerWidth && getComputedStyle(button).visibility !== 'hidden';
  });
  (buttons.find(button => /收起|collapse|close/i.test(button.getAttribute('aria-label') ?? '')) ?? buttons[0])?.click();
}
export function canPickDirectory(): boolean { return typeof directoryPicker === 'function'; }
export async function pickDirectory(): Promise<string | null> {
  if (!directoryPicker) throw new Error('Directory picker unavailable');
  return directoryPicker();
}
export async function revealHostPath(path: string): Promise<'revealed' | 'copied'> {
  if (!path || /[\u0000-\u001f]/.test(path)) throw new Error('Invalid file path');
  // Reveal instead of executing a model-supplied source file with its OS association.
  try {
    if (typeof remote?.session?.openWorkspacePath === 'function') {
      const result = await remote.session.openWorkspacePath({ path, action: 'reveal' });
      if (result?.ok === true) return 'revealed';
    }
  } catch { /* Host unavailable: preserve a usable explicit fallback. */ }
  if (!navigator.clipboard?.writeText) throw new Error('File reveal and clipboard unavailable');
  await navigator.clipboard.writeText(path);
  return 'copied';
}

export interface WorkspaceInfo {
  cwd: string;
  title: string;
  items: { workspaceId: string; path: string; title: string }[];
}

/** The 0.2 Controller catalog has no `current`: selection belongs to the main view. */
export function selectedWorkspace(sessions: any, workspaces: any, sidebarRight?: any): WorkspaceInfo | null {
  const catalog = sessions?.list?.getSnapshot?.();
  const registry = workspaces?.list?.getSnapshot?.();
  const items = (registry?.items ?? []).filter((it: any) => typeof it.path === 'string' && it.path).map((it: any) => ({
    workspaceId: String(it.workspaceId ?? it.path), path: it.path, title: String(it.title ?? it.path),
  }));
  let id: string | undefined;
  if (sidebarRight?.mounted?.getSnapshot) {
    id = sidebarRight.mounted.getSnapshot();
  } else if (catalog?.current !== undefined && catalog?.current !== null) {
    id = catalog.current;
  } else {
    const owners = Object.values(catalog?.byId ?? {}).filter((s: any) => (s.retainedBy?.mainView ?? 0) > 0) as any[];
    if (owners.length === 1) id = owners[0].id;
  }
  const cwd = id === undefined ? undefined : catalog?.byId?.[id]?.cwd;
  if (typeof cwd !== 'string' || !cwd) return null;
  const normalize = (p: string) => {
    const n = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(n) ? n.toLowerCase() : n;
  };
  const hit = items.find((it: any) => normalize(it.path) === normalize(cwd));
  return { cwd, title: hit?.title ?? cwd.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() ?? cwd, items };
}

/** Window-owned state survives separate plugin bundles and releases only at the final owner. */
interface DockLayout {
  owners: number;
  update(): void;
  dispose(): void;
}
type DockWindow = Window & {
  __dshDock?: Record<string, { open: boolean; width: number; overlay?: boolean }>;
  __dshPluginDockLayout?: DockLayout;
  __dshDockOwners?: Record<string, { collapse(mode?: 'rail' | 'closed'): void; railWidth: number }>;
};
export function registerDockPanel(id: string, collapse: (mode?: 'rail' | 'closed') => void, railWidth: number): () => void {
  const w = window as DockWindow;
  const owner = { collapse, railWidth };
  w.__dshDockOwners = { ...w.__dshDockOwners, [id]: owner };
  return () => { if (w.__dshDockOwners?.[id] === owner) delete w.__dshDockOwners[id]; };
}
export function installDockLayout(): () => void {
  const w = window as DockWindow;
  if (!w.__dshPluginDockLayout) {
    const body = document.body;
    const margin = body.style.marginRight;
    const variable = document.documentElement.style.getPropertyValue('--dsh-squeeze');
    const style = document.createElement('style');
    style.dataset.dshPluginDockLayout = '';
    document.head.append(style);
    let frame: HTMLElement | null = null;
    let observer: MutationObserver | undefined;
    let focused: string | undefined;
    const update = (event?: Event) => {
      const id = (event as CustomEvent | undefined)?.detail?.id;
      if (typeof id === 'string' && (w.__dshDock?.[id]?.width ?? 0) > 64) focused = id;
      let footprints = Object.values(w.__dshDock ?? {});
      const full = footprints.some(f => f.open && f.overlay);
      let total = footprints.reduce((n, f) => n + (f.open && Number.isFinite(f.width) ? Math.max(0, f.width) : 0), 0);
      const next = document.querySelector<HTMLElement>('[data-dsh-plugin-shell-frame]') ??
        Array.from(document.querySelectorAll<HTMLElement>('[class*="frame"]')).find(el => !el.closest('[data-dsh-plugin]')) ?? null;
      if (next !== frame) {
        observer?.disconnect();
        frame?.removeAttribute('data-dsh-plugin-shell-frame');
        frame = next;
        frame?.setAttribute('data-dsh-plugin-shell-frame', '');
        if (frame) observer?.observe(frame, { attributes: true, attributeFilter: ['data-rightbar-collapsed', 'data-rightbar-fullscreen'] });
      }
      const side = frame?.querySelector<HTMLElement>('[class*="sidebarCol"]')?.getBoundingClientRect().width ?? 0;
      let right = sidebar?.isExpanded?.() === false ? 0 : frame?.querySelector<HTMLElement>('[class*="rightbarCol"]')?.getBoundingClientRect().width ?? 0;
      const nativeExpanded = sidebar?.isExpanded?.() === true || right > 0;
      if (nativeExpanded) {
        // In overlay presentation the native grid track is only a rail; its
        // expanded panel extends left of that track. Measure the visible panel.
        const column = frame?.querySelector<HTMLElement>('[class*="rightbarCol"]');
        for (const element of Array.from(column?.querySelectorAll<HTMLElement>('*') ?? [])) {
          const rect = element.getBoundingClientRect();
          if (rect.height > window.innerHeight * .5 && getComputedStyle(element).visibility !== 'hidden') right = Math.max(right, Math.min(window.innerWidth, rect.width));
        }
      }
      if (nativeExpanded && (right === 0 || total > Math.max(0, window.innerWidth - side - right - 400))) {
        const selected = typeof id === 'string' ? w.__dshDock?.[id] : undefined;
        if (selected?.open && selected.width > 64 && typeof sidebar?.toggleExpanded === 'function') {
          // A plugin gesture wins the scarce track; reopening the native pane
          // later is its own explicit gesture and will release these drawers.
          sidebar.toggleExpanded();
          right = 0;
        } else {
          for (const [other, owner] of Object.entries(w.__dshDockOwners ?? {})) {
            if (!w.__dshDock?.[other]?.open) continue;
            owner.collapse('closed');
            w.__dshDock[other] = { open: false, width: 0 };
          }
          total = Object.values(w.__dshDock ?? {}).reduce((n, f) => n + (f.open ? Math.max(0, f.width) : 0), 0);
        }
      }
      const budget = Math.max(300, window.innerWidth - side - right - 400);
      // When a window cannot fit several editors, retain the most recently
      // opened editor and collapse its siblings to reachable rails.
      if (!full && total > budget) {
        for (const [other, owner] of Object.entries(w.__dshDockOwners ?? {})) {
          const footprint = w.__dshDock?.[other];
          if (other === focused || !footprint?.open || footprint.width <= 64) continue;
          owner.collapse();
          total -= footprint.width - owner.railWidth;
          w.__dshDock![other] = { open: true, width: owner.railWidth };
          if (total <= budget) break;
        }
      }
      // Keep native navigation at the real viewport width. Shrinking the frame
      // triggers Desktop's responsive sidebar collapse and hides our own entries.
      const width = full ? 0 : Math.min(total, Math.max(0, window.innerWidth - side - right - 400));
      body.style.marginRight = margin;
      document.documentElement.style.setProperty('--dsh-squeeze', `${width}px`);
      style.textContent = dockChromeStyles + '[data-dsh-plugin-shell-frame] { width: 100vw !important; box-sizing: border-box !important; padding-right: var(--dsh-squeeze, 0px) !important; }';
    };
    observer = new MutationObserver(() => update());
    const timer = setInterval(update, 1000); // Handles a shell frame replaced by hot reload.
    window.addEventListener('dsh-dock-change', update);
    window.addEventListener('resize', update);
    w.__dshPluginDockLayout = { owners: 0, update, dispose() {
      clearInterval(timer);
      observer?.disconnect();
      window.removeEventListener('dsh-dock-change', update);
      window.removeEventListener('resize', update);
      frame?.removeAttribute('data-dsh-plugin-shell-frame');
      style.remove();
      body.style.marginRight = margin;
      if (variable) document.documentElement.style.setProperty('--dsh-squeeze', variable);
      else document.documentElement.style.removeProperty('--dsh-squeeze');
    } };
  }
  const state = w.__dshPluginDockLayout;
  state.owners++;
  state.update();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.owners === 0) { state.dispose(); delete w.__dshPluginDockLayout; }
    else state.update();
  };
}
