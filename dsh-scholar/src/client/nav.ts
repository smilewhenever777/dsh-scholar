import { useSyncExternalStore } from 'react';

/**
 * Cross-view navigation: drawer tab + optional paper/card focus.
 *
 * IMPORTANT: snapshots must be value-stable — useSyncExternalStore re-renders
 * only when getSnapshot() returns a NEW reference. Every mutation replaces the
 * whole state object; never mutate it in place.
 */
export type TabId = 'papers' | 'graph' | 'cards';

export type TFunc = (key: string, params?: Record<string, unknown>) => string;

export interface NavState {
  tab: TabId;
  paperId: string | null;
  cardId: string | null;
  /** paper id prefilled for a new idea card (cross-view capture) */
  prefillPaperId: string | null;
}

let state: NavState = { tab: 'papers', paperId: null, cardId: null, prefillPaperId: null };
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
  go(tab: TabId, paperId?: string | null, cardId?: string | null, prefillPaperId?: string | null) {
    const next: NavState = { tab, paperId: paperId ?? null, cardId: cardId ?? null, prefillPaperId: prefillPaperId ?? null };
    if (next.tab !== state.tab || next.paperId !== state.paperId || next.cardId !== state.cardId || next.prefillPaperId !== state.prefillPaperId) {
      state = next;
      emit();
    }
  },
  consumePrefill() {
    if (state.prefillPaperId) {
      state = { ...state, prefillPaperId: null };
      emit();
    }
  },
  consumePaperId() {
    if (state.paperId) {
      state = { ...state, paperId: null };
      emit();
    }
  },
  consumeCardId() {
    if (state.cardId) {
      state = { ...state, cardId: null };
      emit();
    }
  },
};

export function useNav(): NavState {
  return useSyncExternalStore(navBus.subscribe, navBus.getSnapshot);
}
