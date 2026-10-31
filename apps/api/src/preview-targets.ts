import {
  type PreviewIdleCandidate,
  PreviewsRepo,
  SessionsRepo,
  SessionProcessesRepo,
} from "@mend/db";
import type { PreviewId, SessionProcessId } from "@mend/domain";
import {
  type PreviewGatewayResolution,
  PreviewStartRefusal,
  ResourceDependencyStopped,
  type PreviewStartRequest,
} from "@mend/domain/workbench";
import {
  type PreviewStartDeclined,
  type PreviewStartRefused,
  ResourceRuntime,
  SessionEngine,
} from "@mend/sessions";
import { Effect, Layer, Schema, type Scope } from "effect";
import * as Context from "effect/Context";

export class PreviewStartFailed extends Schema.TaggedError<PreviewStartFailed>()(
  "PreviewStartFailed",
  { reason: PreviewStartRefusal, resourceStopped: Schema.optional(ResourceDependencyStopped) },
) {}

export class PreviewTargets extends Context.Service<
  PreviewTargets,
  {
    /** A person's stop still holds when the preview Service itself is running. */
    readonly resourceStopOf: (
      attemptId: SessionProcessId,
    ) => Effect.Effect<ResourceDependencyStopped | null>;
    /** Only the gateway writes admitted activity, in batches. */
    readonly touchActivity: (stamps: ReadonlyMap<PreviewId, Date>) => Effect.Effect<void>;
    readonly idleCandidates: () => Effect.Effect<ReadonlyArray<PreviewIdleCandidate>>;
    readonly stopIdle: (
      id: PreviewId,
      attemptId: SessionProcessId,
      idleMs: number,
      beforeStop: Effect.Effect<void>,
    ) => Effect.Effect<boolean>;
    /** Null when no kept preview has this id. */
    readonly snapshot: (id: PreviewId) => Effect.Effect<PreviewGatewayResolution | null>;
    /** One read for many previews; an id with no kept preview is absent from the map. */
    readonly snapshots: (
      ids: ReadonlyArray<PreviewId>,
    ) => Effect.Effect<ReadonlyMap<PreviewId, PreviewGatewayResolution>>;
    /**
     * Returns once the attempt is seen to answer on its port, or fails, by `request.deadline`.
     * `claim` runs only if this request claims a new launch (`SessionEngine.ensurePreviewRunning`).
     */
    readonly ensureRunning: (
      request: PreviewStartRequest,
      claim: Effect.Effect<void, PreviewStartDeclined, Scope.Scope>,
    ) => Effect.Effect<SessionProcessId, PreviewStartFailed | PreviewStartDeclined>;
  }
>()("@mend/api/PreviewTargets") {}

/** Drops `detail`: it is for logs, never for a browser. */
export const previewStartFailure = (refused: PreviewStartRefused): PreviewStartFailed =>
  new PreviewStartFailed({
    reason: refused.reason,
    ...(refused.resourceStopped === undefined ? {} : { resourceStopped: refused.resourceStopped }),
  });

export const PreviewTargetsLive: Layer.Layer<
  PreviewTargets,
  never,
  PreviewsRepo | SessionEngine | SessionProcessesRepo | SessionsRepo | ResourceRuntime
> = Layer.effect(
  PreviewTargets,
  Effect.gen(function* () {
    const previews = yield* PreviewsRepo;
    const engine = yield* SessionEngine;
    const processes = yield* SessionProcessesRepo;
    const sessions = yield* SessionsRepo;
    const resources = yield* ResourceRuntime;
    return {
      resourceStopOf: (attemptId) =>
        Effect.gen(function* () {
          const launch = yield* processes.launchOf(attemptId);
          if (launch === null) return null;
          const attempt = yield* processes.byId(attemptId);
          if (attempt === null) return null;
          const session = yield* sessions
            .byId(attempt.sessionId)
            .pipe(Effect.orElseSucceed(() => null));
          return session === null
            ? null
            : yield* resources.stoppedDependency(
                session.projectId,
                session.worktreeId,
                launch.depends,
              );
        }),
      touchActivity: previews.touchActivity,
      idleCandidates: previews.idleCandidates,
      stopIdle: engine.stopIdlePreview,
      snapshot: (id) =>
        previews
          .gatewaySnapshot(id)
          .pipe(
            Effect.map((read) =>
              read === null || read.preview.state === "removed" ? null : read.resolution,
            ),
          ),
      snapshots: (ids) =>
        previews
          .gatewaySnapshots(ids)
          .pipe(
            Effect.map(
              (read) =>
                new Map(
                  [...read].flatMap(([id, found]) =>
                    found.preview.state === "removed" ? [] : [[id, found.resolution] as const],
                  ),
                ),
            ),
          ),
      ensureRunning: (request, claim) =>
        engine.ensurePreviewRunning(request, claim).pipe(
          Effect.catchTag("PreviewStartRefused", (refused) =>
            Effect.logWarning("preview: a request-triggered start was refused").pipe(
              Effect.annotateLogs({
                previewId: request.previewId,
                reason: refused.reason,
                detail: refused.detail ?? "",
              }),
              Effect.andThen(Effect.fail(previewStartFailure(refused))),
            ),
          ),
        ),
    };
  }),
);
