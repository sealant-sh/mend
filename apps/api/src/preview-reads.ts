import {
  PreviewPreparationsRepo,
  PreviewsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionProcessesRepo,
} from "@mend/db";
import type { ServiceId, SessionId, WorktreeId } from "@mend/domain";
import {
  previewStatusesOf,
  unpreparedStatusOf,
  type PreviewStatus,
  type PreviewView,
} from "@mend/domain/workbench";
import { PreviewReadUnavailable, SlackPreviewReads } from "@mend/jobs";
import { NetworkConfig } from "@mend/network";
import type { PreviewNotice, WorktreePreviews } from "@mend/slack";
import { Cause, Effect, Layer } from "effect";

import { PreviewSetupConfig, type PreviewSetup } from "./preview-config.ts";
import { readPreviewOpen, type PreviewOpen } from "./preview-open.ts";

export interface DescribedPreview {
  readonly view: PreviewView;
  readonly facts: ReadonlyArray<PreviewStatus>;
  readonly open: PreviewOpen;
  readonly boundTo: { readonly serviceId: ServiceId; readonly sessionId: SessionId } | null;
}

export interface DescribedPreviews {
  readonly previews: ReadonlyArray<DescribedPreview>;
  /** A preparation that failed before any preview was allocated. */
  readonly unprepared: PreviewStatus | null;
}

type PreviewReads =
  | PreviewsRepo
  | PreviewPreparationsRepo
  | ServiceObservationsRepo
  | SessionProcessesRepo
  | ServicesRepo;

/**
 * The web's read and Slack's both come through here, so their facts cannot disagree. It writes
 * nothing: a caller that may allocate does so before.
 */
export const describeWorktreePreviews = (
  worktreeId: WorktreeId,
  views: ReadonlyArray<PreviewView>,
  setup: PreviewSetup,
): Effect.Effect<DescribedPreviews, never, PreviewReads> =>
  Effect.gen(function* () {
    const previews = yield* PreviewsRepo;
    const observations = yield* ServiceObservationsRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;
    const snapshots = yield* previews.gatewaySnapshots(views.map(({ preview }) => preview.id));
    const preparation = yield* (yield* PreviewPreparationsRepo).latestForWorktree(worktreeId);
    const described = yield* Effect.forEach(views, (view) =>
      Effect.gen(function* () {
        const resolution = snapshots.get(view.preview.id)?.resolution ?? null;
        const bound = resolution?._tag === "Bound" ? resolution.attempt : null;
        const observation =
          bound === null ? null : yield* observations.latestForService(bound.serviceId);
        const attemptId =
          resolution?._tag === "Bound"
            ? resolution.attempt.attemptId
            : resolution?._tag === "Starting"
              ? resolution.attemptId
              : resolution?._tag === "Dormant"
                ? resolution.source.sourceAttemptId
                : null;
        const attempt = attemptId === null ? null : yield* processes.byId(attemptId);
        const boundService =
          view.binding._tag === "Bound" ? yield* services.byId(view.binding.serviceId) : null;
        const activity =
          resolution?._tag === "Dormant" ? yield* previews.activityOf(view.preview.id) : null;
        const facts = previewStatusesOf(
          {
            preview: view.preview,
            resolution,
            observation,
            attemptStartedAt: attempt?.createdAt ?? null,
            idleStop:
              activity?.idleStoppedAttemptId === attemptId &&
              activity?.idleMinutes !== null &&
              activity?.idleMinutes !== undefined
                ? { minutes: activity.idleMinutes }
                : null,
          },
          preparation,
        );
        return {
          view,
          facts,
          open: yield* readPreviewOpen(setup, view, resolution, preparation),
          boundTo:
            boundService === null
              ? null
              : { serviceId: boundService.id, sessionId: boundService.sessionId },
        } satisfies DescribedPreview;
      }),
    );
    return {
      previews: described,
      unprepared: unpreparedStatusOf(
        views.map(({ preview }) => preview),
        preparation,
      ),
    };
  });

const byServiceThenId = (a: PreviewNotice, b: PreviewNotice) =>
  a.service < b.service ? -1 : a.service > b.service ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * No access check: a thread has no caller, and the reporter applies the thread's disclosure. The
 * link's origin is `APP_URL`, as the gateway's own sign-in redirect.
 */
export const SlackPreviewReadsLive: Layer.Layer<
  SlackPreviewReads,
  never,
  PreviewReads | PreviewSetupConfig | NetworkConfig
> = Layer.effect(
  SlackPreviewReads,
  Effect.gen(function* () {
    const { appUrl } = yield* NetworkConfig;
    const { setup } = yield* PreviewSetupConfig;
    const reads = yield* Effect.context<PreviewReads>();
    const previews = yield* PreviewsRepo;
    return {
      forWorktree: (worktreeId) =>
        setup._tag === "Off"
          ? Effect.succeed({ _tag: "Hidden" })
          : Effect.gen(function* () {
              const views = yield* previews.readForWorktree(worktreeId);
              const described = yield* describeWorktreePreviews(worktreeId, views, setup);
              const shown: WorktreePreviews = {
                _tag: "Shown",
                appUrl,
                previews: described.previews
                  .map(
                    ({ view, facts, open }): PreviewNotice => ({
                      id: view.preview.id,
                      service: view.preview.serviceName,
                      facts,
                      openable: open._tag === "Open",
                    }),
                  )
                  .toSorted(byServiceThenId),
                unprepared: described.unprepared,
              };
              return shown;
            }).pipe(
              Effect.provideContext(reads),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.fail(
                      new PreviewReadUnavailable({ worktreeId, cause: Cause.pretty(cause) }),
                    ),
              ),
            ),
    };
  }),
);
