import type { AgentItemId, SessionId } from "@mend/domain";
import { McpAppDocument } from "@mend/domain/workbench";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { agentItems, agentSessions } from "./workbench.ts";

/** A provider document is retained with the tool item that produced it. */
export const mcpAppSnapshots = pgTable("mcp_app_snapshots", {
  itemId: text("item_id")
    .$type<AgentItemId>()
    .primaryKey()
    .references(() => agentItems.id, { onDelete: "cascade" }),
  server: text().notNull(),
  tool: text().notNull(),
  resourceUri: text("resource_uri").notNull(),
  html: text().notNull(),
  metadata: jsonb().$type<Omit<typeof McpAppDocument.Encoded, "html">>().notNull(),
  capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});

/** Each app has one replaceable context entry per conversation. */
export const mcpAppModelContexts = pgTable(
  "mcp_app_model_contexts",
  {
    sessionId: text("session_id")
      .$type<SessionId>()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .$type<AgentItemId>()
      .notNull()
      .references(() => mcpAppSnapshots.itemId, { onDelete: "cascade" }),
    text: text().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.itemId] })],
);
