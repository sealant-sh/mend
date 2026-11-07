import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Migration 0221: MCP app snapshots and the model context an app sets for its session. */
export const mcpAppsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_app_snapshots (
    item_id text PRIMARY KEY REFERENCES agent_items(id) ON DELETE CASCADE,
    server text NOT NULL,
    tool text NOT NULL,
    resource_uri text NOT NULL CHECK (resource_uri LIKE 'ui://%'),
    html text NOT NULL CHECK (octet_length(html) <= 5242880),
    metadata jsonb NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now()
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_app_model_contexts (
    session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    item_id text NOT NULL REFERENCES mcp_app_snapshots(item_id) ON DELETE CASCADE,
    text text NOT NULL CHECK (octet_length(text) <= 16384),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, item_id)
  )`;
});
