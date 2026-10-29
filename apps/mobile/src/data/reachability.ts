import { useSyncExternalStore } from "react";

/**
 * No answer came back at all: no network, or the machine out of reach. `fetch` reports that with a
 * TypeError, which a bug throws too, so the transport turns it into this before anyone reads it.
 */
export class Unreachable extends Error {}

let unreachable = false;
const listeners = new Set<() => void>();

export const heard = (answered: boolean): void => {
  if (unreachable !== answered) return;
  unreachable = !answered;
  for (const listener of listeners) listener();
};

export const useUnreachable = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => unreachable,
    () => false,
  );
