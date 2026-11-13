import { PgClient } from "@effect/sql-pg";
import type { AgentItemId, SessionId } from "@mend/domain";
import {
  McpAppModelContext,
  McpAppRef,
  McpAppSnapshot,
  type McpAppDocument,
  type McpAppTarget,
} from "@mend/domain/workbench";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { mcpAppModelContexts, mcpAppSnapshots } from "../schema/mcp-apps.ts";
import { agentItems, agentSessions, agentTurns } from "../schema/workbench.ts";
import { notifyAgentConversation } from "./agent-conversation.ts";

/** Storage failure without exposing HTML, app context or credentials. */
export class McpAppStorageError extends Schema.TaggedError<McpAppStorageError>()(
  "McpAppStorageError",
  { cause: Schema.Defect() },
) {}

/** Durable documents and replaceable next-turn context; no live MCP connection is stored. */
export class McpAppsRepo extends Context.Service<
  McpAppsRepo,
  {
    readonly save: (
      itemId: AgentItemId,
      target: McpAppTarget,
      document: McpAppDocument,
    ) => Effect.Effect<void, McpAppStorageError>;
    readonly byItem: (
      itemId: AgentItemId,
    ) => Effect.Effect<McpAppSnapshot | null, McpAppStorageError>;
    readonly listForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<McpAppRef>, McpAppStorageError>;
    readonly setContext: (
      sessionId: SessionId,
      itemId: AgentItemId,
      text: string,
    ) => Effect.Effect<void, McpAppStorageError>;
    readonly contextForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<McpAppModelContext>, McpAppStorageError>;
  }
>()("@mend/db/McpAppsRepo") {}

const storageFailed = (cause: unknown) => new McpAppStorageError({ cause });

const parseSnapshot = (row: {
  readonly snapshot: typeof mcpAppSnapshots.$inferSelect;
  readonly sessionId: SessionId;
  readonly processId: typeof agentItems.$inferSelect.processId;
}) =>
  Schema.decodeUnknownEffect(McpAppSnapshot)({
    ...row.snapshot,
    ...row.snapshot.metadata,
    sessionId: row.sessionId,
    processId: row.processId,
  });

const make: Effect.Effect<McpAppsRepo["Service"], never, MendDB | PgClient.PgClient> = Effect.gen(
  function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;
    const columns = {
      snapshot: mcpAppSnapshots,
      sessionId: agentItems.sessionId,
      processId: agentItems.processId,
    };
    const byItem = Effect.fn("McpAppsRepo.byItem")(function* (itemId: AgentItemId) {
      const [row] = yield* db
        .select(columns)
        .from(mcpAppSnapshots)
        .innerJoin(agentItems, eq(agentItems.id, mcpAppSnapshots.itemId))
        .where(eq(mcpAppSnapshots.itemId, itemId))
        .limit(1)
        .pipe(Effect.mapError(storageFailed));
      return row === undefined
        ? null
        : yield* parseSnapshot(row).pipe(Effect.mapError(storageFailed));
    });
    const save = Effect.fn("McpAppsRepo.save")(function* (
      itemId: AgentItemId,
      target: McpAppTarget,
      document: McpAppDocument,
    ) {
      const { html, ...metadata } = document;
      const written = yield* db
        .insert(mcpAppSnapshots)
        .values({ itemId, ...target, html, metadata })
        .onConflictDoNothing()
        .returning({ itemId: mcpAppSnapshots.itemId })
        .pipe(Effect.mapError(storageFailed));
      if (written.length === 0) return;
      const [item] = yield* db
        .select({ sessionId: agentItems.sessionId, projectId: agentSessions.projectId })
        .from(agentItems)
        .innerJoin(agentSessions, eq(agentSessions.id, agentItems.sessionId))
        .where(eq(agentItems.id, itemId))
        .limit(1)
        .pipe(Effect.mapError(storageFailed));
      if (item !== undefined) yield* notifyAgentConversation(db, pg, item.sessionId);
    });
    const listForSession = Effect.fn("McpAppsRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      // HTML stays out of the conversation's small reference list.
      const rows = yield* db
        .select({
          itemId: mcpAppSnapshots.itemId,
          sessionId: agentItems.sessionId,
          processId: agentItems.processId,
          server: mcpAppSnapshots.server,
          tool: mcpAppSnapshots.tool,
          resourceUri: mcpAppSnapshots.resourceUri,
          metadata: mcpAppSnapshots.metadata,
          capturedAt: mcpAppSnapshots.capturedAt,
        })
        .from(mcpAppSnapshots)
        .innerJoin(agentItems, eq(agentItems.id, mcpAppSnapshots.itemId))
        .where(eq(agentItems.sessionId, sessionId))
        .orderBy(asc(agentItems.seq))
        .pipe(Effect.mapError(storageFailed));
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(McpAppRef)({ ...row, ...row.metadata }),
      ).pipe(Effect.mapError(storageFailed));
    });
    const setContext = Effect.fn("McpAppsRepo.setContext")(function* (
      sessionId: SessionId,
      itemId: AgentItemId,
      text: string,
    ) {
      if (text.trim() === "") {
        yield* db
          .delete(mcpAppModelContexts)
          .where(
            and(
              eq(mcpAppModelContexts.sessionId, sessionId),
              eq(mcpAppModelContexts.itemId, itemId),
            ),
          )
          .pipe(Effect.mapError(storageFailed));
        return;
      }
      const updatedAt = yield* DateTime.nowAsDate;
      yield* db
        .insert(mcpAppModelContexts)
        .values({ sessionId, itemId, text, updatedAt })
        .onConflictDoUpdate({
          target: [mcpAppModelContexts.sessionId, mcpAppModelContexts.itemId],
          set: { text, updatedAt },
        })
        .pipe(Effect.mapError(storageFailed));
    });
    const contextForSession = Effect.fn("McpAppsRepo.contextForSession")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select({
          itemId: mcpAppSnapshots.itemId,
          server: mcpAppSnapshots.server,
          tool: mcpAppSnapshots.tool,
          text: mcpAppModelContexts.text,
        })
        .from(mcpAppModelContexts)
        .innerJoin(mcpAppSnapshots, eq(mcpAppSnapshots.itemId, mcpAppModelContexts.itemId))
        .innerJoin(agentItems, eq(agentItems.id, mcpAppSnapshots.itemId))
        .innerJoin(agentTurns, eq(agentTurns.id, agentItems.turnId))
        .where(
          and(
            eq(mcpAppModelContexts.sessionId, sessionId),
            isNull(agentTurns.withdrawnHistoryRevision),
          ),
        )
        .orderBy(asc(mcpAppModelContexts.updatedAt), asc(mcpAppModelContexts.itemId))
        .pipe(Effect.mapError(storageFailed));
      return yield* Schema.decodeUnknownEffect(Schema.Array(McpAppModelContext))(rows).pipe(
        Effect.mapError(storageFailed),
      );
    });
    return McpAppsRepo.of({ save, byItem, listForSession, setContext, contextForSession });
  },
);

/** PostgreSQL implementation over the caller's pool. */
export const McpAppsRepoLive: Layer.Layer<McpAppsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(McpAppsRepo, make);
