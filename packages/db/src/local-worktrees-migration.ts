import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Stable Local allocation survives a failed creation, rename, or explicit worktree removal. */
export const projectLocalWorktreesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_local_worktrees (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id text NOT NULL UNIQUE
    )`;
  yield* sql`CREATE TRIGGER project_local_worktrees_project_retention
    BEFORE INSERT OR UPDATE OR DELETE ON project_local_worktrees
    FOR EACH ROW EXECUTE FUNCTION project_retention_admit_content()`;
  // No worktree FK: the allocation must commit before git creation, and survives its failure.
  // Deleting the project cascades it; explicitly starting Local again can recreate a removed one.
});
