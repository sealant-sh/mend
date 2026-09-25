import { PgClient } from "@effect/sql-pg";
import { ChangesRepo, InstanceRolesRepo, IssuesRepo, notifyEvent, RunsRepo } from "@mend/db";
import {
  Sha,
  SealantRunId,
  SealantWorkspaceId,
  type ChangeId,
  type Issue,
  type IssueId,
  type Run,
} from "@mend/domain";
import { asSealantUser, SealantClient } from "@mend/sealant";
import type { Run as SdkRun } from "@sealant/sdk";
import { opencode } from "@sealant/sdk";
import { Effect, Layer, Option, Stream } from "effect";

import { RunStarter, RunStartError } from "./dispatcher.ts";
import { JobRunner } from "./job-runner.ts";

/**
 * The raw issue text — the harness's task, quoted verbatim. Used wherever the
 * issue is embedded (the initial-run contract below, and the verification
 * prompt), so it stays unadorned.
 */
const buildPrompt = (issue: Issue) =>
  issue.body === "" ? issue.title : `${issue.title}\n\n${issue.body}`;

/**
 * The initial run's prompt: the issue wrapped in Mend's operational contract for
 * a *reviewable* change — work on a branch, run the repo's own checks, commit
 * with a clean tree, report honestly — and deliberately no solution guidance, so
 * the brief still reviews the agent's own judgment, not Mend's instructions. A
 * bare issue prompt used to let the agent do real work and walk away without
 * committing; the contract (and the `git status` self-check) closes that.
 */
const initialPrompt = (issue: Issue) =>
  `You are working in a fresh clone of this repository, checked out at its default branch. Your task is the issue below. How to solve it is your call: read enough of the code to understand the problem, then make the change you judge right. Nothing here tells you how to fix it.

For the work to be reviewable, it has to land a certain way:

- Work on a new branch, not the default branch.
- If the issue carries a reproduction, reproduce the problem first, so you know you are fixing the right thing. If it is a feature request or is only loosely specified, work from what it actually says; do not invent a reproduction it does not provide.
- Check your own work with the tooling the repository already has: its build, its tests, its typecheck. Run them and read the results rather than assume them. A check that still fails is something to report, not to hide or force green.
- Commit the work on your branch with a clear message, and leave the working tree clean when you stop: nothing staged, nothing unstaged. Work left uncommitted is not part of the change and is invisible to the review; only what you commit counts. A quick \`git status\` before you finish confirms it.
- Report honestly what you did and did not accomplish. If the change is partial, or something blocks you, commit what you have and describe what remains. That is worth more than a claim of completion the work does not support.

The issue:
${buildPrompt(issue)}`;

/**
 * The causal proof, harness-prompted (ROADMAP §M2 interim): a verification run
 * executes scenarios without changing code, and its recording carries the
 * `base fails · head passes · revert fails` legs as observed exit codes. The
 * brief recompiles after it settles and cites those events.
 */
/** A full sha from a recorded `git rev-parse`, or null — never a guess. */
const shaOf = (result: { readonly exitCode: number; readonly stdout: string }) => {
  const sha = result.exitCode === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(sha) ? Sha.make(sha) : null;
};

const verificationPrompt = (issue: Issue) =>
  `This is a verification run for review evidence. Do not change any code: leave HEAD where it is and the working tree clean when you finish.

The repository sits at the head of a change addressing the issue below. Demonstrate each leg with commands, so their exit codes land in the record:

1. head passes — run the issue's reproduction (or the most direct check of the reported behavior) at the current HEAD.
2. base fails — check out the base commit (the merge base with the default branch, e.g. \`git merge-base HEAD origin/HEAD\`), run the same reproduction there, then check the previous HEAD out again.
3. revert fails — revert the change on top of head without committing (\`git revert --no-commit\`), run the same reproduction, then discard the revert (\`git reset --hard\`).

A leg you cannot execute is stated and skipped, never faked.

The issue:
${buildPrompt(issue)}`;

/** A routed follow-up: review feedback, self-contained, on the existing branch. */
const followUpPrompt = (instruction: string) =>
  `This is a follow-up run on an existing change, responding to review feedback. The change's branch is already checked out with the earlier work committed on it: keep working on that branch, and do not start a new one or reset it.

Address the feedback below, using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Commit what you change with a clear message and leave the working tree clean: uncommitted work is invisible to the review, so a quick \`git status\` before you finish confirms nothing is left behind. Report honestly what you changed and what you did not. If part of the feedback cannot or should not be done, commit what you have and say so plainly rather than claim more than the work supports.

${instruction}`;

/** A routed verification pass: execute the scenario, change nothing. */
const routedVerificationPrompt = (instruction: string) =>
  `This is a verification run for review evidence. Do not change any code: leave HEAD where it is and the working tree clean when you finish. Demonstrate the scenario below with commands, so their exit codes land in the record. A step you cannot execute is stated and skipped, never faked.

${instruction}`;

/**
 * One supervised fiber per active run (ARCHITECTURE.md §5): stream the record,
 * persist the last-seen sequence, settle the card when the run does. Fibers
 * are forked into the layer's scope so they live as long as the process —
 * crash/restart re-attaches from the stored sequence instead of re-running.
 */
/**
 * The retired queue's runs belong to the operator (docs/adr/0003-organizations-and-tenancy.md):
 * the longest-standing one, resolved per call. With no operator the platform refuses the call.
 */
const asOperator = <A, E, R>(roles: InstanceRolesRepo["Service"], effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const [operator] = yield* roles.operators();
    return yield* effect.pipe(asSealantUser(operator ?? null));
  });

export const runStarterLayer = Layer.effect(
  RunStarter,
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    const roles = yield* InstanceRolesRepo;
    const runs = yield* RunsRepo;
    const issues = yield* IssuesRepo;
    const changes = yield* ChangesRepo;
    const jobs = yield* JobRunner;
    const sql = yield* PgClient.PgClient;
    const scope = yield* Effect.scope;

    /**
     * The head the evidence describes, read from the workspace itself — each
     * exec is recorded, so even these facts have records behind them. Failures
     * degrade to nulls: a gap is content, not a broken pipeline.
     */
    const discoverHeadFacts = Effect.fn("RunStarter.discoverHeadFacts")(function* (run: Run) {
      if (run.sealantWorkspaceId === null) {
        return { branch: "", baseSha: null, headSha: null };
      }
      const workspace = yield* sealant.getWorkspace(run.sealantWorkspaceId);
      const head = yield* sealant.exec(workspace, ["git", "rev-parse", "HEAD"]);
      const branch = yield* sealant.exec(workspace, ["git", "branch", "--show-current"]);
      // origin/HEAD still points at the clone-time default-branch head — the
      // base the evidence was gathered against, surviving local commits.
      const base = yield* sealant.exec(workspace, ["git", "rev-parse", "origin/HEAD"]);
      return {
        branch: branch.exitCode === 0 ? branch.stdout.trim() : "",
        baseSha: shaOf(base),
        headSha: shaOf(head),
      };
    });

    /**
     * The prompt asks the harness to commit its work; this guarantees it. If a
     * completed run left the working tree dirty — real edits the agent did but
     * forgot to commit, the failure a bare issue prompt used to produce — Mend
     * snapshots them into a commit itself, on the agent's branch or a fresh
     * `mend/<issue>` one, so no real work is ever invisible to a git-state
     * review. Every exec is recorded, so the snapshot commit is honest evidence.
     */
    const ensureCommitted = Effect.fn("RunStarter.ensureCommitted")(function* (
      run: Run,
      issue: Issue,
    ) {
      if (run.sealantWorkspaceId === null) return;
      const workspace = yield* sealant.getWorkspace(run.sealantWorkspaceId);
      const status = yield* sealant.exec(workspace, ["git", "status", "--porcelain"]);
      // Clean tree: the agent committed (or genuinely did nothing) — leave it be.
      if (status.exitCode !== 0 || status.stdout.trim() === "") return;

      const current = yield* sealant.exec(workspace, ["git", "branch", "--show-current"]);
      const defRef = yield* sealant.exec(workspace, [
        "git",
        "rev-parse",
        "--abbrev-ref",
        "origin/HEAD",
      ]);
      const currentBranch = current.exitCode === 0 ? current.stdout.trim() : "";
      const defaultBranch =
        defRef.exitCode === 0 ? defRef.stdout.trim().replace(/^origin\//, "") : "";
      // Commit on the agent's branch if it made one; otherwise start a mend branch.
      const onDefault = currentBranch === "" || currentBranch === defaultBranch;
      const branch = onDefault ? `mend/${issue.id.slice(0, 8)}` : currentBranch;
      if (onDefault) {
        yield* sealant.exec(workspace, ["git", "checkout", "-B", branch]);
      }
      yield* sealant.exec(workspace, ["git", "add", "-A"]);
      yield* sealant.exec(workspace, [
        "git",
        "-c",
        "user.email=mend@sealant.local",
        "-c",
        "user.name=Mend",
        "commit",
        "-m",
        `mend: snapshot of the ${run.kind} run for "${issue.title}"`,
      ]);
      yield* Effect.logInfo("run supervisor: committed the agent's uncommitted work").pipe(
        Effect.annotateLogs({ runId: run.id, branch }),
      );
    });

    const enqueueLogged = Effect.fn("RunStarter.enqueueLogged")(function* (
      run: Run,
      job: { name: string; payload: Record<string, unknown>; idempotencyKey: string },
    ) {
      yield* jobs
        .enqueue(job)
        .pipe(
          Effect.catchTag("JobEnqueueError", (error) =>
            Effect.logError(`run supervisor: ${job.name} enqueue failed`).pipe(
              Effect.annotateLogs({ runId: run.id, cause: String(error.cause) }),
            ),
          ),
        );
    });

    /**
     * A completed run grows the change and recompiles the brief: ensure the
     * change row, tie the run's recording to it, enqueue the `brief` job (the
     * per-run key: a repeat while that compile is queued or running is
     * dropped). A completed
     * mending run also starts the verification run whose recording carries the
     * causal proof; the recompile after IT settles cites those legs.
     */
    // Annotated: supervise → afterCompleted → startVerification → supervise is
    // a deliberate cycle (a run's settle can start the next run).
    const afterCompleted: (run: Run, issue: Issue) => Effect.Effect<void> = Effect.fn(
      "RunStarter.afterCompleted",
    )(function* (staleRun: Run, issue: Issue) {
      // The in-memory row predates setSealantIds — without the re-read, head
      // discovery sees no workspace and the verification run never starts.
      const run = yield* runs.byId(staleRun.id).pipe(Effect.orElseSucceed(() => staleRun));
      // A verification run must change nothing; every other run's uncommitted
      // work is snapshotted so it lands in the diff the brief reviews.
      if (run.kind !== "verification") {
        yield* ensureCommitted(run, issue).pipe(
          Effect.catchTag("SealantPlatformError", (error) =>
            Effect.logWarning("run supervisor: commit snapshot failed").pipe(
              Effect.annotateLogs({ runId: run.id, error: error.message }),
            ),
          ),
        );
      }
      const facts = yield* discoverHeadFacts(run).pipe(
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.logWarning("run supervisor: head discovery failed").pipe(
            Effect.annotateLogs({ runId: run.id, error: error.message }),
            Effect.as({ branch: "", baseSha: null, headSha: null }),
          ),
        ),
      );
      const change = yield* changes.ensureForIssue(issue.id, facts);
      yield* runs.linkChange(run.id, change.id);
      yield* enqueueLogged(run, {
        name: "brief",
        payload: { issueId: issue.id, changeId: change.id, runId: run.id },
        idempotencyKey: `brief:${change.id}:${run.id}`,
      });
      if (run.kind !== "verification") {
        yield* startVerification(run, issue);
      }
    });

    const failRun = Effect.fn("RunStarter.failRun")(function* (
      run: Run,
      issueId: IssueId,
      summary: string,
    ) {
      yield* runs.settle(run.id, "failed", summary);

      // A failed verification or follow-up never drags the issue back to
      // triage — the change still stands; the brief recompiles and reports
      // what the failed recording observed.
      if (run.kind !== "initial") {
        const current = yield* runs.byId(run.id).pipe(Effect.orElseSucceed(() => run));
        if (current.changeId === null) return;
        yield* enqueueLogged(run, {
          name: "brief",
          payload: { issueId, changeId: current.changeId, runId: run.id },
          idempotencyKey: `brief:${current.changeId}:${run.id}`,
        });
        return;
      }

      yield* issues.returnToTriage(issueId, run.id).pipe(Effect.ignore);
      // The failure mini-brief needs a recording to sum; without one, the
      // settle summary is all there is — a gap, carried as content. The row is
      // re-read because the in-memory run predates setSealantIds.
      const current = yield* runs.byId(run.id).pipe(Effect.orElseSucceed(() => run));
      if (current.sealantRunId === null) return;
      yield* enqueueLogged(run, {
        name: "failure-brief",
        payload: { issueId, runId: run.id },
        idempotencyKey: `failure-brief:${run.id}`,
      });
    });

    const supervise = Effect.fn("RunStarter.supervise")(function* (
      run: Run,
      issue: Issue,
      sdkRun: SdkRun,
      from: bigint,
    ) {
      yield* sealant.recordStream(sdkRun, { from }).pipe(
        Stream.tap((entry) =>
          Effect.gen(function* () {
            yield* runs.saveLastSeenSequence(run.id, entry.sequence);
            yield* notifyEvent(sql, {
              type: "run-progress",
              runId: run.id,
              issueId: issue.id,
              sequence: String(entry.sequence),
              line: entry.summary,
            });
          }),
        ),
        Stream.runDrain,
        // A broken stream is not a settled run — the wait below decides.
        Effect.catch((error) =>
          Effect.logWarning("run supervisor: record stream failed").pipe(
            Effect.annotateLogs({ runId: run.id, error: error.message }),
          ),
        ),
      );

      const settled = yield* sealant.waitRun(sdkRun);
      if (settled.result.outcome === "completed") {
        yield* runs.settle(run.id, "completed", settled.result.summary ?? null);
        yield* issues.markReview(issue.id).pipe(Effect.ignore);
        yield* afterCompleted(run, issue);
        return;
      }
      yield* failRun(
        run,
        issue.id,
        settled.result.summary ?? `harness exited with code ${settled.result.exitCode}`,
      );
    });

    /**
     * The causal-proof run: same workspace, no code changes, kind
     * `verification`. Supervised like any run; when it settles, the brief
     * recompiles and can cite its recording.
     */
    const startVerification: (completedRun: Run, issue: Issue) => Effect.Effect<void> = Effect.fn(
      "RunStarter.startVerification",
    )(function* (completedRun: Run, issue: Issue) {
      if (completedRun.sealantWorkspaceId === null) return;
      const workspaceId = completedRun.sealantWorkspaceId;

      const run = yield* runs.create(issue.id, "verification");
      yield* changes.byIssue(issue.id).pipe(
        Effect.flatMap((change) => runs.linkChange(run.id, change.id)),
        Effect.ignore,
      );

      const work = Effect.gen(function* () {
        // The creating handle is gone — start by workspace id (the re-fetched
        // facade handle carries no harness; see PLATFORM-FEEDBACK.md).
        const sdkRun = yield* sealant.startHarnessInWorkspace(
          workspaceId,
          opencode(),
          verificationPrompt(issue),
        );
        yield* runs.setSealantIds(
          run.id,
          SealantRunId.make(sdkRun.id),
          SealantWorkspaceId.make(workspaceId),
        );
        yield* runs.setStatus(run.id, "running");
        yield* supervise(run, issue, sdkRun, 0n);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => failRun(run, issue.id, error.message)),
        Effect.catchDefect((defect) =>
          failRun(run, issue.id, `run supervision died: ${String(defect)}`),
        ),
      );
      yield* Effect.forkIn(work, scope);
    });

    const launch = Effect.fn("RunStarter.launch")(function* (run: Run, issue: Issue) {
      const work = Effect.gen(function* () {
        const workspace = yield* sealant.createWorkspace({
          repository: issue.repository,
          harness: opencode(),
          name: `mend-${issue.id.slice(0, 8)}`,
        });
        const sdkRun = yield* sealant.startHarness(workspace, initialPrompt(issue), {
          idempotencyKey: run.id,
        });
        yield* runs.setSealantIds(
          run.id,
          SealantRunId.make(sdkRun.id),
          SealantWorkspaceId.make(workspace.id),
        );
        yield* runs.setStatus(run.id, "running");
        yield* supervise(run, issue, sdkRun, 0n);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => failRun(run, issue.id, error.message)),
        Effect.catchDefect((defect) =>
          failRun(run, issue.id, `run supervision died: ${String(defect)}`),
        ),
      );
      yield* Effect.forkIn(work, scope);
    });

    /** Re-attach to runs that were live when the last process died. */
    const resume = Effect.fn("RunStarter.resume")(function* () {
      const unsettled = yield* runs.listUnsettled();
      for (const run of unsettled) {
        const issue = yield* issues.byId(run.issueId).pipe(Effect.option);
        if (Option.isNone(issue)) continue;
        if (run.sealantRunId === null) {
          // Died between run-row creation and harness start; nothing recorded.
          yield* failRun(run, run.issueId, "process restarted before the harness started");
          continue;
        }
        const sealantRunId = run.sealantRunId;
        const work = Effect.gen(function* () {
          const sdkRun = yield* sealant.getRun(sealantRunId);
          yield* supervise(run, issue.value, sdkRun, run.lastSeenSequence);
        }).pipe(
          Effect.catchTag("SealantPlatformError", (error) =>
            failRun(run, run.issueId, error.message),
          ),
          Effect.catchDefect((defect) =>
            failRun(run, run.issueId, `run supervision died: ${String(defect)}`),
          ),
        );
        yield* Effect.forkIn(work, scope);
        yield* Effect.logInfo("run supervisor: re-attached").pipe(
          Effect.annotateLogs({ runId: run.id, from: String(run.lastSeenSequence) }),
        );
      }
    });

    yield* resume();

    const start = Effect.fn("RunStarter.start")(function* (issue: Issue) {
      const run = yield* runs.create(issue.id, "initial");
      // Mark mending before forking so the next dispatcher tick sees the slot taken.
      yield* issues.markMending(issue.id).pipe(Effect.ignore);
      yield* launch(run, issue);
    });

    /**
     * A routed run on the change's existing branch (PRODUCT.md, Iteration):
     * same workspace as the recordings behind the change, supervised like any
     * run. The card stays in review — the review is the conversation.
     */
    const startOnChange = Effect.fn("RunStarter.startOnChange")(function* (
      changeId: ChangeId,
      instruction: string,
      kind: "follow-up" | "verification",
    ) {
      const change = yield* changes
        .byId(changeId)
        .pipe(Effect.mapError(() => new RunStartError({ message: `no change ${changeId}` })));
      const issue = yield* issues
        .byId(change.issueId)
        .pipe(Effect.mapError(() => new RunStartError({ message: `no issue ${change.issueId}` })));

      const issueRuns = yield* runs.listForIssue(change.issueId);
      const anchor = issueRuns.find((run) => run.sealantWorkspaceId !== null);
      if (anchor === undefined || anchor.sealantWorkspaceId === null) {
        return yield* new RunStartError({
          message: `no workspace stands behind change ${changeId} — nothing to run on`,
        });
      }
      const workspaceId = anchor.sealantWorkspaceId;

      const run = yield* runs.create(issue.id, kind);
      yield* runs.linkChange(run.id, change.id);

      const promptText =
        kind === "follow-up" ? followUpPrompt(instruction) : routedVerificationPrompt(instruction);
      const work = Effect.gen(function* () {
        const sdkRun = yield* sealant.startHarnessInWorkspace(workspaceId, opencode(), promptText);
        yield* runs.setSealantIds(
          run.id,
          SealantRunId.make(sdkRun.id),
          SealantWorkspaceId.make(workspaceId),
        );
        yield* runs.setStatus(run.id, "running");
        yield* supervise(run, issue, sdkRun, 0n);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => failRun(run, issue.id, error.message)),
        Effect.catchDefect((defect) =>
          failRun(run, issue.id, `run supervision died: ${String(defect)}`),
        ),
      );
      yield* Effect.forkIn(work, scope);
      return run.id;
    });

    return {
      start: (issue: Issue) => asOperator(roles, start(issue)),
      startOnChange: (change: ChangeId, instruction: string, kind: "follow-up" | "verification") =>
        asOperator(roles, startOnChange(change, instruction, kind)),
    };
  }).pipe((build) =>
    Effect.gen(function* () {
      return yield* asOperator(yield* InstanceRolesRepo, build);
    }),
  ),
);
