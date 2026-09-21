/**
 * Overlay panel state.
 *
 * The panel's trigger lives in a *session-scoped* slot and the panel itself in
 * the *root-scoped* `shell.overlay`, so the overlay has no `sessionId` of its
 * own. This store carries both the open flag and the session the trigger was
 * opened for, and hands each side a stable snapshot for `useSyncExternalStore`.
 *
 * @module dsh-context-compaction-optimizer/client/panel-state
 */

type Listener = () => void;

/** Stable snapshot handed to React. */
export interface PanelSnapshot {
  readonly open: boolean;
  readonly sessionId: string | null;
}

/** Panel state handle. */
export interface PanelState {
  subscribe(listener: Listener): () => void;
  snapshot(): PanelSnapshot;
  open(sessionId: string): void;
  close(): void;
  toggle(sessionId: string): void;
}

/** Create the shared panel state. */
export function createPanelState(): PanelState {
  let current: PanelSnapshot = { open: false, sessionId: null };
  const listeners = new Set<Listener>();

  // Replace the snapshot object only on a real change: an unstable snapshot
  // makes `useSyncExternalStore` re-render without end.
  const commit = (next: PanelSnapshot): void => {
    if (next.open === current.open && next.sessionId === current.sessionId) return;
    current = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => current,
    open(sessionId) {
      commit({ open: true, sessionId });
    },
    close() {
      commit({ open: false, sessionId: current.sessionId });
    },
    toggle(sessionId) {
      const sameSession = current.sessionId === sessionId;
      commit({ open: sameSession ? !current.open : true, sessionId });
    },
  };
}
