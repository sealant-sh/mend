import { useSyncExternalStore } from "react";

/** Harness choices offered first by the desktop launcher. */
export const HARNESSES = ["claude", "codex", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Desktop preferences that do not belong to a project or session. */
export interface AppSettings {
  /** Harness placed first in the session launcher. */
  readonly defaultHarness: Harness;
}

const KEY = "mend-app-settings";
const FALLBACK: AppSettings = { defaultHarness: "claude" };

const parseHarness = (value: unknown): Harness | null =>
  HARNESSES.find((harness) => harness === value) ?? null;

const read = (): AppSettings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return FALLBACK;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("defaultHarness" in parsed)) {
      return FALLBACK;
    }
    return { defaultHarness: parseHarness(parsed.defaultHarness) ?? FALLBACK.defaultHarness };
  } catch {
    return FALLBACK;
  }
};

let settings: AppSettings = read();
const listeners = new Set<() => void>();

const set = (next: AppSettings) => {
  settings = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable. The in-memory preference still applies this run.
  }
  for (const listener of listeners) listener();
};

/** Subscribe to desktop-only workbench preferences. */
export const useAppSettings = (): AppSettings =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => settings,
  );

/** Update desktop-only workbench preferences. */
export const appSettings = {
  setDefaultHarness: (defaultHarness: Harness) => set({ defaultHarness }),
};
