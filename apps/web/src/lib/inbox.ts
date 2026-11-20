import { REVIEW_WAIT_MS } from "@mend/domain/workbench";
import type { LumpPr, LumpStatus } from "@mend/ui/components/lump";
import type { StatusTone } from "@mend/ui/components/status";

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
   * Whether a running agent is on a turn; false between a conversation's turns, null from a
   * server too old to say.
   */
  readonly turnOpen: boolean | null;
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
  /**
   * In Done because the person marked it done, not because of how the session ended: only the
   * menu's Mark not done tells the two apart; the row's words say what happened.
   */
  readonly markedDone: boolean;
}

/** Ended: the agent exited, failed, or was stopped, and its workspace is gone or going. */
const ENDED: ReadonlySet<InboxSession["status"]> = new Set(["completed", "stopped", "failed"]);

/** The session is alive: starting, working, asking, between turns, or saving before it goes. */
export const isAlive = (status: InboxSession["status"]): boolean => !ENDED.has(status);

/**
 * Whether the session's change has files, as the server last counted them; null when it hasn't
 * counted them yet (a session from before the count, or one whose count failed).
 */
const changedFiles = ({ annotation }: SessionInboxRowDto): boolean | null =>
  annotation?.fileCount == null ? null : annotation.fileCount > 0;

/**
 * An ended session waits under To review: a follow-up waits to be sent, or it ended within
 * `REVIEW_WAIT_MS` with no review comment on its change and either failed (a failure is never
 * filed away unseen, files or not) or changed files. A change whose files weren't counted waits
 * too: it is never hidden for want of a count. The server lists the same sessions past its cap
 * (`SessionsRepo.listForInbox`), counted or not.
 */
const endedToReview = (row: SessionInboxRowDto, now: Date): boolean => {
  const { session, annotation } = row;
  if (annotation?.pendingFollowUp === true) return true;
  if (now.getTime() - session.updatedAt.getTime() > REVIEW_WAIT_MS) return false;
  if (annotation !== null && annotation.totalComments > 0) return false;
  if (session.status === "failed") return true;
  return annotation !== null && annotation.changeId !== null && changedFiles(row) !== false;
};

/** The agent, an imported conversation or a teammate asks something of the person. */
const asksYou = (row: SessionInboxRowDto, askers: number): boolean =>
  row.session.status === "waiting" ||
  row.session.importedConversationWaiting ||
  (askers > 0 && isAlive(row.session.status));

/**
 * When something new last happened, as far as a mark is concerned: the server's `lastNewAt` (an
 * agent started, a turn was sent, the agent asked or was answered), or a teammate's newest ask
 * for shared control. Null when nothing has, or the server is older than `lastNewAt`.
 */
const newestEvent = (row: SessionInboxRowDto): Date | null =>
  [
    row.lastNewAt ?? null,
    ...(row.sharedControlAsks ?? []).map((ask) => ask.askedAt),
  ].reduce<Date | null>(
    (latest, at) => (at === null || (latest !== null && latest >= at) ? latest : at),
    null,
  );

/**
 * A done or snooze mark holds only while nothing new has happened since it was made (rule M of
 * the session states model): comparing the mark's time with the session's newest event, both by
 * the server's clock, settles a mark that races a new turn without the server deleting it.
 */
const holds = (mark: InboxMark | undefined, row: SessionInboxRowDto): mark is InboxMark => {
  if (mark === undefined) return false;
  const newest = newestEvent(row);
  return newest === null || mark.markedAt >= newest;
};

/**
 * Every session the person can see, in its group, newest activity first. The groups follow the
 * session's life, not the agent's turn (Yiannis, 20 Nov 2026):
 *
 * - **Running** while the session is alive and asks nothing: starting, working, or finished its
 *   reply and waiting for the next message. Nothing the person marked overrides it.
 * - **Waiting on you** while the agent asks (a question, a command, an edit), a teammate asks to
 *   share control, or an imported conversation waits for its first message. A snooze made after
 *   the ask holds it in Snoozed until the snooze ends; a new ask brings it back at once.
 * - Once the session has ended: **Snoozed** while a snooze made since it last ran is on; **Done**
 *   when marked done since it last ran; **To review** when its change has files nobody reviewed
 *   yet (or isn't counted, or a follow-up waits), or it failed, one row per change; else **Done**.
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
        // Absent from a server before SLNT-1199: a running session is on a turn.
        turnOpen: row.turnOpen ?? null,
        // Absent from a server before SLNT-1149: nobody asks.
        askers: (row.sharedControlAsks ?? []).map((ask) => nameOf(ask.userId)),
        snoozedUntil: null,
        doneAt: null,
        markedDone: false,
      };
      const found = markOf.get(session.id);
      const mark = holds(found, row) ? found : undefined;
      const snoozedUntil =
        mark?.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now
          ? mark.snoozedUntil
          : null;
      if (asksYou(row, base.askers.length))
        return snoozedUntil === null
          ? { ...base, group: "waiting" }
          : { ...base, group: "snoozed", snoozedUntil };
      if (isAlive(session.status)) return { ...base, group: "running" };
      // One row per change: the worktree's sessions share it, so its newest ended session speaks
      // for it, whatever that one's mark. Marking it done puts the change away; an older session
      // of the change doesn't take its place under To review.
      const change = annotation?.changeId ?? session.id;
      const speaksForChange = endedToReview(row, now) && !reviewedChanges.has(change);
      if (speaksForChange) reviewedChanges.add(change);
      if (snoozedUntil !== null) return { ...base, group: "snoozed", snoozedUntil };
      if (mark?.state === "settled")
        return { ...base, group: "done", doneAt: mark.markedAt, markedDone: true };
      if (speaksForChange) return { ...base, group: "review" };
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

/**
 * A session's status word from its status alone, for a session the inbox doesn't list (the
 * project page's older sessions). "Replied" is a finished turn with the session still up.
 */
export const SESSION_WORDS: Readonly<Record<InboxSession["status"], string>> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting on you",
  idle: "Replied",
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

/** What `statusWord` and `rowLump` read of a row: the session's facts, never the person's marks. */
export type RowFacts = Pick<
  InboxRow,
  "session" | "annotation" | "ask" | "activity" | "turnOpen" | "askers"
>;

/**
 * The agent finished its reply and the session is still up, waiting for the next message: a
 * terminal agent `idle`, or a conversation between turns (it reads `running`).
 */
const replied = (row: RowFacts): boolean =>
  row.session.status === "idle" ||
  (row.session.status === "running" && row.turnOpen === false && row.activity === null);

/**
 * What a session is doing, is waiting on, or how it ended, in one word or short phrase: the
 * sidebar row, the rail's name for it and the project page's table all read it here, so they
 * never disagree. It reads the session's facts only, never the person's marks: a row someone
 * marked done says what happened ("Completed", "Replied"), not "Marked done".
 */
export const statusWord = (row: RowFacts): RowStatus => {
  const { session } = row;
  if (session.importedConversationWaiting) return plain("Waiting for your first message");
  if (session.status === "waiting") return plain(askWords(row.ask));
  if (row.askers.length > 0 && isAlive(session.status)) return plain(askersWords(row.askers));
  if (session.status === "running" && row.activity !== null)
    return plain(activityWords(row.activity));
  if (replied(row)) return plain("Replied");
  if (ENDED.has(session.status) && row.annotation?.pendingFollowUp === true)
    return plain("Follow-up not sent");
  return { word: SESSION_WORDS[session.status], failed: session.status === "failed" };
};

/**
 * What a sidebar row says: when a snoozed row comes back, else the session's own word
 * (`statusWord`).
 */
export const rowStatus = (row: InboxRow, now: Date): RowStatus =>
  row.group === "snoozed" ? plain(`Back ${backAt(row.snoozedUntil ?? now, now)}`) : statusWord(row);

const ENDED_SHAPES: Readonly<Partial<Record<InboxSession["status"], LumpStatus>>> = {
  completed: "done",
  failed: "fail",
  stopped: "stop",
};

/**
 * The session glyph's shape (the lump, canvas guide `sheet-lump`), always in step with the row's
 * group and words: the kneading shape only in Running while the agent works ("Starting",
 * "Saving" and every activity), the plain dome there once it replied, the amber point only in
 * Waiting on you, and how it ended (a check, a flag, a flat stop) once it has. A snoozed session
 * that still asks rests as the dome: it is put off, not shouting.
 */
export const rowLump = (row: RowFacts & Pick<InboxRow, "group">): LumpStatus => {
  if (row.group === "waiting") return "wait";
  const ended = ENDED_SHAPES[row.session.status];
  if (ended !== undefined) return ended;
  if (row.group === "running") return replied(row) ? "idle" : "run";
  return "idle";
};

/** The glyph's colour: the change's newest pull request as `gh` last reported it. */
export const rowPr = (row: Pick<InboxRow, "annotation">): LumpPr => {
  switch (row.annotation?.pullRequestState) {
    case "open":
      return "open";
    case "merged":
      return "merged";
    case "closed":
    case null:
    case undefined:
      return "none";
  }
};

/**
 * A session's glyph and word from its inbox row alone, placed with no marks (a person's marks are
 * their inbox's): its tab in the sheet reads them here, so it says what its sidebar row says.
 */
export const sessionFace = (
  row: SessionInboxRowDto,
  now: Date,
): { readonly lump: LumpStatus; readonly pr: LumpPr; readonly word: string } | null => {
  const [placed] = inboxRows({ rows: [row], marks: [], now });
  return placed === undefined
    ? null
    : { lump: rowLump(placed), pr: rowPr(placed), word: statusWord(placed).word };
};

/** The table's tone for a row's word: amber while it waits on you, red when it failed. */
export const statusTone = (lump: LumpStatus): StatusTone => {
  switch (lump) {
    case "wait":
      return "wait";
    case "fail":
      return "bad";
    case "done":
      return "ok";
    case "run":
      return "run";
    case "idle":
    case "stop":
      return "idle";
  }
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
  /** Its glyph: kneading while it waits or starts, the flag once it failed. */
  readonly lump: LumpStatus;
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
          lump: "fail",
          failure:
            row.failure === null
              ? { step: "start", message: "This session did not start." }
              : { step: row.failure.step, message: row.failure.message },
        };
      return {
        ...base,
        group: "running",
        status: plain(row.state === "waiting" ? "Waiting for the clone" : "Starting"),
        lump: "run",
        failure: null,
      };
    });
