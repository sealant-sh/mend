/**
 * One window's observation of its workspace's `extensions.json`: the last read, the restores Mend
 * asked VS Code for, and the journal of picks and removals the window saw. A pure reducer; the
 * shell in `workspace-editor.ts` reads, installs and writes the book.
 */
import type { Listed, WorkspaceList } from "./editor-extensions.js";
import { mergePicks, type ExtensionId, type PickEntry, type ProjectPicks } from "./editor-picks.js";

/** How long after its command settles a restore may take to show in the workspace's list. */
export const PROPAGATION_WAIT_MS = 3_000;

export type RestoreOutcome = "reported" | "failed";

/**
 * Mend's own install of an id. While it holds, the id's appearance is never a pick and its
 * disappearance never a removal: VS Code lists an extension before its dependencies finish, and
 * takes it out again when one fails.
 */
export type Restore =
  | { readonly kind: "inFlight" }
  | { readonly kind: "settled"; readonly outcome: RestoreOutcome; readonly until: number };

export type ReadResult =
  | { readonly kind: "list"; readonly list: WorkspaceList }
  | { readonly kind: "fileNotFound" }
  | { readonly kind: "unreadable" };

export interface Observer {
  /** Bumped when the setting goes off, so a read or a restore begun before it is dropped. */
  readonly generation: number;
  /** The last successful read; null until the first read of an enabled period, its baseline. */
  readonly previous: WorkspaceList | null;
  readonly restores: ReadonlyMap<ExtensionId, Restore>;
  /** Every pick and removal this window saw, replayed into the book until the book holds it. */
  readonly journal: ProjectPicks;
}

export type ObserverEvent =
  | {
      readonly kind: "read";
      readonly generation: number;
      readonly at: number;
      readonly result: ReadResult;
      /** The project's entries in the stored book; empty while the project is unknown. */
      readonly book: ProjectPicks;
    }
  | { readonly kind: "restoreStarted"; readonly generation: number; readonly id: ExtensionId }
  | {
      readonly kind: "restoreSettled";
      readonly generation: number;
      readonly id: ExtensionId;
      readonly outcome: RestoreOutcome;
      readonly at: number;
    }
  | { readonly kind: "off" };

export interface Step {
  readonly observer: Observer;
  /** The book entries this event observed, already folded into the journal. */
  readonly entries: ProjectPicks;
  readonly fromFile: ReadonlyArray<ExtensionId>;
}

export const initialObserver: Observer = {
  generation: 0,
  previous: null,
  restores: new Map(),
  journal: new Map(),
};

export const inFlight = (observer: Observer): ReadonlySet<ExtensionId> =>
  new Set(
    [...observer.restores].flatMap(([id, restore]) => (restore.kind === "inFlight" ? [id] : [])),
  );

/** Remote-SSH, its helpers and Mend itself are never picks. */
const NEVER_PICKED: ReadonlyArray<RegExp> = [
  /^ms-vscode-remote\./,
  /^ms-vscode\.remote-(?:explorer|server)$/,
  /^sealant-sh\.mend$/,
];

const neverPicked = (id: ExtensionId): boolean => NEVER_PICKED.some((pattern) => pattern.test(id));

const byId = (left: string, right: string) => left.localeCompare(right);

const unchanged = (observer: Observer): Step => ({ observer, entries: new Map(), fromFile: [] });

/** A missing file is an empty list only at the baseline: a fresh home has none before its first install. */
const listOf = (result: ReadResult, previous: WorkspaceList | null): WorkspaceList | null => {
  switch (result.kind) {
    case "list":
      return result.list;
    case "fileNotFound":
      return previous === null ? new Map() : null;
    case "unreadable":
      return null;
  }
};

const restoresAfter = (
  restores: ReadonlyMap<ExtensionId, Restore>,
  now: WorkspaceList,
  at: number,
): ReadonlyMap<ExtensionId, Restore> =>
  new Map(
    [...restores].filter(
      ([id, restore]) =>
        restore.kind === "inFlight" ||
        (at < restore.until && !(restore.outcome === "reported" && now.has(id))),
    ),
  );

const changesBetween = (
  observer: Observer & { readonly previous: WorkspaceList },
  now: WorkspaceList,
  event: Extract<ObserverEvent, { kind: "read" }>,
): Omit<Step, "observer"> => {
  const { previous, restores } = observer;
  const known = mergePicks(event.book, observer.journal);
  const ignored = (id: ExtensionId) => restores.has(id) || neverPicked(id);
  const picked: Array<Listed> = [];
  const fromFile: Array<ExtensionId> = [];
  for (const listed of now.values()) {
    if (ignored(listed.id)) continue;
    const was = previous.get(listed.id);
    if (was === undefined) {
      if (listed.source === "file") fromFile.push(listed.id);
      // Pack members and dependencies arrive with a restore; they must not undo a removal.
      else if (restores.size === 0 || known.get(listed.id)?.kind !== "removed") picked.push(listed);
    } else if (listed.source === "gallery" && listed.preRelease !== was.preRelease) {
      picked.push(listed);
    }
  }
  const removed = [...previous.keys()].filter(
    (id) => !now.has(id) && !neverPicked(id) && !restores.has(id),
  );
  return {
    entries: new Map<ExtensionId, PickEntry>([
      ...picked
        .toSorted((left, right) => byId(left.id, right.id))
        .map((listed): [ExtensionId, PickEntry] => [
          listed.id,
          { kind: "picked", at: event.at, preRelease: listed.preRelease },
        ]),
      ...removed
        .toSorted(byId)
        .map((id): [ExtensionId, PickEntry] => [id, { kind: "removed", at: event.at }]),
    ]),
    fromFile: fromFile.toSorted(byId),
  };
};

const read = (observer: Observer, event: Extract<ObserverEvent, { kind: "read" }>): Step => {
  const now = listOf(event.result, observer.previous);
  if (now === null) return unchanged(observer);
  const restores = restoresAfter(observer.restores, now, event.at);
  const { previous } = observer;
  if (previous === null) return unchanged({ ...observer, previous: now, restores });
  const step = changesBetween({ ...observer, previous }, now, event);
  return {
    ...step,
    observer: {
      ...observer,
      previous: now,
      restores,
      journal: mergePicks(observer.journal, step.entries),
    },
  };
};

const settle = (
  observer: Observer,
  event: Extract<ObserverEvent, { kind: "restoreSettled" }>,
): Observer => {
  if (observer.restores.get(event.id)?.kind !== "inFlight") return observer;
  const restores = new Map(observer.restores);
  if (event.outcome === "reported" && observer.previous?.has(event.id) === true) {
    restores.delete(event.id);
  } else {
    restores.set(event.id, {
      kind: "settled",
      outcome: event.outcome,
      until: event.at + PROPAGATION_WAIT_MS,
    });
  }
  return { ...observer, restores };
};

export const observe = (observer: Observer, event: ObserverEvent): Step => {
  if (event.kind === "off") {
    return unchanged({
      ...observer,
      generation: observer.generation + 1,
      previous: null,
      restores: new Map(),
    });
  }
  if (event.generation !== observer.generation) return unchanged(observer);
  switch (event.kind) {
    case "read":
      return read(observer, event);
    case "restoreStarted":
      return unchanged({
        ...observer,
        restores: new Map(observer.restores).set(event.id, { kind: "inFlight" }),
      });
    case "restoreSettled":
      return unchanged(settle(observer, event));
  }
};
