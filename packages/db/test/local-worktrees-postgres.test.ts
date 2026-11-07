import { PgClient } from "@effect/sql-pg";
import { ProjectId } from "@mend/domain";
import { Effect, Layer, Redacted, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  ProjectLocalWorktreesRepo,
  ProjectLocalWorktreesRepoLive,
} from "../src/repos/project-local-worktrees.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_local_worktrees_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratch = PgClient.layer({
  url: Redacted.make(url.toString()),
  transformResultNames: Str.snakeToCamel,
});
const repository = ProjectLocalWorktreesRepoLive.pipe(Layer.provideMerge(scratch));
const run = <A, E>(effect: Effect.Effect<A, E, ProjectLocalWorktreesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repository), Effect.scoped));

describe.skipIf(postgres.skip)("project Local allocation in PostgreSQL", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );
    await run(
      Effect.gen(function* () {
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* (yield* SqlClient.SqlClient)`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
        VALUES ('local-project', 'local-project', '/store/local/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
      }),
    );
  });
  afterAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      ).pipe(Effect.provide(admin), Effect.scoped),
    );
  });
  it("reserves one identity across callers before checkout creation and retains it across service rebuilds", async () => {
    const project = ProjectId.make("local-project");
    expect(
      await run(Effect.flatMap(ProjectLocalWorktreesRepo, (repo) => repo.find(project))),
    ).toBeNull();
    const allocated = await run(
      Effect.gen(function* () {
        const repo = yield* ProjectLocalWorktreesRepo;
        return yield* Effect.all(
          Array.from({ length: 8 }, () => repo.reserve(project)),
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(new Set(allocated).size).toBe(1);
    expect(await run(Effect.flatMap(ProjectLocalWorktreesRepo, (repo) => repo.find(project)))).toBe(
      allocated[0],
    );
    await run(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient)`DELETE FROM projects WHERE id = ${project}`;
        expect(yield* (yield* ProjectLocalWorktreesRepo).find(project)).toBeNull();
      }),
    );
  });
});
