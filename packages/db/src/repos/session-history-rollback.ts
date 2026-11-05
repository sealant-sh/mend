import { createHash, randomUUID } from "node:crypto";

import type { PgClient } from "@effect/sql-pg";
import { AgentTurnId, OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  BoundaryObservation,
  HistoryOperationId,
  RollbackOperation,
  RollbackRefusedError,
  type HistoryPosition,
  type RollbackRequest,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { notifyEvent } from "../events.ts";

/** Rollback receipts share the history repository, never the turn scheduler. */
export interface RollbackHistory {
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

/** Builds the rollback portion of SessionHistoryRepo over its existing transaction client. */
export const makeRollbackHistory = (sql: PgClient.PgClient): RollbackHistory => ({
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
      WHERE s.id=${input.request.sessionId}`;
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
