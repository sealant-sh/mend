import { PgClient } from "@effect/sql-pg";
import { ChangeId, ProjectId, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ChangePassesRepo, ChangePassesRepoLive } from "../src/repos/change-passes.ts";

/**
 * A pass's `queued` row (the review page's "queued", not a spinner), against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip rather
 * than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_passes_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = ChangePassesRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, ChangePassesRepo | SqlClient.SqlClient>) =>
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

const PROJECT = ProjectId.make("p-passes");
const WORKTREE = WorktreeId.make("wt-passes");
const CHANGE = ChangeId.make("c-passes");

describe.skipIf(!reachable)("change passes, in Postgres", () => {
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
          VALUES (${PROJECT}, 'passes', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt', 'wt', 'mend/wt', 'abc')`;
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, branch, base_sha)
          VALUES (${CHANGE}, ${PROJECT}, ${WORKTREE}, 'mend/wt', 'abc')`;
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

  it("reads queued until a worker begins it, and never overwrites a pass in flight", async () => {
    await run(
      Effect.gen(function* () {
        const passes = yield* ChangePassesRepo;
        const statusOf = Effect.fn(function* (kind: "tour" | "suggest") {
          const rows = yield* passes.listForChange(CHANGE);
          return rows.find((row) => row.kind === kind)?.status ?? null;
        });

        yield* passes.queue(CHANGE, "tour");
        expect(yield* statusOf("tour")).toBe("queued");
        yield* passes.begin(CHANGE, "tour");
        // A second request while it runs keeps the running row.
        yield* passes.queue(CHANGE, "tour");
        expect(yield* statusOf("tour")).toBe("running");
        yield* passes.complete(CHANGE, "tour", null);
        expect(yield* statusOf("tour")).toBe("completed");
        // A finished pass asked for again reads queued, with its old outcome cleared.
        yield* passes.queue(CHANGE, "tour");
        const again = (yield* passes.listForChange(CHANGE)).find((row) => row.kind === "tour");
        expect([again?.status, again?.finishedAt, again?.detail]).toEqual(["queued", null, null]);

        yield* passes.queue(CHANGE, "suggest");
        yield* passes.begin(CHANGE, "suggest");
        yield* passes.fail(CHANGE, "suggest", "no connected account");
        yield* passes.queue(CHANGE, "suggest");
        expect(yield* statusOf("suggest")).toBe("queued");
      }),
    );
  });
});
