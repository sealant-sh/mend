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
const STOPPING = SessionId.make("s-stopping");
const FAILING = SessionId.make("s-failing");

/** A reading with one capture pending, taken at `at`. */
const observed = (at: Date) => ({
  pending: 1,
  pendingBytes: null,
  refused: null,
  registeredAt: null,
  observedAt: at,
});

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
        for (const id of [DRAINING, REMOVING, STOPPING, FAILING]) {
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
  it("a session whose stop drain holds its workspace reads `stopping` and is not settled until the drain ends", async () => {
    const t0 = new Date("2026-09-27T11:00:00.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        // Settled first (the agent's own exit), then the sweep's stop drain begins: unsettled.
        yield* sessions.settle(STOPPING, "completed", "exited with code 0");
        const settledFirst = yield* sessions.byId(STOPPING);
        yield* sessions.beginCaptureDrain(STOPPING, "stop", t0);
        const draining = yield* sessions.byId(STOPPING);
        // Any settle while the stop drain holds it keeps it `stopping`.
        yield* sessions.settle(STOPPING, "stopped", null);
        const held = yield* sessions.byId(STOPPING);
        // The drain ends once the termination is observed: now it settles.
        yield* sessions.endCaptureDrain(STOPPING);
        yield* sessions.settle(STOPPING, "completed", "exited with code 0");
        const settled = yield* sessions.byId(STOPPING);
        // A relaunch drain is not a stop: a settle while it runs settles.
        yield* sessions.reopen(STOPPING, "running");
        yield* sessions.planRelaunch(STOPPING, "claude", t0);
        yield* sessions.settle(STOPPING, "failed", "resume failed");
        const relaunching = yield* sessions.byId(STOPPING);
        // The owner's stop turns it into a stop drain: unsettled again.
        yield* sessions.stopCaptureDrain(STOPPING);
        const stopped = yield* sessions.byId(STOPPING);
        return { settledFirst, draining, held, settled, relaunching, stopped };
      }),
    );
    expect(result.settledFirst.status).toBe("completed");
    expect(result.settledFirst.settledAt).not.toBeNull();
    expect(result.draining.status).toBe("stopping");
    expect(result.draining.settledAt).toBeNull();
    expect(result.held.status).toBe("stopping");
    expect(result.held.settledAt).toBeNull();
    expect(result.settled.status).toBe("completed");
    expect(result.settled.settledAt).not.toBeNull();
    expect(result.relaunching.status).toBe("failed");
    expect(result.relaunching.settledAt).not.toBeNull();
    expect(result.stopped.status).toBe("stopping");
    expect(result.stopped.settledAt).toBeNull();
  });

  it("keeps when a snap first failed and what sealantd said, clears it once snaps succeed or the executor is gone, and keeps a discard until the session runs again", async () => {
    const t0 = new Date("2026-09-27T16:29:51.000Z");
    const t1 = new Date("2026-09-27T16:30:36.000Z");
    const t2 = new Date("2026-09-27T16:40:02.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.recordCaptureObservation(FAILING, {
          ...observed(t0),
          failing: { since: t0, error: "EIO: tree/db.sqlite" },
        });
        // A later reading of the same failure keeps when it started, and its latest error.
        yield* sessions.recordCaptureObservation(FAILING, {
          ...observed(t1),
          failing: { since: t1, error: "EIO: tree/db.sqlite (2)" },
        });
        const failing = yield* sessions.byId(FAILING);
        // A reading that says nothing of snaps leaves it as it was.
        yield* sessions.recordCaptureObservation(FAILING, observed(t1));
        const unsaid = yield* sessions.byId(FAILING);
        yield* sessions.recordCaptureObservation(FAILING, { ...observed(t1), failing: null });
        const recovered = yield* sessions.byId(FAILING);
        // A final flush's incomplete reason carries what sealantd named behind it.
        yield* sessions.beginCaptureDrain(FAILING, "stop", t1);
        yield* sessions.recordCaptureObservation(FAILING, {
          ...observed(t1),
          failing: { since: t1, error: "EACCES" },
          incompleteReason: "snapshot-failed",
          incompleteDetail: "EACCES · unreadable tree/secrets.pem",
        });
        const kept = yield* sessions.byId(FAILING);
        yield* sessions.endCaptureDrain(FAILING, { at: t2, by: "Ada Lovelace" });
        const discarded = yield* sessions.byId(FAILING);
        yield* sessions.reopen(FAILING, "running");
        const reopened = yield* sessions.byId(FAILING);
        return { failing, unsaid, recovered, kept, discarded, reopened };
      }),
    );
    expect(result.failing.captureFailingSince).toEqual(t0);
    expect(result.failing.captureFailingError).toBe("EIO: tree/db.sqlite (2)");
    expect(result.unsaid.captureFailingSince).toEqual(t0);
    expect(result.recovered.captureFailingSince).toBeNull();
    expect(result.recovered.captureFailingError).toBeNull();
    expect(result.kept.captureIncompleteReason).toBe("snapshot-failed");
    expect(result.kept.captureIncompleteDetail).toBe("EACCES · unreadable tree/secrets.pem");
    expect(result.discarded.captureDrain).toBeNull();
    expect(result.discarded.captureIncompleteDetail).toBeNull();
    expect(result.discarded.captureFailingSince).toBeNull();
    expect(result.discarded.captureDiscardedAt).toEqual(t2);
    expect(result.discarded.captureDiscardedBy).toBe("Ada Lovelace");
    expect(result.reopened.captureDiscardedAt).toBeNull();
    expect(result.reopened.captureDiscardedBy).toBeNull();
  });
  it("keeps the executor's own word that its final flush completed (0079)", async () => {
    const t0 = new Date("2026-09-27T19:48:49.000Z");
    const t1 = new Date("2026-09-27T19:49:26.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const before = yield* sessions.captureSavedOf(STOPPING);
        yield* sessions.recordCaptureSaved(STOPPING, { workspaceId: "ws-1", at: t0, n: 21 });
        const first = yield* sessions.captureSavedOf(STOPPING);
        yield* sessions.recordCaptureSaved(STOPPING, { workspaceId: "ws-1", at: t1, n: null });
        const latest = yield* sessions.captureSavedOf(STOPPING);
        // Bookkeeping: the session row reads as it did.
        const row = yield* sessions.byId(STOPPING);
        return { before, first, latest, keys: Object.keys(row) };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.first).toEqual({ workspaceId: "ws-1", at: t0, n: 21 });
    expect(result.latest).toEqual({ workspaceId: "ws-1", at: t1, n: null });
    expect(result.keys).not.toContain("captureSavedAt");
  });
});
