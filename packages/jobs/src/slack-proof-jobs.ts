import {
  ProofArtifactsRepo,
  ProjectsRepo,
  SlackInstallsRepo,
  SlackProofDeliveriesRepo,
  SlackThreadsRepo,
} from "@mend/db";
import { ProofArtifactId } from "@mend/domain";
import type { ProofArtifact } from "@mend/domain/workbench";
import { SlackApi, SlackApiError } from "@mend/slack/client";
import { BlobStore, SecretCipher } from "@mend/store";
import { Clock, Effect, Layer, Schedule, Schema } from "effect";

import { JobRunner, type JobSpec } from "./job-runner.ts";
import { deliverProofToSlack } from "./slack-proof-delivery.ts";

/** Durable payload; workers reload current disclosure and delivery progress on every attempt. */
export const SlackDeliverProofJob = Schema.Struct({ artifactId: ProofArtifactId });
const JOB_NAME = "slack-deliver-proof";
// pg-boss jitter puts the sixth retry 315 to 630 seconds out, beyond Slack's share delay.
const RETRY_LIMIT = 6;

/** Live-key exclusion covers capture retries and the worker's periodic recovery scan. */
export const slackProofJob = (artifactId: ProofArtifactId): JobSpec => ({
  name: JOB_NAME,
  payload: { artifactId },
  idempotencyKey: `slack-proof:${artifactId}`,
  retryLimit: RETRY_LIMIT,
  retryDelaySeconds: 5,
});

const enqueue = Effect.fn("enqueueSlackProof")(function* (artifact: ProofArtifact) {
  if (artifact.capture._tag === "Recording" || artifact.sessionId === null) return;
  const threads = yield* SlackThreadsRepo;
  if ((yield* threads.forSession(artifact.sessionId)) === null) return;
  yield* (yield* JobRunner).enqueue(slackProofJob(artifact.id));
});

/**
 * Wraps the capture repository at the process boundary, after its transaction commits. A failed
 * enqueue must not turn a stored capture into a tool failure; reconciliation recovers the gap.
 */
export const ProofArtifactsWithSlackDeliveryLive: Layer.Layer<
  ProofArtifactsRepo,
  never,
  ProofArtifactsRepo | SlackThreadsRepo | JobRunner
> = Layer.effect(
  ProofArtifactsRepo,
  Effect.gen(function* () {
    const artifacts = yield* ProofArtifactsRepo;
    const context = yield* Effect.context<SlackThreadsRepo | JobRunner>();
    const notify = (artifact: ProofArtifact | null) =>
      artifact === null
        ? Effect.void
        : enqueue(artifact).pipe(
            Effect.provideContext(context),
            Effect.catchCause(() =>
              Effect.logWarning("slack proof: enqueue failed; reconciliation will retry").pipe(
                Effect.annotateLogs({ artifactId: artifact.id }),
              ),
            ),
          );
    return ProofArtifactsRepo.of({
      ...artifacts,
      insert: (artifact, callKey) => artifacts.insert(artifact, callKey).pipe(Effect.tap(notify)),
      settleVideo: (id, capture) => artifacts.settleVideo(id, capture).pipe(Effect.tap(notify)),
    });
  }),
);

/** Recover settled captures from the last day after a lost enqueue or worker restart. */
export const reconcileSlackProof = Effect.fn("reconcileSlackProof")(function* () {
  const deliveries = yield* SlackProofDeliveriesRepo;
  const jobs = yield* JobRunner;
  const now = yield* Clock.currentTimeMillis;
  const pending = yield* deliveries.pendingSince(new Date(now - 24 * 60 * 60_000));
  yield* Effect.forEach(pending, (artifactId) => jobs.enqueue(slackProofJob(artifactId)), {
    discard: true,
  });
});

/** Reload one artifact and its audience, then stream stored bytes into the resumable uploader. */
export const runSlackProof = Effect.fn("runSlackProof")(function* (payload: unknown) {
  const { artifactId } = yield* Schema.decodeUnknownEffect(SlackDeliverProofJob)(payload);
  const artifact = yield* (yield* ProofArtifactsRepo).byId(artifactId);
  if (artifact === null || artifact.sessionId === null || artifact.capture._tag === "Recording")
    return;
  const thread = yield* (yield* SlackThreadsRepo).forSession(artifact.sessionId);
  if (thread === null) return;
  const install = yield* (yield* SlackInstallsRepo).byTeam(thread.teamId);
  if (install === null) return;
  const project = yield* (yield* ProjectsRepo)
    .byId(artifact.projectId)
    .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
  if (project === null || project.organizationId !== install.organizationId) return;
  const token = yield* (yield* SecretCipher).decrypt(install.sealedBotToken);
  const blobs = yield* BlobStore;
  yield* deliverProofToSlack({
    artifact,
    thread,
    install,
    project,
    token,
    attemptLimit: RETRY_LIMIT + 1,
    media: (current) =>
      Effect.gen(function* () {
        const capture = current.capture;
        if (capture._tag !== "Screenshot" && capture._tag !== "Video")
          return yield* Effect.die("slack proof: settled capture has no media");
        const body = yield* Effect.acquireRelease(
          blobs.getStream(capture.media.blobKey).pipe(
            Effect.mapError(
              (error) =>
                new SlackApiError({
                  method: "proof.media",
                  code:
                    error._tag === "BlobNotFoundError" ? "media_not_found" : "media_unavailable",
                  message: "Mend could not read the stored proof file.",
                }),
            ),
          ),
          (stream) =>
            Effect.sync(() => {
              stream.destroy();
            }),
        );
        return { body, length: capture.media.bytes };
      }),
  });
}, Effect.scoped);

type DeliveryServices =
  | ProofArtifactsRepo
  | SlackThreadsRepo
  | SlackInstallsRepo
  | ProjectsRepo
  | SecretCipher
  | BlobStore
  | SlackProofDeliveriesRepo
  | SlackApi;

/** The worker owns registration and a scoped scan at boot and every thirty seconds. */
export const SlackProofWorkerLive: Layer.Layer<never, never, DeliveryServices | JobRunner> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const jobs = yield* JobRunner;
      const context = yield* Effect.context<DeliveryServices | JobRunner>();
      yield* jobs.work(JOB_NAME, (payload) =>
        runSlackProof(payload).pipe(Effect.provideContext(context), Effect.orDie),
      );
      yield* reconcileSlackProof().pipe(
        Effect.provideContext(context),
        Effect.catchCause(() => Effect.logWarning("slack proof: reconciliation failed")),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.forkScoped,
      );
    }),
  );
