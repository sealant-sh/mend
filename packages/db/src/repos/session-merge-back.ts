import { randomUUID } from "node:crypto";

import type { PgClient } from "@effect/sql-pg";
import { AgentTurnId, SessionId } from "@mend/domain";
import {
  MergeBackContext,
  MergeBackId,
  MergeBackRequest,
  MergeBackTransfer,
  SessionHistoryRefusedError,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { notifyEvent } from "../events.ts";

/** Context transfers own no process, login, native file or Git operation. */
export interface MergeBackHistory {
  readonly mergeBack: (
    input: MergeBackRequest & { readonly actorId: string; readonly commandId: string },
  ) => Effect.Effect<MergeBackTransfer, SessionHistoryRefusedError>;
  readonly mergeBackTransfers: (
    parent: SessionId,
  ) => Effect.Effect<ReadonlyArray<MergeBackTransfer>>;
}

const refused = (reason: SessionHistoryRefusedError["reason"], message: string) =>
  new SessionHistoryRefusedError({ reason, message });

const Row = Schema.Struct({
  context: MergeBackContext,
  request: MergeBackRequest,
  actorId: Schema.String,
  commandId: Schema.String,
  status: Schema.Literals(["pending", "consumed", "superseded"]),
  targetTurnId: Schema.NullOr(AgentTurnId),
  consumedAt: Schema.NullOr(Schema.Date),
});
const receipt = (raw: unknown): MergeBackTransfer => {
  const row = Schema.decodeUnknownSync(Row)(raw);
  return Schema.decodeUnknownSync(MergeBackTransfer)({
    ...row.context,
    at: row.request.at,
    commandId: row.commandId,
    requestedBy: row.actorId,
    state:
      row.status === "consumed"
        ? { kind: "consumed", turnId: row.targetTurnId, consumedAt: row.consumedAt }
        : { kind: row.status },
  });
};
const compact = (text: string): string => {
  const value = text.replace(/\s+/gu, " ").trim();
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
};

/** The merge-back part of SessionHistoryRepo shares its transaction client and history locks. */
export const makeMergeBackHistory = (sql: PgClient.PgClient): MergeBackHistory => ({
  mergeBackTransfers: (parent) =>
    sql`SELECT context,request,actor_id AS "actorId",command_id AS "commandId",status,
      target_turn_id AS "targetTurnId",consumed_at AS "consumedAt"
      FROM session_merge_backs WHERE target_session_id=${parent} ORDER BY context->>'createdAt',id`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(receipt)),
    ),
  mergeBack: (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const request = Schema.decodeUnknownSync(MergeBackRequest)({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            at: input.at,
          });
          // All two-session writers take shared-worktree locks first, in the same stable order.
          const worktrees = yield* sql<{
            readonly id: string;
          }>`SELECT DISTINCT worktree_id AS id FROM agent_sessions
      WHERE id IN (${request.sourceSessionId},${request.targetSessionId}) ORDER BY id`;
          for (const { id } of worktrees)
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history-worktree:${id}`}))`;
          for (const id of [request.sourceSessionId, request.targetSessionId].toSorted())
            yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${id}`}))`;
          yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:merge-back:${input.actorId}:${input.commandId}`}))`;
          const [access] = yield* sql<{
            readonly organizationId: string;
            readonly projectId: string;
            readonly sourceRevision: number;
            readonly sourceFence: string | null;
            readonly targetFence: string | null;
          }>`SELECT p.organization_id AS "organizationId",p.id AS "projectId",
      child.history_revision::int AS "sourceRevision",cw.history_operation_id AS "sourceFence",pw.history_operation_id AS "targetFence"
      FROM agent_sessions child JOIN agent_sessions parent ON parent.id=${request.targetSessionId} AND parent.project_id=child.project_id
      JOIN projects p ON p.id=child.project_id
      JOIN worktrees cw ON cw.id=child.worktree_id JOIN worktrees pw ON pw.id=parent.worktree_id
      JOIN organization_members m ON m.organization_id=p.organization_id AND m.user_id=${input.actorId}
      WHERE child.id=${request.sourceSessionId} AND p.removed_at IS NULL
      AND (p.visibility='shared' OR p.created_by_user_id=${input.actorId})
      AND parent.owner_user_id IS NOT NULL AND (parent.owner_user_id=${input.actorId} OR parent.shared_control_enabled_at IS NOT NULL)
      AND child.removal_requested_at IS NULL AND parent.removal_requested_at IS NULL
      AND cw.removal_id IS NULL AND pw.removal_id IS NULL FOR SHARE OF child,parent,p,cw,pw,m`;
          if (access === undefined)
            return yield* refused(
              "forbidden",
              "The fork must be visible and you must control its parent before merging back.",
            );
          const [existing] =
            yield* sql`SELECT context,request,actor_id AS "actorId",command_id AS "commandId",status,
      target_turn_id AS "targetTurnId",consumed_at AS "consumedAt" FROM session_merge_backs
      WHERE organization_id=${access.organizationId} AND actor_id=${input.actorId} AND command_id=${input.commandId}`;
          if (existing !== undefined) {
            const saved = receipt(existing);
            if (
              JSON.stringify(Schema.encodeSync(MergeBackRequest)(request)) !==
              JSON.stringify(
                Schema.encodeSync(MergeBackRequest)({
                  sourceSessionId: saved.sourceSessionId,
                  targetSessionId: saved.targetSessionId,
                  at: saved.at,
                }),
              )
            )
              return yield* refused(
                "command_conflict",
                "This merge-back command already names another selection or parent.",
              );
            return saved;
          }
          if (access.sourceFence !== null || access.targetFence !== null)
            return yield* refused(
              "preparing",
              "A history operation is in progress. Try merging back after it finishes.",
            );
          const [fork] =
            yield* sql`SELECT child_session_id FROM session_forks WHERE child_session_id=${request.sourceSessionId}
      AND provenance->>'sourceSessionId'=${request.targetSessionId}`;
          if (fork === undefined)
            return yield* refused(
              "forbidden",
              "Merge back is available only from a fork to its direct parent.",
            );
          const selected = yield* sql<{
            readonly id: string;
            readonly ordinal: number;
          }>`SELECT t.id,t.ordinal FROM agent_turns t
      WHERE t.session_id=${request.sourceSessionId} AND t.withdrawn_history_revision IS NULL AND ((t.status='completed' AND t.ended_at IS NOT NULL) OR (t.status='running' AND EXISTS (SELECT 1 FROM agent_requests r WHERE r.turn_id=t.id AND r.status='pending')))
      AND (${request.at.kind === "latestStable"} OR t.id=${request.at.kind === "turn" ? request.at.turnId : ""}
        OR EXISTS (SELECT 1 FROM session_turn_boundaries b WHERE b.session_id=t.session_id AND b.turn_id=t.id
          AND b.observation->'boundary'->>'checkpointId'=${request.at.kind === "checkpoint" ? request.at.checkpointId : ""}))
      ORDER BY t.ordinal DESC LIMIT 1`;
          const cutoff = selected[0];
          if (cutoff === undefined)
            return yield* refused(
              "boundary_unavailable",
              "Choose a completed response or one waiting for input in this fork's current conversation before merging back.",
            );
          const delta = yield* sql<{ readonly label: string; readonly text: string | null }>`
      SELECT label,text FROM (
        SELECT t.ordinal,0::bigint AS seq,0 AS part,'User' AS label,t.input AS text
          FROM agent_turns t WHERE t.session_id=${request.sourceSessionId} AND t.ordinal<=${cutoff.ordinal} AND t.withdrawn_history_revision IS NULL
        UNION ALL
        SELECT t.ordinal,i.seq::bigint,1,CASE i.kind WHEN 'assistant-message' THEN 'Assistant' WHEN 'command-execution' THEN 'Command' ELSE 'Activity' END,
          CASE WHEN i.kind='assistant-message' THEN coalesce(i.text,i.title) ELSE coalesce(i.title,i.text) END FROM agent_items i JOIN agent_turns t ON t.id=i.turn_id
          WHERE t.session_id=${request.sourceSessionId} AND t.ordinal<=${cutoff.ordinal} AND t.withdrawn_history_revision IS NULL
          AND i.kind IN ('assistant-message','command-execution','file-change')
        UNION ALL
        SELECT t.ordinal,st.ordinal::bigint,2,'User steer',st.input FROM agent_turn_steers st JOIN agent_turns t ON t.id=st.turn_id
          WHERE t.session_id=${request.sourceSessionId} AND t.ordinal<=${cutoff.ordinal} AND t.withdrawn_history_revision IS NULL AND st.delivery->>'_tag'='Accepted'
        UNION ALL
        SELECT t.ordinal,0::bigint,3,'Waiting for input',coalesce(r.title,r.questions::text) FROM agent_requests r JOIN agent_turns t ON t.id=r.turn_id
          WHERE t.session_id=${request.sourceSessionId} AND t.ordinal<=${cutoff.ordinal} AND t.withdrawn_history_revision IS NULL AND r.status='pending'
        UNION ALL
        SELECT t.ordinal,position,0,'Handoff',context->>'summary' FROM agent_turns t CROSS JOIN LATERAL jsonb_array_elements(t.merge_back) WITH ORDINALITY AS contexts(context,position)
          WHERE t.session_id=${request.sourceSessionId} AND t.ordinal<=${cutoff.ordinal} AND t.withdrawn_history_revision IS NULL
      ) lines ORDER BY ordinal,part,seq`;
          const header = "Merge-back context from forked conversation.\nFork delta:\n";
          const lines = delta.flatMap((row) =>
            row.text === null ? [] : [`- ${row.label}: ${compact(row.text)}`],
          );
          let summary = header;
          for (const [index, line] of lines.entries()) {
            if (summary.length + line.length > 31_800) {
              summary += `\n[${lines.length - index} further items omitted. Read the source conversation for the full details.]`;
              break;
            }
            summary += `${line}\n`;
          }
          const context = Schema.decodeUnknownSync(MergeBackContext)({
            id: MergeBackId.make(randomUUID()),
            sourceSessionId: request.sourceSessionId,
            targetSessionId: request.targetSessionId,
            sourceTurnId: cutoff.id,
            sourceOrdinal: cutoff.ordinal,
            sourceRevision: access.sourceRevision,
            summary,
            createdAt: new Date(),
          });
          // Refuse excess context before changing any existing transfer; never silently drop a sibling.
          const [budget] = yield* sql<{
            readonly size: number;
          }>`SELECT coalesce(sum(length(context->>'summary')),0)::int AS size FROM session_merge_backs
      WHERE target_session_id=${request.targetSessionId} AND source_session_id<>${request.sourceSessionId} AND status='pending'`;
          if ((budget?.size ?? 0) + context.summary.length > 32_000)
            return yield* refused(
              "preparing",
              "This parent already has pending fork context. Send its next message before merging more context back.",
            );
          yield* sql`UPDATE session_merge_backs SET status='superseded' WHERE target_session_id=${request.targetSessionId} AND source_session_id=${request.sourceSessionId} AND status='pending'`;
          const [stored] =
            yield* sql`INSERT INTO session_merge_backs (id,organization_id,actor_id,command_id,source_session_id,target_session_id,request,context)
      VALUES (${context.id},${access.organizationId},${input.actorId},${input.commandId},${request.sourceSessionId},${request.targetSessionId},
        ${JSON.stringify(request)}::jsonb,${JSON.stringify(Schema.encodeSync(Schema.toCodecJson(MergeBackContext))(context))}::jsonb)
      RETURNING context,request,actor_id AS "actorId",command_id AS "commandId",status,target_turn_id AS "targetTurnId",consumed_at AS "consumedAt"`;
          yield* notifyEvent(sql, {
            type: "session",
            sessionId: request.targetSessionId,
            projectId: access.projectId,
          });
          return receipt(stored);
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
});
