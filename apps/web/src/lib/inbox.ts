import type { Tone } from "#/components/kit/status";

import type {
  ProjectDetailDto,
  ProjectDto,
  SessionAnnotationDto,
  SessionDto,
  SessionInboxMarkDto,
} from "./api.ts";
import { worktreeDisplayName } from "./workbench-menus.ts";

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

export interface InboxRow {
  readonly session: SessionDto;
  readonly project: InboxProject;
  readonly annotation: SessionAnnotationDto | undefined;
  readonly title: string;
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

const readyToReview = (session: SessionDto, annotation: SessionAnnotationDto | undefined) =>
  annotation !== undefined &&
  (annotation.pendingFollowUp ||
    (session.status === "completed" &&
      annotation.changeId !== null &&
      annotation.totalComments === 0));

/** Every session the person can see, placed in their inbox, newest activity first. */
export function inboxRows({
  projects,
  marks,
  now,
}: {
  readonly projects: ReadonlyArray<{
    readonly project: InboxProject;
    readonly detail: InboxDetail | undefined;
  }>;
  readonly marks: ReadonlyArray<SessionInboxMarkDto>;
  readonly now: Date;
}): ReadonlyArray<InboxRow> {
  const markOf = new Map(marks.map((mark) => [mark.sessionId, mark]));
  const reviewedChanges = new Set<string>();
  const rows = projects.flatMap(({ project, detail }) => {
    if (detail === undefined) return [];
    return detail.sessions
      .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((session): InboxRow => {
        const annotation = detail.annotations.find((row) => row.sessionId === session.id);
        const worktree = detail.worktrees.find((row) => row.id === session.worktreeId);
        const title =
          session.label ??
          (worktree === undefined
            ? `session ${session.id.slice(0, 8)}`
            : worktreeDisplayName(
                worktree,
                detail.sessions.filter((row) => row.worktreeId === session.worktreeId),
              ));
        const base = { session, project, annotation, title };
        const mark = markOf.get(session.id);
        if (mark?.settledAt != null)
          return {
            ...base,
            place: "settled",
            snoozedUntil: null,
            settledAt: mark.settledAt,
            settledByHand: true,
          };
        if (mark?.snoozedUntil != null && mark.snoozedUntil > now)
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
        return { ...open, place: "settled", settledAt: session.settledAt ?? session.updatedAt };
      });
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
      .filter((mark) => mark.settledAt !== null || (mark.snoozedUntil ?? now) > now)
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
      return { tone: "wait", word: "waiting for input" };
    case "review":
      return row.annotation?.pendingFollowUp === true
        ? { tone: "wait", word: "follow-up not sent" }
        : { tone: "ok", word: "completed" };
    case "running":
      if (session.status === "running") {
        const since = session.startedAt ?? session.createdAt;
        return { tone: "run", word: `running · ${duration(now.getTime() - since.getTime())}` };
      }
      return { tone: "off", word: session.status };
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
