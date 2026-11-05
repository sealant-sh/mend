import type { SessionId, WorktreeId } from "@mend/domain";
import { HistoryAdmissionRefusedError } from "@mend/domain/workbench";
import { Effect } from "effect";
import * as Context from "effect/Context";
import type { SqlClient } from "effect/sql";

/** Internal authority of the one durable rollback continuation, never accepted from HTTP. */
export interface HistoryWorkerIdentity {
  readonly operationId: string;
  readonly token: string;
  readonly generation: number;
}
export const HistoryWorkerContext = Context.Reference<HistoryWorkerIdentity | null>(
  "@mend/db/HistoryWorkerContext",
  { defaultValue: () => null },
);

/** Capture authority and process admission take the same worktree lock before their own locks. */
export const worktreeHistoryBlocked = (sql: SqlClient.SqlClient, worktreeId: WorktreeId) =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history-worktree:${worktreeId}`}))`;
    const worker = yield* HistoryWorkerContext;
    const [blocked] =
      worker === null
        ? yield* sql`SELECT id FROM worktrees WHERE id=${worktreeId} AND history_operation_id IS NOT NULL`
        : yield* sql`SELECT id FROM worktrees w WHERE id=${worktreeId} AND history_operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM session_history_operations o WHERE o.id=w.history_operation_id AND o.id=${worker.operationId} AND o.lease_token=${worker.token} AND (o.operation->>'generation')::bigint=${worker.generation})`;
    return blocked !== undefined;
  });

/** Acquire before a conversation/process lock. A rollback candidate can use only its own fence. */
export const checkHistoryFence = (sql: SqlClient.SqlClient, sessionId: SessionId) =>
  Effect.gen(function* () {
    const [session] = yield* sql<{
      readonly worktreeId: WorktreeId;
    }>`SELECT worktree_id AS "worktreeId" FROM agent_sessions WHERE id=${sessionId}`;
    if (session !== undefined && (yield* worktreeHistoryBlocked(sql, session.worktreeId)))
      return yield* new HistoryAdmissionRefusedError({
        reason: "history_operation_in_progress",
        sessionId,
        message:
          "A rollback holds this worktree. Your work was not admitted. Wait for it to complete or recover it.",
      });
  });
