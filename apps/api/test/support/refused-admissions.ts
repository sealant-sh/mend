import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { AgentConversationRepo, AgentConversationRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import type { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";

/** The database's error for every insert of a turn or a steer. */
export const ADMISSION_REFUSED = "admission refused by the test";

/**
 * A throwaway database in which Postgres refuses every insert of a turn or a steer. It holds
 * Alice's running session, its agent process and one running turn, under the ids given.
 */
export const refusedAdmissions = (seed: {
  readonly session: SessionId;
  readonly process: SessionProcessId;
  readonly turn: AgentTurnId;
}) => {
  const postgres = postgresTestConfig();
  const database = `mend_admission_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${database}`;
  const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
  const runtime = ManagedRuntime.make(
    AgentConversationRepoLive.pipe(
      Layer.provideMerge(
        MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) }))),
      ),
    ),
  );
  let created = false;

  const onAdmin = (statement: string) =>
    Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );

  const open = async (): Promise<AgentConversationRepo["Service"]> => {
    await onAdmin(`CREATE DATABASE ${database}`);
    created = true;
    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES ('alice','alice','alice@example.invalid',now())`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
          VALUES ('admission-project','admission','/store/admission/repo.git','main',(SELECT id FROM organizations LIMIT 1),'alice')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
          VALUES ('admission-worktree','admission-project','admission','admission','admission',${"a".repeat(40)})`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
          VALUES (${seed.session},'admission-project','admission-worktree','alice','codex','admission','admission',${"a".repeat(40)},'running')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
          VALUES (${seed.process},${seed.session},'admission-workspace','agent-protocol','codex','running')`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,author,input,status)
          VALUES (${seed.turn},${seed.session},${seed.process},0,'alice','Continue','running')`;
        yield* sql.unsafe(
          `CREATE FUNCTION refuse_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${ADMISSION_REFUSED}'; END $$`,
        );
        yield* sql`CREATE TRIGGER refuse_turn BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION refuse_admission()`;
        yield* sql`CREATE TRIGGER refuse_steer BEFORE INSERT ON agent_turn_steers FOR EACH ROW EXECUTE FUNCTION refuse_admission()`;
        return yield* AgentConversationRepo;
      }),
    );
  };

  const close = async () => {
    await runtime.dispose();
    if (created) await onAdmin(`DROP DATABASE ${database} WITH (FORCE)`);
  };

  return { skip: postgres.skip, open, close };
};
