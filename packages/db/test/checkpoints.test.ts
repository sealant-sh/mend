import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  CheckpointOrdinalTakenError,
  CheckpointsRepo,
  CheckpointsRepoLive,
  type NewCheckpoint,
} from "../src/repos/checkpoints.ts";

/**
 * Runs against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database; skips when
 * nothing listens. MEND_TEST_DATABASE_URL points elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_checkpoints_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({
  url: Redacted.make(scratchUrl),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const reposLayer = CheckpointsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, CheckpointsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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

const PROJECT = ProjectId.make("proj-checkpoints");
let worktreeSeq = 0;
const freshWorktree = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  worktreeSeq += 1;
  const id = WorktreeId.make(`wt-${process.pid}-${worktreeSeq}`);
  yield* sql`
    INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
    VALUES (${id}, ${PROJECT}, ${id}, ${id}, ${`mend/wt/${id}`}, ${"a".repeat(40)})`;
  return id;
});

const sha = (c: string) => Sha.make(c.repeat(40));
const rowAt = (worktreeId: WorktreeId, ordinal: number, c: string): NewCheckpoint => ({
  worktreeId,
  sessionId: null,
  ordinal,
  ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
  sha: sha(c),
  sealantRunId: null,
  seq: 0n,
  trigger: "user-mark",
});

describe.skipIf(!reachable)("checkpoints repo", () => {
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
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES (${PROJECT}, 'checkpoints-fixture', NULL, '/store/checkpoints-fixture/repo.git', 'main')`;
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

  it("create: concurrent writers of one ordinal — exactly one row, the rest are answered with it, never a unique violation", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* CheckpointsRepo;
        const worktreeId = yield* freshWorktree;
        const outcomes = yield* Effect.forEach(
          ["b", "c", "d", "e", "f", "1", "2", "3"],
          (c) =>
            repo.create(rowAt(worktreeId, 0, c)).pipe(
              Effect.map((created) => ({ kind: "created" as const, id: created.id })),
              Effect.catchTag("CheckpointOrdinalTakenError", (error) =>
                Effect.succeed({ kind: "taken" as const, id: error.existing.id }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const at0 = yield* repo.byOrdinal(worktreeId, 0);
        const next = yield* repo.create(rowAt(worktreeId, 1, "9"));
        const chain = yield* repo.listForWorktree(worktreeId);
        return { outcomes, chain, at0, next };
      }),
    );
    const winners = seen.outcomes.filter((o) => o.kind === "created");
    expect(winners).toHaveLength(1);
    const winner = winners[0]?.id;
    expect(seen.outcomes.filter((o) => o.kind === "taken")).toHaveLength(7);
    expect(seen.outcomes.every((o) => o.id === winner)).toBe(true);
    expect(seen.chain.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(seen.at0?.id).toBe(winner);
    expect(seen.next.ordinal).toBe(1);
  });

  it("create: a taken ordinal is the typed conflict carrying the standing row", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const repo = yield* CheckpointsRepo;
        const worktreeId = yield* freshWorktree;
        const first = yield* repo.create(rowAt(worktreeId, 0, "b"));
        const second = yield* repo.create(rowAt(worktreeId, 0, "c")).pipe(Effect.flip);
        return { first, second };
      }),
    );
    expect(outcome.second).toBeInstanceOf(CheckpointOrdinalTakenError);
    expect(outcome.second.ordinal).toBe(0);
    expect(outcome.second.existing.id).toBe(outcome.first.id);
    expect(outcome.second.existing.sha).toBe(sha("b"));
  });
});
