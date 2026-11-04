import { useSyncExternalStore } from "react";

import type { Harness } from "#/lib/session-launch";

/** A browser launch before its opening message reaches the durable conversation. */
export interface PendingLaunch {
  readonly draftId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly harness: Harness;
  readonly prompt: string;
  readonly sentAt: string;
  readonly state:
    | { readonly _tag: "Creating" }
    | { readonly _tag: "Created"; readonly sessionId: string }
    | { readonly _tag: "Failed"; readonly words: string };
}

const empty: ReadonlyArray<PendingLaunch> = [];
let launches = empty;
const listeners = new Set<() => void>();
type CreateLaunch = (isCurrent: () => boolean) => Promise<string>;
const retries = new Map<string, CreateLaunch>();
let edit: PendingLaunch | null = null;

const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Every launch in this tab, with stable snapshots for React and an empty server snapshot. */
export const usePendingLaunches = (): ReadonlyArray<PendingLaunch> =>
  useSyncExternalStore(
    subscribe,
    () => launches,
    () => empty,
  );

/** The opening message for one real session; readers hide it once its recorded message arrives. */
export const launchForSession = (
  held: ReadonlyArray<PendingLaunch>,
  sessionId: string,
): PendingLaunch | undefined =>
  held.find((launch) => launch.state._tag === "Created" && launch.state.sessionId === sessionId);

/** Keep the target and launch options in the operation, rather than pretending to have a server DTO. */
export const addPendingLaunch = (launch: PendingLaunch, create: CreateLaunch) => {
  edit = null;
  retries.set(launch.draftId, create);
  launches = [...launches, launch];
  changed();
};

/** Retry creation in place, preserving the person's message and draft URL. */
export const retryPendingLaunch = async (draftId: string) => {
  const launch = launches.find((row) => row.draftId === draftId);
  const create = retries.get(draftId);
  if (launch === undefined || create === undefined || running.has(draftId)) return;
  running.add(draftId);
  const update = (state: PendingLaunch["state"]) => {
    launches = launches.map((row) => (row.draftId === draftId ? { ...row, state } : row));
    changed();
  };
  update({ _tag: "Creating" });
  try {
    const sessionId = await create(() => retries.get(draftId) === create);
    update({ _tag: "Created", sessionId });
    retries.delete(draftId);
  } catch (cause) {
    update({
      _tag: "Failed",
      words: cause instanceof Error ? cause.message : "Could not create the session.",
    });
  } finally {
    running.delete(draftId);
  }
};
const running = new Set<string>();

/** Once a recorded message replaces the launch bubble, its browser-only entry can leave. */
export const finishPendingLaunch = (sessionId: string) => {
  const kept = launches.filter(
    (launch) => launch.state._tag !== "Created" || launch.state.sessionId !== sessionId,
  );
  if (kept.length === launches.length) return;
  launches = kept;
  changed();
};

/** Return failed words to the home composer, without putting a private prompt in the URL. */
export const editPendingLaunch = (launch: PendingLaunch) => {
  edit = launch;
  retries.delete(launch.draftId);
  launches = launches.filter((row) => row.draftId !== launch.draftId);
  changed();
};

/** Read the message restored by Edit when the composer mounts. */
export const readLaunchEdit = (): PendingLaunch | null => edit;

/** Pending words belong to the signed-in person and must leave with their other drafts. */
export const forgetPendingLaunches = () => {
  launches = empty;
  retries.clear();
  edit = null;
  changed();
};
