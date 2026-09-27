import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";

/**
 * The durable drain intent (docs/adr/0002, "Stop drains, then terminates") against the dev
 * Postgres (`compose.dev.yaml`, :5434) in a throwaway database: what a restart takes up again, the
 * one `not saved` a stall records, and a removal that waits for its workspace. Without a database
 * reachable these skip; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_capture_drain_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = SessionsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionsRepo | SqlClient.SqlClient>) =>
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

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const DRAINING = SessionId.make("s-draining");
const REMOVING = SessionId.make("s-removing");

describe.skipIf(!reachable)("a session's capture drain, in Postgres", () => {
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
        const sessions = yield* SessionsRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        for (const id of [DRAINING, REMOVING]) {
          yield* sessions.create({
            id,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "claude",
            label: null,
            worktree: "wt-1",
            branch: "mend/wt-1",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: "alice",
            origin: "mend",
          });
        }
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

  it("keeps a drain's first request and progress across a second ask, and records one stall", async () => {
    const t0 = new Date("2026-09-27T10:00:00.000Z");
    const t1 = new Date("2026-09-27T10:05:00.000Z");
    const t2 = new Date("2026-09-27T10:15:00.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.setExecutorStartedAt(DRAINING, t0);
        yield* sessions.beginCaptureDrain(DRAINING, "stop", t0);
        // A relaunch behind the stop is asked explicitly; the drain's history stands.
        yield* sessions.planRelaunch(DRAINING, "claude", t1);
        // A sweep's stop after it (a restart's settle) does not turn the relaunch into a stop.
        yield* sessions.beginCaptureDrain(DRAINING, "stop", t2);
        const resumeAsked = yield* sessions.relaunchOf(DRAINING);
        yield* sessions.recordCaptureObservation(DRAINING, {
          pending: 3,
          pendingBytes: null,
          refused: null,
          registeredAt: t1,
          observedAt: t1,
        });
        const asked = yield* sessions.byId(DRAINING);
        const listed = (yield* sessions.listCaptureDrains()).map((session) => session.id);
        const firstStall = yield* sessions.markCaptureNotSaved(DRAINING, t2);
        const secondStall = yield* sessions.markCaptureNotSaved(DRAINING, t2);
        const stalled = yield* sessions.byId(DRAINING);
        yield* sessions.recordCaptureDrainProgress(DRAINING, t2);
        const moving = yield* sessions.byId(DRAINING);
        yield* sessions.endCaptureDrain(DRAINING);
        const ended = yield* sessions.byId(DRAINING);
        // The drain ended; the relaunch is still to run, and the reaper lists it until it has.
        const listedAfterEnd = (yield* sessions.listCaptureDrains()).map((session) => session.id);
        const resumeAfterEnd = yield* sessions.relaunchOf(DRAINING);
        yield* sessions.clearRelaunch(DRAINING);
        const listedAfterClear = (yield* sessions.listCaptureDrains()).length;
        // Nothing to mark once no drain is under way.
        const afterEnd = yield* sessions.markCaptureNotSaved(DRAINING, t2);
        return {
          asked,
          listed,
          firstStall,
          secondStall,
          stalled,
          moving,
          ended,
          afterEnd,
          resumeAsked,
          listedAfterEnd,
          resumeAfterEnd,
          listedAfterClear,
        };
      }),
    );
    expect(result.asked.captureDrain).toBe("relaunch");
    expect(result.asked.captureDrainRequestedAt).toEqual(t0);
    expect(result.asked.captureDrainProgressAt).toEqual(t0);
    expect(result.asked.capturePending).toBe(3);
    expect(result.asked.captureRegisteredAt).toEqual(t1);
    expect(result.asked.executorStartedAt).toEqual(t0);
    expect(result.listed).toEqual([DRAINING]);
    expect([result.firstStall, result.secondStall]).toEqual([true, false]);
    expect(result.stalled.captureNotSavedAt).toEqual(t2);
    expect(result.moving.captureNotSavedAt).toBeNull();
    expect(result.moving.captureDrainProgressAt).toEqual(t2);
    expect(result.ended.captureDrain).toBeNull();
    expect(result.ended.captureDrainRequestedAt).toBeNull();
    expect(result.ended.capturePending).toBe(3);
    expect(result.afterEnd).toBe(false);
    expect(result.resumeAsked).toBe("claude");
    expect(result.listedAfterEnd).toEqual([DRAINING]);
    expect(result.resumeAfterEnd).toBe("claude");
    expect(result.listedAfterClear).toBe(0);
  });

  it("keeps the first removal request, and lists what waits on its workspace", async () => {
    const first = new Date("2026-09-27T11:00:00.000Z");
    const later = new Date("2026-09-27T11:10:00.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.requestRemoval(REMOVING, first);
        yield* sessions.requestRemoval(REMOVING, later);
        const listed = yield* sessions.listRemovalRequested();
        yield* sessions.remove(REMOVING);
        return {
          listed: listed.map((session) => [session.id, session.removalRequestedAt]),
          after: (yield* sessions.listRemovalRequested()).length,
        };
      }),
    );
    expect(result.listed).toEqual([[REMOVING, first]]);
    expect(result.after).toBe(0);
  });
});
