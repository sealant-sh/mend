import { type AgentItemDto, itemName } from "@mend/agent-conversation";
import type { ScreenLogEntry } from "@mend/domain/workbench";

import type { TranscriptEventDto } from "./api.ts";
import { stepCommand } from "./checks.ts";
import type { ConversationView } from "./conversation.ts";
import { screenLogWords } from "./screen-log.ts";

export type RecordKind = "message" | "command" | "edit" | "screen" | "checkpoint" | "step";

/**
 * What a row opens to: as much of the step as the record holds. A command keeps its output, exit
 * code, how long it ran and where, when its harness records them (Codex does; Claude's tool call
 * holds only the command). Anything else opens to its whole text.
 */
export type RecordDetail =
  | {
      readonly kind: "command";
      readonly output: string | null;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
      readonly cwd: string | null;
      readonly running: boolean;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "edit"; readonly diff: string }
  | { readonly kind: "checkpoint"; readonly sha: string; readonly trigger: string };

/** What the Record reads of a checkpoint. */
export interface RecordCheckpoint {
  readonly id: string;
  readonly ordinal: number;
  readonly sha: string;
  readonly trigger: string;
  readonly createdAt: Date;
}

/** One row of the Record: when, what kind, what, and the checkpoint it is, if it is one. */
export interface RecordRow {
  readonly key: string;
  /** Null for what a terminal session's record holds without a time. */
  readonly at: Date | null;
  readonly kind: RecordKind;
  /** The row's line; a command, an edited file or a checkpoint's own words. */
  readonly text: string;
  /** Who said it, for a message: "Claude Code", "You", "Ada Lovelace". */
  readonly who: string | null;
  /** How it ended, after the line: "exit 1", "failed", "still running". */
  readonly outcome: string | null;
  /** The checkpoint this row is: its link (`#checkpoint-N`) lands here. */
  readonly checkpoint: number | null;
  /** What the row opens to; null when the line is all the record holds. */
  readonly detail: RecordDetail | null;
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

export const isRecordFilter = (value: string): value is RecordFilter =>
  RECORD_FILTERS.some((filter) => filter.value === value);

/** "Message", "Command": a kind as its column says it. */
export const KIND_WORDS: Readonly<Record<RecordKind, string>> = {
  message: "Message",
  command: "Command",
  edit: "Edit",
  screen: "Screen",
  checkpoint: "Checkpoint",
  step: "Step",
};

/** How Mend came to take a checkpoint, in the Record's words. */
export const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  "session-start": "session started",
  "command-settle": "a command settled",
  "turn-boundary": "turn ended",
  "review-open": "review opened",
  "user-mark": "marked by hand",
  "proof-capture": "proof captured",
};

const KIND_OF_ITEM: Readonly<Record<string, RecordKind>> = {
  "assistant-message": "message",
  "command-execution": "command",
  "file-change": "edit",
  screen: "screen",
};

const isRecordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = <T>(
  data: unknown,
  names: ReadonlyArray<string>,
  is: (value: unknown) => value is T,
): T | null => {
  if (!isRecordValue(data)) return null;
  for (const name of names) {
    const value = data[name];
    if (is(value)) return value;
  }
  return null;
};
const isNumber = (value: unknown): value is number => typeof value === "number";
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A command step's detail: Codex's output, exit code, duration and directory; Claude's none. */
const commandDetail = (item: AgentItemDto): RecordDetail => ({
  kind: "command",
  output: field(item.data, ["aggregatedOutput", "output"], isText) ?? item.text,
  exitCode: field(item.data, ["exitCode", "exit_code"], isNumber),
  durationMs: field(item.data, ["durationMs", "duration_ms"], isNumber),
  cwd: field(item.data, ["cwd"], isText),
  running: item.status === "in-progress",
});

const commandOutcome = (item: AgentItemDto): string | null => {
  if (item.status === "in-progress") return "still running";
  const exitCode = field(item.data, ["exitCode", "exit_code"], isNumber);
  if (exitCode !== null) return `exit ${exitCode}`;
  return item.status === "failed" ? "failed" : null;
};

/**
 * The files an edit changed and its diff: Codex's `fileChange` item keeps `changes` (each with its
 * `path` and `diff`), Claude's tool call `input.file_path`.
 */
const editOf = (
  item: AgentItemDto,
): { readonly paths: string; readonly diff: string | null } | null => {
  const data = isRecordValue(item.data) ? item.data : null;
  const changes = Array.isArray(data?.["changes"]) ? data["changes"].filter(isRecordValue) : [];
  const paths = changes.map((change) => change["path"]).filter(isText);
  if (paths.length > 0) {
    const diffs = changes.map((change) => change["diff"]).filter(isText);
    return { paths: paths.join(", "), diff: diffs.length === 0 ? null : diffs.join("\n") };
  }
  const input = isRecordValue(data?.["input"]) ? data["input"] : null;
  const path = field(input, ["file_path", "path"], isText) ?? field(data, ["path"], isText);
  return path === null ? null : { paths: path, diff: null };
};

/** The words a line shows in one row; the rest opens under it. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

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
  readonly checkpoints: ReadonlyArray<RecordCheckpoint>;
  readonly screenLog: ReadonlyArray<ScreenLogEntry>;
  readonly agent: string;
  /** A sender's name; `fallback` names a message the record keeps without its sender. */
  readonly nameOf: (userId: string | null, fallback?: string) => string;
  readonly actorOf: (entry: ScreenLogEntry) => string;
}): ReadonlyArray<RecordRow> => {
  const rows: Array<RecordRow> = [];
  const message = (key: string, at: Date | null, who: string, text: string): RecordRow => ({
    key,
    at,
    kind: "message",
    text: oneLine(text),
    who,
    outcome: null,
    checkpoint: null,
    detail: { kind: "text", text },
  });
  for (const turn of conversation?.turns ?? []) {
    if (turn.origin !== "harness")
      rows.push(
        message(
          `turn:${turn.id}`,
          new Date(turn.createdAt),
          nameOf(turn.author ?? null),
          turn.input,
        ),
      );
    for (const steer of turn.steers ?? [])
      rows.push(
        message(`steer:${steer.id}`, new Date(steer.createdAt), nameOf(steer.author), steer.input),
      );
  }
  for (const item of conversation?.items ?? []) {
    if (item.kind === "reasoning" || item.kind === "user-message") continue;
    const kind = KIND_OF_ITEM[item.kind] ?? "step";
    const at = new Date(item.createdAt);
    if (kind === "message") {
      rows.push(message(`item:${item.id}`, at, agent, item.text ?? ""));
      continue;
    }
    const edit = kind === "edit" ? editOf(item) : null;
    const text =
      (kind === "command" ? stepCommand(item) : null) ?? edit?.paths ?? oneLine(itemName(item));
    rows.push({
      key: `item:${item.id}`,
      at,
      kind,
      text,
      who: null,
      outcome:
        kind === "command" ? commandOutcome(item) : item.status === "failed" ? "failed" : null,
      checkpoint: null,
      detail:
        kind === "command"
          ? commandDetail(item)
          : edit === null || edit.diff === null
            ? null
            : { kind: "edit", diff: edit.diff },
    });
  }
  for (const entry of screenLog)
    rows.push({
      key: `screen:${entry.screenId}:${entry.seq}`,
      at: entry.at,
      kind: "screen",
      text: screenLogWords(entry),
      who: actorOf(entry),
      outcome: null,
      checkpoint: null,
      detail: null,
    });
  for (const checkpoint of checkpoints)
    rows.push({
      key: `checkpoint:${checkpoint.id}`,
      at: checkpoint.createdAt,
      kind: "checkpoint",
      text: `Checkpoint ${checkpoint.ordinal} · ${TRIGGER_WORDS[checkpoint.trigger] ?? checkpoint.trigger}`,
      who: null,
      outcome: null,
      checkpoint: checkpoint.ordinal,
      detail: { kind: "checkpoint", sha: checkpoint.sha, trigger: checkpoint.trigger },
    });
  const dated = rows.toSorted((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  // What the record holds without times, after everything that has one, newest first.
  const undated = transcript.flatMap((event, index): ReadonlyArray<RecordRow> => {
    const key = `record:${index}`;
    if (event.kind === "user" && event.text !== null)
      return [message(key, null, nameOf(null, "You"), event.text)];
    if (event.kind === "assistant" && event.text !== null)
      return [message(key, null, agent, event.text)];
    if (event.kind === "tool")
      return [
        {
          key,
          at: null,
          kind: event.command === null ? "step" : "command",
          text: event.command ?? event.name ?? "tool",
          who: null,
          outcome: null,
          checkpoint: null,
          detail:
            event.output === null
              ? null
              : {
                  kind: "command",
                  output: event.output,
                  exitCode: null,
                  durationMs: null,
                  cwd: null,
                  running: false,
                },
        },
      ];
    return [];
  });
  return [...dated, ...undated.toReversed()];
};

/** The rows a filter shows. */
export const filteredRows = (
  rows: ReadonlyArray<RecordRow>,
  filter: RecordFilter,
): ReadonlyArray<RecordRow> =>
  filter === "all" ? rows : rows.filter((row) => row.kind === filter);

/** The checkpoint a row falls in: the newest one taken at or before it, `#N`. */
export const checkpointAt = (
  checkpoints: ReadonlyArray<RecordCheckpoint>,
  at: Date | null,
): number | null => {
  if (at === null) return null;
  let found: RecordCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.createdAt.getTime() > at.getTime()) continue;
    if (found === null || checkpoint.createdAt > found.createdAt) found = checkpoint;
  }
  return found?.ordinal ?? null;
};

/** The checkpoint a link names: `#checkpoint-6` is 6; anything else is null. */
export const checkpointOfHash = (hash: string): number | null => {
  const match = /^#?checkpoint-(\d+)$/.exec(hash);
  return match === null ? null : Number(match[1]);
};

/** "It exited with code 0 after 41 seconds.": what a finished command's record says of its end. */
export const commandEndWords = (
  detail: Extract<RecordDetail, { readonly kind: "command" }>,
): string | null => {
  if (detail.running) return "It's still running.";
  const after = detail.durationMs === null ? "" : ` after ${durationWords(detail.durationMs)}`;
  if (detail.exitCode !== null) return `It exited with code ${detail.exitCode}${after}.`;
  return detail.durationMs === null ? null : `It ran for ${durationWords(detail.durationMs)}.`;
};

const unit = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** "41 seconds", "2 minutes 4 seconds", "under a second". */
export const durationWords = (durationMs: number): string => {
  if (durationMs < 1000) return "under a second";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? unit(minutes, "minute")
    : `${unit(minutes, "minute")} ${unit(rest, "second")}`;
};
