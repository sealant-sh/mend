import { sessionTitle as titleOf } from "@mend/domain/workbench";

import type { Tone } from "#/components/kit/status";

import type {
  ProjectDetailDto,
  ProjectDto,
  SessionAnnotationDto,
  SessionAskDto,
  SessionDto,
  SessionInboxMarkDto,
  SessionInboxRowDto,
} from "./api.ts";

/**
 * Where a session sits in a person's inbox. The first three follow its status; Snoozed and
 * Settled fold at the bottom. A session that ended with nothing left to read settles on its own;
 * any session can be settled or snoozed by hand, for this person only.
 */
export type InboxPlace = "needs-you" | "running" | "review" | "snoozed" | "settled";

export const OPEN_PLACES = [
  { place: "needs-you", label: "Needs you" },
  { place: "running", label: "Running" },
  { place: "review", label: "Ready to review" },
] as const satisfies ReadonlyArray<{ readonly place: InboxPlace; readonly label: string }>;

export type InboxProject = Pick<ProjectDto, "id" | "name">;
export type InboxDetail = Pick<ProjectDetailDto, "sessions" | "annotations" | "worktrees">;

/** What a row shows of a session: the inbox read's trimmed session, or a whole one. */
export type InboxSession = SessionInboxRowDto["session"];
/** What a row reads of the worktree's change: the inbox read's trimmed facts, or the whole set. */
export type InboxAnnotation = NonNullable<SessionInboxRowDto["annotation"]>;

/** What a row is made from: the inbox read's row, or a project's detail (`sourcesOfProject`). */
export interface InboxSource {
  readonly session: InboxSession;
  readonly project: InboxProject;
  readonly annotation: InboxAnnotation | undefined;
  readonly title: string;
  /** Why a waiting session waits, when the read says. */
  readonly ask: SessionAskDto | null;
}

export interface InboxRow extends InboxSource {
  readonly place: InboxPlace;
  /** When a snooze ends, for Snoozed rows. */
  readonly snoozedUntil: Date | null;
  /** When the row settled: by hand, or when the session ended. */
  readonly settledAt: Date | null;
  /** True when the person settled it, false when it settled because the session ended. */
  readonly settledByHand: boolean;
}

const RUNNING: ReadonlySet<SessionDto["status"]> = new Set([
  "starting",
  "running",
  "idle",
  "stopping",
]);

const readyToReview = (session: InboxSession, annotation: InboxAnnotation | undefined) =>
  annotation !== undefined &&
  (annotation.pendingFollowUp ||
    (session.status === "completed" &&
      annotation.changeId !== null &&
      annotation.totalComments === 0));

/**
 * What a session is called wherever it is listed or opened: its label, else its worktree's name,
 * else the start of its id. The same words in the inbox and the session's own header; the server
 * names inbox rows with the same rule.
 */
export const sessionTitle = (
  session: Pick<SessionDto, "id" | "label" | "worktreeId">,
  detail: Pick<ProjectDetailDto, "sessions" | "worktrees"> | undefined,
): string =>
  titleOf(
    session,
    detail?.worktrees.find((row) => row.id === session.worktreeId),
    detail?.sessions.filter((row) => row.worktreeId === session.worktreeId) ?? [],
  );

/** The inbox read's rows as row sources. */
export const sourcesOfInbox = (
  rows: ReadonlyArray<SessionInboxRowDto>,
): ReadonlyArray<InboxSource> =>
  rows.map((row) => ({
    session: row.session,
    project: { id: row.session.projectId, name: row.projectName },
    annotation: row.annotation ?? undefined,
    title: row.title,
    ask: row.ask,
  }));

/** One project's sessions, from its detail, as row sources: the project page's list. */
export const sourcesOfProject = (
  project: InboxProject,
  detail: InboxDetail | undefined,
): ReadonlyArray<InboxSource> =>
  detail === undefined
    ? []
    : detail.sessions.map((session) => ({
        session,
        project,
        annotation: detail.annotations.find((row) => row.sessionId === session.id),
        title: sessionTitle(session, detail),
        ask: null,
      }));

/** Every session the person can see, placed in their inbox, newest activity first. */
export function inboxRows({
  sources,
  marks,
  now,
}: {
  readonly sources: ReadonlyArray<InboxSource>;
  readonly marks: ReadonlyArray<SessionInboxMarkDto>;
  readonly now: Date;
}): ReadonlyArray<InboxRow> {
  const markOf = new Map(marks.map((mark) => [mark.sessionId, mark]));
  const reviewedChanges = new Set<string>();
  const rows = sources
    .toSorted((a, b) => b.session.updatedAt.getTime() - a.session.updatedAt.getTime())
    .map((base): InboxRow => {
      const { session, annotation } = base;
      const mark = markOf.get(session.id);
      if (mark?.state === "settled")
        return {
          ...base,
          place: "settled",
          snoozedUntil: null,
          settledAt: mark.markedAt,
          settledByHand: true,
        };
      if (mark?.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now)
        return {
          ...base,
          place: "snoozed",
          snoozedUntil: mark.snoozedUntil,
          settledAt: null,
          settledByHand: false,
        };
      const open = { ...base, snoozedUntil: null, settledAt: null, settledByHand: false };
      if (session.status === "waiting") return { ...open, place: "needs-you" };
      if (RUNNING.has(session.status)) return { ...open, place: "running" };
      // One row per change: the worktree's sessions share it, so only the newest one is listed.
      const changeId = annotation?.changeId ?? null;
      if (readyToReview(session, annotation) && !reviewedChanges.has(changeId ?? session.id)) {
        reviewedChanges.add(changeId ?? session.id);
        return { ...open, place: "review" };
      }
      // Kept in the inbox by hand: an ended session waits under Ready to review until settled.
      if (mark?.state === "inbox") return { ...open, place: "review" };
      return { ...open, place: "settled", settledAt: session.settledAt ?? session.updatedAt };
    });
  return rows.toSorted((a, b) => activity(b) - activity(a));
}

const activity = (row: InboxRow) => (row.settledAt ?? row.session.updatedAt).getTime();

/** The inbox filters on one line: projects, who started it, which agent, which branch. */
export interface InboxFilters {
  /** Empty means every project. */
  readonly projectIds: ReadonlyArray<string>;
  readonly startedBy: "anyone" | "me";
  readonly agent: string | null;
  readonly branch: string | null;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  projectIds: [],
  startedBy: "me",
  agent: null,
  branch: null,
};

export const matchesFilters = (
  row: InboxRow,
  filters: InboxFilters,
  viewerId: string | null,
): boolean =>
  (filters.projectIds.length === 0 || filters.projectIds.includes(row.project.id)) &&
  (filters.startedBy === "anyone" || viewerId === null || row.session.ownerUserId === viewerId) &&
  (filters.agent === null || row.session.harness === filters.agent) &&
  (filters.branch === null || row.session.branch === filters.branch);

/** Rows by place, in the order the inbox shows them. */
export const groupRows = (
  rows: ReadonlyArray<InboxRow>,
): Readonly<Record<InboxPlace, ReadonlyArray<InboxRow>>> => ({
  "needs-you": rows.filter((row) => row.place === "needs-you"),
  running: rows.filter((row) => row.place === "running"),
  review: rows.filter((row) => row.place === "review"),
  snoozed: rows
    .filter((row) => row.place === "snoozed")
    .toSorted((a, b) => (a.snoozedUntil?.getTime() ?? 0) - (b.snoozedUntil?.getTime() ?? 0)),
  settled: rows.filter((row) => row.place === "settled"),
});

/**
 * The waiting sessions a person has not snoozed or settled: the rail's badge and the Sessions
 * count. Read from the live list, so every page can show it without loading every project.
 */
export const needsYouCount = (
  active: ReadonlyArray<SessionDto>,
  marks: ReadonlyArray<SessionInboxMarkDto>,
  now: Date,
): number => {
  const marked = new Set(
    marks
      .filter(
        (mark) =>
          mark.state === "settled" ||
          (mark.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now),
      )
      .map((mark) => mark.sessionId),
  );
  return active.filter((session) => session.status === "waiting" && !marked.has(session.id)).length;
};

/** The mono status word and dot a row carries. */
export const rowStatus = (row: InboxRow, now: Date): { tone: Tone | null; word: string } => {
  const { session } = row;
  switch (row.place) {
    case "snoozed":
      return { tone: null, word: `until ${whenAhead(row.snoozedUntil ?? now, now)}` };
    case "settled":
      if (row.settledByHand) return { tone: null, word: `settled ${ago(row.settledAt, now)}` };
      return {
        tone: session.status === "failed" ? "bad" : null,
        word: `${session.status} ${ago(row.settledAt, now)}`,
      };
    case "needs-you":
      return { tone: "wait", word: askWords(row.ask) };
    case "review":
      return row.annotation?.pendingFollowUp === true
        ? { tone: "wait", word: "follow-up not sent" }
        : session.status === "completed"
          ? { tone: "ok", word: "completed" }
          : { tone: session.status === "failed" ? "bad" : "off", word: session.status };
    case "running":
      if (session.status === "running") {
        const since = session.startedAt ?? session.createdAt;
        return { tone: "run", word: `running · ${duration(now.getTime() - since.getTime())}` };
      }
      return { tone: "off", word: session.status };
  }
};

/** Why a waiting session waits, in the row's words: "wants to run pnpm test". */
export const askWords = (ask: SessionAskDto | null): string => {
  switch (ask?.kind) {
    case "question":
      return "asked a question";
    case "command":
      return ask.subject === null ? "wants to run a command" : `wants to run ${ask.subject}`;
    case "edit":
      return ask.subject === null ? "wants to edit files" : `wants to edit ${ask.subject}`;
    case "tool":
      return ask.subject === null ? "wants to use a tool" : `wants to use ${ask.subject}`;
    case "decision":
    case undefined:
      return "waiting for input";
  }
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "6 min", "2 h", "3 d": how long something has run. */
export const duration = (ms: number): string =>
  ms < HOUR
    ? `${Math.max(1, Math.floor(ms / MINUTE))} min`
    : ms < DAY
      ? `${Math.floor(ms / HOUR)} h`
      : `${Math.floor(ms / DAY)} d`;

const clock = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "just now", "12 min ago", "2 h ago", "yesterday", "Oct 30". */
export const ago = (date: Date | null, now: Date): string => {
  if (date === null) return "";
  const ms = now.getTime() - date.getTime();
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  const days = Math.round((dayStart(now) - dayStart(date)) / DAY);
  if (days === 0) return `${Math.floor(ms / HOUR)} h ago`;
  if (days === 1) return "yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** "16:00", "tomorrow 09:00", "Mon 09:00": when a snooze ends. */
export const whenAhead = (date: Date, now: Date): string => {
  const days = Math.round((dayStart(date) - dayStart(now)) / DAY);
  if (days <= 0) return clock(date);
  if (days === 1) return `tomorrow ${clock(date)}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock(date)}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** The snooze choices the row menu offers, each with the time it ends. */
export const snoozeChoices = (
  now: Date,
): ReadonlyArray<{ readonly label: string; readonly until: Date }> => {
  const at = (days: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
  const evening = at(0, 18);
  const nextMonday = at(((8 - now.getDay()) % 7) + (now.getDay() === 1 ? 7 : 0), 9);
  return [
    { label: "In an hour", until: new Date(now.getTime() + HOUR) },
    ...(evening.getTime() - now.getTime() > HOUR
      ? [{ label: "This evening", until: evening }]
      : []),
    { label: "Tomorrow morning", until: at(1, 9) },
    { label: "Next week", until: nextMonday },
  ];
};
