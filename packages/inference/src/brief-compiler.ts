import { BriefsRepo, RunsRepo } from "@mend/db";
import { ChangeId, IssueId, RunId, type Run } from "@mend/domain";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { InferenceError, InferenceProvider } from "./provider.ts";
import { briefCompilationTools } from "./toolset.ts";

/** The `brief` job's payload — enqueued when a run settles completed. */
export class CompileBriefJob extends Schema.Class<CompileBriefJob>("CompileBriefJob")({
  issueId: IssueId,
  changeId: ChangeId,
  runId: RunId,
}) {}

/**
 * The rules the brief never breaks (PRODUCT.md §4), addressed to the model.
 * Everything else — anatomy, dispositions, grounding — is carried by the
 * document schema on the publish_brief tool.
 */
const SYSTEM = `You compile the brief: the review of a code change, grounded in the recording of the run that produced it. You are Mend's interface inference — you phrase and organize evidence; you cannot mint claims.

Rules the brief never breaks:
- Evidence, not verdicts. Status words describe what was observed ("completed · observed"), never a judgment ("safe to merge"). No scores, no grades, no confidence numbers, no recommendation to merge.
- The recording is the only permitted source of claims. Every claim carries evidence pointers (run id, sequence, and a short quoted excerpt from that event). A statement the recording does not support must be phrased as inferred, or carried as a gap.
- Dispositions are earned. "direct-evidence" only when the recording contains direct evidence for that question — an event you can point to. Nothing defaults to green. A path never exercised is "not-executed" (amber). An edit in the diff with no cause in the recording is "unrelated-change" (red).
- Gaps are content, not omissions. Paths the agent never exercised are listed in the attention callouts, never hidden.
- Recompiles amend the living document: read the existing brief first when one exists, keep questions whose evidence still stands, renumber coherently.

The register — the brief is a working surface, not a report:
- One fact, one place. Each observation appears exactly once, in the zone that owns it: gaps and anomalies are attention callouts; dispositions live on their questions; the narrative lives in whatWasDone/statusNow; counts live in monoFacts and the header. Other zones point at evidence, they never restate.
- Terse fields, enforced at publish — an over-long field fails validation and you rewrite it:
  issueRestated ≤ 280 chars (one or two sentences: what and why, no history).
  attention[].text ≤ 200 chars each (one sentence — the observation only; the detail stays behind the evidence pointers).
  whatWasDone ≤ 400 chars (two or three sentences; never restates a callout).
  statusNow ≤ 280 chars (one or two sentences: where things stand now).
  monoFacts ≤ 120 chars (counts only — files, +/−, checks; shas live in the header).
  questions[].question ≤ 160 chars each (one line where possible).
  evidenceUsed[].established ≤ 140 chars each (one clause).

Method:
1. read_issue — restate the issue in one line; quote the failing reproduction if the issue carries one.
2. read_change — the diff and per-file counts; write the mono facts line from these numbers only.
3. read_recording — work through the recording (page and narrow as needed; processStarted carries the program and its working directory, but no arguments, which are no longer recorded; processExited carries the exit code; fileChange carries edits; network kinds carry sources). Match every edit in the diff to its cause in the recording.
4. read_brief — when a brief already exists, amend it.
5. Decompose the review into numbered questions a careful reviewer would ask (typically 3-7), give each its earned disposition and evidence pointers, then publish_brief exactly once.

Excerpts are short (one line, the event's summary or the relevant fragment). Sequences are decimal strings.`;

const prompt = (job: CompileBriefJob, runs: ReadonlyArray<Run>) => {
  const recordings = runs
    .map((run) => `- ${run.id} · ${run.kind} · ${run.outcome ?? run.status}`)
    .join("\n");
  return (
    `Compile the brief for change ${job.changeId} (issue ${job.issueId}). ` +
    `The run that just settled is ${job.runId}.\n\n` +
    `The recordings behind this change:\n${recordings}\n\n` +
    `Verification recordings carry the causal proof legs (base fails · head passes · revert ` +
    `fails) as observed exit codes — cite them in causalProof when present; a leg with no ` +
    `observed event stays null.\n\n` +
    `Publish with publish_brief when every claim is grounded.`
  );
};

/**
 * Compiles the living brief for a change — the `brief` job's worker body.
 * Succeeds only when a publish actually happened; anything else fails into the
 * job engine's retry.
 */
export class BriefCompiler extends Context.Service<
  BriefCompiler,
  {
    readonly compile: (job: CompileBriefJob) => Effect.Effect<void, InferenceError>;
  }
>()("@mend/inference/BriefCompiler") {
  static readonly layer = Layer.effect(
    BriefCompiler,
    Effect.gen(function* () {
      const provider = yield* InferenceProvider;
      const briefs = yield* BriefsRepo;
      const runs = yield* RunsRepo;
      const tools = yield* briefCompilationTools;

      const compile = Effect.fn("BriefCompiler.compile")(function* (job: CompileBriefJob) {
        const before = yield* briefs.byChange(job.changeId).pipe(
          Effect.map((brief) => brief.currentVersion),
          Effect.orElseSucceed(() => 0),
        );

        // Every recording behind the change, settled or live — verification
        // recordings are where the causal proof legs live.
        const issueRuns = yield* runs
          .listForIssue(job.issueId)
          .pipe(Effect.map((all) => all.filter((run) => run.sealantRunId !== null)));

        yield* provider.respond({
          context: "brief-compilation",
          system: SYSTEM,
          prompt: prompt(job, issueRuns),
          tools,
        });

        // The compile is judged by its side effect: a new version, or it failed.
        const after = yield* briefs.byChange(job.changeId).pipe(
          Effect.map((brief) => brief.currentVersion),
          Effect.orElseSucceed(() => 0),
        );
        if (after <= before) {
          return yield* new InferenceError({
            message: `the compile finished without publishing (version stayed at ${before})`,
            cause: null,
          });
        }
      });

      return { compile };
    }),
  );
}
