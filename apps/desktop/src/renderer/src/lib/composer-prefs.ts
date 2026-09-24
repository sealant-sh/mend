import {
  EFFORT_LEVELS,
  HARNESS_MODELS,
  PERMISSION_MODES,
  SPEED_MODES,
  type EffortLevel,
  type PermissionMode,
  type SpeedMode,
} from "@mend/domain/workbench";
import { useSyncExternalStore } from "react";

import { HARNESSES, type Harness } from "#/lib/app-settings";

/**
 * Sticky composer choices — last-used harness per project, last-used
 * model/effort/permission/speed per project + harness. Same shape as the web
 * app's lib/composer-prefs.ts and this app's app-settings.ts: module state +
 * one localStorage key + useSyncExternalStore; writes are event-driven from
 * the composer's handlers. The app-wide default harness (Settings) is the
 * fallback when a project has not picked its own.
 */

/**
 * `effort`/`permission`/`speed` absent = harness default (no flag composed). `mode` null = the
 * PTY launch every harness has; `protocol` runs the agent as a conversation (claude, codex).
 */
export interface HarnessPrefs {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly permission: PermissionMode | null;
  readonly speed: SpeedMode | null;
  readonly mode: "protocol" | null;
}

interface ProjectPrefs {
  readonly harness: Harness | null;
  readonly byHarness: Partial<Record<Harness, HarnessPrefs>>;
}

interface ComposerPrefs {
  readonly byProject: Readonly<Record<string, ProjectPrefs>>;
}

const KEY = "mend-composer-prefs";
const EMPTY: ComposerPrefs = { byProject: {} };
const listeners = new Set<() => void>();
let current: ComposerPrefs = EMPTY;

const HARNESS_NAMES: ReadonlyArray<string> = HARNESSES;
const EFFORT_NAMES: ReadonlyArray<string> = EFFORT_LEVELS;
const PERMISSION_NAMES: ReadonlyArray<string> = PERMISSION_MODES;
const SPEED_NAMES: ReadonlyArray<string> = SPEED_MODES;

const isHarness = (value: unknown): value is Harness =>
  typeof value === "string" && HARNESS_NAMES.includes(value);
const isEffort = (value: unknown): value is EffortLevel =>
  typeof value === "string" && EFFORT_NAMES.includes(value);
const isPermission = (value: unknown): value is PermissionMode =>
  typeof value === "string" && PERMISSION_NAMES.includes(value);
const isSpeed = (value: unknown): value is SpeedMode =>
  typeof value === "string" && SPEED_NAMES.includes(value);

/** Tolerant revive — a malformed or stale blob degrades to defaults, never throws. */
const revive = (raw: string): ComposerPrefs => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const record = parsed as { byProject?: unknown };
  const byProject: Record<string, ProjectPrefs> = {};
  if (typeof record.byProject === "object" && record.byProject !== null) {
    for (const [projectId, value] of Object.entries(record.byProject)) {
      const row = value as { harness?: unknown; byHarness?: unknown };
      const byHarness: Partial<Record<Harness, HarnessPrefs>> = {};
      if (typeof row.byHarness === "object" && row.byHarness !== null) {
        for (const [harness, prefs] of Object.entries(row.byHarness)) {
          if (!isHarness(harness)) continue;
          const p = prefs as {
            model?: unknown;
            effort?: unknown;
            permission?: unknown;
            speed?: unknown;
            mode?: unknown;
          };
          byHarness[harness] = {
            model: typeof p.model === "string" ? p.model : null,
            effort: isEffort(p.effort) ? p.effort : null,
            permission: isPermission(p.permission) ? p.permission : null,
            speed: isSpeed(p.speed) ? p.speed : null,
            mode: p.mode === "protocol" ? "protocol" : null,
          };
        }
      }
      byProject[projectId] = { harness: isHarness(row.harness) ? row.harness : null, byHarness };
    }
  }
  return { byProject };
};

try {
  const stored = localStorage.getItem(KEY);
  if (stored !== null) current = revive(stored);
} catch {
  // Malformed blob or no storage — start clean.
}

const write = (next: ComposerPrefs): void => {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the choice still applies this run.
  }
  for (const listener of listeners) listener();
};

const projectPrefs = (projectId: string): ProjectPrefs =>
  current.byProject[projectId] ?? { harness: null, byHarness: {} };

export const setComposerHarness = (projectId: string, harness: Harness): void =>
  write({
    byProject: { ...current.byProject, [projectId]: { ...projectPrefs(projectId), harness } },
  });

export const setComposerHarnessPrefs = (
  projectId: string,
  harness: Harness,
  prefs: Partial<HarnessPrefs>,
): void => {
  const project = projectPrefs(projectId);
  const merged: HarnessPrefs = {
    model: null,
    effort: null,
    permission: null,
    speed: null,
    mode: null,
    ...project.byHarness[harness],
    ...prefs,
  };
  write({
    byProject: {
      ...current.byProject,
      [projectId]: { ...project, byHarness: { ...project.byHarness, [harness]: merged } },
    },
  });
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export const useComposerPrefs = (): ComposerPrefs => useSyncExternalStore(subscribe, () => current);

/** The project's sticky harness, else the app-wide default from Settings. */
export const effectiveHarness = (
  prefs: ComposerPrefs,
  projectId: string,
  fallback: Harness,
): Harness => prefs.byProject[projectId]?.harness ?? fallback;

/** The catalog default model id for a harness, when it has a catalog. */
export const defaultModel = (harness: Harness): string | null =>
  HARNESS_MODELS[harness]?.find((option) => option.isDefault)?.id ??
  HARNESS_MODELS[harness]?.[0]?.id ??
  null;

/** The effective (sticky ?? default) selections for one project + harness. */
export const effectiveHarnessPrefs = (
  prefs: ComposerPrefs,
  projectId: string,
  harness: Harness,
): HarnessPrefs => {
  const sticky = prefs.byProject[projectId]?.byHarness[harness];
  const model = sticky?.model ?? null;
  const catalog = HARNESS_MODELS[harness] ?? [];
  return {
    // A sticky id the catalog no longer lists falls back to the default.
    model:
      model !== null && catalog.some((option) => option.id === model)
        ? model
        : defaultModel(harness),
    effort: sticky?.effort ?? null,
    permission: sticky?.permission ?? null,
    speed: sticky?.speed ?? null,
    mode: sticky?.mode ?? null,
  };
};
