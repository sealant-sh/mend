import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { HotWorkspacesRepo, HotWorkspacesRepoLive } from "../src/repos/hot-workspaces.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_hot_workspaces_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = HotWorkspacesRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) }))),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, HotWorkspacesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
const PROJECT = ProjectId.make("project-hot");

const standby = (id: string) =>
  Effect.gen(function* () {
    const pool = yield* HotWorkspacesRepo;
    return yield* pool.create({
      id: SessionId.make(id),
      projectId: PROJECT,
      worktreeId: null,
      ownerUserId: "alice",
      fingerprint: "fingerprint",
      harnessLayout: "shared",
      worktree: null,
      branch: null,
      baseSha: null,
    });
  });

describe.skipIf(postgres.skip)("the hot-session pool (SLNT-803)", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'hot', '/store/p-hot/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("retires an unclaimed standby so no claim takes it, and never a claimed one", async () => {
    const answers = await run(
      Effect.gen(function* () {
        const pool = yield* HotWorkspacesRepo;
        const sql = yield* SqlClient.SqlClient;
        const ready = yield* standby("standby-ready");
        const other = yield* standby("standby-claimed");
        yield* sql`UPDATE hot_workspaces SET status = 'ready'`;
        const retired = yield* pool.retire(ready.id, "draining · ending");
        // Only the other one is left to claim.
        const claimed = yield* pool.claim(PROJECT, "fingerprint", "alice");
        const retiredClaimed = yield* pool.retire(other.id, "draining · ending");
        const gone = yield* pool.retire(SessionId.make("standby-gone"), "draining · ending");
        return {
          retired,
          row: yield* pool.byId(ready.id),
          claimed: claimed?.id,
          retiredClaimed,
          claimedRow: (yield* pool.byId(other.id))?.status,
          gone,
        };
      }),
    );
    expect(answers.retired).toBe(true);
    expect(answers.row).toMatchObject({ status: "failed", error: "draining · ending" });
    expect(answers.claimed).toBe("standby-claimed");
    expect(answers.retiredClaimed).toBe(false);
    expect(answers.claimedRow).toBe("claimed");
    expect(answers.gone).toBe(false);
  });
});
