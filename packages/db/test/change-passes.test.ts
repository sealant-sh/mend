import { PgClient } from "@effect/sql-pg";
import { ChangeId, ProjectId, WorktreeId } from "@mend/domain";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ChangePassesRepo, ChangePassesRepoLive } from "../src/repos/change-passes.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
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

const PROJECT = ProjectId.make("p-passes");
const WORKTREE = WorktreeId.make("wt-passes");
const CHANGE = ChangeId.make("c-passes");

describe.skipIf(postgres.skip)("change passes, in Postgres", () => {
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

  it("ignores pass writes after the change has been deleted", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const passes = yield* ChangePassesRepo;
        const deleted = ChangeId.make("deleted-change");
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
        VALUES ('deleted-worktree', ${PROJECT}, 'deleted', 'deleted', 'mend/deleted', 'abc')`;
        yield* sql`INSERT INTO worktree_changes (id, project_id, worktree_id, branch, base_sha)
        VALUES (${deleted}, ${PROJECT}, 'deleted-worktree', 'mend/deleted', 'abc')`;
        yield* passes.queue(deleted, "tour");
        yield* passes.begin(deleted, "tour");
        yield* sql`DELETE FROM worktree_changes WHERE id = ${deleted}`;
        yield* passes.complete(deleted, "tour", null);
        yield* passes.fail(deleted, "tour", "already gone");
        yield* passes.queue(deleted, "tour");
        yield* passes.begin(deleted, "tour");
        yield* passes.recordPrep(deleted, "tour", "digest");
        expect(yield* passes.listForChange(deleted)).toEqual([]);
        expect(yield* passes.preparedDigest(deleted, "tour")).toBeNull();
      }),
    );
  });

  it.effect("expires abandoned running passes at the deadline and persists the failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const passes = yield* ChangePassesRepo;
      const start = yield* DateTime.nowAsDate;
      // Rows left by an older process; this test's clock owns their age.
      yield* sql`DELETE FROM change_passes WHERE change_id = ${CHANGE}`;
      for (const kind of ["tour", "read", "suggest"]) {
        yield* sql`INSERT INTO change_passes (change_id, kind, status, started_at, findings)
          VALUES (${CHANGE}, ${kind}, 'running', ${start}, NULL)`;
      }
      yield* TestClock.adjust("4 minutes");
      expect((yield* passes.listForChange(CHANGE)).map((pass) => pass.status)).toEqual([
        "running",
        "running",
        "running",
      ]);
      yield* TestClock.adjust("1 minute");
      const expired = yield* passes.listForChange(CHANGE);
      expect(expired).toHaveLength(3);
      for (const pass of expired)
        expect(pass).toMatchObject({
          status: "failed",
          detail: "The review pass timed out after 5 minutes. Ask for it again.",
          startedAt: start,
          finishedAt: new Date(5 * 60 * 1000),
          findings: null,
        });
      const stored =
        yield* sql`SELECT status, finished_at FROM change_passes WHERE change_id = ${CHANGE}`;
      expect(stored.every((row) => row["status"] === "failed" && row["finished_at"] !== null)).toBe(
        true,
      );
      // A retry gets a fresh running row; another read must not fail it using the old start.
      yield* passes.begin(CHANGE, "tour");
      expect(
        (yield* passes.listForChange(CHANGE)).find((pass) => pass.kind === "tour")?.status,
      ).toBe("running");
    }).pipe(Effect.provide(repoLayer)),
  );

  it.effect("leaves queued, completed, and failed outcomes intact regardless of age", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const passes = yield* ChangePassesRepo;
      const start = yield* DateTime.nowAsDate;
      yield* sql`DELETE FROM change_passes WHERE change_id = ${CHANGE}`;
      for (const [kind, status] of [
        ["tour", "queued"],
        ["read", "completed"],
        ["suggest", "failed"],
      ]) {
        yield* sql`INSERT INTO change_passes (change_id, kind, status, started_at, detail)
          VALUES (${CHANGE}, ${kind}, ${status}, ${start}, 'keep this outcome')`;
      }
      yield* TestClock.adjust("30 days");
      expect(
        (yield* passes.listForChange(CHANGE)).map((pass) => [pass.kind, pass.status, pass.detail]),
      ).toEqual([
        ["read", "completed", "keep this outcome"],
        ["suggest", "failed", "keep this outcome"],
        ["tour", "queued", "keep this outcome"],
      ]);
    }).pipe(Effect.provide(repoLayer)),
  );
});
