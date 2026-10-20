import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import {
  HandoffBranch,
  HandoffCutAt,
  HandoffMachine,
  HexSha,
  type WorktreeHandoff,
} from "@mend/domain/workbench";
import { Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { WorktreesRepo, WorktreesRepoLive } from "../src/repos/worktrees.ts";

const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_worktree_handoff_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = WorktreesRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, WorktreesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const PROJECT_A = ProjectId.make("handoff-project-a");
const PROJECT_B = ProjectId.make("handoff-project-b");
const W = HexSha.make("a".repeat(40));
const provenance: WorktreeHandoff = {
  machine: HandoffMachine.make("dana-mbp"),
  localBranch: HandoffBranch.make("fix/login"),
  cutAt: HandoffCutAt.make("2026-10-18T07:42:05.000Z"),
  head: HexSha.make("b".repeat(40)),
  index: HexSha.make("c".repeat(40)),
  checkpoint: W,
  mergeBase: HexSha.make("d".repeat(40)),
  deltaPack: "projects/handoff-project-a/packs/" + "e".repeat(64),
};

const row = (id: string, projectId: ProjectId, handoff: WorktreeHandoff | null) => ({
  id: WorktreeId.make(id),
  projectId,
  name: id,
  directory: id,
  branch: `mend/${id}`,
  baseSha: Sha.make("d".repeat(40)),
  baseRef: "main",
  handoff,
});

describe.skipIf(!reachable)("worktrees.handoff in Postgres", () => {
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
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT_A}, 'a', '/store/a/repo.git', 'main', (SELECT id FROM organizations LIMIT 1)),
                 (${PROJECT_B}, 'b', '/store/b/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
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

  it("writes the provenance with the row, reads it back decoded, and finds the worktree by its snapshot", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* WorktreesRepo;
        const created = yield* repo.create(row("fix-login", PROJECT_A, provenance));
        const byId = yield* repo.byId(created.id);
        const found = yield* repo.byHandoffCheckpoint(PROJECT_A, Sha.make(W));
        const elsewhere = yield* repo.byHandoffCheckpoint(PROJECT_B, Sha.make(W));
        const other = yield* repo.byHandoffCheckpoint(PROJECT_A, Sha.make("f".repeat(40)));
        return { created, byId, found, elsewhere, other };
      }),
    );
    expect(seen.created.handoff).toEqual(provenance);
    expect(seen.byId.handoff).toEqual(provenance);
    expect(seen.found?.id).toBe("fix-login");
    expect(seen.elsewhere).toBeNull();
    expect(seen.other).toBeNull();
  });

  it("refuses a second worktree for the same snapshot in the same project, and allows it in another", async () => {
    const duplicate = await run(
      Effect.gen(function* () {
        const repo = yield* WorktreesRepo;
        return yield* repo.create(row("fix-login-2", PROJECT_A, provenance)).pipe(Effect.exit);
      }),
    );
    expect(Exit.isFailure(duplicate)).toBe(true);
    const elsewhere = await run(
      Effect.gen(function* () {
        const repo = yield* WorktreesRepo;
        return yield* repo.create(row("fix-login-b", PROJECT_B, provenance));
      }),
    );
    expect(elsewhere.handoff?.checkpoint).toBe(W);
  });

  it("lets any number of base worktrees share a null handoff", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const repo = yield* WorktreesRepo;
        const one = yield* repo.create(row("base-one", PROJECT_A, null));
        const two = yield* repo.create(row("base-two", PROJECT_A, null));
        return [one, two];
      }),
    );
    expect(rows.map((worktree) => worktree.handoff)).toEqual([null, null]);
  });
});
