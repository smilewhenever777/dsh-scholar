import { useSyncExternalStore } from 'react';

/**
 * Cross-view navigation: drawer tab + optional node focus.
 *
 * IMPORTANT: snapshots must be value-stable — useSyncExternalStore re-renders
 * only when getSnapshot() returns a NEW reference. Every mutation replaces the
 * whole state object; never mutate it in place.
 */
export type TabId = 'graph' | 'list' | 'story';

export type TFunc = (key: string, params?: Record<string, unknown>) => string;

export interface NavState {
  tab: TabId;
  /** node id to open in the editor / select on the graph (one-shot) */
  focusNodeId: string | null;
}

let state: NavState = { tab: 'list', focusNodeId: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const navBus = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  go(tab: TabId, focusNodeId?: string | null) {
    const next: NavState = { tab, focusNodeId: focusNodeId ?? null };
    if (next.tab !== state.tab || next.focusNodeId !== state.focusNodeId) {
      state = next;
      emit();
    }
  },
  consumeFocus() {
    if (state.focusNodeId) {
      state = { ...state, focusNodeId: null };
      emit();
    }
  },
};

export function useNav(): NavState {
  return useSyncExternalStore(navBus.subscribe, navBus.getSnapshot);
}
