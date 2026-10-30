import { PgClient } from "@effect/sql-pg";
import { migrations, RemovalFencesRepo, RemovalFencesRepoLive } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import type { Project, Session, Worktree } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";

export const postgres = postgresTestConfig();

const pgLayer = (url: string) => PgClient.layer({ url: Redacted.make(url), maxConnections: 6 });

/**
 * Removal marks as migration 0164 keeps them, in a scratch database holding a row for each of the
 * world's projects, worktrees and sessions: what a mark's age decides, which sessions work in a
 * worktree and which starts are admitted, decided by Postgres. `fences` passes to
 * `createTenancyApi` as `implement.removalFences`; `sql` runs statements against the rows.
 */
export const removalDatabase = async (world: {
  readonly projects: ReadonlyMap<string, Project>;
  readonly worktrees: ReadonlyMap<string, Worktree>;
  readonly sessions: ReadonlyMap<string, Session>;
}) => {
  const name = `mend_removal_api_${process.pid}_${Date.now()}`;
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${name}`;
  const admin = (statement: string) =>
    Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
        Effect.provide(pgLayer(postgres.adminUrl)),
        Effect.scoped,
        Effect.asVoid,
      ),
    );
  await admin(`CREATE DATABASE ${name}`);
  const runtime = ManagedRuntime.make(
    RemovalFencesRepoLive.pipe(Layer.provideMerge(pgLayer(url.toString()))),
  );
  const drop = async () => {
    await runtime.dispose();
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  };
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        for (const organizationId of new Set(
          [...world.projects.values()].map((project) => project.organizationId),
        )) {
          yield* sql`INSERT INTO organizations (id, name) VALUES (${organizationId}, ${organizationId})`;
        }
        for (const project of world.projects.values()) {
          yield* sql`
            INSERT INTO projects (id, name, store_path, default_branch, organization_id)
            VALUES (${project.id}, ${project.name}, ${project.storePath}, 'main',
                    ${project.organizationId})`;
        }
        for (const worktree of world.worktrees.values()) {
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${worktree.id}, ${worktree.projectId}, ${worktree.name}, ${worktree.id},
                    ${worktree.branch}, ${worktree.baseSha})`;
        }
        for (const session of world.sessions.values()) {
          yield* sql`
            INSERT INTO agent_sessions
              (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id,
               status)
            VALUES (${session.id}, ${session.projectId}, ${session.worktreeId}, ${session.harness},
                    ${session.worktree}, ${session.branch}, ${session.baseSha},
                    ${session.ownerUserId}, ${session.status})`;
        }
      }),
    );
  } catch (error) {
    await drop();
    throw error;
  }
  const fences = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* RemovalFencesRepo;
    }),
  );
  const sql = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, statement));
  return { fences, sql, drop };
};
