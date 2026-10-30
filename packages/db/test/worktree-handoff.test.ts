import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import {
  HandoffBranch,
  HandoffCutAt,
  HandoffMachine,
  HexSha,
  type WorktreeHandoff,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { uniqueViolationConstraint } from "../src/repos/unique-violation.ts";
import { WorktreesRepo, WorktreesRepoLive } from "../src/repos/worktrees.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
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
  worktreeTree: HexSha.make("e".repeat(40)),
  indexTree: HexSha.make("f".repeat(40)),
  ownerUserId: "user-dana",
  deltaPack: "captures/handoff-a/0/packs/" + "e".repeat(64),
  commitsAhead: 2,
  previous: null,
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

describe.skipIf(postgres.skip)("worktrees.handoff in Postgres", () => {
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

  it("refuses a second worktree for the same snapshot or name in the same project, naming the key a handoff replay reads, and allows it in another", async () => {
    const refusedKey = (id: string, name: string, handoff: WorktreeHandoff | null) =>
      run(
        Effect.gen(function* () {
          const repo = yield* WorktreesRepo;
          return yield* repo.create({ ...row(id, PROJECT_A, handoff), name }).pipe(
            Effect.as("created"),
            Effect.catchDefect((defect) => Effect.succeed(uniqueViolationConstraint(defect))),
          );
        }),
      );
    expect(await refusedKey("fix-login-2", "fix-login-2", provenance)).toBe(
      "worktrees_project_handoff_checkpoint_key",
    );
    expect(await refusedKey("fix-login-3", "fix-login", null)).toBe("worktrees_project_name_key");
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

  it("names the delta pack of every handoff row, and none for a base worktree", async () => {
    const packs = await run(Effect.flatMap(WorktreesRepo, (repo) => repo.handoffPacks()));
    expect(packs).toEqual([provenance.deltaPack, provenance.deltaPack]);
  });
});
