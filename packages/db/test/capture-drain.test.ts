import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { executorEndOf } from "@mend/domain/workbench";
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
const FENCED = SessionId.make("s-fenced");

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
  it("keeps an executor create's key until its answer is on the row, and the runtime identity beside it (0081, 0082)", async () => {
    const t0 = new Date("2026-09-28T10:00:00.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.recordExecutorCreate(STOPPING, "launch:k1");
        const pending = yield* sessions.executorCreateOf(STOPPING);
        const listed = yield* sessions.listExecutorCreates();
        // Another key does not clear it; its own does.
        yield* sessions.clearExecutorCreate(STOPPING, "launch:other");
        const kept = yield* sessions.executorCreateOf(STOPPING);
        yield* sessions.recordExecutorCreate(STOPPING, "launch:k2");
        yield* sessions.recordAcceptedWorkspace(
          STOPPING,
          SealantWorkspaceId.make("ws-9"),
          t0,
          "launch:k2",
        );
        const answered = yield* sessions.executorCreateOf(STOPPING);
        const launch = yield* sessions.executorLaunchOf(STOPPING);
        yield* sessions.recordExecutorResource(STOPPING, SealantWorkspaceId.make("ws-other"), "no");
        const notOther = yield* sessions.executorResourceOf(STOPPING);
        yield* sessions.recordExecutorResource(STOPPING, SealantWorkspaceId.make("ws-9"), "c0ffee");
        const resource = yield* sessions.executorResourceOf(STOPPING);
        return { pending, listed, kept, answered, launch, notOther, resource };
      }),
    );
    expect(result.pending).toBe("launch:k1");
    expect(result.listed).toEqual([{ sessionId: STOPPING, key: "launch:k1" }]);
    expect(result.kept).toBe("launch:k1");
    expect(result.answered).toBeNull();
    expect(result.notOther).toBeNull();
    expect(result.launch).toEqual({ workspaceId: "ws-9", launchId: "launch:k2" });
    expect(result.resource).toEqual({
      workspaceId: "ws-9",
      resourceId: "c0ffee",
      launchId: "launch:k2",
    });
  });
  it("keeps the executor's own word that its final flush completed, with its epoch (0079, 0081)", async () => {
    const t0 = new Date("2026-09-27T19:48:49.000Z");
    const t1 = new Date("2026-09-27T19:49:26.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const before = yield* sessions.captureSavedOf(STOPPING);
        yield* sessions.recordCaptureSaved(STOPPING, {
          workspaceId: "ws-1",
          at: t0,
          n: 21,
          epoch: 3,
        });
        const first = yield* sessions.captureSavedOf(STOPPING);
        yield* sessions.recordCaptureSaved(STOPPING, {
          workspaceId: "ws-1",
          at: t1,
          n: null,
          epoch: null,
        });
        const latest = yield* sessions.captureSavedOf(STOPPING);
        // Bookkeeping: the session row reads as it did.
        const row = yield* sessions.byId(STOPPING);
        return { before, first, latest, keys: Object.keys(row) };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.first).toEqual({ workspaceId: "ws-1", at: t0, n: 21, epoch: 3 });
    expect(result.latest).toEqual({ workspaceId: "ws-1", at: t1, n: null, epoch: null });
    expect(result.keys).not.toContain("captureSavedAt");
    expect(result.keys).not.toContain("captureSavedEpoch");
  });
  it("keeps the executor's latest answer that it held unsaved work (0084, review 2026-09-28 (4) #9)", async () => {
    const t0 = new Date("2026-09-28T00:00:20.000Z");
    const t1 = new Date("2026-09-28T00:00:31.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const before = yield* sessions.captureUnsavedOf(STOPPING);
        yield* sessions.recordCaptureUnsaved(STOPPING, {
          workspaceId: "ws-1",
          at: t0,
          words: "4.1 KB pending",
        });
        const first = yield* sessions.captureUnsavedOf(STOPPING);
        yield* sessions.recordCaptureUnsaved(STOPPING, {
          workspaceId: "ws-1",
          at: t1,
          words: "incomplete · changed",
        });
        const latest = yield* sessions.captureUnsavedOf(STOPPING);
        const row = yield* sessions.byId(STOPPING);
        return { before, first, latest, keys: Object.keys(row) };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.first).toEqual({ workspaceId: "ws-1", at: t0, words: "4.1 KB pending" });
    expect(result.latest).toEqual({ workspaceId: "ws-1", at: t1, words: "incomplete · changed" });
    expect(result.keys).not.toContain("captureUnsavedAt");
  });

  it("keeps what an executor answered per executor, whoever asked, the latest of each kind as the executor ordered them, past the session that asked (0086, 0087, review 2026-09-28 (5) #3, (6) #6)", async () => {
    const sealed = new Date("2026-09-28T00:01:00.000Z");
    const later = new Date("2026-09-28T00:01:30.000Z");
    // The worker that took the late answer runs a clock ahead: its wall time orders nothing.
    const skewed = new Date("2026-09-28T00:05:00.000Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sessions.executorEvidenceOf("ws-shared");
        // The holder's own complete answer, then a joined session's unsaved answer of the same
        // executor, then an older answer of each kind arriving late under a clock ahead: the
        // executor's order decides, and every answer moves the version.
        const v1 = yield* sessions.recordExecutorEvidence("ws-shared", {
          worktreeId: WORKTREE,
          launchId: "launch-a",
          saved: { workspaceId: "ws-shared", at: sealed, n: 4, epoch: 2, position: stampAt(10, 4) },
        });
        const v2 = yield* sessions.recordExecutorEvidence("ws-shared", {
          worktreeId: WORKTREE,
          launchId: null,
          unsaved: {
            workspaceId: "ws-shared",
            at: later,
            words: "unreadable tree/after.txt",
            position: stampAt(20, 4),
          },
        });
        const v3 = yield* sessions.recordExecutorEvidence("ws-shared", {
          worktreeId: WORKTREE,
          launchId: null,
          unsaved: {
            workspaceId: "ws-shared",
            at: skewed,
            words: "1 pending",
            position: stampAt(5, 3),
          },
          saved: { workspaceId: "ws-shared", at: skewed, n: 3, epoch: 2, position: stampAt(4, 3) },
        });
        // A clean answer keeps what is kept and still moves the version.
        const v4 = yield* sessions.recordExecutorEvidence("ws-shared", {
          worktreeId: WORKTREE,
          launchId: null,
        });
        const kept = yield* sessions.executorEvidenceOf("ws-shared");
        // The sessions that asked go; what the executor said stays with its worktree.
        yield* sql`DELETE FROM agent_sessions WHERE id = ${FAILING}`;
        const afterRemoval = yield* sessions.executorEvidenceOf("ws-shared");
        // An answer nothing orders against the kept one (no stamp) is kept beside it: no save
        // stands over it.
        yield* sessions.recordExecutorEvidence("ws-shared", {
          worktreeId: WORKTREE,
          launchId: null,
          unsaved: { workspaceId: "ws-shared", at: sealed, words: "incomplete · changed" },
        });
        const unstamped = yield* sessions.executorEvidenceOf("ws-shared");
        return { before, versions: [v1, v2, v3, v4], kept, afterRemoval, unstamped };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.versions).toEqual([1, 2, 3, 4]);
    expect(result.kept).toEqual({
      workspaceId: "ws-shared",
      launchId: "launch-a",
      saved: { workspaceId: "ws-shared", at: sealed, n: 4, epoch: 2, position: stampAt(10, 4) },
      unsaved: [
        {
          workspaceId: "ws-shared",
          at: later,
          words: "unreadable tree/after.txt",
          position: stampAt(20, 4),
        },
      ],
      version: 4,
    });
    expect(result.afterRemoval).toEqual(result.kept);
    // Kept beside the stamped answer, never over it (cross-repo decision 25): nothing orders the
    // two, and no save stands over the unstamped one.
    expect(result.unstamped?.unsaved).toEqual([
      {
        workspaceId: "ws-shared",
        at: later,
        words: "unreadable tree/after.txt",
        position: stampAt(20, 4),
      },
      {
        workspaceId: "ws-shared",
        at: sealed,
        words: "incomplete · changed",
        position: null,
      },
    ]);
    expect(result.unstamped?.version).toBe(5);
  });

  // Review 2026-09-28 (7) #3: the fence on an executor's evidence was the engine's memory, and an
  // answer was published in three writes. The fence is a row, written before the ask; the answer
  // — the session's reading and word, the executor's evidence — is published with the fence
  // deleted in one transaction. A publication that fails leaves nothing of it, and its fence
  // outlives the process that asked (each `run` below is a fresh repository over the database).
  it("fences an executor's evidence durably and publishes an answer with its fence in one transaction (0088, review 2026-09-28 (7) #3)", async () => {
    const at = new Date("2026-09-28T01:00:00.000Z");
    const reading = (ticket: number, holder: string, worktreeId: WorktreeId) => ({
      sessionId: FENCED,
      workspaceId: "ws-fenced",
      fence: { ticket, holder },
      observation: observed(at),
      position: stampAt(30, 5),
      saved: null,
      unsaved: {
        workspaceId: "ws-fenced",
        at,
        words: "unreadable tree/late.txt",
        position: stampAt(30, 5),
      },
      answer: {
        worktreeId,
        launchId: "launch-a",
        unsaved: {
          workspaceId: "ws-fenced",
          at,
          words: "unreadable tree/late.txt",
          position: stampAt(30, 5),
        },
      },
    });
    // Engine A asks; nothing comes back: the fence goes.
    const unanswered = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.create({
          id: FENCED,
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
        const ticket = yield* sessions.openEvidenceFence("ws-fenced", "engine-a");
        const during = yield* sessions.evidenceFenced("ws-fenced");
        yield* sessions.closeEvidenceFence(ticket, "unanswered");
        return { during, after: yield* sessions.evidenceFenced("ws-fenced") };
      }),
    );
    expect(unanswered).toEqual({ during: true, after: false });
    // Engine A asks; the answer arrives and its publication fails (the executor's worktree is
    // gone): nothing of it is written, and the fence stays, unpublished.
    const failed = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const ticket = yield* sessions.openEvidenceFence("ws-fenced", "engine-a");
        const exit = yield* Effect.exit(
          sessions.publishExecutorReading(reading(ticket, "engine-a", WorktreeId.make("wt-gone"))),
        );
        yield* sessions.closeEvidenceFence(ticket, "unpublished");
        return { failed: exit._tag === "Failure", ticket };
      }),
    );
    expect(failed.failed).toBe(true);
    // Engine B, after a restart: the fence is still there; the session holds nothing of the
    // answer; the executor holds no evidence.
    const restarted = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        return {
          fenced: yield* sessions.evidenceFenced("ws-fenced"),
          unsaved: yield* sessions.captureUnsavedOf(FENCED),
          evidence: yield* sessions.executorEvidenceOf("ws-fenced"),
        };
      }),
    );
    expect(restarted).toEqual({ fenced: true, unsaved: null, evidence: null });
    // Engine B asks while one of its own asks is still in flight; the later answer is published:
    // the unpublished fence goes with it, its own in-flight one stays until it returns.
    const published = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const inFlight = yield* sessions.openEvidenceFence("ws-fenced", "engine-b");
        const ticket = yield* sessions.openEvidenceFence("ws-fenced", "engine-b");
        const version = yield* sessions.publishExecutorReading(
          reading(ticket, "engine-b", WORKTREE),
        );
        const whileInFlight = yield* sessions.evidenceFenced("ws-fenced");
        yield* sessions.closeEvidenceFence(inFlight, "unanswered");
        return {
          version,
          whileInFlight,
          fenced: yield* sessions.evidenceFenced("ws-fenced"),
          unsaved: yield* sessions.captureUnsavedOf(FENCED),
          position: yield* sessions.captureObservedPositionOf(FENCED),
          evidence: yield* sessions.executorEvidenceOf("ws-fenced"),
          session: yield* sessions.byId(FENCED),
        };
      }),
    );
    expect(published.version).toBe(1);
    expect(published.whileInFlight).toBe(true);
    expect(published.fenced).toBe(false);
    expect(published.unsaved).toEqual({
      workspaceId: "ws-fenced",
      at,
      words: "unreadable tree/late.txt",
    });
    expect(published.position).toEqual(stampAt(30, 5));
    expect(published.evidence?.unsaved.map((answer) => answer.position)).toEqual([stampAt(30, 5)]);
    expect(published.session.capturePending).toBe(1);
    expect(published.session.captureObservedAt).toEqual(at);
  });

  // Review 2026-09-28 (9) #4 (the reviewer's sequence, cross-repo decision 25): the evidence kept
  // one unsaved answer, and an answer nothing ordered against it replaced it. A recovery boot's
  // failure (generation 0: incomparable with everything) was erased by a delayed answer of the
  // sealed boot made before its seal, and the seal read saved again. Every answer no kept one
  // was made after is kept; a save stands only over all of them.
  it("review 9 #4 a delayed older answer never erases a recovery boot's failure nothing orders against it: the save stays revoked", async () => {
    const workspaceId = "ws-r9-incomparable";
    const sealedAt = new Date("2026-09-28T00:01:00Z");
    const at = new Date("2026-09-28T00:05:00Z");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        // Boot A seals at observation 100 (its completed final flush).
        yield* sessions.recordExecutorEvidence(workspaceId, {
          worktreeId: WORKTREE,
          launchId: "launch-a",
          saved: { workspaceId, at: sealedAt, n: 4, epoch: 2, position: stampAt(100, 4) },
        });
        // Recovery boot B, generation 0 (its count could not be persisted): a failed snapshot.
        yield* sessions.recordExecutorEvidence(workspaceId, {
          worktreeId: WORKTREE,
          launchId: "launch-a",
          unsaved: {
            workspaceId,
            at,
            words: "unreadable tree/recovery-work.txt",
            position: { ...stampAt(1, 4), bootId: "boot-b", bootGeneration: 0 },
          },
        });
        const blocked = yield* sessions.executorEvidenceOf(workspaceId);
        // A delayed answer boot A made before its seal.
        yield* sessions.recordExecutorEvidence(workspaceId, {
          worktreeId: WORKTREE,
          launchId: "launch-a",
          unsaved: { workspaceId, at, words: "1 pending", position: stampAt(90, 3) },
        });
        const after = yield* sessions.executorEvidenceOf(workspaceId);
        // A later answer of boot A still made before its seal adds nothing: boot A's 90 is kept
        // until an answer of that boot made after it replaces it.
        yield* sessions.recordExecutorEvidence(workspaceId, {
          worktreeId: WORKTREE,
          launchId: "launch-a",
          unsaved: { workspaceId, at, words: "2 pending", position: stampAt(95, 3) },
        });
        const replaced = yield* sessions.executorEvidenceOf(workspaceId);
        return { blocked, after, replaced };
      }),
    );
    const ending = (evidence: typeof result.after) =>
      executorEndOf({
        head: { kind: "final", n: 4, registeredAt: sealedAt, bulkPending: false },
        executorStartedAt: null,
        reading: { pending: null, pendingBytes: null, observedAt: null },
        finalSaved: evidence?.saved ?? null,
        unsaved: evidence?.unsaved ?? null,
        settled: true,
      });
    expect(ending(result.blocked).kind).toBe("unconfirmed");
    // Boot B's failure is still kept beside the delayed answer: the seal does not stand.
    expect(JSON.stringify(result.after?.unsaved)).toContain("boot-b");
    expect(ending(result.after).kind).toBe("unconfirmed");
    expect(JSON.stringify(result.replaced?.unsaved)).toContain("boot-b");
    expect(JSON.stringify(result.replaced?.unsaved)).toContain("2 pending");
    expect(JSON.stringify(result.replaced?.unsaved)).not.toContain("1 pending");
    expect(ending(result.replaced).kind).toBe("unconfirmed");
  });
});

/** Where executor `launch-a` (epoch 2, boot `boot-a`) made an answer: sealantd's stamp. */
const stampAt = (observation: number, headN: number) => ({
  epoch: 2,
  launchId: "launch-a",
  bootId: "boot-a",
  bootGeneration: 1,
  observation,
  headN,
});

// Review 2026-09-28 (7) #3, rows written before 0088: a session could hold an unsaved answer whose
// executor-wide write failed. Migrating fences that executor until an answer asked after it is
// published — the failure already stored on its session keeps any older save from reading saved.
describe.skipIf(!reachable)("migration 0088 over rows written before it", () => {
  const LEGACY_DB = `mend_capture_fence_migration_${process.pid}_${Date.now()}`;
  const legacyUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${LEGACY_DB}`;
    return url.toString();
  })();
  const legacy = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(legacyUrl) })), Effect.scoped),
    );

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${LEGACY_DB}`);
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${LEGACY_DB} WITH (FORCE)`);
      }),
    );
  });

  it("fences every executor whose session holds an unsaved answer later than its evidence keeps", async () => {
    const fenced = await legacy(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        for (const [name, migration] of ordered) {
          if (name.localeCompare("0088") >= 0) continue;
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-legacy', 'web', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-legacy', 'p-legacy', 'wt', 'wt', 'mend/wt', 'abc')`;
        // ws-partial: the session's unsaved answer never reached the executor's evidence.
        // ws-published: it did. ws-older: the executor keeps a later one.
        for (const [id, workspace, at] of [
          ["s-partial", "ws-partial", "2026-09-28T00:02:00Z"],
          ["s-published", "ws-published", "2026-09-28T00:02:00Z"],
          ["s-older", "ws-older", "2026-09-28T00:01:00Z"],
        ] as const) {
          yield* sql`
            INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch,
                                        base_sha, base_ref, capture_unsaved_workspace_id,
                                        capture_unsaved_at, capture_unsaved_detail)
            VALUES (${id}, 'p-legacy', 'wt-legacy', 'claude', 'wt', 'mend/wt', 'abc', 'main',
                    ${workspace}, ${at}, 'unreadable tree/x')`;
        }
        yield* sql`
          INSERT INTO executor_capture_evidence (workspace_id, worktree_id, unsaved_at, unsaved_detail)
          VALUES ('ws-published', 'wt-legacy', '2026-09-28T00:02:00Z', 'unreadable tree/x'),
                 ('ws-older', 'wt-legacy', '2026-09-28T00:03:00Z', 'unreadable tree/y')`;
        const [, fence] = ordered.find(([name]) => name.startsWith("0088")) ?? [];
        if (fence === undefined) return yield* Effect.die("no 0088");
        yield* fence;
        return yield* sql<{ readonly workspace: string; readonly unpublished: boolean }>`
          SELECT workspace_id AS workspace, unpublished
            FROM executor_evidence_fences ORDER BY workspace_id`;
      }),
    );
    expect(fenced.map((row) => ({ ...row }))).toEqual([
      { workspace: "ws-partial", unpublished: true },
    ]);
  });
});

// Review 2026-09-28 (9) #4, rows written before 0090: an executor's evidence kept one unsaved
// answer in `unsaved_*`. Migrating starts its kept answers from that one.
describe.skipIf(!reachable)("migration 0090 over rows written before it", () => {
  const LEGACY_DB = `mend_capture_unsaved_answers_${process.pid}_${Date.now()}`;
  const legacyUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${LEGACY_DB}`;
    return url.toString();
  })();
  const legacyLayer = SessionsRepoLive.pipe(
    Layer.provideMerge(
      MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(legacyUrl) }))),
    ),
  );
  const legacy = <A, E>(effect: Effect.Effect<A, E, SessionsRepo | SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(legacyLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${LEGACY_DB}`);
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${LEGACY_DB} WITH (FORCE)`);
      }),
    );
  });

  it("keeps the one unsaved answer an executor's evidence held as its first kept answer", async () => {
    const result = await legacy(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionsRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        for (const [name, migration] of ordered) {
          if (name.localeCompare("0090") >= 0) continue;
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-legacy', 'web', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-legacy', 'p-legacy', 'wt', 'wt', 'mend/wt', 'abc')`;
        yield* sql`
          INSERT INTO executor_capture_evidence (workspace_id, worktree_id, unsaved_at,
                                                 unsaved_detail, unsaved_position, version)
          VALUES ('ws-unsaved', 'wt-legacy', '2026-09-28T00:02:00Z', 'unreadable tree/x',
                  ${JSON.stringify(stampAt(7, 3))}::jsonb, 3),
                 ('ws-clean', 'wt-legacy', NULL, NULL, NULL, 1)`;
        const [, migration] = ordered.find(([name]) => name.startsWith("0090")) ?? [];
        if (migration === undefined) return yield* Effect.die("no 0090");
        yield* migration;
        const unsaved = yield* sessions.executorEvidenceOf("ws-unsaved");
        const clean = yield* sessions.executorEvidenceOf("ws-clean");
        // A later answer nothing orders against it joins it; it is not replaced.
        yield* sessions.recordExecutorEvidence("ws-unsaved", {
          worktreeId: WorktreeId.make("wt-legacy"),
          launchId: null,
          unsaved: {
            workspaceId: "ws-unsaved",
            at: new Date("2026-09-28T00:03:00Z"),
            words: "incomplete · changed",
            position: { ...stampAt(1, 3), bootId: "boot-b", bootGeneration: 0 },
          },
        });
        const joined = yield* sessions.executorEvidenceOf("ws-unsaved");
        return { unsaved, clean, joined };
      }),
    );
    expect(result.unsaved?.unsaved).toEqual([
      {
        workspaceId: "ws-unsaved",
        at: new Date("2026-09-28T00:02:00Z"),
        words: "unreadable tree/x",
        position: stampAt(7, 3),
      },
    ]);
    expect(result.unsaved?.version).toBe(3);
    expect(result.clean?.unsaved).toEqual([]);
    expect(result.joined?.unsaved.map((answer) => answer.words)).toEqual([
      "unreadable tree/x",
      "incomplete · changed",
    ]);
  });
});
