import type { LumpPr, LumpStatus } from "@mend/ui/components/lump";

import type { SessionDetailDto, SessionStatusDto } from "./api.ts";
import type { ConversationRow } from "./conversation-rows.ts";
import type { CheckpointMark } from "./turn-checkpoints.ts";

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
 * The turns' checkpoints laid into the conversation (`checkpointMarks` in `lib/turn-checkpoints.ts`
 * says which), each right after its turn's reply: after the turn's last reply row, else after the
 * last row older than the checkpoint. So none comes before the first message, and a turn has one
 * at most. One with no row before it in the held window belongs to an earlier window.
 */
export const withCheckpoints = (
  rows: ReadonlyArray<ConversationRow>,
  marks: ReadonlyArray<CheckpointMark>,
): ReadonlyArray<ConversationEntry> => {
  const after = new Map<number, Array<CheckpointMark>>();
  for (const mark of marks.toSorted((a, b) => a.ordinal - b.ordinal)) {
    const reply = rows.findLastIndex((row) => row.kind === "agent" && row.turn?.id === mark.turnId);
    const index = reply === -1 ? rows.findLastIndex((row) => row.at <= mark.at) : reply;
    if (index === -1) continue;
    const held = after.get(index) ?? [];
    held.push(mark);
    after.set(index, held);
  }
  return rows.flatMap(
    (row, index): ReadonlyArray<ConversationEntry> => [
      { kind: "row", row },
      ...(after.get(index) ?? []).map(
        (mark): ConversationEntry => ({ kind: "checkpoint", key: mark.key, mark }),
      ),
    ],
  );
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
