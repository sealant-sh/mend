// Launch tunables: model, thinking effort, priority. The lists come from the
// server (`useHarnessModels` in live.ts, docs/models-audit.md); this file only
// keeps what the person last chose, per harness on device (same external-store
// pattern as preferences.ts). The picker (`modelPicker` in
// `@mend/domain/workbench`) turns the choice and the catalog into what to show
// and what rides `POST /sessions/:id/launch` at start.

import { EFFORT_LEVELS, type EffortLevel } from "@mend/domain/workbench";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

export type { EffortLevel };

/**
 * `model` null means nothing chosen yet: the picker preselects the server's default, and reads a
 * saved id the catalog no longer lists the same way. `effort` null is the harness's own default.
 */
export interface LaunchOptions {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly speed: "fast" | null;
}

export const DEFAULT_LAUNCH_OPTIONS: LaunchOptions = { model: null, effort: null, speed: null };

type LaunchPrefs = Readonly<Record<string, LaunchOptions>>;

const STORAGE_KEY = "mend-launch-options";

let current: LaunchPrefs = {};
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

const isEffort = (value: unknown): value is EffortLevel =>
  typeof value === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(value);

const parsePrefs = (raw: string): LaunchPrefs => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const prefs: Record<string, LaunchOptions> = {};
    for (const [harness, options] of Object.entries(value)) {
      if (typeof options !== "object" || options === null) continue;
      const row: Readonly<Record<string, unknown>> = options;
      prefs[harness] = {
        model: typeof row.model === "string" && row.model !== "" ? row.model : null,
        effort: isEffort(row.effort) ? row.effort : null,
        speed: row.speed === "fast" ? "fast" : null,
      };
    }
    return prefs;
  } catch {
    return {};
  }
};

void AsyncStorage.getItem(STORAGE_KEY)
  .then((raw) => {
    if (raw !== null) {
      current = parsePrefs(raw);
      notify();
    }
    return undefined;
  })
  // The web build's static render runs in Node, where there is no localStorage
  // and the read rejects; the defaults stand there and the browser hydrates.
  .catch(() => undefined);

export const setLaunchOptions = (harness: string, options: LaunchOptions): void => {
  current = { ...current, [harness]: options };
  notify();
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export const useLaunchOptions = (harness: string): LaunchOptions =>
  useSyncExternalStore(
    subscribe,
    () => current[harness] ?? DEFAULT_LAUNCH_OPTIONS,
    () => DEFAULT_LAUNCH_OPTIONS,
  );
