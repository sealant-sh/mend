import { PgClient } from "@effect/sql-pg";
import { WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  HarnessLayoutsRepo,
  HarnessLayoutsRepoLive,
  linuxLoginNameOf,
} from "../src/repos/harness-layouts.ts";

/**
 * docs/adr/0016-per-person-harness-homes.md, decisions 1 and 14, against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip rather
 * than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_harness_layouts_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = HarnessLayoutsRepoLive.pipe(Layer.provideMerge(scratchLayer));

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, HarnessLayoutsRepo | SqlClient.SqlClient>) =>
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

const worktree = WorktreeId.make("wt-1");

describe("Linux login names", () => {
  it("are m and 8 base32 characters, stable per account and attempt", () => {
    const name = linuxLoginNameOf("Q94IcJexample");
    expect(name).toMatch(/^m[a-z2-7]{8}$/);
    expect(linuxLoginNameOf("Q94IcJexample")).toBe(name);
    expect(linuxLoginNameOf("Q94IcJexample", 1)).not.toBe(name);
    expect(linuxLoginNameOf("Q94IcJexample", 1)).toMatch(/^m[a-z2-7]{8}$/);
    expect(linuxLoginNameOf("another")).not.toBe(name);
  });
});

describe.skipIf(!reachable)("per-person harness homes, in Postgres", () => {
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
          VALUES ('p-1', 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${worktree}, 'p-1', 'auth', 'auth', 'mend/auth', 'abc')`;
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

  // Runs first: nothing recorded yet. What startup reads once to know it may read no more.
  it("says no layout is recorded on a fresh store, and an operator's request counts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HarnessLayoutsRepo;
        const fresh = yield* repo.anyRecorded();
        yield* repo.requestLayout(worktree, "shared");
        const requested = yield* repo.anyRecorded();
        yield* sql`UPDATE worktrees SET harness_layout_requested = NULL WHERE id = ${worktree}`;
        return { fresh, requested, cleared: yield* repo.anyRecorded() };
      }),
    );
    expect(result).toEqual({ fresh: false, requested: true, cleared: false });
  });

  it("gives each account one stable identity, uids from 40001, even when they ask at once", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        const accounts = Array.from({ length: 12 }, (_, index) => `account-${index}`);
        const first = yield* Effect.forEach(accounts, (id) => repo.ensureIdentity(id), {
          concurrency: "unbounded",
        });
        const uids = first.map((identity) => identity.uid).toSorted((a, b) => a - b);
        expect(uids).toEqual(Array.from({ length: 12 }, (_, index) => 40_001 + index));
        expect(new Set(first.map((identity) => identity.name)).size).toBe(12);
        for (const identity of first) {
          expect(identity.name).toBe(linuxLoginNameOf(identity.accountId));
        }
        // Asked again, from anywhere: the same name and uid.
        const again = yield* repo.ensureIdentity("account-3");
        expect(again).toEqual(first[3]);
        const listed = yield* repo.identitiesOf(["account-3", "account-0", "nobody"]);
        expect(listed.map((identity) => identity.accountId)).toEqual(["account-0", "account-3"]);
      }),
    );
  });

  it("moves on to the next name when another account holds the first", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HarnessLayoutsRepo;
        yield* sql`
          INSERT INTO linux_identities (user_id, name, uid)
          VALUES ('squatter', ${linuxLoginNameOf("late")}, 49000)`;
        const late = yield* repo.ensureIdentity("late");
        expect(late.name).toBe(linuxLoginNameOf("late", 1));
        expect(late.uid).toBe(49_001);
      }),
    );
  });

  it("makes a worktree person with its first confirmed person launch, and never clears it", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        expect(yield* repo.worktreeLayout(worktree)).toEqual({ layout: null, requested: null });
        // A predicted person launch is not the worktree's layout until prepare confirms it.
        yield* repo.recordLaunch({
          launchId: "launch-1",
          worktreeId: worktree,
          sessionId: "s-1",
          layout: "person",
          source: "flag",
          reason: null,
          imageKey: "img",
          confirmed: false,
        });
        expect((yield* repo.worktreeLayout(worktree)).layout).toBeNull();
        // Prepare found otherwise: the launch falls back, the worktree stays without a layout.
        yield* repo.recordFallback("launch-1", "no sudo");
        expect(yield* repo.launchLayout("launch-1")).toMatchObject({
          layout: "shared",
          source: "fallback",
          reason: "no sudo",
          confirmed: true,
        });
        expect((yield* repo.worktreeLayout(worktree)).layout).toBeNull();
        // The next one is confirmed: the worktree is person from now on.
        yield* repo.recordLaunch({
          launchId: "launch-2",
          worktreeId: worktree,
          sessionId: "s-1",
          layout: "person",
          source: "flag",
          reason: null,
          imageKey: "img",
          confirmed: false,
        });
        yield* repo.confirmPerson("launch-2", worktree);
        expect((yield* repo.worktreeLayout(worktree)).layout).toBe("person");
        // A later shared record (nothing should make one, but nothing may undo the worktree).
        yield* repo.recordLaunch({
          launchId: "launch-3",
          worktreeId: worktree,
          sessionId: "s-2",
          layout: "shared",
          source: "flag",
          reason: null,
          imageKey: null,
          confirmed: true,
        });
        yield* repo.recordFallback("launch-2", "late");
        expect((yield* repo.worktreeLayout(worktree)).layout).toBe("person");
        expect((yield* repo.launchLayout("launch-2"))?.layout).toBe("person");
      }),
    );
  });

  it("keeps the operator's request and what prepare found per image and runtime", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        yield* repo.requestLayout(worktree, "shared");
        expect((yield* repo.worktreeLayout(worktree)).requested).toBe("shared");
        expect(yield* repo.capabilityOf("img", "docker")).toBeNull();
        yield* repo.recordCapability({
          imageKey: "img",
          runtime: "docker",
          person: false,
          missing: ["sudo", "uid 40001 is taken"],
        });
        expect(yield* repo.capabilityOf("img", "docker")).toMatchObject({
          person: false,
          missing: ["sudo", "uid 40001 is taken"],
        });
        yield* repo.recordCapability({
          imageKey: "img",
          runtime: "docker",
          person: true,
          missing: [],
        });
        expect(yield* repo.capabilityOf("img", "docker")).toMatchObject({
          person: true,
          missing: [],
        });
        expect(yield* repo.capabilityOf("img", "microvm")).toBeNull();
      }),
    );
  });

  // Runs last: the person launches above are recorded.
  it("says a layout is recorded once a person launch is", async () => {
    expect(await run(Effect.flatMap(HarnessLayoutsRepo, (repo) => repo.anyRecorded()))).toBe(true);
  });
});
