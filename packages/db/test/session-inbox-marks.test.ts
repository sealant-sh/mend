import { PgClient } from "@effect/sql-pg";
import { SessionId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  SessionInboxMarksRepo,
  SessionInboxMarksRepoLive,
} from "../src/repos/session-inbox-marks.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_session_inbox_marks_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const repoLayer = SessionInboxMarksRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) })),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionInboxMarksRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

const first = SessionId.make("sess-1");
const second = SessionId.make("sess-2");
const hour = 60 * 60 * 1000;

describe.skipIf(postgres.skip)("session inbox marks, in Postgres", () => {
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
        for (const user of ["anna", "ben"])
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
            VALUES (${user}, ${user}, ${`${user}@example.invalid`}, '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
          VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'anna')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
          VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
        for (const session of [first, second])
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
            VALUES (${session},'proj-1','wt-1','anna','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
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

  it("keeps each person's marks apart, and a snooze lapses at its time", async () => {
    await run(
      Effect.gen(function* () {
        const marks = yield* SessionInboxMarksRepo;
        const now = new Date();
        const until = new Date(now.getTime() + hour);

        yield* marks.set("anna", first, { _tag: "Snoozed", until });
        const settled = yield* marks.set("anna", second, { _tag: "Settled" });
        expect(settled).toMatchObject({ sessionId: second, state: "settled", snoozedUntil: null });
        expect(settled.markedAt).toBeInstanceOf(Date);

        expect(yield* marks.forUser("ben", now)).toEqual([]);
        const annas = yield* marks.forUser("anna", now);
        expect(annas.map((mark) => mark.sessionId).toSorted()).toEqual([first, second]);
        expect(annas.find((mark) => mark.sessionId === first)).toMatchObject({
          state: "snoozed",
          snoozedUntil: until,
        });

        const later = new Date(until.getTime() + 1);
        expect((yield* marks.forUser("anna", later)).map((mark) => mark.sessionId)).toEqual([
          second,
        ]);
      }),
    );
  });

  it("replaces one mark with the next, and keeps an Inbox mark as an override", async () => {
    await run(
      Effect.gen(function* () {
        const marks = yield* SessionInboxMarksRepo;
        const now = new Date();
        yield* marks.set("ben", first, { _tag: "Snoozed", until: new Date(now.getTime() + hour) });
        const settled = yield* marks.set("ben", first, { _tag: "Settled" });
        expect(settled).toMatchObject({ state: "settled", snoozedUntil: null });

        const kept = yield* marks.set("ben", first, { _tag: "Inbox" });
        expect(kept).toMatchObject({ sessionId: first, state: "inbox", snoozedUntil: null });
        expect(yield* marks.forUser("ben", now)).toEqual([kept]);
      }),
    );
  });

  it("refuses a snooze with no end", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const refused = yield* sql`INSERT INTO session_inbox_marks (user_id, session_id, state)
          VALUES ('ben', ${second}, 'snoozed')`.pipe(Effect.flip);
        expect(refused._tag).toBe("SqlError");
        const rows = yield* sql`SELECT 1 FROM session_inbox_marks
          WHERE user_id = 'ben' AND session_id = ${second}`;
        expect(rows).toEqual([]);
      }),
    );
  });

  it("goes with the session", async () => {
    await run(
      Effect.gen(function* () {
        const marks = yield* SessionInboxMarksRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* marks.set("ben", second, { _tag: "Settled" });
        yield* sql`DELETE FROM agent_sessions WHERE id = ${second}`;
        const left = yield* marks.forUser("ben", new Date());
        expect(left.map((mark) => mark.sessionId)).toEqual([first]);
      }),
    );
  });
});
