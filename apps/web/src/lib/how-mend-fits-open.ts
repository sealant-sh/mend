import { useSyncExternalStore } from "react";

/**
 * Whether How Mend fits together is open again as a dialog, and where focus goes when it closes.
 * The account menu (and, on a phone, the account sheet in Settings) opens it; the signed-in layout
 * draws it once. The menu can't draw the dialog itself: the dialog's pictures draw the sidebar,
 * which holds the menu.
 */
export interface FitsDialogState {
  readonly open: boolean;
  /** The control that opened it, still on the page once the menu closes; null for none. */
  readonly returnTo: HTMLElement | null;
}

const CLOSED: FitsDialogState = { open: false, returnTo: null };

let state: FitsDialogState = CLOSED;
const listeners = new Set<() => void>();

const set = (next: FitsDialogState) => {
  state = next;
  for (const listener of listeners) listener();
};

export const fitsDialog = {
  open: (returnTo: HTMLElement | null = null) => set({ open: true, returnTo }),
  close: () => set({ ...state, open: false }),
  use: (): FitsDialogState =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => state,
      () => CLOSED,
    ),
};
