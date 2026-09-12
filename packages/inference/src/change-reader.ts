import { ProjectsRepo, ReviewCommentsRepo, WorktreeChangesRepo, SessionsRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { RecordLink } from "@mend/domain/workbench";
import type { SealantClient } from "@mend/sealant";
import type { WorktreeReads } from "@mend/sessions";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider, InferenceToolError } from "./provider.ts";
import { makeSessionChangePass } from "./session-tools.ts";
import { makeTool } from "./toolset.ts";

/** The `read-change` job's payload — on-demand from the review page (§7.3). */
export class ReadChangeJob extends Schema.Class<ReadChangeJob>("ReadChangeJob")({
  changeId: ChangeId,
}) {}

/**
 * "Mend reads the change" (plan §7.3): the machine review pass over a settled
 * session change. Output is draft review comments — dispositions and evidence
 * links, never verdicts. The evidential noise filter is enforced at the tool
 * boundary, not requested in the prompt: draft_finding rejects any finding
 * whose evidence does not cite a sequence the model actually read in this
 * pass, so an invented pointer cannot land.
 */
const SYSTEM = `You read a settled code change for its author's reviewer, grounded in the session record that produced it. You are Mend's interface inference — you phrase and organize evidence; you cannot mint claims.

Rules a finding never breaks:
- Evidence, not verdicts. You describe what was observed and what was not; you never grade, approve, or recommend. No "LGTM", no severity scores.
- Every finding cites the record. draft_finding requires evidence pointers — sequences you actually read via read_recording in this pass, each with a one-line excerpt. A finding you cannot ground is not emitted; if the gap itself is the observation ("this function was rewritten and nothing exercising it ran"), the evidence is the events that show what DID run.
- Dispositions are earned. "direct-evidence" only when the record contains the event you point to. A path never exercised is "not-executed". An edit in the diff with no cause in the record is "unrelated-change". Nothing defaults to green.
- Findings a diff-only reviewer could write are worth less than findings only the record supports: rewritten-but-never-exercised code, edits with no visible cause, checks that were started and never finished, instructions in the record the diff contradicts.
- Do not restate existing comments — they are given to you; skip anything already covered.
- Zero findings is a legitimate outcome. When the record grounds nothing worth a reviewer's attention, write none and say so in one sentence.

The register — terse, enforced at the tool boundary:
  body ≤ 500 chars (the observation and why it matters; the detail stays behind the evidence pointers).
  Each excerpt ≤ 200 chars (one line — the event's summary or the relevant fragment).
  Plain declarative prose for a professional reviewer: no self-reference ("my reading", "I think"), no editorial labels ("Note:", "Key point:"), no hedging filler ("Worth checking…", "It's worth noting…").

Method — budget your rounds; reads first, then write, then stop:
1. read_change — the diff and per-file counts for this session's worktree against its base.
2. read_terminal — the harness process's ACTUAL output and reconstructed commands. For a TUI session this is where the work is visible; the timeline's PTY payloads are content-addressed hashes, not readable text.
3. read_recording — the structured timeline for sequence anchors (processStarted/processExited carry commands and exit codes). The prompt tells you the record's extent — never probe beyond it. Two or three selective calls suffice; do not page exhaustively.
4. draft_finding — one call per finding, anchored to a file (and line range when the diff pinpoints one) or change-level when it spans files. Ground claims in what read_terminal showed; cite the nearest timeline sequences you read as the evidence anchors. Typically 0-5 findings.
5. Finish with one short sentence: how many findings and the single most important one, or why there are none.

Sequences are decimal strings.`;

const Disposition = Schema.Literals(["direct-evidence", "not-executed", "unrelated-change"]);

const DraftFindingInput = Schema.Struct({
  /** Null file = change-level finding. */
  file: Schema.NullOr(Schema.String),
  line: Schema.optional(Schema.NullOr(Schema.Int)),
  endLine: Schema.optional(Schema.NullOr(Schema.Int)),
  body: Schema.String,
  disposition: Disposition,
  evidence: Schema.Array(
    Schema.Struct({ sequence: Schema.BigIntFromString, excerpt: Schema.String }),
  ),
});

const FindingResult = Schema.Struct({ recorded: Schema.Boolean, commentId: Schema.String });

const failed = (message: string) => new InferenceError({ message, cause: null });
const reject = (message: string) =>
  Effect.fail(new InferenceToolError({ tool: "draft_finding", message }));

export class ChangeReader extends Context.Service<
  ChangeReader,
  {
    /** Resolves with how many draft findings the pass wrote — zero is legitimate. */
    readonly read: (job: ReadChangeJob) => Effect.Effect<number, InferenceError>;
  }
>()("@mend/inference/ChangeReader") {
  static readonly layer = Layer.effect(
    ChangeReader,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const changes = yield* WorktreeChangesRepo;
      const sessions = yield* SessionsRepo;
      const projects = yield* ProjectsRepo;
      const comments = yield* ReviewCommentsRepo;
      // The pass tools need Store + SealantClient; captured here, provided
      // per job (the comment-router pattern — tool sets are built fresh).
      const toolContext = yield* Effect.context<WorktreeReads | SealantClient>();

      const read = Effect.fn("ChangeReader.read")(function* (job: ReadChangeJob) {
        const change = yield* changes
          .byId(job.changeId)
          .pipe(Effect.mapError(() => failed(`no change ${job.changeId}`)));
        // Phase-A record evidence reads the LAST CONTRIBUTING conversation
        // (the change's session mirror); multi-session evidence union is
        // named follow-up work. Null = no session ever inhabited the worktree.
        if (change.sessionId === null) {
          return yield* failed(
            "the change has no contributing session — nothing to ground findings in",
          );
        }
        const session = yield* sessions
          .byId(change.sessionId)
          .pipe(Effect.mapError(() => failed(`no session ${change.sessionId}`)));
        const project = yield* projects
          .byId(change.projectId)
          .pipe(Effect.mapError(() => failed(`no project ${change.projectId}`)));
        if (session.sealantRunId === null) {
          return yield* failed(
            "the session has no record (it never launched supervised) — nothing to ground findings in",
          );
        }
        const sealantRunId = session.sealantRunId;

        const pass = yield* makeSessionChangePass({
          projectId: project.id,
          worktreeId: change.worktreeId,
          change,
          sealantRunId,
        }).pipe(Effect.provide(toolContext));

        const existing = yield* comments.listForChange(job.changeId);

        let findingsWritten = 0;
        const draftFindingTool = makeTool({
          name: "draft_finding",
          description:
            "Record one finding as a draft review comment the reviewer will accept, edit, or dismiss. Evidence is required and every cited sequence must be one you actually read via read_recording in this pass.",
          inputSchema: {
            type: "object",
            properties: {
              file: {
                type: ["string", "null"],
                description: "a changed file's path, or null for a change-level finding",
              },
              line: { type: ["integer", "null"] },
              endLine: { type: ["integer", "null"] },
              body: { type: "string", description: "≤500 chars" },
              disposition: {
                type: "string",
                enum: ["direct-evidence", "not-executed", "unrelated-change"],
              },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sequence: { type: "string", description: "decimal string" },
                    excerpt: { type: "string", description: "≤200 chars" },
                  },
                  required: ["sequence", "excerpt"],
                  additionalProperties: false,
                },
              },
            },
            required: ["file", "body", "disposition", "evidence"],
            additionalProperties: false,
          },
          input: DraftFindingInput,
          run: (input) =>
            Effect.gen(function* () {
              // The evidential noise filter (plan §7.3, hard rule): no record
              // link, no finding. Cited sequences must have been read here.
              if (input.evidence.length === 0) {
                return yield* reject(
                  "a finding without a record link is not emitted — cite sequences you read via read_recording",
                );
              }
              const unseen = input.evidence.filter(
                (pointer) => !pass.seenSequences.has(pointer.sequence.toString()),
              );
              if (unseen.length > 0) {
                return yield* reject(
                  `evidence cites sequences this pass never read: ${unseen.map((p) => p.sequence.toString()).join(", ")} — read them via read_recording first, or drop them`,
                );
              }
              if (input.body.length > 500) {
                return yield* reject(
                  `body is ${input.body.length} chars — the register caps it at 500; state the observation once and let the evidence carry the detail`,
                );
              }
              const overlong = input.evidence.filter((pointer) => pointer.excerpt.length > 200);
              if (overlong.length > 0) {
                return yield* reject("excerpts cap at 200 chars — quote the relevant fragment");
              }
              if (input.file !== null && !pass.changedPaths.has(input.file)) {
                return yield* reject(
                  `"${input.file}" is not in this change — anchor to a changed file from read_change, or use null for change-level`,
                );
              }
              const created = yield* comments
                .create({
                  changeId: job.changeId,
                  file: input.file,
                  line: input.file === null ? null : (input.line ?? null),
                  endLine: input.file === null ? null : (input.endLine ?? null),
                  authorKind: "mend",
                  authorName: "Mend",
                  body: input.body,
                  state: "draft",
                  evidence: input.evidence.map(
                    (pointer) =>
                      new RecordLink({
                        sealantRunId,
                        sequence: pointer.sequence,
                        excerpt: pointer.excerpt,
                      }),
                  ),
                })
                .pipe(Effect.orDie);
              findingsWritten += 1;
              return { recorded: true, commentId: created.id };
            }),
          encode: (value) => Schema.encodeEffect(FindingResult)(value).pipe(Effect.orDie),
        });

        const existingSummary =
          existing.length === 0
            ? "none"
            : existing
                .map(
                  (comment) =>
                    `- ${comment.authorKind} · ${comment.state} · ${comment.file ?? "change-level"}${comment.line === null ? "" : `:${comment.line}`} · ${comment.body.slice(0, 120)}`,
                )
                .join("\n");

        yield* provider.respond({
          context: "change-reading",
          system: SYSTEM,
          prompt:
            `Read the change for session ${session.id} (${session.harness}, branch ${change.branch}). ` +
            `The session settled "${session.status}"${session.summary === null ? "" : ` — its own summary: ${session.summary.slice(0, 300)}`}.\n\n` +
            `The record spans sequences 1..${session.lastSeenSequence} — do not read beyond that.\n\n` +
            `Existing comments on this change (do not restate):\n${existingSummary}\n\n` +
            `Start with read_change, then read_terminal.`,
          tools: [
            pass.readChangeTool,
            pass.readRecordingTool,
            pass.readTerminalTool,
            draftFindingTool,
          ],
          maxRounds: 30,
        });

        // Zero findings is legitimate; the pass itself completing is success.
        yield* Effect.annotateLogs(Effect.logInfo("change read complete"), {
          changeId: job.changeId,
          findingsWritten,
        });
        return findingsWritten;
      });

      return { read };
    }),
  );
}
