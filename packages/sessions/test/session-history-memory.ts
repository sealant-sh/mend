import { SessionHistoryRepo, type NativeSeedFile, type RetainedFork } from "@mend/db";
import type { SessionId } from "@mend/domain";
import {
  SessionHistoryRefusedError,
  type BoundaryObservation,
  type ForkOperation,
  type HistoryOperationId,
  type NativeHistorySeed,
  type NativeSeedId,
  type TurnBoundaryId,
} from "@mend/domain/workbench";
import { Clock, Effect, Layer } from "effect";

/** A persistent test state can be provided to a second engine to exercise recovery. */
export const makeHistoryMemory = () => {
  const observations = new Map<string, BoundaryObservation>();
  const operations = new Map<HistoryOperationId, ForkOperation>();
  const forks = new Map<SessionId, RetainedFork>();
  const seeds = new Map<
    NativeSeedId,
    { readonly manifest: NativeHistorySeed; readonly files: ReadonlyArray<NativeSeedFile> }
  >();
  const leases = new Map<HistoryOperationId, { readonly token: string; readonly until: number }>();
  const boundary = (id: TurnBoundaryId) =>
    [...observations.values()].find((item) => item.kind === "ready" && item.boundary.id === id);
  const layer: Layer.Layer<SessionHistoryRepo> = Layer.effect(
    SessionHistoryRepo,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      return SessionHistoryRepo.of({
        read: () => Effect.succeed({ observations: [], fork: null }),
        rollback: () => Effect.succeed(null),
        recovery: () => Effect.succeed(null),
        claimRollback: () => Effect.die("Rollback requires actual PostgreSQL."),
        advanceRollback: () => Effect.die("Rollback requires actual PostgreSQL."),
        saveRecovery: () => Effect.die("Rollback requires actual PostgreSQL."),
        publishRollback: () => Effect.die("Rollback requires actual PostgreSQL."),
        admitRollback: () => Effect.die("Rollback admission tests require actual PostgreSQL."),
        historyPosition: () => Effect.succeed({ historyRevision: 0, worktreeEpoch: 0 }),
        saveSeed: (manifest, files) =>
          Effect.sync(() => {
            seeds.set(manifest.id, { manifest, files });
          }),
        seed: (id) => Effect.sync(() => seeds.get(id) ?? null),
        observe: (item) =>
          Effect.sync(() => {
            const key =
              item.kind === "ready"
                ? item.boundary.anchor.kind === "turn"
                  ? `${item.boundary.sessionId}:${item.boundary.anchor.turnId}`
                  : item.boundary.id
                : `${item.sessionId}:${item.turnId}`;
            if (!observations.has(key)) observations.set(key, item);
          }),
        boundary: (id) =>
          Effect.sync(() => {
            const item = boundary(id);
            return item?.kind === "ready" ? item.boundary : null;
          }),
        observations: (sessionId) =>
          Effect.sync(() =>
            [...observations.values()].filter(
              (item) =>
                (item.kind === "ready" ? item.boundary.sessionId : item.sessionId) === sessionId,
            ),
          ),
        selectBoundary: (sessionId, point) =>
          Effect.sync(
            () =>
              [...observations.values()]
                .flatMap((item) =>
                  item.kind === "ready" && item.boundary.sessionId === sessionId
                    ? [item.boundary]
                    : [],
                )
                .filter(
                  (item) =>
                    point.kind === "latestStable" ||
                    (point.kind === "checkpoint"
                      ? item.checkpointId === point.checkpointId
                      : item.anchor.kind === "turn" && item.anchor.turnId === point.turnId),
                )
                .toSorted((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ?? null,
          ),
        operation: (organizationId, actorId, commandId) =>
          Effect.sync(
            () =>
              [...operations.values()].find(
                (item) =>
                  item.organizationId === organizationId &&
                  item.actorId === actorId &&
                  item.commandId === commandId,
              ) ?? null,
          ),
        reserve: (requested, provenance, history) =>
          Effect.suspend(() => {
            const existing = [...operations.values()].find(
              (item) =>
                item.organizationId === requested.organizationId &&
                item.actorId === requested.actorId &&
                item.commandId === requested.commandId,
            );
            if (existing !== undefined)
              return existing.intentDigest === requested.intentDigest
                ? Effect.succeed(existing)
                : Effect.fail(
                    new SessionHistoryRefusedError({
                      reason: "command_conflict",
                      message: "This command has a different intent.",
                    }),
                  );
            operations.set(requested.id, requested);
            forks.set(provenance.childSessionId, { operation: requested, provenance, history });
            return Effect.succeed(requested);
          }),
        claim: (id, token) =>
          Effect.sync(() => {
            const progress = operations.get(id)?.progress;
            if (
              progress === undefined ||
              (progress.kind !== "preparing" && !(progress.kind === "failed" && progress.retryable))
            )
              return false;
            const held = leases.get(id);
            const now = clock.currentTimeMillisUnsafe();
            if (held !== undefined && held.token !== token && held.until > now) return false;
            leases.set(id, { token, until: now + 300_000 });
            return true;
          }),
        progress: (id, token, progress) =>
          Effect.sync(() => {
            const held = leases.get(id);
            const op = operations.get(id);
            if (
              op === undefined ||
              held?.token !== token ||
              held.until <= clock.currentTimeMillisUnsafe()
            )
              return false;
            const operation = {
              ...op,
              progress,
              updatedAt: new Date(clock.currentTimeMillisUnsafe()),
            };
            operations.set(id, operation);
            const retained = forks.get(op.intent.childSessionId);
            if (retained !== undefined)
              forks.set(op.intent.childSessionId, { ...retained, operation });
            return true;
          }),
        release: (id, token) =>
          Effect.sync(() => {
            if (leases.get(id)?.token === token) leases.delete(id);
          }),
        bindNative: (id, providerSessionId) =>
          Effect.sync(() => {
            const fork = forks.get(id);
            if (
              fork === undefined ||
              (fork.operation.progress.kind !== "awaitingNative" &&
                !(
                  fork.operation.progress.kind === "complete" &&
                  fork.operation.progress.providerSessionId === providerSessionId
                ))
            )
              return false;
            const operation: ForkOperation = {
              ...fork.operation,
              progress: { kind: "complete", providerSessionId },
            };
            operations.set(operation.id, operation);
            forks.set(id, { ...fork, operation });
            return true;
          }),
        fork: (id) => Effect.sync(() => forks.get(id) ?? null),
        forkBoundaryForWorktree: (id) =>
          Effect.sync(() => {
            const op = [...operations.values()].find((item) => item.intent.childWorktreeId === id);
            const item = op === undefined ? null : boundary(op.intent.sourceBoundaryId);
            return item?.kind === "ready" ? item.boundary : null;
          }),
      });
    }),
  );
  return { layer, observations, operations, forks, seeds };
};
