import { createHash, randomUUID } from "node:crypto";

import type { PgClient } from "@effect/sql-pg";
import { AgentTurnId, OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  BoundaryObservation,
  HistoryOperationId,
  RollbackOperation,
  RollbackRecovery,
  type RollbackProgress,
  RollbackRefusedError,
  type HistoryPosition,
  type RollbackRequest,
  type HistoryBlob,
  type RollbackFailure,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { notifyEvent } from "../events.ts";

/** A generation belongs to one continuation, never to a turn or a lease timeout. */
export interface RollbackWorker {
  readonly operationId: HistoryOperationId;
  readonly token: string;
  readonly generation: number;
  readonly version: number;
}

/** Rollback receipts share the history repository, never the turn scheduler. */
export interface RollbackHistory {
  readonly rollback: (id: HistoryOperationId) => Effect.Effect<RollbackOperation | null>;
  readonly recovery: (id: HistoryOperationId) => Effect.Effect<RollbackRecovery | null>;
  readonly claimRollback: (input: {
    readonly operationId: HistoryOperationId;
    readonly token: string;
    readonly expectedVersion: number;
    readonly previousWorkerExited: boolean;
    readonly recovery?: { readonly actorId: string; readonly action: "finish" | "restoreSaved" };
  }) => Effect.Effect<RollbackOperation | null, RollbackRefusedError>;
  readonly checkRollbackWorker: (
    worker: RollbackWorker,
    actorId: string,
    files: boolean,
  ) => Effect.Effect<RollbackOperation, RollbackRefusedError>;
  readonly releaseRollback: (
    worker: RollbackWorker,
    actorId: string,
    reason: RollbackFailure,
    originalStateEvidence: HistoryBlob,
  ) => Effect.Effect<RollbackOperation, RollbackRefusedError>;
  readonly advanceRollback: (
    worker: RollbackWorker,
    progress: Exclude<RollbackProgress, { readonly kind: "complete" }>,
  ) => Effect.Effect<RollbackOperation | null>;
  readonly saveRecovery: (
    worker: RollbackWorker,
    recovery: RollbackRecovery,
  ) => Effect.Effect<boolean>;
  /** Only ProtocolHost calls this after proving candidate binding and file outcome. */
  readonly publishRollback: (
    worker: RollbackWorker,
  ) => Effect.Effect<RollbackOperation, RollbackRefusedError>;

  readonly admitRollback: (input: {
    readonly actorId: string;
    readonly commandId: string;
    readonly request: RollbackRequest;
  }) => Effect.Effect<RollbackOperation, RollbackRefusedError>;
  readonly historyPosition: (sessionId: SessionId) => Effect.Effect<HistoryPosition | null>;
}

const SessionAdmission = Schema.Struct({
  organizationId: OrganizationId,
  projectId: ProjectId,
  worktreeId: WorktreeId,
  historyRevision: Schema.Number,
  worktreeEpoch: Schema.Number,
  ownerId: Schema.NullOr(Schema.String),
  shared: Schema.Boolean,
  visible: Schema.Boolean,
  changeOwner: Schema.NullOr(Schema.String),
  changeOwnerProven: Schema.Boolean,
  fence: Schema.NullOr(Schema.String),
  harness: Schema.String,
  removing: Schema.Boolean,
  draining: Schema.Boolean,
});
const decodeOperation = Schema.decodeUnknownSync(RollbackOperation);
const encodeOperation = Schema.encodeSync(Schema.toCodecJson(RollbackOperation));
const refused = (code: RollbackRefusedError["code"], message: string) =>
  new RollbackRefusedError({ code, message });

const lockWorktree = (sql: PgClient.PgClient, worktreeId: WorktreeId) =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history-worktree:${worktreeId}`}))`;
    const sessions = yield* sql<{
      readonly id: string;
    }>`SELECT id FROM agent_sessions WHERE worktree_id=${worktreeId} ORDER BY id`;
    for (const session of sessions)
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${session.id}`}))`;
    const processes = yield* sql<{
      readonly id: string;
    }>`SELECT p.id FROM session_processes p JOIN agent_sessions s ON s.id=p.session_id WHERE s.worktree_id=${worktreeId} ORDER BY p.id`;
    for (const process of processes)
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-process:${process.id}`}))`;
  });
const readRollback = (sql: PgClient.PgClient, id: HistoryOperationId) =>
  sql<{
    readonly operation: unknown;
  }>`SELECT operation FROM session_history_operations WHERE id=${id} AND operation->'intent'->>'kind'='rollback'`.pipe(
    Effect.orDie,
    Effect.map((rows) => (rows[0] === undefined ? null : decodeOperation(rows[0].operation))),
  );
const heldRollback = (sql: PgClient.PgClient, worker: RollbackWorker) =>
  Effect.gen(function* () {
    const operation = yield* readRollback(sql, worker.operationId);
    if (operation === null) return null;
    yield* lockWorktree(sql, operation.intent.worktreeId);
    const [held] = yield* sql<{
      readonly operation: unknown;
    }>`SELECT o.operation FROM session_history_operations o JOIN worktrees w ON w.history_operation_id=o.id WHERE o.id=${worker.operationId} AND o.lease_token=${worker.token} AND (o.operation->>'generation')::bigint=${worker.generation} AND (o.operation->>'version')::bigint=${worker.version} FOR UPDATE OF o`;
    return held === undefined ? null : decodeOperation(held.operation);
  });

const authorizeWorker = (
  sql: PgClient.PgClient,
  operation: RollbackOperation,
  actorId: string,
  files: boolean,
) =>
  Effect.gen(function* () {
    const [authorized] = yield* sql`SELECT s.id FROM agent_sessions s
      JOIN projects p ON p.id=s.project_id JOIN worktrees w ON w.id=s.worktree_id
      JOIN organization_members m ON m.organization_id=p.organization_id AND m.user_id=${actorId}
      WHERE s.id=${operation.intent.sessionId} AND p.organization_id=${operation.organizationId}
      AND (p.visibility='shared' OR p.created_by_user_id=${actorId})
      AND (s.owner_user_id=${actorId} OR s.shared_control_enabled_at IS NOT NULL)
      AND (NOT ${files} OR (w.change_owner_user_id=${actorId} AND w.change_owner_proven))
      AND s.removal_requested_at IS NULL AND w.removal_id IS NULL FOR SHARE OF s,p,w,m`;
    if (authorized === undefined)
      return yield* refused(
        "actor_revoked",
        "Current session control or file authority is unavailable. The rollback remains fenced.",
      );
  });

/** Builds the rollback portion of SessionHistoryRepo over its existing transaction client. */
export const makeRollbackHistory = (sql: PgClient.PgClient): RollbackHistory => ({
  rollback: (id) => readRollback(sql, id),
  recovery: (id) =>
    sql<{
      readonly manifest: unknown;
    }>`SELECT manifest FROM session_history_recoveries WHERE operation_id=${id}`.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows[0] === undefined ? null : Schema.decodeUnknownSync(RollbackRecovery)(rows[0].manifest),
      ),
    ),
  claimRollback: (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* readRollback(sql, input.operationId);
          if (operation === null) return null;
          yield* lockWorktree(sql, operation.intent.worktreeId);
          const actor =
            input.recovery?.actorId ?? operation.recoveryAttempt?.actorId ?? operation.actorId;
          yield* authorizeWorker(
            sql,
            operation,
            actor,
            operation.intent.restoreFiles || input.recovery?.action === "restoreSaved",
          );
          const [held] = yield* sql<{
            readonly token: string | null;
          }>`SELECT lease_token AS token FROM session_history_operations WHERE id=${operation.id} FOR UPDATE`;
          if (
            held === undefined ||
            (held.token !== null && held.token !== input.token && !input.previousWorkerExited)
          )
            return null;
          const rows = yield* sql<{
            readonly operation: unknown;
          }>`UPDATE session_history_operations SET lease_token=${input.token}, lease_until=NULL,
      operation=jsonb_set(jsonb_set(jsonb_set(operation,'{generation}',to_jsonb((operation->>'generation')::bigint+1)),'{version}',to_jsonb((operation->>'version')::bigint+1)),'{updatedAt}',to_jsonb(now()))
      WHERE id=${operation.id} AND (operation->>'version')::bigint=${input.expectedVersion} AND operation->'progress'->>'kind' NOT IN ('complete','failed') RETURNING operation`;
          if (rows[0] === undefined) return null;
          const claimed = decodeOperation(rows[0].operation);
          if (input.recovery === undefined) return claimed;
          const next: RollbackOperation = {
            ...claimed,
            recoveryAttempt: {
              ...input.recovery,
              requestedAt: new Date(),
            },
          };
          yield* sql`UPDATE session_history_operations SET operation=${JSON.stringify(encodeOperation(next))}::jsonb WHERE id=${next.id}`;
          return next;
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  checkRollbackWorker: (worker, actorId, files) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* heldRollback(sql, worker);
          if (operation === null)
            return yield* refused(
              "authority_uncertain",
              "A different continuation owns this rollback.",
            );
          if (actorId !== (operation.recoveryAttempt?.actorId ?? operation.actorId))
            return yield* refused(
              "forbidden",
              "Only the admitted rollback actor can continue this operation.",
            );
          yield* authorizeWorker(sql, operation, actorId, files);
          return operation;
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  releaseRollback: (worker, actorId, reason, originalStateEvidence) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* heldRollback(sql, worker);
          if (operation === null)
            return yield* refused(
              "authority_uncertain",
              "A different continuation owns this rollback.",
            );
          if (actorId !== (operation.recoveryAttempt?.actorId ?? operation.actorId))
            return yield* refused(
              "forbidden",
              "Only the admitted recovery actor can release this operation.",
            );
          yield* authorizeWorker(
            sql,
            operation,
            actorId,
            operation.recoveryAttempt?.action === "restoreSaved",
          );
          if (operation.progress.kind !== "recoveryRequired")
            return yield* refused(
              "recovery_required",
              "Only a reconciled recovery can release the original history.",
            );
          const recoveryId = operation.progress.recoveryId;
          if (recoveryId === null)
            return yield* refused("save_incomplete", "The original retained save is unavailable.");
          const next: RollbackOperation = {
            ...operation,
            version: operation.version + 1,
            updatedAt: new Date(),
            progress: { kind: "failed", reason, recoveryId, originalStateEvidence },
          };
          yield* sql`UPDATE session_history_operations SET operation=${JSON.stringify(encodeOperation(next))}::jsonb,
      lease_token=NULL,lease_until=NULL WHERE id=${operation.id}`;
          yield* sql`UPDATE worktrees SET history_operation_id=NULL WHERE id=${operation.intent.worktreeId} AND history_operation_id=${operation.id}`;
          const peers = yield* sql<{
            readonly id: string;
          }>`SELECT id FROM agent_sessions WHERE worktree_id=${operation.intent.worktreeId}`;
          for (const peer of peers)
            yield* notifyEvent(sql, {
              type: "session",
              sessionId: peer.id,
              projectId: operation.intent.projectId,
            });
          return next;
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  advanceRollback: (worker, progress) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* heldRollback(sql, worker);
          if (operation === null) return null;
          const transitions: Readonly<
            Record<RollbackProgress["kind"], ReadonlyArray<RollbackProgress["kind"]>>
          > = {
            admitted: ["saving", "failed", "recoveryRequired"],
            saving: ["saved", "failed", "recoveryRequired"],
            saved: ["preparingNative", "nativeReady", "failed", "recoveryRequired"],
            preparingNative: ["nativeReady", "failed", "recoveryRequired"],
            nativeReady: ["restoringFiles", "readyToPublish", "failed", "recoveryRequired"],
            restoringFiles: ["readyToPublish", "recoveryRequired"],
            readyToPublish: ["recoveryRequired"],
            complete: [],
            failed: [],
            recoveryRequired: [
              "saving",
              "saved",
              "preparingNative",
              "nativeReady",
              "restoringFiles",
              "readyToPublish",
              "failed",
              "recoveryRequired",
            ],
          };
          if (!transitions[operation.progress.kind].includes(progress.kind)) return null;
          if ("recoveryId" in progress && progress.recoveryId !== null) {
            const [saved] =
              yield* sql`SELECT id FROM session_history_recoveries WHERE operation_id=${operation.id} AND id=${progress.recoveryId}`;
            if (saved === undefined) return null;
          }
          const next = {
            ...operation,
            progress,
            version: operation.version + 1,
            updatedAt: new Date(),
          };
          yield* sql`UPDATE session_history_operations SET operation=${JSON.stringify(encodeOperation(next))}::jsonb WHERE id=${operation.id}`;
          yield* notifyEvent(sql, {
            type: "session",
            sessionId: operation.intent.sessionId,
            projectId: operation.intent.projectId,
          });
          return next;
        }),
      )
      .pipe(Effect.orDie),
  saveRecovery: (worker, recovery) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* heldRollback(sql, worker);
          if (
            operation === null ||
            recovery.operationId !== operation.id ||
            recovery.worktreeId !== operation.intent.worktreeId ||
            recovery.generation > operation.generation
          )
            return false;
          const encoded = Schema.encodeSync(Schema.toCodecJson(RollbackRecovery))(recovery);
          yield* sql`INSERT INTO session_history_recoveries (id,operation_id,organization_id,worktree_id,manifest_digest,manifest) VALUES (${recovery.id},${operation.id},${operation.organizationId},${recovery.worktreeId},${recovery.manifestDigest},${JSON.stringify(encoded)}::jsonb) ON CONFLICT (operation_id) DO NOTHING`;
          const [saved] = yield* sql<{
            readonly digest: string;
          }>`SELECT manifest_digest AS digest FROM session_history_recoveries WHERE operation_id=${operation.id}`;
          return saved?.digest === recovery.manifestDigest;
        }),
      )
      .pipe(Effect.orDie),
  publishRollback: (worker) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const operation = yield* heldRollback(sql, worker);
          if (operation === null)
            return yield* refused(
              "stale_revision",
              "This rollback worker no longer owns publication.",
            );
          const progress = operation.progress;
          if (
            progress.kind !== "readyToPublish" ||
            progress.evidence.sha256 !== progress.evidenceDigest
          )
            return yield* refused(
              "recovery_required",
              "Native and file evidence are not ready for publication.",
            );
          const publishingActor = operation.recoveryAttempt?.actorId ?? operation.actorId;
          const [authorized] =
            yield* sql`SELECT s.id FROM agent_sessions s JOIN projects p ON p.id=s.project_id JOIN worktrees w ON w.id=s.worktree_id JOIN organization_members m ON m.organization_id=p.organization_id AND m.user_id=${publishingActor}
      WHERE s.id=${operation.intent.sessionId} AND p.organization_id=${operation.organizationId} AND (p.visibility='shared' OR p.created_by_user_id=${publishingActor}) AND (s.owner_user_id=${publishingActor} OR s.shared_control_enabled_at IS NOT NULL)
      AND (NOT ${operation.intent.restoreFiles} OR (w.change_owner_user_id=${publishingActor} AND w.change_owner_proven))
      AND s.history_revision=${operation.intent.from.historyRevision} AND w.history_epoch=${operation.intent.from.worktreeEpoch} AND w.history_operation_id=${operation.id} AND s.removal_requested_at IS NULL AND w.removal_id IS NULL FOR SHARE OF s,p,w,m`;
          if (authorized === undefined)
            return yield* refused(
              "actor_revoked",
              "Current access or file authority changed before publication. The recovery remains fenced.",
            );
          const [target] = yield* sql<{
            readonly ordinal: number | null;
          }>`SELECT t.ordinal FROM session_turn_boundaries b LEFT JOIN agent_turns t ON t.id=b.turn_id WHERE b.id=${operation.intent.targetBoundaryId} AND b.session_id=${operation.intent.sessionId} AND b.observation->>'kind'='ready' AND (b.turn_id IS NULL OR t.withdrawn_history_revision IS NULL)`;
          if (target === undefined)
            return yield* refused(
              "boundary_unavailable",
              "The exact active boundary is unavailable.",
            );
          const suffix = yield* sql<{
            readonly id: string;
            readonly status: string;
          }>`SELECT id,status FROM agent_turns WHERE session_id=${operation.intent.sessionId} AND ordinal>${target.ordinal ?? -1} AND withdrawn_history_revision IS NULL ORDER BY ordinal`;
          if (
            JSON.stringify(suffix.map((t) => t.id)) !==
              JSON.stringify(operation.intent.removedTurnIds) ||
            suffix.some((t) => t.status === "queued" || t.status === "running")
          )
            return yield* refused(
              "busy",
              "The admitted history suffix changed. Publication was refused.",
            );
          const [saved] =
            yield* sql`SELECT id FROM session_history_recoveries WHERE id=${progress.recoveryId} AND operation_id=${operation.id}`;
          if (saved === undefined)
            return yield* refused(
              "save_incomplete",
              "The independently retained original recovery is unavailable.",
            );
          yield* sql`INSERT INTO session_history_revisions (session_id,revision,organization_id,native_binding) SELECT id,history_revision,${operation.organizationId},jsonb_build_object('kind','legacyUnverified','providerSessionId',provider_session_id) FROM agent_sessions WHERE id=${operation.intent.sessionId} AND history_revision=0 ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO session_history_revisions (session_id,revision,organization_id,parent_revision,operation_id,target_boundary_id,native_binding) VALUES (${operation.intent.sessionId},${operation.intent.toRevision},${operation.organizationId},${operation.intent.from.historyRevision},${operation.id},${operation.intent.targetBoundaryId},${JSON.stringify(progress.candidate)}::jsonb)`;
          yield* sql`UPDATE agent_turns SET withdrawn_history_revision=${operation.intent.toRevision},withdrawn_by_operation_id=${operation.id} WHERE session_id=${operation.intent.sessionId} AND ordinal>${target.ordinal ?? -1} AND withdrawn_history_revision IS NULL`;
          yield* sql`UPDATE agent_sessions SET history_revision=${operation.intent.toRevision},provider_session_id=${progress.candidate.providerSessionId},updated_at=now() WHERE id=${operation.intent.sessionId}`;
          const epoch = operation.intent.from.worktreeEpoch + (progress.filesChanged ? 1 : 0);
          const publishedAt = new Date();
          const next: RollbackOperation = {
            ...operation,
            version: operation.version + 1,
            updatedAt: publishedAt,
            progress: {
              kind: "complete",
              result: {
                recoveryId: progress.recoveryId,
                targetBoundaryId: operation.intent.targetBoundaryId,
                position: { historyRevision: operation.intent.toRevision, worktreeEpoch: epoch },
                files: operation.intent.restoreFiles ? "restored" : "unchanged",
                native:
                  operation.intent.removedTurnIds.length === 0 ? "already_at_boundary" : "replaced",
                publishedAt,
              },
            },
          };
          yield* sql`UPDATE worktrees SET history_epoch=${epoch},history_operation_id=NULL WHERE id=${operation.intent.worktreeId} AND history_operation_id=${operation.id}`;
          yield* sql`UPDATE session_history_operations SET operation=${JSON.stringify(encodeOperation(next))}::jsonb,lease_token=NULL,lease_until=NULL WHERE id=${operation.id}`;
          const peers = yield* sql<{
            readonly id: string;
          }>`SELECT id FROM agent_sessions WHERE worktree_id=${operation.intent.worktreeId}`;
          for (const peer of peers)
            yield* notifyEvent(sql, {
              type: "session",
              sessionId: peer.id,
              projectId: operation.intent.projectId,
            });
          return next;
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  historyPosition: (sessionId) =>
    Effect.gen(function* () {
      const [row] =
        yield* sql`SELECT s.history_revision::float8 AS "historyRevision", w.history_epoch::float8 AS "worktreeEpoch" FROM agent_sessions s JOIN worktrees w ON w.id=s.worktree_id WHERE s.id=${sessionId}`.pipe(
          Effect.orDie,
        );
      return row === undefined
        ? null
        : Schema.decodeUnknownSync(
            Schema.Struct({ historyRevision: Schema.Number, worktreeEpoch: Schema.Number }),
          )(row);
    }),
  admitRollback: (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [location] = yield* sql<{
            readonly id: string;
          }>`SELECT worktree_id AS id FROM agent_sessions WHERE id=${input.request.sessionId}`;
          if (location === undefined)
            return yield* refused("forbidden", "This session is unavailable to this account.");
          yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history-worktree:${location.id}`}))`;
          const sessions = yield* sql<{
            readonly id: string;
          }>`SELECT id FROM agent_sessions WHERE worktree_id=${location.id} ORDER BY id`;
          for (const session of sessions)
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${session.id}`}))`;
          const processes = yield* sql<{
            readonly id: string;
          }>`SELECT p.id FROM session_processes p JOIN agent_sessions s ON s.id=p.session_id WHERE s.worktree_id=${location.id} ORDER BY p.id`;
          for (const process of processes)
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-process:${process.id}`}))`;
          const [raw] =
            yield* sql`SELECT p.organization_id AS "organizationId", p.id AS "projectId", w.id AS "worktreeId",
      s.history_revision::float8 AS "historyRevision", w.history_epoch::float8 AS "worktreeEpoch",
      s.owner_user_id AS "ownerId", (s.shared_control_enabled_at IS NOT NULL) AS shared,
      (p.visibility='shared' OR p.created_by_user_id=${input.actorId}) AS visible,
      w.change_owner_user_id AS "changeOwner", w.change_owner_proven AS "changeOwnerProven",
      w.history_operation_id AS fence, s.harness,
      (s.removal_requested_at IS NOT NULL OR w.removal_id IS NOT NULL) AS removing,
      EXISTS (SELECT 1 FROM agent_sessions peer WHERE peer.worktree_id=w.id AND (peer.capture_drain IS NOT NULL OR peer.removal_requested_at IS NOT NULL)) AS draining
      FROM agent_sessions s JOIN projects p ON p.id=s.project_id JOIN worktrees w ON w.id=s.worktree_id
      JOIN organization_members m ON m.organization_id=p.organization_id AND m.user_id=${input.actorId}
      WHERE s.id=${input.request.sessionId} FOR SHARE OF s,p,w,m`;
          if (raw === undefined)
            return yield* refused("forbidden", "This session is unavailable to this account.");
          const source = Schema.decodeUnknownSync(SessionAdmission)(raw);
          if (!source.visible || (source.ownerId !== input.actorId && !source.shared))
            return yield* refused(
              "forbidden",
              "Only this session's owner or someone with shared control may roll it back.",
            );
          if (source.removing)
            return yield* refused("busy", "This worktree or session is being removed.");
          const restoreFiles = input.request.restoreFiles ?? true;
          if (restoreFiles && (source.changeOwner !== input.actorId || !source.changeOwnerProven))
            return yield* refused(
              "forbidden",
              "Restoring files requires the change's proven owner. Conversation-only rollback does not restore files.",
            );
          const intentDigest = createHash("sha256")
            .update(
              JSON.stringify({
                kind: "rollback",
                sessionId: input.request.sessionId,
                at: {
                  checkpointId: input.request.at.checkpointId,
                  boundaryId: input.request.at.boundaryId,
                },
                restoreFiles,
              }),
            )
            .digest("hex");
          yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history:${source.organizationId}:${input.actorId}:${input.commandId}`}))`;
          const [prior] = yield* sql<{
            readonly operation: unknown;
            readonly digest: string;
            readonly kind: string;
          }>`SELECT operation, intent_digest AS digest, operation->'intent'->>'kind' AS kind FROM session_history_operations WHERE organization_id=${source.organizationId} AND actor_id=${input.actorId} AND command_id=${input.commandId}`;
          if (prior !== undefined) {
            if (prior.kind !== "rollback" || prior.digest !== intentDigest)
              return yield* refused(
                "command_conflict",
                "This history command was already used with different options.",
              );
            return decodeOperation(prior.operation);
          }
          if (source.fence !== null)
            return yield* refused(
              "busy",
              "A history operation is already in progress for this worktree.",
            );
          if (source.draining)
            return yield* refused("busy", "This session is waiting for its capture drain.");
          const [saved] = yield* sql<{
            readonly observation: unknown;
            readonly ordinal: number | null;
          }>`SELECT b.observation, t.ordinal FROM session_turn_boundaries b LEFT JOIN agent_turns t ON t.id=b.turn_id
      JOIN checkpoints c ON c.id=b.checkpoint_id AND c.worktree_id=${source.worktreeId}
      WHERE b.id=${input.request.at.boundaryId} AND b.session_id=${input.request.sessionId} AND b.checkpoint_id=${input.request.at.checkpointId}
      AND b.observation->>'kind'='ready' AND (b.turn_id IS NULL OR (t.session_id=b.session_id AND t.withdrawn_history_revision IS NULL))`;
          const observation =
            saved === undefined
              ? null
              : Schema.decodeUnknownSync(BoundaryObservation)(saved.observation);
          if (
            observation?.kind !== "ready" ||
            observation.boundary.selection.harness !== source.harness
          )
            return yield* refused(
              "boundary_unavailable",
              "This checkpoint has no exact retained active native boundary for this session.",
            );
          const [admission] =
            yield* sql`SELECT a.id FROM session_admissions a JOIN agent_sessions s ON s.id=a.session_id WHERE s.worktree_id=${source.worktreeId} LIMIT 1`;
          if (admission !== undefined)
            return yield* refused(
              "busy",
              "A launch or file operation was already admitted in this worktree. Wait for it to finish.",
            );
          const [queued] =
            yield* sql`SELECT t.id FROM agent_turns t JOIN agent_sessions s ON s.id=t.session_id WHERE s.worktree_id=${source.worktreeId} AND t.status IN ('queued','running') AND t.withdrawn_history_revision IS NULL LIMIT 1`;
          if (queued !== undefined)
            return yield* refused(
              "queued_work",
              "This worktree has an active or admitted queued turn. Finish or cancel it before rollback.",
            );
          const [steering] =
            yield* sql`SELECT st.id FROM agent_turn_steers st JOIN agent_turns t ON t.id=st.turn_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.worktree_id=${source.worktreeId} AND st.delivery->>'_tag' IN ('Sending','Queued') LIMIT 1`;
          if (steering !== undefined)
            return yield* refused("queued_work", "This worktree has an undecided or queued steer.");
          const [live] =
            yield* sql`SELECT p.id FROM session_processes p JOIN agent_sessions s ON s.id=p.session_id WHERE s.worktree_id=${source.worktreeId} AND p.exited_at IS NULL AND (s.id<>${input.request.sessionId} OR p.kind<>'agent-protocol') LIMIT 1`;
          if (live !== undefined)
            return yield* refused(
              "busy",
              "Another process in this worktree is live. Stop it through its normal controls before rollback.",
            );
          const [launch] =
            yield* sql`SELECT c.session_id FROM conversation_processes c JOIN agent_sessions s ON s.id=c.session_id LEFT JOIN session_processes p ON p.id=c.process_id WHERE s.worktree_id=${source.worktreeId} AND c.launch_id IS NOT NULL AND (c.process_id IS NULL OR (s.id<>${input.request.sessionId} AND p.exited_at IS NULL)) LIMIT 1`;
          if (launch !== undefined)
            return yield* refused("busy", "Another agent launch in this worktree is reserved.");
          const [tasks] =
            yield* sql`SELECT i.id FROM agent_items i JOIN agent_sessions s ON s.id=i.session_id WHERE s.worktree_id=${source.worktreeId} AND i.kind='task' AND i.status IN ('running','in-progress') LIMIT 1`;
          if (tasks !== undefined)
            return yield* refused(
              "busy",
              "This worktree has background agent activity. Wait for it to finish before rollback.",
            );
          if (
            source.historyRevision !== input.request.expected.historyRevision ||
            source.worktreeEpoch !== input.request.expected.worktreeEpoch
          )
            return yield* refused(
              "stale_revision",
              "History or files changed after this rollback was selected. Read the current history before trying again.",
            );
          const suffix = yield* sql<{
            readonly id: string;
          }>`SELECT id FROM agent_turns WHERE session_id=${input.request.sessionId} AND withdrawn_history_revision IS NULL AND ordinal>${saved?.ordinal ?? -1} ORDER BY ordinal`;
          const now = new Date();
          const operation: RollbackOperation = {
            id: HistoryOperationId.make(randomUUID()),
            organizationId: source.organizationId,
            actorId: input.actorId,
            commandId: input.commandId,
            intentDigest,
            request: { ...input.request, restoreFiles },
            intent: {
              kind: "rollback",
              sessionId: input.request.sessionId,
              projectId: source.projectId,
              worktreeId: source.worktreeId,
              targetBoundaryId: input.request.at.boundaryId,
              from: {
                historyRevision: source.historyRevision,
                worktreeEpoch: source.worktreeEpoch,
              },
              toRevision: source.historyRevision + 1,
              restoreFiles,
              removedTurnIds: suffix.map((row) => AgentTurnId.make(row.id)),
              candidateKey: randomUUID(),
            },
            progress: { kind: "admitted" },
            version: 0,
            generation: 0,
            createdAt: now,
            updatedAt: now,
          };
          yield* sql`INSERT INTO session_history_operations (id,organization_id,actor_id,command_id,intent_digest,operation) VALUES (${operation.id},${operation.organizationId},${operation.actorId},${operation.commandId},${operation.intentDigest},${JSON.stringify(encodeOperation(operation))}::jsonb)`;
          yield* sql`UPDATE worktrees SET history_operation_id=${operation.id} WHERE id=${source.worktreeId}`;
          yield* notifyEvent(sql, {
            type: "session",
            sessionId: input.request.sessionId,
            projectId: source.projectId,
          });
          return operation;
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
});
