import type { ProjectId, WorktreeId } from "@mend/domain";
import type { Change } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { WorktreeReads } from "@mend/sessions";
import { Effect, Schema, Stream } from "effect";

import { InferenceToolError, type InferenceTool } from "./provider.ts";
import { RecordingEvent } from "./tools.ts";
import { makeTool } from "./toolset.ts";

/** One read_recording call returns at most this many events — narrow with the selector. */
const MAX_RECORDING_EVENTS = 500;
/** A diff bigger than this is truncated in the tool result — the model is told. */
const MAX_DIFF_CHARS = 180_000;

const ReadChangeInput = Schema.Struct({});
const ReadRecordingInput = Schema.Struct({
  fromSequence: Schema.optional(Schema.NullOr(Schema.BigIntFromString)),
  toSequence: Schema.optional(Schema.NullOr(Schema.BigIntFromString)),
  kinds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const ReadTerminalInput = Schema.Struct({
  /** How many characters from the END of the output to return (default 30000). */
  tailChars: Schema.optional(Schema.NullOr(Schema.Int)),
});

const TerminalReadResult = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      exitCode: Schema.NullOr(Schema.Int),
      cwd: Schema.NullOr(Schema.String),
    }),
  ),
  /** ANSI-stripped tail of the harness process's output. */
  output: Schema.String,
  totalChars: Schema.Int,
});

// Control Sequence Introducer / Operating System Command and friends — a TUI
// redraws constantly; without stripping, the scrollback is unreadable noise.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[a-zA-Z]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[()][A-Z0-9]|[=><MC78])`,
  "g",
);
const stripAnsi = (text: string): string =>
  text
    .replaceAll(ANSI_PATTERN, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(/\n{3,}/g, "\n\n");

const ChangeReadResult = Schema.Struct({
  branch: Schema.String,
  baseSha: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, additions: Schema.Int, deletions: Schema.Int }),
  ),
  diff: Schema.String,
  truncated: Schema.Boolean,
});

export interface SessionChangePass {
  readonly readChangeTool: InferenceTool;
  readonly readRecordingTool: InferenceTool;
  /** The harness process's actual output + reconstructed commands. */
  readonly readTerminalTool: InferenceTool;
  /** Sequences the model actually read in this pass — the noise filter's memory. */
  readonly seenSequences: ReadonlySet<string>;
  /** Paths read_change reported as changed — the only valid file anchors. */
  readonly changedPaths: ReadonlySet<string>;
}

/**
 * The session-scoped read tools every "Mend reads the change" pass shares
 * (finding drafts, the tour): no ids cross the tool boundary — the pass is
 * closed over ONE session's worktree and record, so the model cannot wander.
 * The pass object also carries what was actually read, which is what lets
 * writers enforce evidence discipline instead of requesting it politely.
 *
 * Built fresh per job (the seen/changed sets are the pass's memory); callers
 * capture their context at layer construction and provide it per call, the
 * comment-router pattern.
 */
export const makeSessionChangePass = (deps: {
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly change: Change;
  readonly sealantRunId: string;
}): Effect.Effect<SessionChangePass, never, WorktreeReads | SealantClient> =>
  Effect.gen(function* () {
    const reads = yield* WorktreeReads;
    const sealant = yield* SealantClient;
    const seenSequences = new Set<string>();
    const changedPaths = new Set<string>();

    const readChangeTool = makeTool({
      name: "read_change",
      description:
        "The session's change: unified diff of its worktree against the base, with per-file +/- counts. Takes no input.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      input: ReadChangeInput,
      run: () =>
        Effect.gen(function* () {
          // Through the identity-keyed reads: the live worktree beside Mend, or the chain
          // head's worktree tree on a runner in capture mode (ADR-0002) — never a stale copy.
          const diff = (yield* reads.diffWorktree(
            deps.projectId,
            deps.worktreeId,
            deps.change.baseSha,
          )).value;
          const files = (yield* reads.changedFiles(
            deps.projectId,
            deps.worktreeId,
            deps.change.baseSha,
          )).value;
          for (const file of files) changedPaths.add(file.path);
          const truncated = diff.length > MAX_DIFF_CHARS;
          return {
            branch: deps.change.branch,
            baseSha: deps.change.baseSha,
            files,
            diff: truncated
              ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated — ${diff.length} chars total; rely on the per-file counts for scope)`
              : diff,
            truncated,
          };
        }).pipe(
          Effect.mapError(
            (error) =>
              new InferenceToolError({
                tool: "read_change",
                message: `reading the change failed: ${String(error)}`,
              }),
          ),
        ),
      encode: (value) => Schema.encodeEffect(ChangeReadResult)(value).pipe(Effect.orDie),
    });

    const readRecordingTool = makeTool({
      name: "read_recording",
      description:
        "The session's durable record, oldest first. Returns at most 500 events; page with fromSequence, narrow with toSequence/kinds. processStarted/processExited carry commands and exit codes.",
      inputSchema: {
        type: "object",
        properties: {
          fromSequence: { type: ["string", "null"], description: "decimal string" },
          toSequence: { type: ["string", "null"], description: "decimal string" },
          kinds: { type: ["array", "null"], items: { type: "string" } },
        },
        additionalProperties: false,
      },
      input: ReadRecordingInput,
      run: (input) =>
        Effect.gen(function* () {
          const sdkRun = yield* sealant.getRun(deps.sealantRunId);
          const from = input.fromSequence ?? 0n;
          const to = input.toSequence ?? null;
          const kinds = input.kinds ?? null;
          const events = yield* sealant.recordTimeline(sdkRun, { from }).pipe(
            Stream.takeWhile((entry) => to === null || entry.sequence <= to),
            Stream.filter((entry) => (kinds === null ? true : kinds.includes(entry.kind))),
            Stream.take(MAX_RECORDING_EVENTS),
            Stream.map(
              (entry) =>
                new RecordingEvent({
                  sequence: entry.sequence,
                  kind: entry.kind,
                  occurredAt: new Date(entry.occurredAt),
                  summary: entry.summary,
                  // The runtime recorded every timeline entry — that is what observed means.
                  provenance: "observed",
                  data: entry.data,
                }),
            ),
            Stream.runCollect,
          );
          for (const event of events) seenSequences.add(event.sequence.toString());
          return events;
        }).pipe(
          Effect.mapError(
            (error) =>
              new InferenceToolError({
                tool: "read_recording",
                message: `reading the record failed: ${String(error)}`,
              }),
          ),
        ),
      encode: (value) =>
        Schema.encodeEffect(Schema.Array(RecordingEvent))([...value]).pipe(Effect.orDie),
    });

    const readTerminalTool = makeTool({
      name: "read_terminal",
      description:
        "The harness process's ACTUAL terminal output (ANSI-stripped) plus the reconstructed command list. The timeline stores PTY payloads content-addressed — this is where the session's visible work lives. tailChars controls how much of the end you get (default 30000).",
      inputSchema: {
        type: "object",
        properties: {
          tailChars: {
            type: ["integer", "null"],
            description: "chars from the end, default 30000",
          },
        },
        additionalProperties: false,
      },
      input: ReadTerminalInput,
      run: (input) =>
        Effect.gen(function* () {
          const sdkRun = yield* sealant.getRun(deps.sealantRunId);
          const commands = yield* sealant.recordCommands(sdkRun);
          const started = yield* sealant.recordTimeline(sdkRun, { from: 0n }).pipe(
            Stream.filter((entry) => entry.kind === "processStarted"),
            Stream.take(1),
            Stream.runCollect,
          );
          const processId = [...started][0]?.processId ?? null;
          let output = "";
          let totalChars = 0;
          if (processId !== null && processId !== undefined) {
            // A TUI session's output rides the PTY stream; exec-style
            // processes ride stdout. Try the PTY first, fall back.
            let bytes = yield* sealant.recordScrollback(sdkRun, processId, "pty");
            if (bytes.length === 0) {
              bytes = yield* sealant.recordScrollback(sdkRun, processId, "stdout");
            }
            const text = stripAnsi(new TextDecoder().decode(bytes));
            totalChars = text.length;
            const tail = Math.min(Math.max(input.tailChars ?? 30_000, 1_000), 120_000);
            output =
              text.length > tail
                ? `…(${text.length - tail} earlier chars omitted — raise tailChars to see more)\n${text.slice(-tail)}`
                : text;
          }
          return {
            commands: commands.map((command) => ({
              command: command.command,
              exitCode: command.exitCode ?? null,
              cwd: command.cwd ?? null,
            })),
            output,
            totalChars,
          };
        }).pipe(
          Effect.mapError(
            (error) =>
              new InferenceToolError({
                tool: "read_terminal",
                message: `reading the terminal failed: ${String(error)}`,
              }),
          ),
        ),
      encode: (value) => Schema.encodeEffect(TerminalReadResult)(value).pipe(Effect.orDie),
    });

    return { readChangeTool, readRecordingTool, readTerminalTool, seenSequences, changedPaths };
  });
