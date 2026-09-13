import { ProjectsRepo, SessionsRepo } from "@mend/db";
import { ProjectId, type SessionId, type WorktreeId } from "@mend/domain";
import { CaptureRuntime, promoteBulkToCache, SessionEngine } from "@mend/sessions";
import { BlobStore, decodeManifest } from "@mend/store";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import * as Context from "effect/Context";

import { JobRunner } from "./job-runner.ts";

/**
 * The Mend-controlled install (ADR-0002 amended 2026-09-13, decisions 2 and 9): the ONLY writer
 * of a project's shared dependency cache. Mend launches a session of its own in a fresh
 * worktree; the engine's launch runs the project's install command there (the tree it
 * materialised has no bulk for the executor's platform), the shell exits, the executor ships
 * its final capture, and this job promotes that capture's bulk section — and only that one —
 * into `projects/<project>/cache/<platform>/` by server-side copy. A capture registered by any
 * other session is never promoted: nothing else calls `promoteBulkToCache`.
 */
export class DependencyInstallJob extends Schema.Class<DependencyInstallJob>(
  "DependencyInstallJob",
)({
  projectId: ProjectId,
}) {}

export class InstallRunError extends Schema.TaggedErrorClass<InstallRunError>()("InstallRunError", {
  projectId: Schema.String,
  message: Schema.String,
}) {}

/**
 * How the install session is run: provisioned, launched, and awaited until it settles. A port,
 * so the promotion policy is testable without a platform; the live adapter drives the engine.
 */
export class InstallRunner extends Context.Service<
  InstallRunner,
  {
    readonly run: (
      projectId: ProjectId,
    ) => Effect.Effect<{ readonly worktreeId: WorktreeId }, InstallRunError>;
  }
>()("@mend/jobs/InstallRunner") {}

export type DependencyInstallOutcome =
  | { readonly outcome: "promoted"; readonly platform: string; readonly captureId: string }
  | { readonly outcome: "skipped"; readonly reason: string };

export class DependencyInstaller extends Context.Service<
  DependencyInstaller,
  {
    readonly install: (job: DependencyInstallJob) => Effect.Effect<DependencyInstallOutcome>;
  }
>()("@mend/jobs/DependencyInstaller") {}

/** How long the install session may take before the job gives up on its capture. */
export const INSTALL_SESSION_DEADLINE = Duration.minutes(30);

export const DependencyInstallerLive: Layer.Layer<
  DependencyInstaller,
  never,
  CaptureRuntime | InstallRunner | ProjectsRepo
> = Layer.effect(
  DependencyInstaller,
  Effect.gen(function* () {
    const capture = yield* CaptureRuntime;
    const runner = yield* InstallRunner;
    const projects = yield* ProjectsRepo;

    const install = Effect.fn("DependencyInstaller.install")(function* (job: DependencyInstallJob) {
      if (!capture.enabled) {
        return { outcome: "skipped", reason: "not in capture mode" } as const;
      }
      const project = yield* projects
        .byId(job.projectId)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
      if (project === null) return { outcome: "skipped", reason: "the project is gone" } as const;
      const ran = yield* runner.run(job.projectId).pipe(Effect.option);
      if (ran._tag === "None") {
        return { outcome: "skipped", reason: "the install session did not run" } as const;
      }
      const head = (yield* capture.repo.headOf(ran.value.worktreeId))?.head ?? null;
      if (head === null) {
        return { outcome: "skipped", reason: "the install session captured nothing" } as const;
      }
      const manifest = yield* capture.blobs.get(head.manifestKey).pipe(
        Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)),
        Effect.option,
      );
      if (manifest._tag === "None" || manifest.value.sections.bulk === "pending") {
        return {
          outcome: "skipped",
          reason: "the install session's head capture carries no dependency tree",
        } as const;
      }
      const record = yield* promoteBulkToCache(job.projectId, head.id, manifest.value).pipe(
        Effect.provideService(BlobStore, capture.blobs),
        Effect.orDie,
      );
      if (record === null) {
        return { outcome: "skipped", reason: "the bulk section was empty" } as const;
      }
      yield* Effect.logInfo("dependency-install: shared cache promoted").pipe(
        Effect.annotateLogs({
          projectId: job.projectId,
          platform: record.platform,
          captureId: head.id,
          packs: record.packs.length,
        }),
      );
      return { outcome: "promoted", platform: record.platform, captureId: head.id } as const;
    });

    return { install };
  }),
);

/** The install session's harness argv: the engine's launch installs; the shell then exits. */
export const INSTALL_SESSION_ARGV: ReadonlyArray<string> = ["sh", "-lc", "true"];
export const INSTALL_SESSION_LABEL = "install · mend";

/**
 * The live runner: a session Mend owns, in a fresh anonymous worktree of the project, launched
 * with a shell that exits at once — the engine's launch runs the install command first (the
 * fresh worktree's capture 0 has no dependency tree), and the executor's final capture carries
 * the result. Settling is observed by polling the row; the deadline is the job's.
 */
export const InstallRunnerEngineLive: Layer.Layer<
  InstallRunner,
  never,
  SessionEngine | SessionsRepo
> = Layer.effect(
  InstallRunner,
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const settled = (sessionId: SessionId) =>
      sessions
        .byId(sessionId)
        .pipe(Effect.map((session) => session.settledAt !== null))
        .pipe(Effect.catch(() => Effect.succeed(true)));
    const run = Effect.fn("InstallRunner.run")(function* (projectId: ProjectId) {
      const failure = (message: string) => new InstallRunError({ projectId, message });
      const session = yield* engine
        .provision({
          projectId,
          harness: "shell",
          label: INSTALL_SESSION_LABEL,
          name: null,
          base: null,
          ownerUserId: null,
        })
        .pipe(Effect.mapError((error) => failure(`provision: ${error._tag}`)));
      yield* engine
        .launch(session.id, INSTALL_SESSION_ARGV)
        .pipe(Effect.mapError((error) => failure(`launch: ${error._tag}`)));
      const done = yield* settled(session.id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.seconds(5)),
          until: (isSettled) => isSettled,
        }),
        Effect.timeoutOption(INSTALL_SESSION_DEADLINE),
      );
      if (done._tag === "None") {
        return yield* failure("the install session did not settle before the deadline");
      }
      return { worktreeId: session.worktreeId };
    });
    return { run };
  }),
);

const decodeJob = Schema.decodeUnknownEffect(DependencyInstallJob);

/** Register the worker; the handler dies into pg-boss retry like every other job. */
export const DependencyInstallWorkerLive: Layer.Layer<
  never,
  never,
  JobRunner | DependencyInstaller
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* JobRunner;
    const installer = yield* DependencyInstaller;
    yield* jobs.work("dependency-install", (payload) =>
      decodeJob(payload).pipe(
        Effect.flatMap((job) => installer.install(job)),
        Effect.asVoid,
        Effect.orDie,
      ),
    );
  }),
);
