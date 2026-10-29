import { type SetupClaimRequest, type SetupRunAgain, SetupRunsRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { ServiceStartSetup, type SetupDeclaration } from "@mend/domain/workbench";
import { type ProcessUser, SealantClient, type SealantPlatformError } from "@mend/sealant";
import type { Workspace } from "@sealant/sdk";
import { Deferred, Duration, Effect, Exit, Option, Schema } from "effect";

import { digestWorktreeFile } from "./recipes.ts";
import { WORKSPACE_REPO } from "./service-launch.ts";
import {
  outputTailOf,
  parseSetupInputs,
  SETUP_BUSY_POLL_MS,
  SETUP_LEASE_MS,
  SETUP_RENEW_MS,
  SETUP_STEP_LIMIT_MINUTES,
  type SetupInputDigest,
  setupFingerprint,
  setupInputsArgv,
  setupSiteKey,
  setupStepArgv,
  setupStopArgv,
} from "./setup.ts";

/** Why setup did not let its plan go on, in the words the start reports. */
export class SetupNotRun extends Schema.TaggedError<SetupNotRun>()("SetupNotRun", {
  message: Schema.String,
}) {}

/** The copy of the worktree Mend reads: beside this process, or only in the session's workspace. */
export type WorktreeCopy =
  | { readonly _tag: "Host"; readonly path: string }
  | { readonly _tag: "Workspace"; readonly workspace: Workspace };

/** The part of a recipe start's plan setup reads and reports to. */
export interface SetupPlan {
  readonly stopped: () => boolean;
  /** Done once a Stop reaches the plan. */
  readonly stopping: Deferred.Deferred<void>;
  readonly report: (setup: ServiceStartSetup) => Effect.Effect<void>;
}

/** Who setup runs as: the person's user and identity, exactly as their Service gets them. */
export interface SetupPerson {
  readonly user: ProcessUser;
  readonly env: Readonly<Record<string, string>>;
}

export interface SetupRun {
  readonly plan: SetupPlan;
  readonly setup: SetupDeclaration;
  readonly worktreeId: WorktreeId;
  readonly copy: WorktreeCopy;
  /** Where the steps run: the copy's workspace, or the session's for a co-located worktree. */
  readonly workspace: Workspace;
  readonly person: SetupPerson | null;
  readonly runsAs: string | null;
  readonly runAgain: SetupRunAgain;
}

const SETUP_STOPPED = "a Stop came during setup";
const LOST_WORDS =
  "setup lost its claim on this directory (its lease was not renewed in time), so its run was stopped and nothing was started · start it again";

const report = (
  plan: SetupPlan,
  state: ServiceStartSetup["state"],
  step: string | null = null,
  reason: string | null = null,
) => plan.report(new ServiceStartSetup({ state, step, reason }));

const withOutput = (words: string, tail: string | null) =>
  tail === null || tail === "" ? words : `${words}\n--- output ---\n${tail}`;

const pause = (plan: SetupPlan) =>
  Effect.raceFirst(
    Effect.sleep(Duration.millis(SETUP_BUSY_POLL_MS)),
    Deferred.await(plan.stopping),
  );

type StepEnd =
  | { readonly _tag: "Exited"; readonly exitCode: number; readonly output: string }
  | { readonly _tag: "OverLimit" };

/**
 * Runs a recipe start's `[setup]` once per site and fingerprint (ADR 0017, decision 4), outside
 * the lifecycle permit. One claimant at a time runs it in a site: a lapsed claim's processes are
 * stopped before another starts there, and a claimant whose claim lapses stops its own.
 */
export const makeSetupRunner = Effect.gen(function* () {
  const sealant = yield* SealantClient;
  const setupRuns = yield* SetupRunsRepo;

  const execAs = (
    workspace: Workspace,
    person: SetupPerson | null,
    argv: ReadonlyArray<string>,
    cwd?: string,
  ) =>
    sealant.exec(workspace, argv, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(person === null ? {} : { user: person.user }),
    });

  const notRun = (message: string) => new SetupNotRun({ message });
  const platformFailed = (error: SealantPlatformError) =>
    notRun(`setup did not run · ${error.message}`);

  const fingerprintOf = Effect.fn("SetupRunner.fingerprint")(function* (run: SetupRun) {
    const { copy, setup, workspace } = run;
    const image = yield* sealant
      .bootedImage(workspace)
      .pipe(Effect.orElseSucceed((): string | null => null));
    if (copy._tag === "Host") {
      const inputs: SetupInputDigest[] = [];
      for (const path of setup.inputs) {
        const digest = yield* digestWorktreeFile(copy.path, path).pipe(
          Effect.mapError((error) => notRun(`setup did not run · input ${error.message}`)),
        );
        inputs.push({ path, digest });
      }
      return setupFingerprint({ run: setup.run, inputs, platform: null, image });
    }
    const read = yield* execAs(
      workspace,
      run.person,
      setupInputsArgv(WORKSPACE_REPO, setup.inputs),
    ).pipe(Effect.mapError(platformFailed));
    const parsed = read.exitCode === 0 ? parseSetupInputs(read.stdout, setup.inputs) : null;
    if (parsed === null || parsed._tag === "Unreadable") {
      return yield* notRun(
        `setup did not run · its inputs could not be read in the session workspace (exit ${read.exitCode})${parsed === null ? "" : `: ${parsed.reason}`}`,
      );
    }
    if (parsed._tag === "Refused") {
      return yield* notRun(`setup did not run · input ${parsed.path} ${parsed.reason}`);
    }
    return setupFingerprint({
      run: setup.run,
      inputs: parsed.inputs,
      platform: parsed.platform,
      image,
    });
  });

  /** A run's processes, wherever they are, found by their marker; as root, whoever they run as. */
  const stopRun = (workspace: Workspace, claimId: string) =>
    sealant.exec(workspace, setupStopArgv(claimId)).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  /**
   * The site's claim, or what decides this start without one. The fingerprint is read after any
   * wait, so a start that waited behind another's setup decides on the inputs as they are now.
   */
  const claimSite = Effect.fn("SetupRunner.claim")(function* (run: SetupRun) {
    const { plan } = run;
    const workspaceId = run.workspace.id;
    const siteKey = setupSiteKey(
      run.copy._tag === "Host"
        ? { _tag: "Host", worktreeId: run.worktreeId }
        : { _tag: "Executor", workspaceId },
    );
    let fenced: string | null = null;
    for (;;) {
      if (plan.stopped()) return yield* notRun(SETUP_STOPPED);
      const request: SetupClaimRequest = {
        siteKey,
        worktreeId: run.worktreeId,
        workspaceId,
        fingerprint: yield* fingerprintOf(run),
        runsAs: run.runsAs,
        runAgain: run.runAgain,
        leaseMs: SETUP_LEASE_MS,
        fenced,
      };
      const claim = yield* setupRuns.claim(request);
      if (claim._tag === "Busy") {
        yield* report(plan, "waiting", null, "another start is running setup here");
        while (!plan.stopped() && (yield* setupRuns.busy(siteKey))) yield* pause(plan);
        continue;
      }
      if (claim._tag !== "Stale") return claim;
      yield* report(plan, "waiting", null, "an earlier setup here stopped answering · ending it");
      const where =
        claim.workspaceId === workspaceId
          ? run.workspace
          : yield* sealant
              .getWorkspace(claim.workspaceId)
              .pipe(Effect.orElseSucceed((): Workspace | null => null));
      // Its processes are known stopped, or it is taken over once a whole lease more has passed.
      if (where !== null && (yield* stopRun(where, claim.claimId))) fenced = claim.claimId;
      else yield* pause(plan);
    }
  });

  /**
   * Fails once the claim is no longer held, or a renewal does not land before its lease would
   * lapse, whatever stopped it landing.
   */
  const holdClaim = (claimId: string) =>
    Effect.sleep(Duration.millis(SETUP_RENEW_MS)).pipe(
      Effect.andThen(
        setupRuns
          .renew(claimId, SETUP_LEASE_MS)
          .pipe(
            Effect.timeoutOption(Duration.millis(SETUP_LEASE_MS - SETUP_RENEW_MS)),
            Effect.exit,
          ),
      ),
      Effect.flatMap((renewed) =>
        Exit.isSuccess(renewed) && Option.getOrElse(renewed.value, () => false)
          ? Effect.void
          : Effect.fail(notRun(LOST_WORDS)),
      ),
      Effect.forever,
    );

  const runStep = (run: SetupRun, claimId: string, step: string) => {
    const stopProcesses = stopRun(run.workspace, claimId).pipe(Effect.asVoid);
    return execAs(
      run.workspace,
      run.person,
      setupStepArgv(claimId, step, run.person?.env ?? {}),
      WORKSPACE_REPO,
    ).pipe(
      Effect.map(
        (result): StepEnd => ({
          _tag: "Exited",
          exitCode: result.exitCode,
          output: `${result.stdout}${result.stdout !== "" && result.stderr !== "" ? "\n" : ""}${result.stderr}`,
        }),
      ),
      // Exec cannot be cancelled: whatever ends the wait first ends the step's processes.
      Effect.onError(() => stopProcesses),
      Effect.catchIf(
        (error) => error.code === "exec_timeout",
        (): Effect.Effect<StepEnd> => Effect.succeed({ _tag: "OverLimit" }),
      ),
      Effect.mapError(platformFailed),
      Effect.raceFirst(
        Deferred.await(run.plan.stopping).pipe(
          Effect.andThen(
            stopProcesses.pipe(Effect.andThen(Effect.sleep("5 seconds")), Effect.forever),
          ),
        ),
      ),
    );
  };

  /** Stamped done only when every step exited 0, no Stop came, and the claim was still held. */
  const runSteps = Effect.fn("SetupRunner.steps")(function* (run: SetupRun, claimId: string) {
    const { plan } = run;
    let tail = "";
    for (const step of run.setup.run) {
      if (plan.stopped()) return yield* notRun(SETUP_STOPPED);
      yield* report(plan, "running", step);
      const ended = yield* runStep(run, claimId, step);
      if (plan.stopped()) return yield* notRun(SETUP_STOPPED);
      if (ended._tag === "Exited" && ended.exitCode === 0) {
        tail = outputTailOf(ended.output);
        continue;
      }
      const why =
        ended._tag === "OverLimit"
          ? `\`${step}\` ran past ${SETUP_STEP_LIMIT_MINUTES} minutes, the longest one setup step may run, so it was stopped`
          : `\`${step}\` exited ${ended.exitCode}`;
      const outputTail = ended._tag === "Exited" ? outputTailOf(ended.output) : "";
      yield* setupRuns.finish(claimId, {
        state: "failed",
        exitCode: ended._tag === "Exited" ? ended.exitCode : null,
        outputTail: outputTail === "" ? why : outputTail,
      });
      yield* report(plan, "failed", step, why);
      return yield* notRun(
        withOutput(`setup did not finish, so nothing was started · ${why}`, outputTail),
      );
    }
    if (plan.stopped()) return yield* notRun(SETUP_STOPPED);
    if (!(yield* setupRuns.finish(claimId, { state: "done", exitCode: 0, outputTail: tail }))) {
      return yield* notRun(LOST_WORDS);
    }
    yield* report(plan, "ran");
  });

  return Effect.fn("SetupRunner.run")(function* (run: SetupRun) {
    const claim = yield* claimSite(run);
    if (claim._tag === "Done") return yield* report(run.plan, "unchanged");
    if (claim._tag === "Failed") {
      const why = `it failed here (exit ${claim.exitCode ?? "unknown"}) and an automatic start does not run it again · a Start runs it`;
      yield* report(run.plan, "failed", null, why);
      return yield* notRun(withOutput(`setup ${why}`, claim.outputTail));
    }
    const { claimId } = claim;
    yield* runSteps(run, claimId).pipe(
      Effect.raceFirst(holdClaim(claimId)),
      Effect.ensuring(setupRuns.release(claimId)),
    );
  });
});
