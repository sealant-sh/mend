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
  // App content belongs to its originating item or displayed session, without a second project id.
  // Preserve the ordinary content fence's cascade and purge behavior for these indirect owners.
  yield* sql.unsafe(`CREATE OR REPLACE FUNCTION project_retention_admit_content() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE r jsonb; pid text; removed boolean; purging boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
      IF pg_trigger_depth() <= 1 THEN
        pid := CASE TG_ARGV[0]
          WHEN 'change' THEN (SELECT project_id FROM worktree_changes WHERE id = r->>'change_id')
          WHEN 'session' THEN (SELECT project_id FROM agent_sessions WHERE id = r->>'session_id')
          WHEN 'item' THEN (SELECT s.project_id FROM agent_items i
            JOIN agent_sessions s ON s.id = i.session_id WHERE i.id = r->>'item_id')
          ELSE r->>'project_id' END;
        SELECT removed_at IS NOT NULL, removal_phase = 'deleting' INTO removed, purging
          FROM projects WHERE id = pid FOR SHARE;
        IF removed AND NOT (TG_OP = 'DELETE' AND purging) THEN
          RAISE EXCEPTION 'project % is unavailable; restore a removed project before changing it', pid
            USING ERRCODE = 'MRFRM';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  yield* sql`DROP TRIGGER IF EXISTS mcp_app_snapshots_project_retention ON mcp_app_snapshots`;
  yield* sql`CREATE TRIGGER mcp_app_snapshots_project_retention
    BEFORE INSERT OR UPDATE OR DELETE ON mcp_app_snapshots
    FOR EACH ROW EXECUTE FUNCTION project_retention_admit_content('item')`;
  yield* sql`DROP TRIGGER IF EXISTS mcp_app_model_contexts_project_retention ON mcp_app_model_contexts`;
  yield* sql`CREATE TRIGGER mcp_app_model_contexts_project_retention
    BEFORE INSERT OR UPDATE OR DELETE ON mcp_app_model_contexts
    FOR EACH ROW EXECUTE FUNCTION project_retention_admit_content('session')`;
});
