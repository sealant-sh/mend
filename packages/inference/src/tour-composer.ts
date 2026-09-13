import { createHash } from "node:crypto";

import { ChangeToursRepo, ProjectsRepo, WorktreeChangesRepo, SessionsRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { RecordLink, TourStop } from "@mend/domain/workbench";
import type { SealantClient } from "@mend/sealant";
import { WorktreeReads } from "@mend/sessions";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";
import { makeSessionChangePass } from "./session-tools.ts";

/** The `compose-tour` job's payload — on-demand from the review page. */
export class ComposeTourJob extends Schema.Class<ComposeTourJob>("ComposeTourJob")({
  changeId: ChangeId,
}) {}

/**
 * The composed review tour (plan §7.3): Mend reads the diff and the session
 * record and writes the guided walkthrough the reviewer follows — a summary
 * of what the change is, how the session went about it, and ordered stops
 * that each circle a region of the diff and say what to look at. Structured
 * output, rendered by the UI; the model never touches the presentation.
 */
const SYSTEM = `You compose the review tour for a settled code change: the guided walkthrough its reviewer follows, grounded in the diff and the session record that produced it. You are Mend's interface inference — you phrase and organize evidence; you cannot mint claims.

Rules the tour never breaks:
- Evidence, not verdicts. Describe what changed, what was observed, what never ran. Never grade, approve, or recommend a merge.
- Claims about what HAPPENED (commands, checks, errors, the session's process) carry evidence pointers — sequences you actually read via read_recording, each with a one-line excerpt. Claims that are your reading of the code carry no pointer and the stop is marked ungrounded — that honesty is required, not optional.
- The tour teaches the change, in reading order: start where understanding starts (the core of the change), not alphabetically. Group by idea, not by file. A single file may deserve two stops; five trivial files may share one.
- Circle precisely. When a stop is about a specific region, give its line range in NEW-file coordinates from the diff. When it is about a whole file or a cross-cutting theme, leave the range null.
- What was NOT exercised is part of the tour. If the record shows a rewritten path no check touched, a stop says so.
- The summary states what the change IS and does — two to four sentences a reviewer reads before any diff. The approach states how the session got there, from the record: what it read, ran, retried.

The register:
  summary ≤ 700 chars. approach ≤ 500 chars.
  stops: typically 3-8. title ≤ 90 chars. narration ≤ 700 chars each — what to look at, why it matters, what the record shows.
  excerpts ≤ 200 chars, one line.

The voice — plain technical prose for a professional reviewer:
- Declarative sentences the reviewer can verify against the diff or the record. No self-reference ("my reading", "I think", "this is my interpretation") — the document has no narrator.
- No editorial framing labels ("Reviewer's eye:", "Note:", "Key point:") and no hedging filler ("Worth checking that…", "It's worth noting…", "Interestingly…"). When something needs the reviewer's verification, state it as an imperative with the concrete condition: "Confirm PUID/PGID match the other *arr services", not "Worth checking that the identity matches".
- Never announce groundedness in prose ("no check exercised this, so this is inferred") — the evidence pointers, or their absence, already carry that; write the observation itself.

Method — budget your rounds; reads first, then answer:
1. read_change — the full diff and per-file counts.
2. read_terminal — the harness process's ACTUAL output and reconstructed commands; for a TUI session this is where the work is visible (the timeline's PTY payloads are content-addressed hashes).
3. read_recording — the structured timeline for sequence anchors. The prompt tells you the record's extent — never probe beyond it; two or three selective calls suffice.
4. Answer with the tour document in the required JSON shape. Sequences are decimal strings. File paths must be paths from the diff.`;

/** The model's answer shape — validated, then filtered against what was actually read. */
const TourAnswer = Schema.Struct({
  summary: Schema.String,
  approach: Schema.NullOr(Schema.String),
  stops: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      file: Schema.NullOr(Schema.String),
      line: Schema.optional(Schema.NullOr(Schema.Int)),
      endLine: Schema.optional(Schema.NullOr(Schema.Int)),
      narration: Schema.String,
      evidence: Schema.Array(Schema.Struct({ sequence: Schema.String, excerpt: Schema.String })),
    }),
  ),
});

const failed = (message: string) => new InferenceError({ message, cause: null });

export class TourComposer extends Context.Service<
  TourComposer,
  {
    readonly compose: (job: ComposeTourJob) => Effect.Effect<void, InferenceError>;
  }
>()("@mend/inference/TourComposer") {
  static readonly layer = Layer.effect(
    TourComposer,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const changes = yield* WorktreeChangesRepo;
      const sessions = yield* SessionsRepo;
      const projects = yield* ProjectsRepo;
      const tours = yield* ChangeToursRepo;
      const reads = yield* WorktreeReads;
      const toolContext = yield* Effect.context<WorktreeReads | SealantClient>();

      const outputDocument = Schema.toJsonSchemaDocument(TourAnswer);
      const outputSchema: Record<string, unknown> = {
        ...outputDocument.schema,
        ...(Object.keys(outputDocument.definitions).length === 0
          ? {}
          : { $defs: outputDocument.definitions }),
      };

      const compose = Effect.fn("TourComposer.compose")(function* (job: ComposeTourJob) {
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
            "the session has no record (it never launched supervised) — the tour would be diff-only guesswork",
          );
        }
        const sealantRunId = session.sealantRunId;

        const pass = yield* makeSessionChangePass({
          projectId: project.id,
          worktreeId: change.worktreeId,
          change,
          sealantRunId,
        }).pipe(Effect.provide(toolContext));

        const answer = yield* provider.respond({
          context: "change-tour",
          system: SYSTEM,
          prompt:
            `Compose the tour for session ${session.id} (${session.harness}, branch ${change.branch}). ` +
            `The session settled "${session.status}"${session.summary === null ? "" : ` — its own summary: ${session.summary.slice(0, 300)}`}.\n\n` +
            `The record spans sequences 1..${session.lastSeenSequence} — do not read beyond that.\n\n` +
            `Start with read_change, then read_terminal, then the timeline. Answer with the tour document.`,
          tools: [pass.readChangeTool, pass.readRecordingTool, pass.readTerminalTool],
          outputSchema,
          maxRounds: 24,
        });

        const parsed = yield* Schema.decodeUnknownEffect(TourAnswer)(answer).pipe(
          Effect.mapError(
            (error) =>
              new InferenceError({
                message: `the tour did not match its schema: ${error.message}`,
                cause: error,
              }),
          ),
        );

        // The noise filter, applied at the write boundary: evidence citing
        // sequences this pass never read is dropped; a stop anchored to a
        // file outside the change loses its anchor. `grounded` records what
        // survived — the UI shows inferred reading as inferred.
        const stops = parsed.stops.map((stop) => {
          const evidence = stop.evidence
            .filter((pointer) => pass.seenSequences.has(pointer.sequence))
            .map(
              (pointer) =>
                new RecordLink({
                  sealantRunId,
                  sequence: BigInt(pointer.sequence),
                  excerpt: pointer.excerpt.slice(0, 200),
                }),
            );
          const anchored = stop.file !== null && pass.changedPaths.has(stop.file);
          return new TourStop({
            title: stop.title.slice(0, 90),
            file: anchored ? stop.file : null,
            line: anchored ? (stop.line ?? null) : null,
            endLine: anchored ? (stop.endLine ?? null) : null,
            narration: stop.narration.slice(0, 700),
            evidence,
            grounded: evidence.length > 0,
          });
        });
        if (stops.length === 0) {
          return yield* failed("the tour came back with no stops — nothing to guide");
        }

        const diff = yield* reads.diffWorktree(project.id, change.worktreeId, change.baseSha).pipe(
          Effect.map((read) => read.value),
          Effect.mapError((error) => failed(`hashing the diff failed: ${String(error)}`)),
        );

        yield* tours.upsert({
          changeId: job.changeId,
          sessionId: change.sessionId,
          summary: parsed.summary.slice(0, 700),
          approach: parsed.approach === null ? null : parsed.approach.slice(0, 500),
          stops,
          diffDigest: createHash("sha256").update(diff).digest("hex"),
        });
      });

      return { compose };
    }),
  );
}
