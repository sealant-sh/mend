import type { LumpPr, LumpStatus } from "@mend/ui/components/lump";

import type { SessionDetailDto, SessionStatusDto } from "./api.ts";
import type { ConversationRow } from "./conversation-rows.ts";

/** The address of a session's page, the conversation tab of its workspace's sheet. */
export const sessionLink = (sessionId: string) =>
  ({ to: "/sessions/$sessionId", params: { sessionId } }) as const;

/** The lump's shape for a session's status: running, waiting on you, done, failed, stopped, idle. */
export const lumpStatusOf = (status: SessionStatusDto): LumpStatus => {
  switch (status) {
    case "starting":
    case "running":
      return "run";
    case "waiting":
      return "wait";
    case "idle":
      return "idle";
    case "completed":
      return "done";
    case "failed":
      return "fail";
    case "stopping":
    case "stopped":
      return "stop";
  }
};

/** The lump's colour: the change's newest pull request as `gh` last reported it. */
export const lumpPrOf = (landings: SessionDetailDto["landings"]): LumpPr => {
  const pullRequest = landings.find((landing) => landing.pullRequest !== null)?.pullRequest;
  switch (pullRequest?.state) {
    case "open":
      return "open";
    case "merged":
      return "merged";
    case "closed":
    case undefined:
      return "none";
  }
};

/** A session's status as the tab says it to a screen reader: the words the inbox rows use. */
export const STATUS_WORDS: Readonly<Record<SessionStatusDto, string>> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting on you",
  idle: "Idle",
  stopping: "Saving",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * When a message was sent, for its byline: the clock time today ("10:42"), the day and the time
 * before today ("13 Nov, 10:42"), and the year too when it isn't this year.
 */
export const messageTime = (at: Date, now: Date): string => {
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(at, now)) return time;
  const day = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
};

/** A checkpoint as the conversation marks it. */
export interface CheckpointMark {
  readonly ordinal: number;
  readonly sha: string;
  readonly at: string;
}

/** A landing as the conversation marks it (`landingMarks` in `lib/landing.ts`). */
export interface LandingEntryMark {
  readonly key: string;
  readonly label: string;
  readonly sha: string;
  readonly at: string;
  readonly pullRequest: { readonly url: string } | null;
}

/** One entry of the conversation: a message, or a checkpoint or a landing between messages. */
export type ConversationEntry =
  | { readonly kind: "row"; readonly row: ConversationRow }
  | { readonly kind: "checkpoint"; readonly key: string; readonly mark: CheckpointMark }
  | { readonly kind: "landing"; readonly key: string; readonly mark: LandingEntryMark };

/**
 * The session's own checkpoints laid between its messages, each after the last message that began
 * before it was taken: a checkpoint at the end of a turn follows that turn's reply and comes before
 * the next message. The worktree's starting checkpoint (ordinal 0) and those another session in the
 * worktree took are left out. A checkpoint older than every message held is left out too: it
 * belongs to an earlier window, shown when the reader scrolls back to it.
 */
export const withCheckpoints = (
  rows: ReadonlyArray<ConversationRow>,
  checkpoints: ReadonlyArray<{
    readonly ordinal: number;
    readonly sessionId: string | null;
    readonly sha: string;
    readonly createdAt: Date | string;
  }>,
  sessionId: string,
  /** Whether the rows reach the start of the conversation (no older window to read). */
  fromStart: boolean,
): ReadonlyArray<ConversationEntry> => {
  const marks = checkpoints
    .filter((checkpoint) => checkpoint.ordinal > 0 && checkpoint.sessionId === sessionId)
    .map((checkpoint) => ({
      ordinal: checkpoint.ordinal,
      sha: checkpoint.sha.slice(0, 7),
      at: new Date(checkpoint.createdAt).toISOString(),
    }))
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const first = rows[0]?.at;
  const entries: Array<ConversationEntry> = [];
  let next = 0;
  const markUntil = (before: string | null) => {
    while (next < marks.length) {
      const mark = marks[next];
      if (mark === undefined || (before !== null && mark.at >= before)) return;
      next += 1;
      if (!fromStart && first !== undefined && mark.at < first) continue;
      entries.push({ kind: "checkpoint", key: `checkpoint:${mark.ordinal}`, mark });
    }
  };
  for (const row of rows) {
    markUntil(row.at);
    entries.push({ kind: "row", row });
  }
  markUntil(null);
  return entries;
};

const entryAt = (entry: ConversationEntry): string =>
  entry.kind === "row" ? entry.row.at : entry.mark.at;

/**
 * The session's landings laid into its conversation, each after the last entry that came before
 * it (Doop "Session · landed": "Checkpoint 9 landed as pull request #412" after checkpoint 9). A
 * landing older than every entry held belongs to an earlier window, as checkpoints do.
 */
export const withLandings = (
  entries: ReadonlyArray<ConversationEntry>,
  marks: ReadonlyArray<LandingEntryMark>,
  fromStart: boolean,
): ReadonlyArray<ConversationEntry> => {
  const out = [...entries];
  for (const mark of marks.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const index = out.findLastIndex((entry) => entryAt(entry) <= mark.at) + 1;
    if (index === 0 && out.length > 0 && !fromStart) continue;
    out.splice(index, 0, { kind: "landing", key: mark.key, mark });
  }
  return out;
};
