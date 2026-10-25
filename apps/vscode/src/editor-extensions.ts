/**
 * What a Mend workspace lists in `<agentFolder>/extensions/extensions.json`, what changed between
 * two reads of it, and how Mend installs a project's picks there.
 */
import { extensionId, type ExtensionId, type Wanted } from "./editor-picks.js";

export type EditorMode = "off" | "picked";

/** Every value but `off` reads as `picked`, the old `extensions` and `extensionsAndSettings` too. */
export const parseEditorMode = (value: unknown): EditorMode => (value === "off" ? "off" : "picked");

export interface Listed {
  readonly id: ExtensionId;
  /** A `vsix` or `resource` install, or one with no source, is from a file and never carried. */
  readonly source: "gallery" | "file";
  readonly preRelease: boolean;
}

export type WorkspaceList = ReadonlyMap<ExtensionId, Listed>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Null when the text is not a JSON array: a torn read is no observation, never "all removed". */
export const parseWorkspaceList = (text: string): WorkspaceList | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list = new Map<ExtensionId, Listed>();
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const { identifier, metadata } = entry;
    const id =
      isRecord(identifier) && typeof identifier["id"] === "string"
        ? extensionId(identifier["id"])
        : null;
    if (id === null) continue;
    const source = isRecord(metadata) ? metadata["source"] : undefined;
    const preRelease = isRecord(metadata) && metadata["preRelease"] === true;
    list.set(id, { id, source: source === "gallery" ? "gallery" : "file", preRelease });
  }
  return list;
};

export const INSTALL_MEMORY_KEY = "mend.editor.installMemory";

export const MISSING_TTL_MS = 24 * 60 * 60_000;

/** When the gallery last had no such extension, per id, on this machine. */
export interface InstallMemory {
  readonly version: 2;
  readonly missing: Readonly<Record<string, number>>;
}

export const emptyInstallMemory: InstallMemory = { version: 2, missing: {} };

/** The first design's version 1 also kept `staysLocal`; only `missing` survives. */
export const parseInstallMemory = (value: unknown): InstallMemory => {
  if (!isRecord(value) || (value["version"] !== 1 && value["version"] !== 2)) {
    return emptyInstallMemory;
  }
  const missing = value["missing"];
  if (!isRecord(missing)) return emptyInstallMemory;
  return {
    version: 2,
    missing: Object.fromEntries(
      Object.entries(missing).filter((entry): entry is [string, number] =>
        Number.isFinite(entry[1]),
      ),
    ),
  };
};

const recentlyMissing = (at: number | undefined, now: number): boolean =>
  at !== undefined && now - at < MISSING_TTL_MS;

/** Where a project's pick can already be, for this window. */
export interface Presence {
  readonly list: WorkspaceList;
  /**
   * The picks this window runs in its UI host. VS Code's install command updates that local copy
   * instead of installing into the workspace, so it already serves the window.
   */
  readonly inUiHost: ReadonlySet<ExtensionId>;
}

export const isPresent = (presence: Presence, id: ExtensionId): boolean =>
  presence.list.has(id) || presence.inUiHost.has(id);

export interface Plan {
  readonly install: ReadonlyArray<Wanted>;
  readonly recentlyMissing: ReadonlyArray<ExtensionId>;
}

export const planReinstall = (
  wanted: ReadonlyArray<Wanted>,
  presence: Presence,
  inFlight: ReadonlySet<ExtensionId>,
  memory: InstallMemory,
  now: number,
): Plan => {
  const absent = wanted.filter((ref) => !isPresent(presence, ref.id) && !inFlight.has(ref.id));
  const missing = (ref: Wanted) => recentlyMissing(memory.missing[ref.id], now);
  return {
    install: absent.filter((ref) => !missing(ref)),
    recentlyMissing: absent.filter(missing).map((ref) => ref.id),
  };
};

export class TimedOut extends Error {}

export type InstallFailure = "transient" | "missing" | "refused by policy" | "timed out" | "failed";

/** The messages are VS Code 1.139.1's. */
export const classifyInstallFailure = (cause: unknown): InstallFailure => {
  if (cause instanceof TimedOut) return "timed out";
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    /failed to fetch|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(?:429|502|503|504)\b/i.test(
      message,
    )
  ) {
    return "transient";
  }
  if (
    /allowed list|(?:is|are) not allowed|reported to be problematic|contact your administrator/i.test(
      message,
    )
  ) {
    return "refused by policy";
  }
  if (/\bnot found\b/i.test(message) && !/manifest/i.test(message)) return "missing";
  return "failed";
};

export type FailedBecause = Exclude<InstallFailure, "missing">;

export const RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 4_000];

export type InstallOutcome =
  | { readonly ref: Wanted; readonly kind: "reported" }
  | { readonly ref: Wanted; readonly kind: "missing" }
  | { readonly ref: Wanted; readonly kind: "failed"; readonly failure: FailedBecause };

export interface InstallDeps {
  readonly install: (ref: Wanted) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
  readonly onProgress: (current: number, total: number) => void;
}

export interface CompletedRun {
  readonly kind: "completed";
  readonly outcomes: ReadonlyArray<InstallOutcome>;
}

export type InstallRun =
  | CompletedRun
  | { readonly kind: "stopped"; readonly outcomes: ReadonlyArray<InstallOutcome> };

const installOne = async (ref: Wanted, deps: InstallDeps): Promise<InstallOutcome | "stopped"> => {
  for (let attempt = 0; ; attempt += 1) {
    if (deps.signal.aborted) return "stopped";
    try {
      await deps.install(ref);
      return { ref, kind: "reported" };
    } catch (cause) {
      const failure = classifyInstallFailure(cause);
      const delay = RETRY_DELAYS_MS[attempt];
      if (failure === "transient" && delay !== undefined) {
        await deps.sleep(delay);
        continue;
      }
      return failure === "missing" ? { ref, kind: "missing" } : { ref, kind: "failed", failure };
    }
  }
};

export const runInstalls = async (
  plan: ReadonlyArray<Wanted>,
  deps: InstallDeps,
): Promise<InstallRun> => {
  const outcomes: Array<InstallOutcome> = [];
  for (const [index, ref] of plan.entries()) {
    deps.onProgress(index + 1, plan.length);
    const outcome = await installOne(ref, deps);
    if (outcome === "stopped") return { kind: "stopped", outcomes };
    outcomes.push(outcome);
  }
  return { kind: "completed", outcomes };
};

export const absentAfterInstall = (
  outcomes: ReadonlyArray<InstallOutcome>,
  list: WorkspaceList,
): ReadonlyArray<ExtensionId> =>
  outcomes.flatMap((outcome) =>
    outcome.kind === "reported" && !list.has(outcome.ref.id) ? [outcome.ref.id] : [],
  );

export type InstallResult =
  | { readonly id: ExtensionId; readonly kind: "installed" }
  /** Reported installed, yet the workspace does not list it: tried again on the next open. */
  | { readonly id: ExtensionId; readonly kind: "notListed" }
  | { readonly id: ExtensionId; readonly kind: "missing" }
  | { readonly id: ExtensionId; readonly kind: "failed"; readonly failure: FailedBecause };

export const noteOutcomes = (
  memory: InstallMemory,
  run: CompletedRun,
  after: WorkspaceList,
  now: number,
): { readonly memory: InstallMemory; readonly results: ReadonlyArray<InstallResult> } => {
  const missing: Record<string, number> = Object.fromEntries(
    Object.entries(memory.missing).filter(([, at]) => recentlyMissing(at, now)),
  );
  const results = run.outcomes.map((outcome): InstallResult => {
    const { id } = outcome.ref;
    switch (outcome.kind) {
      case "missing":
        missing[id] = now;
        return { id, kind: "missing" };
      case "failed":
        return { id, kind: "failed", failure: outcome.failure };
      case "reported":
        delete missing[id];
        return after.has(id) ? { id, kind: "installed" } : { id, kind: "notListed" };
    }
  });
  return { memory: { version: 2, missing }, results };
};
