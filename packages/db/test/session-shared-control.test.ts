import { PgClient } from "@effect/sql-pg";
import { OrganizationId, SessionId } from "@mend/domain";
import { canSteerSession } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDB, MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import {
  endSharedControlOfMember,
  SessionSharedControlRepo,
  SessionSharedControlRepoLive,
} from "../src/repos/session-shared-control.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_session_shared_control_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const repoLayer = Layer.mergeAll(SessionSharedControlRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(MendDBLive),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) })),
);

type Services =
  | SessionSharedControlRepo
  | SessionsRepo
  | MendDB
  | SqlClient.SqlClient
  | PgClient.PgClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

let next = 0;
/** A fresh running session owned by Grace, so each test starts from nobody asking. */
const freshSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = SessionId.make(`sess-${(next += 1)}`);
  yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
    VALUES (${id},'proj-1','wt-1','grace','claude','fixture','mend/fixture',${"a".repeat(40)},'running')`;
  return id;
});

const reasonOf = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      typeof error === "object" && error !== null && "reason" in error ? error.reason : error,
    ),
  );

describe.skipIf(postgres.skip)("shared control for one person, in Postgres", () => {
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
        for (const user of ["grace", "ada", "linus"])
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
            VALUES (${user}, ${user}, ${`${user}@example.invalid`}, '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
          VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'grace')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
          VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
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

  it("a granted ask lets that one person steer; taking it back ends it", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        const id = yield* freshSession;

        yield* control.ask(id, "ada");
        yield* control.ask(id, "ada");
        expect((yield* control.people(id)).map((person) => [person.userId, person.state])).toEqual([
          ["ada", "asked"],
        ]);
        expect(canSteerSession(yield* sessions.byId(id), "ada")).toBe(false);

        yield* control.grant(id, "ada", "grace");
        const granted = yield* sessions.byId(id);
        expect(granted.sharedControlUserIds).toEqual(["ada"]);
        expect(granted.sharedControlEnabledAt).toBeNull();
        expect(granted.sharedControlEverAt).not.toBeNull();
        expect(canSteerSession(granted, "ada")).toBe(true);
        expect(canSteerSession(granted, "linus")).toBe(false);
        expect(yield* control.people(id)).toMatchObject([
          { userId: "ada", state: "granted", grantedByUserId: "grace" },
        ]);

        yield* control.takeBack(id, "ada");
        expect((yield* sessions.byId(id)).sharedControlUserIds).toEqual([]);
        expect(yield* control.people(id)).toEqual([]);
        expect(yield* reasonOf(control.takeBack(id, "ada"))).toBe("not-granted");
      }),
    );
  });

  it("a grant after the ask was withdrawn or declined is refused, not granted", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        const id = yield* freshSession;

        yield* control.ask(id, "ada");
        yield* control.withdraw(id, "ada");
        expect(yield* reasonOf(control.grant(id, "ada", "grace"))).toBe("not-asked");

        yield* control.ask(id, "ada");
        yield* control.decline(id, "ada");
        expect(yield* reasonOf(control.grant(id, "ada", "grace"))).toBe("not-asked");
        expect((yield* sessions.byId(id)).sharedControlUserIds).toEqual([]);
      }),
    );
  });

  it("racing a grant against a withdrawal leaves the row and the mirror agreeing", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        for (let round = 0; round < 10; round += 1) {
          const id = yield* freshSession;
          yield* control.ask(id, "ada");
          yield* Effect.all(
            [
              control.grant(id, "ada", "grace").pipe(Effect.result),
              control.withdraw(id, "ada").pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          );
          const people = yield* control.people(id);
          const mirror = (yield* sessions.byId(id)).sharedControlUserIds;
          expect(mirror).toEqual(
            people.filter((person) => person.state === "granted").map((person) => person.userId),
          );
        }
      }),
    );
  });

  it("the owner cannot ask, nor anyone who steers already, nor anyone once it settles", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        const id = yield* freshSession;
        expect(yield* reasonOf(control.ask(id, "grace"))).toBe("owner");

        yield* sessions.setSharedControl(id, "grace");
        expect(yield* reasonOf(control.ask(id, "ada"))).toBe("steers");
        yield* sessions.setSharedControl(id, null);

        yield* control.ask(id, "linus");
        yield* sessions.settle(id, "completed", null);
        expect(yield* control.people(id)).toEqual([]);
        expect(yield* reasonOf(control.ask(id, "ada"))).toBe("ended");
      }),
    );
  });

  it("the switch for everyone turned off ends every grant, and leaves open asks", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        const id = yield* freshSession;
        yield* control.ask(id, "ada");
        yield* control.grant(id, "ada", "grace");
        yield* control.ask(id, "linus");

        const off = yield* sessions.setSharedControl(id, null);
        expect(off.sharedControlUserIds).toEqual([]);
        expect(canSteerSession(off, "ada")).toBe(false);
        expect((yield* control.people(id)).map((person) => [person.userId, person.state])).toEqual([
          ["linus", "asked"],
        ]);
      }),
    );
  });

  it("the owner's inbox reads open asks on their own live sessions only", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const id = yield* freshSession;
        const other = yield* freshSession;
        yield* control.ask(id, "ada");
        yield* control.ask(id, "linus");
        yield* control.ask(other, "ada");
        yield* control.grant(other, "ada", "grace");

        const asks = yield* control.asksOnOwnSessions("grace", [id, other]);
        expect(asks.get(id)?.map((person) => person.userId)).toEqual(["ada", "linus"]);
        expect(asks.has(other)).toBe(false);
        expect((yield* control.asksOnOwnSessions("ada", [id])).size).toBe(0);
      }),
    );
  });

  it("a member leaving ends their asks and grants in the organization", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* SessionSharedControlRepo;
        const sessions = yield* SessionsRepo;
        const db = yield* MendDB;
        const sql = yield* SqlClient.SqlClient;
        const asked = yield* freshSession;
        const held = yield* freshSession;
        yield* control.ask(asked, "ada");
        yield* control.ask(held, "ada");
        yield* control.grant(held, "ada", "grace");
        yield* control.ask(held, "linus");

        const [organization] = yield* sql<{ id: string }>`SELECT id FROM organizations LIMIT 1`;
        const released = yield* endSharedControlOfMember(
          db,
          "ada",
          OrganizationId.make(organization?.id ?? ""),
        );
        // Earlier tests left Ada's asks on other sessions too: those end as well.
        expect(released.map((session) => session.id)).toEqual(
          expect.arrayContaining([asked, held]),
        );
        const [left] = yield* sql<{ count: string }>`
          SELECT count(*) AS count FROM session_shared_control WHERE user_id = 'ada'`;
        expect(Number(left?.count)).toBe(0);
        expect((yield* sessions.byId(held)).sharedControlUserIds).toEqual([]);
        expect((yield* control.people(held)).map((person) => person.userId)).toEqual(["linus"]);
        expect(yield* control.people(asked)).toEqual([]);
      }),
    );
  });
});
