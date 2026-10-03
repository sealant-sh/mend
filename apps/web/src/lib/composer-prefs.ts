import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SPEED_MODES,
  type EffortLevel,
  type PermissionMode,
  type SpeedMode,
} from "@mend/domain/workbench";
import { useSyncExternalStore } from "react";

import { HARNESSES, type Harness } from "#/lib/session-launch";

/**
 * Sticky composer choices — last-used harness per project, last-used
 * model/effort/permission per harness, and the last project the Now
 * composer targeted. Same shape as lib/theme.ts: module state + one
 * localStorage key + useSyncExternalStore; writes are event-driven from
 * the composer's handlers.
 */

/**
 * What the person last chose for a harness. `model` null means they chose nothing yet; the
 * picker (`modelPicker` in `@mend/domain/workbench`) then preselects the server's default, and
 * reads a saved id the catalog no longer lists the same way. `effort`/`permission`/`speed` null =
 * the harness's own default (no flag composed).
 */
export interface HarnessPrefs {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly permission: PermissionMode | null;
  readonly speed: SpeedMode | null;
}

interface ProjectPrefs {
  readonly harness: Harness;
  readonly byHarness: Partial<Record<Harness, HarnessPrefs>>;
}

interface ComposerPrefs {
  readonly lastProjectId: string | null;
  readonly byProject: Readonly<Record<string, ProjectPrefs>>;
}

const KEY = "mend-composer-prefs";
const EMPTY: ComposerPrefs = { lastProjectId: null, byProject: {} };
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
  const record = parsed as { lastProjectId?: unknown; byProject?: unknown };
  const byProject: Record<string, ProjectPrefs> = {};
  if (typeof record.byProject === "object" && record.byProject !== null) {
    for (const [projectId, value] of Object.entries(record.byProject)) {
      const row = value as { harness?: unknown; byHarness?: unknown };
      if (!isHarness(row.harness)) continue;
      const byHarness: Partial<Record<Harness, HarnessPrefs>> = {};
      if (typeof row.byHarness === "object" && row.byHarness !== null) {
        for (const [harness, prefs] of Object.entries(row.byHarness)) {
          if (!isHarness(harness)) continue;
          const p = prefs as {
            model?: unknown;
            effort?: unknown;
            permission?: unknown;
            speed?: unknown;
          };
          byHarness[harness] = {
            model: typeof p.model === "string" ? p.model : null,
            effort: isEffort(p.effort) ? p.effort : null,
            permission: isPermission(p.permission) ? p.permission : null,
            speed: isSpeed(p.speed) ? p.speed : null,
          };
        }
      }
      byProject[projectId] = { harness: row.harness, byHarness };
    }
  }
  return {
    lastProjectId: typeof record.lastProjectId === "string" ? record.lastProjectId : null,
    byProject,
  };
};

if (typeof window !== "undefined") {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) current = revive(stored);
  } catch {
    // Malformed blob — start clean.
  }
}

const write = (next: ComposerPrefs): void => {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode without storage — the choice still applies for this tab.
  }
  for (const listener of listeners) listener();
};

const projectPrefs = (projectId: string): ProjectPrefs =>
  current.byProject[projectId] ?? { harness: "claude", byHarness: {} };

export const setComposerProject = (projectId: string): void =>
  write({ ...current, lastProjectId: projectId });

export const setComposerHarness = (projectId: string, harness: Harness): void =>
  write({
    ...current,
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
    ...project.byHarness[harness],
    ...prefs,
  };
  write({
    ...current,
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

export const useComposerPrefs = (): ComposerPrefs =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );

const NOTHING_CHOSEN: HarnessPrefs = { model: null, effort: null, permission: null, speed: null };

/** The sticky choices for one project + harness; every field null until something was chosen. */
export const stickyHarnessPrefs = (
  prefs: ComposerPrefs,
  projectId: string,
  harness: Harness,
): HarnessPrefs => prefs.byProject[projectId]?.byHarness[harness] ?? NOTHING_CHOSEN;
