import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { messageTitle, type TurnSelection, UNNAMED_SESSION_TITLE } from "@mend/domain/workbench";
import { useMemo, useSyncExternalStore } from "react";

import type { SessionInboxRowDto } from "./api.ts";

/**
 * A session this tab is starting, from the moment Start is pressed until Mend has made it. Its
 * page opens at once at `/sessions/<draftId>`, with the person's words, and the sidebar lists it
 * as a starting session; once Mend answers, the session it made takes the same place and the
 * address moves to its id. Kept in the tab's sessionStorage too, so a page reloaded before Mend
 * answered finds the start again by its key (`keyOfDraft`, SLNT-1239).
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

/** Where the tab keeps its starts across a reload. */
const STORED_STARTS = "mend-pending-starts";

/** A start as sessionStorage holds it: its time as text. */
interface StoredStart extends Omit<PendingStart, "sentAt"> {
  readonly sentAt: string;
}

const store = (starts: ReadonlyArray<PendingStart>) => {
  try {
    if (starts.length === 0) sessionStorage.removeItem(STORED_STARTS);
    else
      sessionStorage.setItem(
        STORED_STARTS,
        JSON.stringify(starts.map((start) => ({ ...start, sentAt: start.sentAt.toISOString() }))),
      );
  } catch {
    // No storage (a private window, the server): a reload then shows what the server holds.
  }
};

const set = (next: State) => {
  if (next.starts !== state.starts) store(next.starts);
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

/** The key Mend knows a start by (`POST /session-starts`): the uuid in its draft id. */
export const keyOfDraft = (draftId: string): string => draftId.slice(DRAFT_PREFIX.length);

/** The raw starts the tab kept, as text: a stable value for `useSyncExternalStore`. */
const storedText = (): string | null => {
  try {
    return sessionStorage.getItem(STORED_STARTS);
  } catch {
    return null;
  }
};

const isText = (record: object, key: string): boolean =>
  key in record && typeof Reflect.get(record, key) === "string";

/** What this module wrote: anything else in the slot (an older shape, a hand edit) is no start. */
const isStoredStart = (value: unknown): value is StoredStart => {
  if (typeof value !== "object" || value === null) return false;
  const project: unknown = Reflect.get(value, "project");
  const sessionId: unknown = Reflect.get(value, "sessionId");
  const selection: unknown = Reflect.get(value, "selection");
  return (
    ["draftId", "userId", "harness", "prompt", "sentAt"].every((key) => isText(value, key)) &&
    typeof project === "object" &&
    project !== null &&
    isText(project, "id") &&
    isText(project, "name") &&
    (sessionId === null || typeof sessionId === "string") &&
    (selection === null || typeof selection === "object")
  );
};

/** The start the tab kept under `draftId`, from `storedText`'s text; null when it kept none. */
export const storedStartIn = (text: string | null, draftId: string): PendingStart | null => {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const found = parsed.find(
    (value): value is StoredStart => isStoredStart(value) && value.draftId === draftId,
  );
  return found === undefined ? null : { ...found, sentAt: new Date(found.sentAt) };
};

/**
 * The start this tab kept under `draftId` before a reload; null when it kept none, and undefined
 * while the page is drawn on the server, which can't know.
 */
export const useStoredStart = (draftId: string): PendingStart | null | undefined => {
  const text = useSyncExternalStore(subscribe, storedText, () => undefined);
  return useMemo(
    () => (text === undefined ? undefined : storedStartIn(text, draftId)),
    [text, draftId],
  );
};

/** A start kept from before a reload is this tab's again: its page and its row show. */
export const restoreStart = (start: PendingStart) => {
  if (state.starts.some((each) => each.draftId === start.draftId)) return;
  set({ ...state, starts: [...state.starts, start] });
};

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

/**
 * The address what the person writes on a start's page goes under: the session Mend made for it
 * once it answered, else the start's own. Read when the words are written, not when the page was
 * last drawn: a start's page stays on screen while the session's page is read, and words written
 * there after `startInstantly` moved the rest onto the session must reach the session too
 * (SLNT-1232).
 */
export const writingAddressOf = (draftId: string): string =>
  state.starts.find((start) => start.draftId === draftId)?.sessionId ?? draftId;

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

/** What a start is called until Mend names it: its first line, as an unnamed session is. */
export const startTitle = (prompt: string): string => messageTitle(prompt) ?? UNNAMED_SESSION_TITLE;

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
