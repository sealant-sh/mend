// Display preferences: a theme override and a text scale, stored on device
// beside the server config. A tiny external store (same pattern as the
// scheme hook in theme/evidence.ts) — no provider, hydrated once at import,
// every subscriber re-renders when a preference changes.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

const ThemePreference = Schema.Literals(["system", "light", "dark"]);
export type ThemePreference = typeof ThemePreference.Type;

export interface DisplayPreferences {
  readonly theme: ThemePreference;
  /** Multiplies every type size in the app. 1 is the designed scale. */
  readonly textScale: number;
}

export const TEXT_SCALES = [
  { label: "S", value: 0.9 },
  { label: "M", value: 1 },
  { label: "L", value: 1.1 },
  { label: "XL", value: 1.2 },
] as const;

const DEFAULTS: DisplayPreferences = { theme: "system", textScale: 1 };
const STORAGE_KEY = "mend-display";

/** The stored record: either preference may be missing, and the defaults fill it in. */
const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      theme: Schema.optionalKey(ThemePreference),
      textScale: Schema.optionalKey(Schema.Number),
    }),
  ),
);

let current = DEFAULTS;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

void AsyncStorage.getItem(STORAGE_KEY)
  .then((raw) => {
    if (raw === null) return undefined;
    try {
      current = { ...DEFAULTS, ...decodeStored(raw) };
      notify();
    } catch {
      // Corrupt record — the defaults stand; the next save rewrites it.
    }
    return undefined;
  })
  // The web build's static render runs in Node, where there is no localStorage
  // and the read rejects; the defaults stand there and the browser hydrates.
  .catch(() => undefined);

export const setDisplayPreferences = (patch: Partial<DisplayPreferences>): void => {
  current = { ...current, ...patch };
  notify();
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export const useDisplayPreferences = (): DisplayPreferences =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULTS,
  );
