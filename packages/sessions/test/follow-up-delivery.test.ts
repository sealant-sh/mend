import { describe, expect, it } from "@effect/vitest";
import {
  AgentConversationRepo,
  FollowUpsRepo,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  WorktreeChangesRepo,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  FollowUpId,
  ProjectId,
  ReviewCommentId,
  ReviewSliceId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  WorktreeId,
  SessionProcessId,
  Sha,
} from "@mend/domain";
import {
  AgentTurn,
  Change,
  DiffDigest,
  FollowUp,
  ReviewComment,
  ReviewSlice,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { SessionNotLiveError } from "../src/engine.ts";
import {
  FollowUpDelivery,
  FollowUpDeliveryLive,
  FollowUpLauncher,
} from "../src/follow-up-delivery.ts";

const now = () => new Date("2026-08-20T12:00:00.000Z");
const SESSION_ID = SessionId.make("session-1");
const WORKTREE_ID = WorktreeId.make("worktree-1");
const PROJECT_ID = ProjectId.make("project-1");
const CHANGE_ID = ChangeId.make("change-1");
const SLICE_ID = ReviewSliceId.make("slice-1");
const CHECKPOINT_A_ID = CheckpointId.make("checkpoint-a");
const CHECKPOINT_B_ID = CheckpointId.make("checkpoint-b");
const COMMENT_ID = ReviewCommentId.make("comment-1");
const DIGEST = DiffDigest.make("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

interface TestWorld {
  followUp: FollowUp | null;
  comment: ReviewComment;
  process: SessionProcess | null;
  session: Session;
  insideSessionLock: boolean;
  launches: number;
  launcherMode: "success" | "failure" | "held";
  launchGate: Deferred.Deferred<void> | null;
  deliveryAttemptId: string | null;
  deliveryLeaseExpiresAt: Date | null;
  renewalDefectsRemaining: number;
}

const makeWorld = (launcherMode: TestWorld["launcherMode"] = "success"): TestWorld => ({
  followUp: null,
  comment: new ReviewComment({
    id: COMMENT_ID,
    changeId: CHANGE_ID,
    file: null,
    line: null,
    endLine: null,
    anchor: null,
    authorKind: "reviewer",
    authorName: "Reviewer",
    body: "Keep the instruction exact.",
    kind: "note",
    suggestion: null,
    state: "open",
    evidence: [],
    sentToSessionId: null,
    createdAt: now(),
    updatedAt: now(),
  }),
  process: null,
  session: new Session({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    harness: "codex",
    providerSessionId: null,
    label: null,
    worktree: "session-1",
    branch: "mend/session-1",
    baseSha: Sha.make("base-sha"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: SealantRunId.make("run-previous"),
    sealantWorkspaceId: null,
    sealantSessionId: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: null,
    hasTranscript: null,
    status: "completed",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: now(),
    settledAt: now(),
    createdAt: now(),
    updatedAt: now(),
  }),
  insideSessionLock: false,
  launches: 0,
  launcherMode,
  launchGate: null,
  deliveryAttemptId: null,
  deliveryLeaseExpiresAt: null,
  renewalDefectsRemaining: 0,
});

const updateFollowUp = (world: TestWorld, patch: Partial<FollowUp>): FollowUp => {
  if (world.followUp === null) return Effect.runSync(Effect.die("follow-up missing"));
  const updated = new FollowUp({ ...world.followUp, ...patch });
  world.followUp = updated;
  return updated;
};

const recordAcceptedProcess = (
  world: TestWorld,
  instruction: string,
  correlationId: string,
): void => {
  if (world.process?.kind === "agent-protocol") return;
  world.process = new SessionProcess({
    id: SessionProcessId.make("process-1"),
    sessionId: SESSION_ID,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
    sealantSessionId: "pty-1",
    sealantRunId: SealantRunId.make("run-1"),
    launchCorrelationId: correlationId,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-pty",
    harness: "codex",
    providerSessionId: null,
    protocolOptions: null,
    label: "codex",
    argv: ["codex", instruction],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
  });
};

const launchForWorld = (world: TestWorld, instruction: string, correlationId: string) =>
  Effect.gen(function* () {
    expect(world.insideSessionLock).toBe(false);
    expect(world.followUp?.status).toBe("delivering");
    expect(instruction).toBe("  Address only the selected comment.\nKeep this spacing.  ");
    world.launches += 1;
    if (world.launcherMode === "failure") {
      return yield* new SessionNotLiveError({ sessionId: SESSION_ID });
    }
    if (world.launcherMode === "held") {
      const gate = world.launchGate;
      if (gate === null) return yield* Effect.die("launch gate missing");
      yield* Deferred.await(gate);
    }
    recordAcceptedProcess(world, instruction, correlationId);
    return world.session;
  });

const testLayer = (world: TestWorld) => {
  const change = new Change({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    sessionId: SESSION_ID,
    branch: world.session.branch,
    baseSha: world.session.baseSha,
    headSha: null,
    createdAt: now(),
    updatedAt: now(),
  });
  const slice = new ReviewSlice({
    id: SLICE_ID,
    changeId: CHANGE_ID,
    checkpointAId: CHECKPOINT_A_ID,
    checkpointBId: CHECKPOINT_B_ID,
    diffDigest: DIGEST,
    createdAt: now(),
  });

  const followUpsLayer = Layer.succeed(FollowUpsRepo, {
    createOrGet: (input) =>
      Effect.sync(() => {
        if (world.followUp !== null) return world.followUp;
        world.followUp = new FollowUp({
          id: FollowUpId.make("follow-up-1"),
          ...input,
          status: "pending",
          deliveryProcessId: null,
          deliverySealantRunId: null,
          deliveryError: null,
          deliveryStartedAt: null,
          createdAt: now(),
          deliveredAt: null,
        });
        return world.followUp;
      }),
    withSessionLock: (_sessionId, effect) =>
      Effect.suspend(() => {
        if (world.insideSessionLock) return Effect.die("nested session lock");
        world.insideSessionLock = true;
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              world.insideSessionLock = false;
            }),
          ),
        );
      }),
    byId: () => Effect.succeed(world.followUp),
    byIdempotencyKey: (_sessionId, key) =>
      Effect.succeed(world.followUp?.idempotencyKey === key ? world.followUp : null),
    activeForSession: () => Effect.succeed(world.followUp),
    deliveringForSession: () =>
      Effect.succeed(
        world.followUp?.status === "delivering"
          ? {
              followUp: world.followUp,
              attemptId: world.deliveryAttemptId,
              leaseExpiresAt: world.deliveryLeaseExpiresAt,
            }
          : null,
      ),
    attemptForFollowUp: () =>
      Effect.succeed(
        world.followUp === null
          ? null
          : {
              followUp: world.followUp,
              attemptId: world.deliveryAttemptId,
              leaseExpiresAt: world.deliveryLeaseExpiresAt,
            },
      ),
    markPending: () =>
      Effect.sync(() => {
        world.deliveryAttemptId = null;
        world.deliveryLeaseExpiresAt = null;
        return updateFollowUp(world, {
          status: "pending",
          deliveryError: null,
          deliveryStartedAt: null,
        });
      }),
    claimDelivery: (_id, attemptId, leaseExpiresAt) =>
      Effect.sync(() => {
        if (
          world.followUp === null ||
          (world.followUp.status !== "pending" && world.followUp.status !== "delivery_failed")
        ) {
          return null;
        }
        world.deliveryAttemptId = attemptId;
        world.deliveryLeaseExpiresAt = leaseExpiresAt;
        const followUp = updateFollowUp(world, {
          status: "delivering",
          deliveryError: null,
          deliveryStartedAt: now(),
        });
        return { followUp, attemptId, leaseExpiresAt };
      }),
    renewClaim: (_id, attemptId, leaseExpiresAt) =>
      Effect.suspend(() => {
        if (world.renewalDefectsRemaining > 0) {
          world.renewalDefectsRemaining -= 1;
          return Effect.die("transient lease renewal failure");
        }
        return Effect.sync(() => {
          if (world.followUp?.status !== "delivering" || world.deliveryAttemptId !== attemptId) {
            return false;
          }
          world.deliveryLeaseExpiresAt = leaseExpiresAt;
          return true;
        });
      }),
    releaseClaim: (_id, attemptId, outcome) =>
      Effect.sync(() => {
        if (world.followUp?.status !== "delivering" || world.deliveryAttemptId !== attemptId) {
          return null;
        }
        world.deliveryAttemptId = null;
        world.deliveryLeaseExpiresAt = null;
        return updateFollowUp(
          world,
          outcome.status === "pending"
            ? { status: "pending", deliveryError: null, deliveryStartedAt: null }
            : { status: "delivery_failed", deliveryError: outcome.message },
        );
      }),
    reconcileDelivered: (_id, processId, sealantRunId) =>
      Effect.sync(() => {
        world.deliveryAttemptId = null;
        world.deliveryLeaseExpiresAt = null;
        return updateFollowUp(world, {
          status: "delivered",
          deliveryProcessId: processId,
          deliverySealantRunId: sealantRunId,
          deliveryError: null,
          deliveredAt: now(),
        });
      }),
  });

  const commentsLayer = Layer.succeed(ReviewCommentsRepo, {
    create: () => Effect.die("not in test"),
    byId: () => Effect.succeed(world.comment),
    listForChange: () => Effect.succeed([world.comment]),
    setState: () => Effect.die("not in test"),
    markSent: () => Effect.die("not in test"),
    markSelectedSent: (ids, sessionId) =>
      Effect.sync(() => {
        if (!ids.includes(world.comment.id) || world.comment.sentToSessionId !== null) return 0;
        world.comment = new ReviewComment({
          ...world.comment,
          sentToSessionId: sessionId,
          updatedAt: now(),
        });
        return 1;
      }),
  });

  const slicesLayer = Layer.succeed(ReviewSlicesRepo, {
    create: () => Effect.die("not in test"),
    withChangeLock: (_changeId, effect) => effect,
    byId: (id) => Effect.succeed(id === slice.id ? slice : null),
    byIdempotencyKey: () => Effect.die("not in test"),
    latestForChange: () => Effect.die("not in test"),
  });

  const changesLayer = Layer.succeed(WorktreeChangesRepo, {
    ensureForWorktree: () => Effect.die("not in test"),
    byId: () => Effect.succeed(change),
    byWorktree: (worktreeId) => Effect.succeed(worktreeId === WORKTREE_ID ? change : null),
    bySession: (sessionId: string) => Effect.succeed(sessionId === SESSION_ID ? change : null),
    refreshHead: () => Effect.die("not in test"),
    annotationsForProject: () => Effect.die("not in test"),
  });

  const conversationLayer = Layer.succeed(AgentConversationRepo, {
    submitTurn: () => Effect.die("not in test"),
    byTurnId: () => Effect.succeed(null),
    byLaunchCorrelation: () =>
      Effect.succeed(
        world.process?.kind === "agent-protocol" && world.followUp !== null
          ? new AgentTurn({
              id: AgentTurnId.make("follow-up-turn"),
              sessionId: SESSION_ID,
              processId: world.process.id,
              ordinal: 1,
              author: null,
              input: world.followUp.instruction,
              status: "queued",
              providerTurnId: null,
              error: null,
              usage: null,
              createdAt: now(),
              startedAt: null,
              endedAt: null,
            })
          : null,
      ),
    byProviderTurnId: () => Effect.succeed(null),
    listTurns: () => Effect.succeed([]),
    openTurns: () => Effect.succeed([]),
    claimNextTurn: () => Effect.succeed(null),
    setProviderTurnId: () => Effect.die("not in test"),
    bindRunningProviderTurn: () => Effect.succeed(null),
    failTurn: () => Effect.die("not in test"),
    completeTurn: () => Effect.succeed(null),
    upsertItem: () => Effect.die("not in test"),
    listItems: () => Effect.succeed([]),
    openRequest: () => Effect.die("not in test"),
    byRequestId: () => Effect.succeed(null),
    listRequests: () => Effect.succeed([]),
    hasPendingRequests: () => Effect.succeed(false),
    prepareRequestResponse: () => Effect.die("not in test"),
    completeRequestResponse: () => Effect.die("not in test"),
    failRequestResponse: () => Effect.void,
    resolveRequest: () => Effect.die("not in test"),
    resolveProviderRequest: () => Effect.void,
    cancelOpenForTurn: () => Effect.void,
    cancelOpenForProcess: () => Effect.void,
    protocolCursor: () => Effect.succeed({ nextSequence: 0n }),
    backfillConversation: () => Effect.succeed(0),
    resetSendingResponses: () => Effect.void,
    requeueQueuedTurns: () => Effect.void,
    saveProtocolCursor: () => Effect.void,
  });

  const processesLayer = Layer.succeed(SessionProcessesRepo, {
    create: () => Effect.die("not in test"),
    byId: () => Effect.succeed(world.process),
    byLaunchCorrelation: (correlationId) =>
      Effect.succeed(world.process?.launchCorrelationId === correlationId ? world.process : null),
    listForSession: () => Effect.succeed(world.process === null ? [] : [world.process]),
    listForSessions: () => Effect.succeed(world.process === null ? [] : [world.process]),
    listForService: () => Effect.succeed([]),
    listLiveForWorkspace: () => Effect.die("not in test"),
    listLive: () => Effect.die("not in test"),
    listRecentServices: () => Effect.die("not in test"),
    setStatus: () => Effect.die("not in test"),
    setLabel: () => Effect.die("not in test"),
    setProviderSessionId: () => Effect.die("not in test"),
    setHostPort: () => Effect.die("not in test"),
    setSealantSessionId: () => Effect.die("not in test"),
    markExited: () => Effect.die("not in test"),
    reapLiveForWorkspace: () => Effect.die("not in test"),
  });

  const sessionsLayer = Layer.succeed(SessionsRepo, {
    create: () => Effect.die("not in test"),
    byId: () => Effect.succeed(world.session),
    listForProject: () => Effect.die("not in test"),
    listForWorktree: () => Effect.die("not in test"),
    listActive: () => Effect.die("not in test"),
    listUnsettled: () => Effect.die("not in test"),
    listRecentlySettled: () => Effect.die("not in test"),
    setSealantIds: () => Effect.die("not in test"),
    recordWorkspaceTtlRenewal: () => Effect.die("not in test"),
    recordWorkspaceTtlRenewalFailure: () => Effect.die("not in test"),
    setSealantSessionId: () => Effect.die("not in test"),
    setWorkspaceImage: () => Effect.die("not in test"),
    setDotfiles: () => Effect.die("not in test"),
    setHasTranscript: () => Effect.die("not in test"),
    listSettledUnclassified: () => Effect.succeed([]),
    setProviderSessionId: () => Effect.die("not in test"),
    setReferenceMounts: () => Effect.die("not in test"),
    setExtraMounts: () => Effect.die("not in test"),
    setStatus: () => Effect.die("not in test"),
    nativeIngestCursor: () => Effect.succeed(null),
    setNativeIngestCursor: () => Effect.void,
    saveLastSeenSequence: () => Effect.die("not in test"),
    notifyProgress: () => Effect.die("not in test"),
    settle: () => Effect.die("not in test"),
    reopen: () => Effect.die("not in test"),
    setSummary: () => Effect.die("not in test"),
    setLabel: () => Effect.die("not in test"),
    setLabelIfUnset: () => Effect.die("not in test"),
    remove: () => Effect.die("not in test"),
    setHarness: () => Effect.die("not in test"),
  });

  const launcherLayer = Layer.succeed(FollowUpLauncher, {
    launch: (_sessionId, instruction, correlationId) =>
      launchForWorld(world, instruction, correlationId),
  });

  return FollowUpDeliveryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        conversationLayer,
        followUpsLayer,
        commentsLayer,
        slicesLayer,
        changesLayer,
        processesLayer,
        sessionsLayer,
        launcherLayer,
      ),
    ),
  );
};

const deliveryInput = () => ({
  sessionId: SESSION_ID,
  reviewSliceId: SLICE_ID,
  checkpointAId: CHECKPOINT_A_ID,
  checkpointBId: CHECKPOINT_B_ID,
  diffDigest: DIGEST,
  commentIds: [COMMENT_ID],
  instruction: "  Address only the selected comment.\nKeep this spacing.  ",
  idempotencyKey: "delivery-1",
});

const seedFollowUp = (world: TestWorld, startedAt: Date): FollowUp => {
  const input = deliveryInput();
  const followUp = new FollowUp({
    id: FollowUpId.make("follow-up-1"),
    sessionId: input.sessionId,
    changeId: CHANGE_ID,
    reviewSliceId: input.reviewSliceId,
    checkpointAId: input.checkpointAId,
    checkpointBId: input.checkpointBId,
    diffDigest: input.diffDigest,
    commentIds: input.commentIds,
    instruction: input.instruction,
    idempotencyKey: input.idempotencyKey,
    status: "delivering",
    deliveryProcessId: null,
    deliverySealantRunId: null,
    deliveryError: null,
    deliveryStartedAt: startedAt,
    createdAt: now(),
    deliveredAt: null,
  });
  world.followUp = followUp;
  world.deliveryAttemptId = "seeded-attempt";
  world.deliveryLeaseExpiresAt = startedAt;
  return followUp;
};

const seedAcceptedProcess = (world: TestWorld, followUp: FollowUp) => {
  world.process = new SessionProcess({
    id: SessionProcessId.make("process-before-crash"),
    sessionId: SESSION_ID,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-before-crash"),
    sealantSessionId: "pty-before-crash",
    sealantRunId: SealantRunId.make("run-before-crash"),
    launchCorrelationId: `follow-up:${followUp.id}`,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-pty",
    harness: "codex",
    providerSessionId: null,
    protocolOptions: null,
    label: "codex",
    argv: ["codex", followUp.instruction],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
  });
};

describe("FollowUpDelivery", () => {
  it.effect(
    "commits the claim before a transaction-free launch, then replays by correlation",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const delivery = yield* FollowUpDelivery;
        const result = yield* delivery.deliver(deliveryInput());
        const replay = yield* delivery.deliver(deliveryInput());

        expect(result.status).toBe("delivered");
        expect(result.deliverySealantRunId).toBe("run-1");
        expect(replay.id).toBe(result.id);
        expect(replay.deliverySealantRunId).toBe("run-1");
        expect(world.comment.sentToSessionId).toBe(SESSION_ID);
        expect(world.launches).toBe(1);
        expect(world.insideSessionLock).toBe(false);
      }).pipe(Effect.provide(testLayer(world)));
    },
  );

  it.effect("delivers a follow-up as a turn on the live protocol process", () => {
    const world = makeWorld();
    world.session = new Session({ ...world.session, status: "running", settledAt: null });
    world.process = new SessionProcess({
      id: SessionProcessId.make("protocol-process"),
      sessionId: SESSION_ID,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
      sealantSessionId: "pipe-1",
      sealantRunId: SealantRunId.make("protocol-run"),
      launchCorrelationId: null,
      serviceId: null,
      attemptOrdinal: null,
      kind: "agent-protocol",
      harness: "codex",
      providerSessionId: "thread-1",
      protocolOptions: null,
      label: "codex",
      argv: ["codex", "app-server"],
      status: "running",
      exitCode: null,
      workspacePort: null,
      protocol: "tcp",
      hostPort: null,
      createdAt: now(),
      exitedAt: null,
      updatedAt: now(),
    });
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const result = yield* delivery.deliver(deliveryInput());
      const replay = yield* delivery.deliver(deliveryInput());

      expect(result.status).toBe("delivered");
      expect(result.deliveryProcessId).toBe("protocol-process");
      expect(result.deliverySealantRunId).toBe("protocol-run");
      expect(replay.id).toBe(result.id);
      expect(world.launches).toBe(1);
      expect(world.comment.sentToSessionId).toBe(SESSION_ID);
    }).pipe(Effect.provide(testLayer(world)));
  });

  it.effect("persists a launch failure without sending the selected comment", () => {
    const world = makeWorld("failure");
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const result = yield* delivery.deliver(deliveryInput());

      expect(result.status).toBe("delivery_failed");
      expect(result.deliveryError).toContain("needs a live retained workspace");
      expect(world.comment.sentToSessionId).toBeNull();
      expect(world.session.settledAt).not.toBeNull();
      expect(world.launches).toBe(1);
    }).pipe(Effect.provide(testLayer(world)));
  });

  it.effect("keeps the bundle pending when the session is already active", () => {
    const world = makeWorld();
    world.session = new Session({ ...world.session, status: "running", settledAt: null });
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const result = yield* delivery.deliver(deliveryInput());

      expect(result.status).toBe("pending");
      expect(world.comment.sentToSessionId).toBeNull();
      expect(world.launches).toBe(0);
    }).pipe(Effect.provide(testLayer(world)));
  });

  it.effect("renews a slow launch lease after a transient database defect", () => {
    const world = makeWorld("held");
    world.renewalDefectsRemaining = 1;
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const gate = yield* Deferred.make<void>();
      world.launchGate = gate;
      const first = yield* delivery.deliver(deliveryInput()).pipe(Effect.forkChild);
      while (world.launches === 0) yield* Effect.yieldNow;

      yield* TestClock.adjust("3 minutes");
      const retry = yield* delivery.deliver(deliveryInput());
      expect(retry.status).toBe("delivering");
      expect(world.launches).toBe(1);

      yield* Deferred.succeed(gate, undefined);
      const delivered = yield* Fiber.join(first);
      expect(delivered.status).toBe("delivered");
      expect(world.launches).toBe(1);
    }).pipe(Effect.provide(testLayer(world)));
  });

  it.live("recovers a stale pre-launch claim to a retryable failure before relaunch", () => {
    const world = makeWorld();
    seedFollowUp(world, new Date(0));
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const recovered = yield* delivery.deliver(deliveryInput());
      expect(recovered.status).toBe("delivery_failed");
      expect(world.launches).toBe(0);
      expect(world.comment.sentToSessionId).toBeNull();

      const retried = yield* delivery.deliver(deliveryInput());
      expect(retried.status).toBe("delivered");
      expect(world.launches).toBe(1);
      expect(world.comment.sentToSessionId).toBe(SESSION_ID);
    }).pipe(Effect.provide(testLayer(world)));
  });

  it.effect("reconciles accepted process membership after a final-write crash", () => {
    const world = makeWorld();
    const followUp = seedFollowUp(world, now());
    seedAcceptedProcess(world, followUp);
    return Effect.gen(function* () {
      const delivery = yield* FollowUpDelivery;
      const recovered = yield* delivery.deliver(deliveryInput());
      const replay = yield* delivery.deliver(deliveryInput());

      expect(recovered.status).toBe("delivered");
      expect(recovered.deliverySealantRunId).toBe("run-before-crash");
      expect(replay.id).toBe(recovered.id);
      expect(world.launches).toBe(0);
      expect(world.comment.sentToSessionId).toBe(SESSION_ID);
    }).pipe(Effect.provide(testLayer(world)));
  });
});
