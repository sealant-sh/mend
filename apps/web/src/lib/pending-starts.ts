import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import type { TurnSelection } from "@mend/domain/workbench";
import { useSyncExternalStore } from "react";

import type { SessionInboxRowDto } from "./api.ts";

/**
 * A session this tab is starting, from the moment Start is pressed until Mend has made it. Its
 * page opens at once at `/sessions/<draftId>`, with the person's words, and the sidebar lists it
 * as a starting session; once Mend answers, the session it made takes the same place and the
 * address moves to its id. Tab memory only: a reload shows what the server holds.
 */
export interface PendingStart {
  readonly draftId: string;
  /** Who started it: the sidebar lists it under their sessions. */
  readonly userId: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly harness: string;
  /** The first message, as written. */
  readonly prompt: string;
  /** What its turns run with, as picked: what its composer's model menu starts from. */
  readonly selection: TurnSelection | null;
  readonly sentAt: Date;
  /** The session Mend made for it, once it answered; its own row may not be listed yet. */
  readonly sessionId: string | null;
}

/** A start Mend refused: the composer it came from takes the words back, with Mend's reason. */
export interface RefusedStart {
  readonly draftId: string;
  /** Everything the person wrote for it: the first message and any sent while it started. */
  readonly prompt: string;
  /** What Mend said, in a sentence. */
  readonly words: string;
}

interface State {
  readonly starts: ReadonlyArray<PendingStart>;
  readonly refused: RefusedStart | null;
}

const EMPTY: State = { starts: [], refused: null };
let state = EMPTY;
const listeners = new Set<() => void>();

const set = (next: State) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const DRAFT_PREFIX = "starting-";

/** A new start's id: never a session id Mend hands out. */
export const newDraftId = (uuid: string): string => `${DRAFT_PREFIX}${uuid}`;

/** Whether an address's session id is a start this tab made, not a session. */
export const isDraftId = (id: string): boolean => id.startsWith(DRAFT_PREFIX);

/**
 * Whether an inbox row is a start of this tab's (`pendingRow`), not yet the server's: it has no
 * actions until it is, since there is nothing on the server to act on.
 */
export const isPendingRow = (row: { readonly session: { readonly worktreeId: string } }): boolean =>
  isDraftId(row.session.worktreeId);

/** A start begins: its page and its row show from now. A refusal held from before is spent. */
export const beginStart = (start: Omit<PendingStart, "sessionId">) =>
  set({ starts: [...state.starts, { ...start, sessionId: null }], refused: null });

/** Mend made the session: the row is its from now. */
export const startCreated = (draftId: string, sessionId: string) =>
  set({
    ...state,
    starts: state.starts.map((start) =>
      start.draftId === draftId ? { ...start, sessionId } : start,
    ),
  });

/** Mend refused the start: it goes, page and row. */
export const endStart = (draftId: string) =>
  set({ ...state, starts: state.starts.filter((start) => start.draftId !== draftId) });

/** Keep a refused start's words for the home composer, which opens again to take them back. */
export const keepRefusal = (refused: RefusedStart) => set({ ...state, refused });

/** The composer took the refused words back, or the person moved on. */
export const dismissRefusal = () => {
  if (state.refused !== null) set({ ...state, refused: null });
};

/** The refusal the composer hasn't taken back yet. */
export const refusedStart = (): RefusedStart | null => state.refused;

export const usePendingStarts = (): ReadonlyArray<PendingStart> =>
  useSyncExternalStore(
    subscribe,
    () => state.starts,
    () => EMPTY.starts,
  );

export const usePendingStart = (draftId: string): PendingStart | undefined =>
  usePendingStarts().find((start) => start.draftId === draftId);

export const useRefusedStart = (): RefusedStart | null =>
  useSyncExternalStore(
    subscribe,
    () => state.refused,
    () => null,
  );

const TITLE_LENGTH = 80;

/** What a start is called until Mend names it: its first line, as a queued session is. */
export const startTitle = (prompt: string): string => {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  return firstLine === "" ? "New session" : firstLine.slice(0, TITLE_LENGTH);
};

/**
 * The inbox's rows with this tab's starts laid in: each as a starting session of its own, so the
 * inbox's rules place it where they place a starting session, until the session Mend made is
 * listed. Once made, the row carries that session's id, so it is the same row the list then holds.
 */
export const withPendingStarts = (
  rows: ReadonlyArray<SessionInboxRowDto>,
  starts: ReadonlyArray<PendingStart>,
): ReadonlyArray<SessionInboxRowDto> => {
  if (starts.length === 0) return rows;
  const listed = new Set<string>(rows.map((row) => row.session.id));
  const pending = starts
    .filter((start) => start.sessionId === null || !listed.has(start.sessionId))
    .map((start) => pendingRow(start));
  return pending.length === 0 ? rows : [...rows, ...pending];
};

/** A start as an inbox row: a starting session, owned by whoever started it. */
export const pendingRow = (start: PendingStart): SessionInboxRowDto => ({
  session: {
    id: SessionId.make(start.sessionId ?? start.draftId),
    projectId: ProjectId.make(start.project.id),
    worktreeId: WorktreeId.make(start.draftId),
    harness: start.harness,
    label: null,
    branch: "",
    status: "starting",
    ownerUserId: start.userId,
    sharedControlEnabledAt: null,
    sharedControlUserIds: [],
    startedAt: null,
    settledAt: null,
    createdAt: start.sentAt,
    updatedAt: start.sentAt,
    importedConversationWaiting: false,
  },
  projectName: start.project.name,
  title: startTitle(start.prompt),
  annotation: null,
  ask: null,
});
