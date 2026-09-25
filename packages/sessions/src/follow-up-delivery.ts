import {
  AgentConversationRepo,
  FollowUpsRepo,
  type FollowUpDeliveryAttempt,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  WorktreeChangesRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import type { CheckpointId, ReviewCommentId, ReviewSliceId, SessionId } from "@mend/domain";
import { type DiffDigest, type FollowUp, isLiveAgentProcess } from "@mend/domain/workbench";
import { Clock, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import * as Context from "effect/Context";

import { SessionEngine, SessionNotLiveError } from "./engine.ts";

export interface DeliverFollowUpInput {
  readonly sessionId: SessionId;
  readonly reviewSliceId: ReviewSliceId;
  readonly checkpointAId: CheckpointId;
  readonly checkpointBId: CheckpointId;
  readonly diffDigest: DiffDigest;
  readonly commentIds: ReadonlyArray<ReviewCommentId>;
  readonly instruction: string;
  readonly idempotencyKey: string;
  /**
   * Who sent the review comments. The follow-up turn is recorded as theirs, so automatic landing
   * (docs/adr/0007-landing.md) lands it only when that is the change's owner.
   */
  readonly author: string | null;
}

export class FollowUpDeliveryInputError extends Schema.TaggedErrorClass<FollowUpDeliveryInputError>()(
  "FollowUpDeliveryInputError",
  { message: Schema.String },
) {}

export class FollowUpLauncher extends Context.Service<
  FollowUpLauncher,
  {
    readonly launch: typeof SessionEngine.Service.launchFollowUp;
  }
>()("@mend/sessions/FollowUpLauncher") {}

export const FollowUpLauncherLive: Layer.Layer<FollowUpLauncher, never, SessionEngine> =
  Layer.effect(
    FollowUpLauncher,
    Effect.gen(function* () {
      const engine = yield* SessionEngine;
      return { launch: engine.launchFollowUp };
    }),
  );

export class FollowUpDelivery extends Context.Service<
  FollowUpDelivery,
  {
    readonly deliver: (
      input: DeliverFollowUpInput,
    ) => Effect.Effect<FollowUp, FollowUpDeliveryInputError>;
  }
>()("@mend/sessions/FollowUpDelivery") {}

const DELIVERY_LEASE_DURATION = Duration.seconds(30);
const DELIVERY_HEARTBEAT_INTERVAL = Duration.seconds(10);
/**
 * Row statuses that mean "an agent is live" even before a process row exists: a launch in
 * flight, a run attached without a process. `idle` is NOT here — shells or Services holding the
 * workspace do not block a follow-up; the fold over processes says whether an agent is live.
 */
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running", "waiting"]);

const sameIds = (left: ReadonlyArray<ReviewCommentId>, right: ReadonlyArray<ReviewCommentId>) =>
  left.length === right.length && left.every((id) => right.includes(id));

const matchesInput = (followUp: FollowUp, input: DeliverFollowUpInput): boolean =>
  followUp.reviewSliceId === input.reviewSliceId &&
  followUp.checkpointAId === input.checkpointAId &&
  followUp.checkpointBId === input.checkpointBId &&
  followUp.diffDigest === input.diffDigest &&
  followUp.instruction === input.instruction &&
  sameIds(followUp.commentIds, input.commentIds);

const errorMessage = (error: unknown): string => {
  if (error instanceof SessionNotLiveError) {
    return "The session needs a live retained workspace before this follow-up can launch.";
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message);
    if (message.trim() !== "") return message;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String(error["_tag"]);
  }
  return String(error);
};

const sessionBecameActive = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "session_active";

type DeliveryDecision =
  | { readonly kind: "return"; readonly followUp: FollowUp }
  | {
      readonly kind: "launch";
      readonly followUp: FollowUp;
      readonly attemptId: string;
      readonly correlationId: string;
    };

const returnDecision = (followUp: FollowUp): DeliveryDecision => ({ kind: "return", followUp });

const launchDecision = (attempt: FollowUpDeliveryAttempt): DeliveryDecision => {
  if (attempt.attemptId === null) return returnDecision(attempt.followUp);
  return {
    kind: "launch",
    followUp: attempt.followUp,
    attemptId: attempt.attemptId,
    correlationId: `follow-up:${attempt.followUp.id}`,
  };
};

export const FollowUpDeliveryLive: Layer.Layer<
  FollowUpDelivery,
  never,
  | AgentConversationRepo
  | FollowUpsRepo
  | ReviewCommentsRepo
  | ReviewSlicesRepo
  | WorktreeChangesRepo
  | SessionProcessesRepo
  | SessionsRepo
  | FollowUpLauncher
> = Layer.effect(
  FollowUpDelivery,
  Effect.gen(function* () {
    const conversations = yield* AgentConversationRepo;
    const followUps = yield* FollowUpsRepo;
    const comments = yield* ReviewCommentsRepo;
    const slices = yield* ReviewSlicesRepo;
    const changes = yield* WorktreeChangesRepo;
    const processes = yield* SessionProcessesRepo;
    const sessions = yield* SessionsRepo;
    const launcher = yield* FollowUpLauncher;

    const missingFollowUp = (sessionId: SessionId) =>
      new FollowUpDeliveryInputError({
        message: `The follow-up for session ${sessionId} no longer exists.`,
      });

    const finalizeCorrelated = Effect.fn("FollowUpDelivery.finalizeCorrelated")(function* (
      followUp: FollowUp,
    ) {
      const correlated = yield* processes.byLaunchCorrelation(`follow-up:${followUp.id}`);
      if (correlated === null || correlated.sealantRunId === null) return null;
      const delivered = yield* followUps.reconcileDelivered(
        followUp.id,
        correlated.id,
        correlated.sealantRunId,
      );
      yield* comments.markSelectedSent(followUp.commentIds, followUp.sessionId);
      return delivered;
    });

    const finishLaunch = Effect.fn("FollowUpDelivery.finishLaunch")(function* (
      claimed: FollowUp,
      attemptId: string,
      launchResult: Result.Result<unknown, unknown>,
    ) {
      return yield* followUps.withSessionLock(
        claimed.sessionId,
        Effect.gen(function* () {
          const current = yield* followUps.byId(claimed.id);
          if (current === null) return yield* missingFollowUp(claimed.sessionId);
          const delivered = yield* finalizeCorrelated(current);
          if (delivered !== null) return delivered;
          if (Result.isSuccess(launchResult)) {
            const turn = yield* conversations.byLaunchCorrelation(
              current.sessionId,
              `follow-up:${current.id}`,
            );
            const correlatedProcess = turn === null ? null : yield* processes.byId(turn.processId);
            if (correlatedProcess !== null && correlatedProcess.sealantRunId !== null) {
              const reconciled = yield* followUps.reconcileDelivered(
                current.id,
                correlatedProcess.id,
                correlatedProcess.sealantRunId,
              );
              yield* comments.markSelectedSent(current.commentIds, current.sessionId);
              return reconciled;
            }
          }
          if (current.status !== "delivering") return current;
          const currentAttempt = yield* followUps.attemptForFollowUp(current.id);
          if (currentAttempt?.attemptId !== attemptId) return current;

          let outcome:
            | { readonly status: "pending" }
            | { readonly status: "delivery_failed"; readonly message: string };
          if (Result.isFailure(launchResult)) {
            outcome = sessionBecameActive(launchResult.failure)
              ? { status: "pending" }
              : {
                  status: "delivery_failed",
                  message: errorMessage(launchResult.failure),
                };
          } else {
            outcome = {
              status: "delivery_failed",
              message:
                "The platform accepted the process, but Mend could not recover its membership. Retry with the same key.",
            };
          }
          const released = yield* followUps.releaseClaim(current.id, attemptId, outcome);
          return released ?? (yield* followUps.byId(current.id)) ?? current;
        }),
      );
    });

    const prepare = Effect.fn("FollowUpDelivery.prepare")(function* (
      input: DeliverFollowUpInput,
    ): Effect.fn.Return<DeliveryDecision, FollowUpDeliveryInputError> {
      return yield* followUps.withSessionLock(
        input.sessionId,
        Effect.gen(function* () {
          const session = yield* sessions.byId(input.sessionId).pipe(
            Effect.mapError(
              () =>
                new FollowUpDeliveryInputError({
                  message: `Session ${input.sessionId} was not found.`,
                }),
            ),
          );
          const change = yield* changes.bySession(input.sessionId);
          if (change === null) {
            return yield* new FollowUpDeliveryInputError({
              message: "The session has no change to receive Review feedback.",
            });
          }
          const slice = yield* slices.byId(input.reviewSliceId);
          if (
            slice === null ||
            slice.changeId !== change.id ||
            slice.checkpointAId !== input.checkpointAId ||
            slice.checkpointBId !== input.checkpointBId ||
            slice.diffDigest !== input.diffDigest
          ) {
            return yield* new FollowUpDeliveryInputError({
              message: "The follow-up Review inputs do not match one immutable Review slice.",
            });
          }

          const existing = yield* followUps.byIdempotencyKey(input.sessionId, input.idempotencyKey);
          if (existing !== null && !matchesInput(existing, input)) {
            return yield* new FollowUpDeliveryInputError({
              message:
                "This follow-up idempotency key was already used for different Review input.",
            });
          }

          if (existing !== null) {
            const delivered = yield* finalizeCorrelated(existing);
            if (delivered !== null) return returnDecision(delivered);
            if (existing.status === "delivered") {
              yield* comments.markSelectedSent(existing.commentIds, input.sessionId);
              return returnDecision(existing);
            }
            if (existing.status === "superseded") {
              return yield* new FollowUpDeliveryInputError({
                message: "This follow-up was superseded by a newer Review bundle.",
              });
            }
            if (existing.status === "delivering") {
              const attempt = yield* followUps.attemptForFollowUp(existing.id);
              if (
                attempt === null ||
                attempt.attemptId === null ||
                attempt.leaseExpiresAt === null
              ) {
                return returnDecision(yield* followUps.markPending(existing.id));
              }
              const now = yield* Clock.currentTimeMillis;
              if (attempt.leaseExpiresAt.getTime() > now) return returnDecision(existing);
              const failed = yield* followUps.releaseClaim(existing.id, attempt.attemptId, {
                status: "delivery_failed",
                message:
                  "Delivery was interrupted before process membership was recorded. Retry with the same key.",
              });
              return returnDecision(failed ?? existing);
            }
          }

          const changeComments = yield* comments.listForChange(change.id);
          const selected = new Set(input.commentIds);
          const selectedComments = changeComments.filter((comment) => selected.has(comment.id));
          if (
            selectedComments.length !== input.commentIds.length ||
            selectedComments.some(
              (comment) => comment.state !== "open" || comment.sentToSessionId !== null,
            )
          ) {
            return yield* new FollowUpDeliveryInputError({
              message:
                "Every selected comment must still be open, unsent, and belong to this change.",
            });
          }

          const followUp =
            existing ??
            (yield* followUps.createOrGet({
              sessionId: input.sessionId,
              changeId: change.id,
              reviewSliceId: input.reviewSliceId,
              checkpointAId: input.checkpointAId,
              checkpointBId: input.checkpointBId,
              diffDigest: input.diffDigest,
              commentIds: input.commentIds,
              instruction: input.instruction,
              idempotencyKey: input.idempotencyKey,
            }));

          const sessionProcesses = yield* processes.listForSession(input.sessionId);
          const hasLiveAgent = sessionProcesses.some(isLiveAgentProcess);
          const liveProtocol = sessionProcesses.find(
            (process) => process.kind === "agent-protocol" && isLiveAgentProcess(process),
          );
          const observedActive =
            session.settledAt === null && ACTIVE_SESSION_STATUSES.has(session.status);
          if ((hasLiveAgent || observedActive) && liveProtocol === undefined) {
            const pending =
              followUp.status === "pending" ? followUp : yield* followUps.markPending(followUp.id);
            return returnDecision(pending);
          }

          const inProgress = yield* followUps.deliveringForSession(input.sessionId);
          if (inProgress !== null && inProgress.followUp.id !== followUp.id) {
            const recovered = yield* finalizeCorrelated(inProgress.followUp);
            if (recovered === null) {
              const now = yield* Clock.currentTimeMillis;
              const leaseActive =
                inProgress.leaseExpiresAt !== null && inProgress.leaseExpiresAt.getTime() > now;
              if (inProgress.attemptId !== null && leaseActive) {
                const pending =
                  followUp.status === "pending"
                    ? followUp
                    : yield* followUps.markPending(followUp.id);
                return returnDecision(pending);
              }
              if (inProgress.attemptId === null) {
                yield* followUps.markPending(inProgress.followUp.id);
              } else {
                yield* followUps.releaseClaim(inProgress.followUp.id, inProgress.attemptId, {
                  status: "delivery_failed",
                  message:
                    "Delivery was interrupted before process membership was recorded. Retry with the same key.",
                });
              }
            }
          }

          const now = yield* Clock.currentTimeMillis;
          const claimed = yield* followUps.claimDelivery(
            followUp.id,
            crypto.randomUUID(),
            new Date(now + Duration.toMillis(DELIVERY_LEASE_DURATION)),
          );
          if (claimed === null) {
            const current = yield* followUps.byId(followUp.id);
            return returnDecision(current ?? followUp);
          }
          return launchDecision(claimed);
        }),
      );
    });

    const deliver = Effect.fn("FollowUpDelivery.deliver")(function* (input: DeliverFollowUpInput) {
      const key = input.idempotencyKey.trim();
      const instruction = input.instruction;
      if (key === "" || key.length > 200) {
        return yield* new FollowUpDeliveryInputError({
          message: "Follow-up idempotency keys must contain between 1 and 200 characters.",
        });
      }
      if (instruction.trim() === "" || instruction.length > 100_000) {
        return yield* new FollowUpDeliveryInputError({
          message: "Follow-up instructions must contain between 1 and 100000 characters.",
        });
      }
      if (
        input.commentIds.length === 0 ||
        new Set(input.commentIds).size !== input.commentIds.length
      ) {
        return yield* new FollowUpDeliveryInputError({
          message: "Select at least one Review comment, without duplicates.",
        });
      }

      const normalizedInput = { ...input, instruction, idempotencyKey: key };
      const decision = yield* prepare(normalizedInput);
      if (decision.kind === "return") return decision.followUp;

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const heartbeat = Effect.gen(function* () {
            for (;;) {
              yield* Effect.sleep(DELIVERY_HEARTBEAT_INTERVAL);
              const now = yield* Clock.currentTimeMillis;
              const renewed = yield* followUps
                .renewClaim(
                  decision.followUp.id,
                  decision.attemptId,
                  new Date(now + Duration.toMillis(DELIVERY_LEASE_DURATION)),
                )
                .pipe(
                  Effect.map(Option.some),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("follow-up delivery: lease heartbeat failed").pipe(
                      Effect.annotateLogs({
                        followUpId: decision.followUp.id,
                        cause: String(cause),
                      }),
                      Effect.as(Option.none<boolean>()),
                    ),
                  ),
                );
              if (Option.isSome(renewed) && !renewed.value) return;
            }
          });
          const launched = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* heartbeat.pipe(Effect.interruptible, Effect.forkScoped);
              return yield* launcher
                .launch(input.sessionId, instruction, decision.correlationId, input.author)
                .pipe(Effect.result);
            }),
          );
          return yield* finishLaunch(decision.followUp, decision.attemptId, launched);
        }),
      );
    });

    return { deliver };
  }),
);
