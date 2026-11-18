import type { SessionInboxMarkDto, SessionInboxRowDto } from "./api.ts";
import { backAt, type InboxRow } from "./inbox.ts";
import { documentWriter } from "./optimistic.ts";

/**
 * What a person does to a session from its inbox row, without opening it: rename it, snooze it,
 * mark it done, copy its link. Marks are the person's own (the server keeps one per person and
 * session); a label is the session's, so only its owner renames it.
 *
 * Each change shows at once: the writers below lay every change still on its way over the server's
 * copy, so a refetch or an event landing meanwhile can't undo it on screen, and a refused change
 * falls back to the server's copy on its own.
 */

type SessionId = SessionInboxMarkDto["sessionId"];

/** A mark as the server takes it (`sessions.setInboxMark`). */
export type MarkChange =
  | { readonly _tag: "Snoozed"; readonly until: Date }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Inbox" };

/** One mark write: which session, the change, and when the person made it. */
export interface MarkWrite {
  readonly id: SessionId;
  readonly mark: MarkChange;
  readonly at: Date;
}

const markOf = ({ id, mark, at }: MarkWrite): SessionInboxMarkDto => ({
  sessionId: id,
  state: mark._tag === "Snoozed" ? "snoozed" : mark._tag === "Settled" ? "settled" : "inbox",
  snoozedUntil: mark._tag === "Snoozed" ? mark.until : null,
  markedAt: at,
});

const withMark = (
  marks: ReadonlyArray<SessionInboxMarkDto>,
  mark: SessionInboxMarkDto,
): ReadonlyArray<SessionInboxMarkDto> => [
  ...marks.filter((each) => each.sessionId !== mark.sessionId),
  mark,
];

/** The person's marks, with every mark still on its way laid over its session's. */
export const marksWriter = documentWriter<
  ReadonlyArray<SessionInboxMarkDto>,
  MarkWrite,
  SessionInboxMarkDto
>({
  overlay: (marks, write) => withMark(marks, markOf(write)),
  saved: (marks, saved) => withMark(marks, saved),
});

/** One label write: the session and its new label, null to clear it. */
export interface LabelWrite {
  readonly id: SessionId;
  readonly label: string | null;
}

/** A label as the server keeps it: trimmed, and an empty one is no label. */
export const labelOf = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
};

const withLabel = (
  rows: ReadonlyArray<SessionInboxRowDto>,
  { id, label }: LabelWrite,
): ReadonlyArray<SessionInboxRowDto> =>
  rows.map((row) =>
    row.session.id === id
      ? {
          ...row,
          // The server's title is the label, else the worktree's name.
          title: label ?? row.worktreeName ?? row.title,
          session: { ...row.session, label },
        }
      : row,
  );

/** The inbox's rows, with every rename still on its way laid over its row's title. */
export const labelsWriter = documentWriter<ReadonlyArray<SessionInboxRowDto>, LabelWrite, unknown>({
  overlay: withLabel,
  saved: (rows, _session, write) => withLabel(rows, write),
});

/** The change that puts a session's mark back as it was before `marks` changed it. */
export const markBefore = (
  marks: ReadonlyArray<Pick<SessionInboxMarkDto, "sessionId" | "state" | "snoozedUntil">>,
  id: string,
  now: Date,
): MarkChange => {
  const mark = marks.find((each) => each.sessionId === id);
  if (mark?.state === "settled") return { _tag: "Settled" };
  if (mark?.state === "snoozed" && mark.snoozedUntil !== null && mark.snoozedUntil > now)
    return { _tag: "Snoozed", until: mark.snoozedUntil };
  // No mark, or a snooze that is over. The server can't remove a mark; "Inbox" leaves the session
  // where its status puts it, except that an ended one waits under To review until marked done.
  return { _tag: "Inbox" };
};

const HOUR = 60 * 60_000;

/** The snooze choices: in an hour, this evening (while it is more than an hour off), tomorrow morning, next Monday. */
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

/** Which actions a row's menu offers. */
export interface RowActions {
  readonly snooze: boolean;
  /** Back out of Snoozed now. */
  readonly unsnooze: boolean;
  readonly markDone: boolean;
  /** Back out of Done, for a row the person marked done. */
  readonly markNotDone: boolean;
  /** Only the session's owner renames it. */
  readonly rename: boolean;
}

export const rowActions = (row: InboxRow, viewerId: string | null): RowActions => ({
  snooze: row.group !== "done",
  unsnooze: row.group === "snoozed",
  markDone: row.group !== "done",
  markNotDone: row.group === "done" && row.markedDone,
  rename: viewerId !== null && row.session.ownerUserId === viewerId,
});

/** The address a copied link opens: the session's page on this server. */
export const sessionUrl = (origin: string, id: string): string => `${origin}/sessions/${id}`;

/** What a toast says once a change is made. */
export const doneWords = {
  snoozed: (title: string, until: Date, now: Date) =>
    `Snoozed "${title}" until ${backAt(until, now)}.`,
  unsnoozed: (title: string) => `Moved "${title}" out of Snoozed.`,
  markedDone: (title: string) => `Moved "${title}" to Done.`,
  markedNotDone: (title: string) => `Moved "${title}" out of Done.`,
  renamed: (title: string) => `Renamed to "${title}".`,
  copied: (title: string) => `Copied the link to "${title}".`,
} as const;

/** What a toast says when the server refused a change and the row went back as it was. */
export const refusedWords = (verb: string, title: string, error: unknown): string => {
  const reason = error instanceof Error && error.message !== "" ? error.message : "";
  const why = reason === "" ? "Try again." : /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return `Couldn't ${verb} "${title}". ${why}`;
};
