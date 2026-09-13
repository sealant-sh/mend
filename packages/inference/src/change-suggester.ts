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

/** The `suggest-change` job's payload — at settle when automation says so, or on demand. */
export class SuggestChangeJob extends Schema.Class<SuggestChangeJob>("SuggestChangeJob")({
  changeId: ChangeId,
}) {}

/** The pass refuses to become a firehose: past this, only the reviewer asks for more. */
const MAX_SUGGESTIONS = 5;

/**
 * The suggestion pass: Mend reads the diff and proposes exact replacements
 * for defects the change introduces. Deliberately the opposite of the
 * carpet-bombing review bots — the strictness is the product. Precision is
 * enforced twice: the prompt sets the bar, and draft_suggestion rejects
 * anything that arrives without a concrete failure scenario, an anchor in
 * the change, or a usable replacement. Zero suggestions is a successful pass.
 */
const SYSTEM = `You review a settled code change for defects its diff introduces, and you propose exact replacements. You are Mend's interface inference — you phrase and organize what the code shows; the reviewer decides everything.

You are the opposite of the review bots that carpet-bomb every diff with advice. Your entire value is precision: a suggestion from you means "this specific code, on this specific path, does the wrong thing — here is the fix". Most changes deserve zero suggestions, and zero is a successful pass; say so in one sentence and stop. An unnecessary suggestion costs the reviewer more than a missed one costs you.

The bar — a suggestion clears ALL four or it is not emitted:
1. A defect, not a preference. Correctness, security, data loss, a leaked resource, a broken concurrency assumption, or a contract the surrounding code visibly establishes and this change breaks. Style, naming, formatting, comments, docs, test coverage, performance guesses, and "more idiomatic" never qualify. Neither does anything a typechecker, linter, or formatter reports — those run without you.
2. Introduced by THIS change. The defect lives in added or edited lines. A pre-existing problem visible in context lines is not yours to raise, however real.
3. A concrete failure you can state. Name the input, state, or sequence under which the code observably misbehaves, and what it does instead of what. If you cannot finish "when X, this does Y instead of Z" with specifics — actual values, an actual path — you have a feeling, not a finding. Drop it.
4. An exact fix. A replacement for the anchored lines a careful author would accept verbatim: same style as the surrounding code, minimal, no scope creep, no rewrite beyond the defect.

Before drafting each candidate, try to kill it:
- Hunt for the guard you claim is missing — in the surrounding code, elsewhere in the diff, in the caller. Handled-elsewhere is the most common false suggestion.
- Check intent against the record: the session's terminal output and summary often show a tradeoff was deliberate. A deliberate tradeoff is not a defect.
- If the record shows a check exercising this path passed, your scenario must explain why that check would not catch it — or the candidate dies.
- Speculative hardening is a kill, not a suggestion: a null-check for a value that cannot be null here, handling for an error that cannot occur, a race on data with one writer.
What survives an honest attempt to kill it is worth the reviewer's time. Cap: ${MAX_SUGGESTIONS} per pass — if more survive, keep the worst-consequence few.

The register — terse, enforced at the tool boundary:
  body ≤ 500 chars: the defect and the failure scenario, stated once. Plain declarative prose — no hedging ("consider", "might want to"), no praise, no self-reference ("my reading"), no editorial labels ("Note:").
  replacement: only the corrected lines, exactly what belongs at the anchor — null when the fix is deleting the anchored lines.
  Each evidence excerpt ≤ 200 chars.

Method — reads first, then suggest, then stop:
1. read_change — the diff and per-file counts.
2. read_terminal — what actually ran and what it printed; this is where deliberate tradeoffs and passing checks are visible.
3. read_recording — optional, for sequence anchors when a suggestion leans on what did or did not run.
4. draft_suggestion — one call per surviving defect, anchored to the exact lines in NEW-file coordinates. Evidence pointers are optional and only for claims about what ran; cite only sequences you actually read.
5. Finish with one short sentence: how many suggestions, or why there are none.

Sequences are decimal strings.`;

/**
 * The closed reasons a suggestion may exist. The enum is load-bearing: a
 * category the model cannot name ("style", "cleanup", "idiom") is a
 * suggestion it cannot draft.
 */
const SuggestionCategory = Schema.Literals([
  "correctness",
  "security",
  "data-loss",
  "resource-leak",
  "concurrency",
  "contract-break",
]);

const DraftSuggestionInput = Schema.Struct({
  file: Schema.String,
  /** NEW-file coordinates; the lines the replacement replaces. */
  line: Schema.Int,
  endLine: Schema.optional(Schema.NullOr(Schema.Int)),
  category: SuggestionCategory,
  /** "when X, this does Y instead of Z" — with the specifics. */
  failureScenario: Schema.String,
  body: Schema.String,
  /** The corrected lines, verbatim; null = the fix is deleting the anchored lines. */
  replacement: Schema.NullOr(Schema.String),
  evidence: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ sequence: Schema.BigIntFromString, excerpt: Schema.String })),
    ),
  ),
});

const SuggestionResult = Schema.Struct({ recorded: Schema.Boolean, commentId: Schema.String });

const failed = (message: string) => new InferenceError({ message, cause: null });
const reject = (message: string) =>
  Effect.fail(new InferenceToolError({ tool: "draft_suggestion", message }));

export class ChangeSuggester extends Context.Service<
  ChangeSuggester,
  {
    /** Resolves with how many suggestions the pass drafted — zero is the expected outcome. */
    readonly suggest: (job: SuggestChangeJob) => Effect.Effect<number, InferenceError>;
  }
>()("@mend/inference/ChangeSuggester") {}

export const ChangeSuggesterLive: Layer.Layer<
  ChangeSuggester,
  never,
  | InferenceProvider
  | WorktreeChangesRepo
  | SessionsRepo
  | ProjectsRepo
  | ReviewCommentsRepo
  | WorktreeReads
  | SealantClient
> = Layer.effect(
  ChangeSuggester,
  Effect.gen(function* () {
    const provider = yield* InferenceProvider;
    const changes = yield* WorktreeChangesRepo;
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const comments = yield* ReviewCommentsRepo;
    // The pass tools need Store + SealantClient; captured here, provided
    // per job (the comment-router pattern — tool sets are built fresh).
    const toolContext = yield* Effect.context<WorktreeReads | SealantClient>();

    const suggest = Effect.fn("ChangeSuggester.suggest")(function* (job: SuggestChangeJob) {
      const change = yield* changes
        .byId(job.changeId)
        .pipe(Effect.mapError(() => failed(`no change ${job.changeId}`)));
      // Phase-A record evidence reads the LAST CONTRIBUTING conversation (the
      // change's session mirror); multi-session union is named follow-up work.
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
          "the session has no record (it never launched supervised) — the pass cannot check intent against what ran",
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

      let suggestionsWritten = 0;
      const draftSuggestionTool = makeTool({
        name: "draft_suggestion",
        description:
          "Record one suggestion as a draft review comment carrying an exact replacement for the anchored lines. Only for defects this change introduces, with a concrete failure scenario. The pass caps at " +
          `${MAX_SUGGESTIONS}.`,
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "a changed file's path" },
            line: { type: "integer", description: "first anchored line, NEW-file coordinates" },
            endLine: { type: ["integer", "null"] },
            category: {
              type: "string",
              enum: [
                "correctness",
                "security",
                "data-loss",
                "resource-leak",
                "concurrency",
                "contract-break",
              ],
            },
            failureScenario: {
              type: "string",
              description: '"when X, this does Y instead of Z" — with the specifics; ≤300 chars',
            },
            body: { type: "string", description: "≤500 chars" },
            replacement: {
              type: ["string", "null"],
              description: "the corrected lines, verbatim; null = delete the anchored lines",
            },
            evidence: {
              type: ["array", "null"],
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
          required: ["file", "line", "category", "failureScenario", "body", "replacement"],
          additionalProperties: false,
        },
        input: DraftSuggestionInput,
        run: (input) =>
          Effect.gen(function* () {
            // The precision filter, enforced rather than requested: no anchor
            // in the change, no vague scenario, no firehose.
            if (suggestionsWritten >= MAX_SUGGESTIONS) {
              return yield* reject(
                `the pass caps at ${MAX_SUGGESTIONS} suggestions — stop; the reviewer can request another pass`,
              );
            }
            if (!pass.changedPaths.has(input.file)) {
              return yield* reject(
                `"${input.file}" is not in this change — suggestions anchor to changed files from read_change only`,
              );
            }
            if (input.failureScenario.trim().length < 20) {
              return yield* reject(
                "the failure scenario is too thin to be concrete — state when X, what it does, and what it should do, or drop the suggestion",
              );
            }
            if (input.failureScenario.length > 300) {
              return yield* reject("failureScenario caps at 300 chars — state it once");
            }
            if (input.body.length > 500) {
              return yield* reject(
                `body is ${input.body.length} chars — the register caps it at 500`,
              );
            }
            if (input.replacement !== null && input.replacement.trim() === "") {
              return yield* reject(
                "an empty replacement is ambiguous — pass null to propose deleting the anchored lines",
              );
            }
            const evidence = input.evidence ?? [];
            const unseen = evidence.filter(
              (pointer) => !pass.seenSequences.has(pointer.sequence.toString()),
            );
            if (unseen.length > 0) {
              return yield* reject(
                `evidence cites sequences this pass never read: ${unseen.map((p) => p.sequence.toString()).join(", ")} — read them via read_recording first, or drop them`,
              );
            }
            const overlong = evidence.filter((pointer) => pointer.excerpt.length > 200);
            if (overlong.length > 0) {
              return yield* reject("excerpts cap at 200 chars — quote the relevant fragment");
            }
            const created = yield* comments
              .create({
                changeId: job.changeId,
                file: input.file,
                line: input.line,
                endLine: input.endLine ?? null,
                authorKind: "mend",
                authorName: "Mend",
                body: `${input.body}\n\nFails when: ${input.failureScenario}`,
                kind: "suggestion",
                suggestion: input.replacement,
                state: "draft",
                evidence: evidence.map(
                  (pointer) =>
                    new RecordLink({
                      sealantRunId,
                      sequence: pointer.sequence,
                      excerpt: pointer.excerpt,
                    }),
                ),
              })
              .pipe(Effect.orDie);
            suggestionsWritten += 1;
            return { recorded: true, commentId: created.id };
          }),
        encode: (value) => Schema.encodeEffect(SuggestionResult)(value).pipe(Effect.orDie),
      });

      const existingSummary =
        existing.length === 0
          ? "none"
          : existing
              .map(
                (comment) =>
                  `- ${comment.authorKind} · ${comment.kind} · ${comment.state} · ${comment.file ?? "change-level"}${comment.line === null ? "" : `:${comment.line}`} · ${comment.body.slice(0, 120)}`,
              )
              .join("\n");

      yield* provider.respond({
        context: "change-suggesting",
        system: SYSTEM,
        prompt:
          `Review the change for session ${session.id} (${session.harness}, branch ${change.branch}) and suggest exact fixes for defects it introduces — or none. ` +
          `The session settled "${session.status}"${session.summary === null ? "" : ` — its own summary: ${session.summary.slice(0, 300)}`}.\n\n` +
          `The record spans sequences 1..${session.lastSeenSequence} — do not read beyond that.\n\n` +
          `Existing comments on this change (do not restate or re-suggest):\n${existingSummary}\n\n` +
          `Start with read_change, then read_terminal.`,
        tools: [
          pass.readChangeTool,
          pass.readRecordingTool,
          pass.readTerminalTool,
          draftSuggestionTool,
        ],
        maxRounds: 30,
      });

      // Zero suggestions is the expected outcome; the pass completing is success.
      yield* Effect.annotateLogs(Effect.logInfo("suggestion pass complete"), {
        changeId: job.changeId,
        suggestionsWritten,
      });
      return suggestionsWritten;
    });

    return { suggest };
  }),
);
