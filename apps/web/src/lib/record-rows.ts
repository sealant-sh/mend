import { itemName } from "@mend/agent-conversation";
import type { ScreenLogEntry } from "@mend/domain/workbench";

import type { CheckpointDto, TranscriptEventDto } from "./api.ts";
import { stepCommand } from "./checks.ts";
import type { ConversationView } from "./conversation.ts";
import { screenLogWords } from "./screen-log.ts";

export type RecordKind = "message" | "command" | "edit" | "screen" | "checkpoint" | "step";

/** One row of the Record tab: when, what kind, what, and the checkpoint it falls in. */
export interface RecordRow {
  readonly key: string;
  /** Null for what a terminal session's record holds without a time. */
  readonly at: Date | null;
  readonly kind: RecordKind;
  readonly text: string;
  /** The checkpoint this row is: its anchor (`#checkpoint-N`) lands here. */
  readonly checkpoint: number | null;
}

export const RECORD_FILTERS = [
  { value: "all", label: "All" },
  { value: "message", label: "Messages" },
  { value: "command", label: "Commands" },
  { value: "edit", label: "Edits" },
  { value: "screen", label: "Screen" },
  { value: "checkpoint", label: "Checkpoints" },
] as const;

export type RecordFilter = (typeof RECORD_FILTERS)[number]["value"];

const KIND_OF_ITEM: Readonly<Record<string, RecordKind>> = {
  "assistant-message": "message",
  "command-execution": "command",
  "file-change": "edit",
  screen: "screen",
};

/**
 * Everything the session did, newest first: what was said, the commands it ran, the files it
 * edited, its screen, and its checkpoints. `nameOf` names the people who sent messages.
 */
export const recordRows = ({
  conversation,
  transcript,
  checkpoints,
  screenLog,
  agent,
  nameOf,
  actorOf,
}: {
  readonly conversation: ConversationView | undefined;
  /** A terminal session's record, read when it has no conversation turns; it keeps no times. */
  readonly transcript: ReadonlyArray<TranscriptEventDto>;
  readonly checkpoints: ReadonlyArray<CheckpointDto>;
  readonly screenLog: ReadonlyArray<ScreenLogEntry>;
  readonly agent: string;
  /** A sender's name; `fallback` names a message the record keeps without its sender. */
  readonly nameOf: (userId: string | null, fallback?: string) => string;
  readonly actorOf: (entry: ScreenLogEntry) => string;
}): ReadonlyArray<RecordRow> => {
  const rows: Array<RecordRow> = [];
  for (const turn of conversation?.turns ?? []) {
    if (turn.origin !== "harness")
      rows.push({
        key: `turn:${turn.id}`,
        at: new Date(turn.createdAt),
        kind: "message",
        text: `${nameOf(turn.author ?? null)}: ${turn.input}`,
        checkpoint: null,
      });
    for (const steer of turn.steers ?? [])
      rows.push({
        key: `steer:${steer.id}`,
        at: new Date(steer.createdAt),
        kind: "message",
        text: `${nameOf(steer.author)}: ${steer.input}`,
        checkpoint: null,
      });
  }
  for (const item of conversation?.items ?? []) {
    if (item.kind === "reasoning" || item.kind === "user-message") continue;
    const kind = KIND_OF_ITEM[item.kind] ?? "step";
    const text =
      kind === "message"
        ? `${agent}: ${(item.text ?? "").replace(/\s+/g, " ")}`
        : `${(item.kind === "command-execution" ? stepCommand(item) : null) ?? itemName(item)}${item.status === "failed" ? " · failed" : ""}`;
    rows.push({
      key: `item:${item.id}`,
      at: new Date(item.createdAt),
      kind,
      text,
      checkpoint: null,
    });
  }
  for (const entry of screenLog)
    rows.push({
      key: `screen:${entry.screenId}:${entry.seq}`,
      at: entry.at,
      kind: "screen",
      text: `${actorOf(entry)} · ${screenLogWords(entry)}`,
      checkpoint: null,
    });
  for (const checkpoint of checkpoints)
    rows.push({
      key: `checkpoint:${checkpoint.id}`,
      at: checkpoint.createdAt,
      kind: "checkpoint",
      text: `${checkpoint.trigger} · ${checkpoint.sha.slice(0, 12)}`,
      checkpoint: checkpoint.ordinal,
    });
  const dated = rows.toSorted((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  // What the record holds without times, after everything that has one, newest first.
  const undated = transcript.flatMap((event, index): ReadonlyArray<RecordRow> => {
    const key = `record:${index}`;
    if (event.kind === "user" && event.text !== null)
      return [
        {
          key,
          at: null,
          kind: "message",
          text: `${nameOf(null, "You")}: ${event.text}`,
          checkpoint: null,
        },
      ];
    if (event.kind === "assistant" && event.text !== null)
      return [
        {
          key,
          at: null,
          kind: "message",
          text: `${agent}: ${event.text.replace(/\s+/g, " ")}`,
          checkpoint: null,
        },
      ];
    if (event.kind === "tool")
      return [
        {
          key,
          at: null,
          kind: event.command === null ? "step" : "command",
          text: event.command ?? event.name ?? "tool",
          checkpoint: null,
        },
      ];
    return [];
  });
  return [...dated, ...undated.toReversed()];
};

/** The checkpoint a row falls in: the newest one taken at or before it, `#N`. */
export const checkpointAt = (
  checkpoints: ReadonlyArray<CheckpointDto>,
  at: Date | null,
): number | null => {
  if (at === null) return null;
  let found: CheckpointDto | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.createdAt.getTime() > at.getTime()) continue;
    if (found === null || checkpoint.createdAt > found.createdAt) found = checkpoint;
  }
  return found?.ordinal ?? null;
};
