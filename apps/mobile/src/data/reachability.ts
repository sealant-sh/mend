import { useSyncExternalStore } from "react";

import type { PairingKey } from "@/data/pairing-key";

/**
 * No answer came back at all: no network, or the machine out of reach. `fetch` reports that with a
 * TypeError, which a bug throws too, so the transport turns it into this before anyone reads it.
 */
export class Unreachable extends Error {}

let unreachable: PairingKey | null = null;
const listeners = new Set<() => void>();

export const heard = (pairing: PairingKey, answered: boolean): void => {
  const next = answered ? (unreachable === pairing ? null : unreachable) : pairing;
  if (next === unreachable) return;
  unreachable = next;
  for (const listener of listeners) listener();
};

export const useUnreachable = (pairing: PairingKey): boolean =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => unreachable === pairing,
    () => false,
  );
