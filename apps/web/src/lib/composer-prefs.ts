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
 * the composer's handlers. The person's new-session defaults live on the
 * server (`lib/session-defaults.ts`); this blob keeps a browser's own from
 * before that only until they are handed over (`legacyComposerDefaults`).
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

/**
 * What the composer picks first for a project with no sticky choice yet (Settings → Sessions →
 * New sessions): a harness, and a model and effort per harness. The person's, from the server.
 */
export interface ComposerDefaults {
  /** Null until chosen: the composer then starts on claude. */
  readonly harness: Harness | null;
  readonly byHarness: Partial<Record<Harness, Pick<HarnessPrefs, "model" | "effort">>>;
}

interface ComposerPrefs {
  readonly lastProjectId: string | null;
  readonly byProject: Readonly<Record<string, ProjectPrefs>>;
}

const KEY = "mend-composer-prefs";
export const NO_DEFAULTS: ComposerDefaults = { harness: null, byHarness: {} };
const EMPTY: ComposerPrefs = { lastProjectId: null, byProject: {} };
const listeners = new Set<() => void>();
let current: ComposerPrefs = EMPTY;
/** This browser's own defaults from before they moved to the server, until handed over. */
let legacyDefaults: ComposerDefaults | null = null;

const HARNESS_NAMES: ReadonlyArray<string> = HARNESSES;
const EFFORT_NAMES: ReadonlyArray<string> = EFFORT_LEVELS;
const PERMISSION_NAMES: ReadonlyArray<string> = PERMISSION_MODES;
const SPEED_NAMES: ReadonlyArray<string> = SPEED_MODES;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isHarness = (value: unknown): value is Harness =>
  typeof value === "string" && HARNESS_NAMES.includes(value);
const isEffort = (value: unknown): value is EffortLevel =>
  typeof value === "string" && EFFORT_NAMES.includes(value);
const isPermission = (value: unknown): value is PermissionMode =>
  typeof value === "string" && PERMISSION_NAMES.includes(value);
const isSpeed = (value: unknown): value is SpeedMode =>
  typeof value === "string" && SPEED_NAMES.includes(value);

const reviveDefaults = (value: unknown): ComposerDefaults | null => {
  if (typeof value !== "object" || value === null) return null;
  const harness: unknown = Reflect.get(value, "harness");
  const stored: unknown = Reflect.get(value, "byHarness");
  const byHarness: Partial<Record<Harness, Pick<HarnessPrefs, "model" | "effort">>> = {};
  if (typeof stored === "object" && stored !== null) {
    for (const [name, prefs] of Object.entries(stored)) {
      if (!isHarness(name) || typeof prefs !== "object" || prefs === null) continue;
      const model: unknown = Reflect.get(prefs, "model");
      const effort: unknown = Reflect.get(prefs, "effort");
      byHarness[name] = {
        model: typeof model === "string" ? model : null,
        effort: isEffort(effort) ? effort : null,
      };
    }
  }
  const revived = { harness: isHarness(harness) ? harness : null, byHarness };
  return revived.harness === null && Object.keys(byHarness).length === 0 ? null : revived;
};

/** Tolerant revive — a malformed or stale blob degrades to defaults, never throws. */
const revive = (
  raw: string,
): { readonly prefs: ComposerPrefs; readonly defaults: ComposerDefaults | null } => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { prefs: EMPTY, defaults: null };
  const byProject: Record<string, ProjectPrefs> = {};
  if (isRecord(parsed["byProject"])) {
    for (const [projectId, row] of Object.entries(parsed["byProject"])) {
      if (!isRecord(row)) continue;
      const harness = row["harness"];
      if (!isHarness(harness)) continue;
      const byHarness: Partial<Record<Harness, HarnessPrefs>> = {};
      if (isRecord(row["byHarness"])) {
        for (const [name, prefs] of Object.entries(row["byHarness"])) {
          if (!isHarness(name)) continue;
          // Prefs that are not an object read as none set, as an empty one would.
          const p = isRecord(prefs) ? prefs : {};
          byHarness[name] = {
            model: typeof p["model"] === "string" ? p["model"] : null,
            effort: isEffort(p["effort"]) ? p["effort"] : null,
            permission: isPermission(p["permission"]) ? p["permission"] : null,
            speed: isSpeed(p["speed"]) ? p["speed"] : null,
          };
        }
      }
      byProject[projectId] = { harness, byHarness };
    }
  }
  const lastProjectId = parsed["lastProjectId"];
  return {
    prefs: {
      lastProjectId: typeof lastProjectId === "string" ? lastProjectId : null,
      byProject,
    },
    defaults: reviveDefaults(Reflect.get(parsed, "defaults")),
  };
};

if (typeof window !== "undefined") {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) ({ prefs: current, defaults: legacyDefaults } = revive(stored));
  } catch {
    // Malformed blob — start clean.
  }
}

const store = (): void => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(legacyDefaults === null ? current : { ...current, defaults: legacyDefaults }),
    );
  } catch {
    // Private mode without storage — the choice still applies for this tab.
  }
};

const write = (next: ComposerPrefs): void => {
  current = next;
  store();
  for (const listener of listeners) listener();
};

/**
 * The defaults this browser kept before they moved to the server, or null when it kept none or
 * handed them over already.
 */
export const legacyComposerDefaults = (): ComposerDefaults | null => legacyDefaults;

/** The server holds the person's defaults now: this browser forgets its own. */
export const forgetLegacyComposerDefaults = (): void => {
  legacyDefaults = null;
  store();
};

const projectPrefs = (projectId: string, defaults: ComposerDefaults): ProjectPrefs =>
  current.byProject[projectId] ?? { harness: defaults.harness ?? "claude", byHarness: {} };

export const setComposerProject = (projectId: string): void =>
  write({ ...current, lastProjectId: projectId });

export const setComposerHarness = (projectId: string, harness: Harness): void =>
  write({
    ...current,
    byProject: {
      ...current.byProject,
      [projectId]: { ...projectPrefs(projectId, NO_DEFAULTS), harness },
    },
  });

export const setComposerHarnessPrefs = (
  projectId: string,
  harness: Harness,
  prefs: Partial<HarnessPrefs>,
  defaults: ComposerDefaults,
): void => {
  const project = projectPrefs(projectId, defaults);
  // The first choice for a project starts from what the composer showed, the Settings defaults
  // included, so changing one field keeps the others. A later null is an explicit "default".
  const merged: HarnessPrefs = {
    ...stickyHarnessPrefs(current, defaults, projectId, harness),
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

/**
 * The sticky choices for one project + harness. Until something was chosen there, the model and
 * effort are the Settings defaults for the harness, and every other field null.
 */
export const stickyHarnessPrefs = (
  prefs: ComposerPrefs,
  defaults: ComposerDefaults,
  projectId: string,
  harness: Harness,
): HarnessPrefs =>
  prefs.byProject[projectId]?.byHarness[harness] ?? {
    ...NOTHING_CHOSEN,
    ...defaults.byHarness[harness],
  };

/** The harness the composer starts a project on: its sticky one, else the Settings default. */
export const composerHarness = (
  prefs: ComposerPrefs,
  defaults: ComposerDefaults,
  projectId: string,
): Harness => prefs.byProject[projectId]?.harness ?? defaults.harness ?? "claude";
