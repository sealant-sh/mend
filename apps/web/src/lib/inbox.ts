import { REVIEW_WAIT_MS } from "@mend/domain/workbench";

import type {
  AgentActivityDto,
  QueuedSessionDto,
  SessionAskDto,
  SessionInboxMarkDto,
  SessionInboxRowDto,
} from "./api.ts";
import { askersWords } from "./shared-control.ts";

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
  /** The worktree's name, for the note of sessions sharing a workspace; null when unknown. */
  readonly worktreeName: string | null;
  /** Why a failed session ended, as the server recorded it; null otherwise. */
  readonly failure: string | null;
  /** What a running agent is doing, when the server knows. */
  readonly activity: AgentActivityDto | null;
  /**
   * The people asking the viewer for shared control of their session, oldest first, by name
   * (null where the roster doesn't know them). Only the owner's row carries them.
   */
  readonly askers: ReadonlyArray<string | null>;
  readonly group: InboxGroup;
  /** When a snooze ends, for Snoozed rows. */
  readonly snoozedUntil: Date | null;
  /** When the row went to Done: marked done by hand, or when the session ended. */
  readonly doneAt: Date | null;
  /** In Done because the person marked it done, not because of how the session ended. */
  readonly markedDone: boolean;
}

const RUNNING: ReadonlySet<InboxSession["status"]> = new Set(["starting", "running", "stopping"]);

const ENDED: ReadonlySet<InboxSession["status"]> = new Set(["completed", "stopped", "failed"]);

/**
 * Whether the session's change has files, as the server last counted them; null when it hasn't
 * counted them yet (a session from before the count, or one whose count failed).
 */
const changedFiles = ({ annotation }: SessionInboxRowDto): boolean | null =>
  annotation?.fileCount == null ? null : annotation.fileCount > 0;

/**
 * A follow-up waits to be sent, or the session ended (however it ended) within `REVIEW_WAIT_MS`
 * and its change has files and no review comment yet. A change whose files weren't counted waits
 * too: it is never hidden for want of a count. The server lists the same sessions past its cap
 * (`SessionsRepo.listForInbox`), counted or not.
 */
const endedToReview = (row: SessionInboxRowDto, now: Date): boolean => {
  const { session, annotation } = row;
  return (
    annotation !== null &&
    (annotation.pendingFollowUp ||
      (ENDED.has(session.status) &&
        now.getTime() - session.updatedAt.getTime() <= REVIEW_WAIT_MS &&
        annotation.changeId !== null &&
        annotation.totalComments === 0 &&
        changedFiles(row) !== false))
  );
};

/**
 * Every session the person can see, in its group, newest activity first.
 *
 * A session that ended, or sits Idle, goes under To review when its change has files and under
 * Done when it has none (Yiannis, 16 Nov 2026). Until the server has counted a change's files, an
 * ended session waits under To review and an Idle one stays under Running, where they were.
 */
export function inboxRows({
  rows,
  marks,
  now,
  nameOf = () => null,
}: {
  readonly rows: ReadonlyArray<SessionInboxRowDto>;
  readonly marks: ReadonlyArray<InboxMark>;
  readonly now: Date;
  /** Names the people who ask for shared control; null until the roster is read. */
  readonly nameOf?: (userId: string) => string | null;
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
        // Absent from a server before SLNT-1113: read as unknown.
        worktreeName: row.worktreeName ?? null,
        failure: row.failure ?? null,
        activity: row.activity ?? null,
        // Absent from a server before SLNT-1149: nobody asks.
        askers: (row.sharedControlAsks ?? []).map((ask) => nameOf(ask.userId)),
        snoozedUntil: null,
        doneAt: null,
        markedDone: false,
      };
      const mark = markOf.get(session.id);
      if (mark?.state === "settled")
        return { ...base, group: "done", doneAt: mark.markedAt, markedDone: true };
      if (mark?.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now)
        return { ...base, group: "snoozed", snoozedUntil: mark.snoozedUntil };
      if (session.status === "waiting") return { ...base, group: "waiting" };
      // Someone asks the owner for shared control: it waits on them to answer (SLNT-1158).
      if (base.askers.length > 0 && !ENDED.has(session.status))
        return { ...base, group: "waiting" };
      if (session.status === "idle") {
        const files = changedFiles(row);
        if (files === null) return { ...base, group: "running" };
        return files
          ? { ...base, group: "review" }
          : { ...base, group: "done", doneAt: session.updatedAt };
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

/**
 * The rows a group lists: the first `GROUP_ROWS`, every row once "Show N more" is pressed, and
 * the open session wherever it falls in its group.
 */
export const shownRows = (
  rows: ReadonlyArray<InboxRow>,
  openId: string | undefined,
  showAll: boolean,
): ReadonlyArray<InboxRow> => {
  if (showAll || rows.length <= GROUP_ROWS) return rows;
  return rows.filter((row, index) => index < GROUP_ROWS || row.session.id === openId);
};

/**
 * The sessions the collapsed sidebar shows, one glyph each: the rows the full sidebar lists in its
 * open groups, in the same order, Waiting on you first.
 */
export const railRows = (
  groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>,
  folds: InboxFolds,
  openId: string | undefined,
): ReadonlyArray<InboxRow> =>
  INBOX_GROUPS.flatMap(({ group }) =>
    folds[group] ? shownRows(groups[group], openId, false) : [],
  );

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
  if (row.group === "snoozed") return plain(`Back ${backAt(row.snoozedUntil ?? now, now)}`);
  if (row.markedDone) return plain("Marked done");
  if (session.importedConversationWaiting) return plain("Waiting for a first message");
  if (row.group === "waiting" && session.status !== "waiting" && row.askers.length > 0)
    return plain(askersWords(row.askers));
  if (row.group === "waiting") return plain(askWords(row.ask));
  if (row.group === "review" && row.annotation?.pendingFollowUp === true)
    return plain("Follow-up not sent");
  if (row.activity !== null) return plain(activityWords(row.activity));
  return { word: SESSION_WORDS[session.status], failed: session.status === "failed" };
};

/** What a running agent is doing, in the sidebar's short words: "Running a command". */
export const activityWords = (doing: AgentActivityDto): string => {
  switch (doing.kind) {
    case "command":
      return "Running a command";
    case "edit":
      return "Editing files";
    case "search":
      return "Searching the web";
    case "tool":
      return "Using a tool";
    case "thinking":
      return "Thinking";
    case "writing":
      return "Writing a reply";
    case "planning":
      return "Planning";
    case "task":
      return "Running a task";
  }
};

/**
 * What a running agent is doing, naming what it named, for the phone row's second line:
 * "Running pnpm test", "Editing src/checkout.ts".
 */
export const activityDetail = (doing: AgentActivityDto): string => {
  if (doing.subject === null) return activityWords(doing);
  switch (doing.kind) {
    case "command":
    case "task":
      return `Running ${doing.subject}`;
    case "edit":
      return `Editing ${doing.subject}`;
    case "search":
      return `Searching for ${doing.subject}`;
    case "tool":
      return `Using ${doing.subject}`;
    case "thinking":
    case "writing":
    case "planning":
      return activityWords(doing);
  }
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

const daysAhead = (date: Date, now: Date): number =>
  Math.round((dayStart(date) - dayStart(now)) / DAY);

const weekday = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short" });

/** "16:00", "Sat 09:00", "Mon 23 Nov, 09:00": a snooze choice's time, beside its name. */
export const whenAhead = (date: Date, now: Date): string => {
  const days = daysAhead(date, now);
  if (days <= 0) return clock(date);
  if (days < 7) return `${weekday(date)} ${clock(date)}`;
  return `${weekday(date)} ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(date)}`;
};

/** "today at 18:00", "tomorrow at 09:00", "Mon at 09:00", "23 Nov at 09:00": when a snooze ends. */
export const backAt = (date: Date, now: Date): string => {
  const days = daysAhead(date, now);
  if (days <= 0) return `today at ${clock(date)}`;
  if (days === 1) return `tomorrow at ${clock(date)}`;
  if (days < 7) return `${weekday(date)} at ${clock(date)}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${clock(date)}`;
};

/** The clock time an offline inbox was read at: "9:38". */
export const readAt = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A session started while its project clones, before it is a session (`queuedSessions.list`).
 * It waits under Running ("Waiting for the clone", then "Starting"), and once it is a session the
 * inbox lists that session in its place. One that failed waits under To review, in red, with why,
 * until it is started again or cancelled.
 */
export interface QueuedRow {
  readonly id: QueuedSessionDto["id"];
  /** The task's first line, as the person wrote it. */
  readonly title: string;
  readonly projectName: string;
  readonly group: "running" | "review";
  readonly status: RowStatus;
  readonly failure: { readonly step: "clone" | "start"; readonly message: string } | null;
  /** When it last moved. */
  readonly at: Date;
}

const TITLE_LENGTH = 80;

/** The queued sessions not started yet, newest first, each in its group. */
export const queuedRows = (queued: ReadonlyArray<QueuedSessionDto>): ReadonlyArray<QueuedRow> =>
  queued
    .filter((row) => row.state !== "started")
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((row): QueuedRow => {
      const firstLine = (row.launch.prompt ?? "").trim().split("\n")[0] ?? "";
      const base = {
        id: row.id,
        title: firstLine === "" ? "New session" : firstLine.slice(0, TITLE_LENGTH),
        projectName: row.projectName,
        at: row.updatedAt,
      };
      if (row.state === "failed")
        return {
          ...base,
          group: "review",
          status: { word: "Failed", failed: true },
          failure:
            row.failure === null
              ? { step: "start", message: "This session did not start." }
              : { step: row.failure.step, message: row.failure.message },
        };
      return {
        ...base,
        group: "running",
        status: plain(row.state === "waiting" ? "Waiting for the clone" : "Starting"),
        failure: null,
      };
    });
