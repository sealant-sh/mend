import { REVIEW_WAIT_MS } from "@mend/domain/workbench";

import type { SessionAskDto, SessionInboxMarkDto, SessionInboxRowDto } from "./api.ts";

/**
 * The sidebar inbox: every session a person can see, placed in one of five groups. The server
 * answers in its own terms (a session's status, the person's marks, its worktree's change facts);
 * this module is the one place those become the groups and the words a person reads.
 */

/** A person's mark on a session, keyed by the session's id as any row carries it. */
export type InboxMark = Omit<SessionInboxMarkDto, "sessionId"> & { readonly sessionId: string };

/** The groups, in the order the sidebar lists them. */
export type InboxGroup = "waiting" | "review" | "running" | "snoozed" | "done";

export const INBOX_GROUPS = [
  { group: "waiting", label: "Waiting on you" },
  { group: "review", label: "To review" },
  { group: "running", label: "Running" },
  { group: "snoozed", label: "Snoozed" },
  { group: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ readonly group: InboxGroup; readonly label: string }>;

/** What an open group says when nothing is in it. */
export const EMPTY_GROUP: Readonly<Record<InboxGroup, string>> = {
  waiting: "Nothing is waiting on you.",
  review: "Nothing to review.",
  running: "Nothing is running.",
  snoozed: "Nothing is snoozed.",
  done: "Nothing is done yet.",
};

/** What a row shows of a session: the inbox read's trimmed session. */
export type InboxSession = SessionInboxRowDto["session"];
export type InboxAnnotation = NonNullable<SessionInboxRowDto["annotation"]>;

export interface InboxRow {
  readonly session: InboxSession;
  readonly project: { readonly id: string; readonly name: string };
  readonly annotation: InboxAnnotation | null;
  readonly title: string;
  /** Why a waiting session waits, when the read says. */
  readonly ask: SessionAskDto | null;
  readonly group: InboxGroup;
  /** When a snooze ends, for Snoozed rows. */
  readonly snoozedUntil: Date | null;
  /** When the row went to Done: marked done by hand, or when the session ended. */
  readonly doneAt: Date | null;
}

const RUNNING: ReadonlySet<InboxSession["status"]> = new Set([
  "starting",
  "running",
  "idle",
  "stopping",
]);

const ENDED: ReadonlySet<InboxSession["status"]> = new Set(["completed", "stopped", "failed"]);

/**
 * A follow-up waits to be sent, or the session ended (however it ended) within `REVIEW_WAIT_MS`
 * and its change has no review comment yet. The server lists the same sessions past its cap
 * (`SessionsRepo.listForInbox`).
 */
const endedToReview = (row: SessionInboxRowDto, now: Date): boolean => {
  const { session, annotation } = row;
  return (
    annotation !== null &&
    (annotation.pendingFollowUp ||
      (ENDED.has(session.status) &&
        now.getTime() - session.updatedAt.getTime() <= REVIEW_WAIT_MS &&
        annotation.changeId !== null &&
        annotation.totalComments === 0))
  );
};

/**
 * Every session the person can see, in its group, newest activity first.
 *
 * `changedFiles` holds, by change id, how many files an Idle session's change has, for the Idle
 * sessions whose change has been read: an Idle session with changed files is to review, as a
 * stopped one is. The inbox read carries no file count, so until its change is read an Idle
 * session stays under Running, where it was.
 */
export function inboxRows({
  rows,
  marks,
  changedFiles,
  now,
}: {
  readonly rows: ReadonlyArray<SessionInboxRowDto>;
  readonly marks: ReadonlyArray<InboxMark>;
  readonly changedFiles: Readonly<Record<string, number>>;
  readonly now: Date;
}): ReadonlyArray<InboxRow> {
  const markOf = new Map(marks.map((mark) => [mark.sessionId, mark]));
  const reviewedChanges = new Set<string>();
  const placed = rows
    .toSorted((a, b) => b.session.updatedAt.getTime() - a.session.updatedAt.getTime())
    .map((row): InboxRow => {
      const { session, annotation } = row;
      const base = {
        session,
        project: { id: session.projectId, name: row.projectName },
        annotation,
        title: row.title,
        ask: row.ask,
        snoozedUntil: null,
        doneAt: null,
      };
      const mark = markOf.get(session.id);
      if (mark?.state === "settled") return { ...base, group: "done", doneAt: mark.markedAt };
      if (mark?.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now)
        return { ...base, group: "snoozed", snoozedUntil: mark.snoozedUntil };
      if (session.status === "waiting") return { ...base, group: "waiting" };
      if (session.status === "idle") {
        const files = annotation?.changeId == null ? 0 : changedFiles[annotation.changeId];
        return { ...base, group: files === undefined || files === 0 ? "running" : "review" };
      }
      if (RUNNING.has(session.status)) return { ...base, group: "running" };
      // One row per change: the worktree's sessions share it, so only the newest one is listed.
      const change = annotation?.changeId ?? session.id;
      if (endedToReview(row, now) && !reviewedChanges.has(change)) {
        reviewedChanges.add(change);
        return { ...base, group: "review" };
      }
      // Kept in the inbox by hand: an ended session waits under To review until marked done.
      if (mark?.state === "inbox") return { ...base, group: "review" };
      return { ...base, group: "done", doneAt: session.settledAt ?? session.updatedAt };
    });
  return placed.toSorted((a, b) => activity(b) - activity(a));
}

/** When the row last moved: when it went to Done, else the session's last change. */
export const activity = (row: InboxRow): number => (row.doneAt ?? row.session.updatedAt).getTime();

/** The two filters: one project or all of them, and whose sessions. */
export interface InboxFilters {
  /** Null means every project. */
  readonly projectId: string | null;
  readonly mine: boolean;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = { projectId: null, mine: true };

export const matchesFilters = (
  row: InboxRow,
  filters: InboxFilters,
  viewerId: string | null,
): boolean =>
  (filters.projectId === null || row.project.id === filters.projectId) &&
  (!filters.mine || viewerId === null || row.session.ownerUserId === viewerId);

/** Rows by group. Snoozed rows come back soonest first; the others keep newest activity first. */
export const groupRows = (
  rows: ReadonlyArray<InboxRow>,
): Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>> => ({
  waiting: rows.filter((row) => row.group === "waiting"),
  review: rows.filter((row) => row.group === "review"),
  running: rows.filter((row) => row.group === "running"),
  snoozed: rows
    .filter((row) => row.group === "snoozed")
    .toSorted((a, b) => (a.snoozedUntil?.getTime() ?? 0) - (b.snoozedUntil?.getTime() ?? 0)),
  done: rows.filter((row) => row.group === "done"),
});

/** Which groups are open. Waiting on you and To review start open, the rest closed. */
export type InboxFolds = Readonly<Record<InboxGroup, boolean>>;

export const DEFAULT_INBOX_FOLDS: InboxFolds = {
  waiting: true,
  review: true,
  running: false,
  snoozed: false,
  done: false,
};

/** How many rows a group lists before "Show N more". */
export const GROUP_ROWS = 5;

const SESSION_WORDS: Readonly<Record<InboxSession["status"], string>> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting on you",
  idle: "Idle",
  // A stopping session's workspace is being saved before it goes (capture-and-save).
  stopping: "Saving",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** A row's status: one word or short phrase, red only for Failed. */
export interface RowStatus {
  readonly word: string;
  readonly failed: boolean;
}

const plain = (word: string): RowStatus => ({ word, failed: false });

/** What a row says a session is doing, is waiting on, or how it ended. */
export const rowStatus = (row: InboxRow, now: Date): RowStatus => {
  const { session } = row;
  if (row.group === "snoozed") return plain(`Until ${whenAhead(row.snoozedUntil ?? now, now)}`);
  if (session.importedConversationWaiting) return plain("Waiting for a first message");
  if (row.group === "waiting") return plain(askWords(row.ask));
  if (row.group === "review" && row.annotation?.pendingFollowUp === true)
    return plain("Follow-up not sent");
  return { word: SESSION_WORDS[session.status], failed: session.status === "failed" };
};

/** Why a waiting session waits, in the sidebar's short words: "Wants to run a command". */
export const askWords = (ask: SessionAskDto | null): string => {
  switch (ask?.kind) {
    case "question":
      return "Asked a question";
    case "command":
      return "Wants to run a command";
    case "edit":
      return "Wants to edit a file";
    case "tool":
      return "Wants to use a tool";
    case "decision":
    case undefined:
      return "Waiting on you";
  }
};

/**
 * Why a waiting session waits, naming what the agent named, for the phone row's second line:
 * "Asked: Should the retry back off on a 409?", "Wants to run terraform apply".
 */
export const askDetail = (ask: SessionAskDto | null): string => {
  if (ask === null || ask.subject === null) return askWords(ask);
  switch (ask.kind) {
    case "question":
      return `Asked: ${ask.subject}`;
    case "command":
      return `Wants to run ${ask.subject}`;
    case "edit":
      return `Wants to edit ${ask.subject}`;
    case "tool":
      return `Wants to use ${ask.subject}`;
    case "decision":
      return askWords(ask);
  }
};

/**
 * The sessions sharing this row's workspace while it runs, counting this one, or null when it runs
 * alone or has ended: "2 sessions" on the row's note line.
 */
export const sharedWith = (
  row: InboxRow,
  rows: ReadonlyArray<Pick<InboxRow, "session">>,
): number | null => {
  if (ENDED.has(row.session.status)) return null;
  const count = rows.filter(
    (other) =>
      other.session.worktreeId === row.session.worktreeId && !ENDED.has(other.session.status),
  ).length;
  return count > 1 ? count : null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, as a row says it: "now", "4m", "2h", "3d". */
export const age = (date: Date, now: Date): string => {
  const ms = now.getTime() - date.getTime();
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
};

const clock = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "16:00", "tomorrow 09:00", "Mon 09:00": when a snooze ends. */
export const whenAhead = (date: Date, now: Date): string => {
  const days = Math.round((dayStart(date) - dayStart(now)) / DAY);
  if (days <= 0) return clock(date);
  if (days === 1) return `tomorrow ${clock(date)}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock(date)}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** The clock time an offline inbox was read at: "9:38". */
export const readAt = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
