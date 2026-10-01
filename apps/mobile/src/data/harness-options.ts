// Launch tunables: model, thinking effort, priority. Advisory catalogs
// mirrored from `@mend/domain/workbench` (harness-launch.ts) — the authority;
// mobile keeps a local transcription because pulling the domain package would
// drag the whole Effect runtime into the native bundle for three arrays. The
// contract keeps `model` free-form, so an out-of-date list only limits the
// picker, never what the server accepts.
//
// Chosen options persist per harness on device (same external-store pattern
// as preferences.ts) and ride `POST /sessions/:id/launch` at start.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What each harness's CLI accepts at all; a model may take fewer. */
export const HARNESS_EFFORTS: Readonly<Record<string, ReadonlyArray<EffortLevel>>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

/** `fast` = codex `service_tier=priority`; claude has no launch-time flag. */
export const FAST_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(["codex"]);

export interface HarnessModelOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  /** The efforts this model takes, when fewer than its harness's. */
  readonly efforts?: ReadonlyArray<EffortLevel>;
}

const CODEX_UP_TO_MAX: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh", "max"];
const CODEX_UP_TO_XHIGH: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh"];

export const HARNESS_MODELS: Record<string, ReadonlyArray<HarnessModelOption>> = {
  claude: [
    { id: "fable", label: "Fable · latest", isDefault: true },
    { id: "opus", label: "Opus · latest", isDefault: false },
    { id: "sonnet", label: "Sonnet · latest", isDefault: false },
    { id: "haiku", label: "Haiku · latest", isDefault: false },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true },
    { id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: false },
    { id: "gpt-6-sol", label: "GPT-6 Sol", isDefault: false },
    { id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: false, efforts: CODEX_UP_TO_MAX },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", isDefault: false },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", isDefault: false },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", isDefault: false, efforts: CODEX_UP_TO_MAX },
    { id: "gpt-5.5", label: "GPT-5.5", isDefault: false, efforts: CODEX_UP_TO_XHIGH },
  ],
};

/** The efforts to offer for a harness and model: the model's own when catalogued, else the harness's. */
export const effortsFor = (harness: string, model: string | null): ReadonlyArray<EffortLevel> =>
  HARNESS_MODELS[harness]?.find((option) => option.id === model)?.efforts ??
  HARNESS_EFFORTS[harness] ??
  EFFORT_LEVELS;

/** null = the harness's own default; the field stays off the launch wire. */
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
      const row = options as Readonly<Record<string, unknown>>;
      // A saved model the catalog no longer lists (`claude-fable-5`, `gpt-5.4`) reads as the
      // default, as the web and desktop pickers already do.
      const listed =
        typeof row.model === "string" &&
        (HARNESS_MODELS[harness] ?? []).some((option) => option.id === row.model);
      prefs[harness] = {
        model: listed && typeof row.model === "string" ? row.model : null,
        effort: isEffort(row.effort) ? row.effort : null,
        speed: row.speed === "fast" ? "fast" : null,
      };
    }
    return prefs;
  } catch {
    return {};
  }
};

void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
  if (raw !== null) {
    current = parsePrefs(raw);
    notify();
  }
  return undefined;
});

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
