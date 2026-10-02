import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  type RegisterCapture,
  CaptureStoreRepo,
  CaptureStoreRepoLive,
} from "../src/repos/capture-store.ts";
import { StoreRefsRepo, StoreRefsRepoLive } from "../src/repos/store-refs.ts";

/**
 * Runs against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database; skips when
 * nothing listens. MEND_TEST_DATABASE_URL points elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_capture_store_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
// The production client's name transforms (`src/client.ts`): the repositories read raw `sql`
// results by camelCase key, and a client without the transform would pass a test the API fails.
const scratchLayer = PgClient.layer({
  url: Redacted.make(scratchUrl),
  // Enough connections for a test to hold a row lock while another statement waits on it.
  maxConnections: 10,
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const reposLayer = Layer.mergeAll(CaptureStoreRepoLive, StoreRefsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, CaptureStoreRepo | StoreRefsRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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

const PROJECT = ProjectId.make("proj-cap");
let worktreeSeq = 0;
/** A fresh worktree row + its lease and chain rows. */
const freshWorktree = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* CaptureStoreRepo;
  worktreeSeq += 1;
  const id = WorktreeId.make(`wt-${process.pid}-${worktreeSeq}`);
  yield* sql`
    INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
    VALUES (${id}, ${PROJECT}, ${id}, ${id}, ${`mend/wt/${id}`}, ${"a".repeat(40)})`;
  yield* repo.init(id);
  return id;
});

/** A deletion claim for a test condemnation: `token` names it, an hour to live. */
const claimOf = (token: string, ttlSeconds = 3600) => ({ token, ttlSeconds });

const captureInput = (
  worktreeId: WorktreeId,
  n: number,
  parent: string | null,
  epoch: number,
  id = `cap-${worktreeId}-${n}-${epoch}`,
): RegisterCapture => ({
  worktreeId,
  id,
  n,
  parent,
  epoch,
  seq: BigInt(n * 10),
  kind: n === 0 ? "checkpoint" : "auto",
  manifestKey: `captures/${worktreeId}/${epoch}/manifests/${id}`,
  sections: { git: { packs: [] } },
  gitFsck: "verified",
});

const sha = (c: string) => Sha.make(c.repeat(40));

const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** A conflict's reason, or "ok". */
const reasonOf = <A>(
  effect: Effect.Effect<A, { readonly _tag: string; readonly reason: string }>,
) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error.reason)),
  );

describe.skipIf(!reachable)("capture store (0053)", () => {
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
          INSERT INTO projects (id, name, organization_id, origin_url, store_path, default_branch)
          VALUES (${PROJECT}, 'capture-fixture', (SELECT id FROM organizations LIMIT 1), NULL,
                  '/store/capture-fixture/repo.git', 'main')`;
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

  it("claim: concurrent claimers — exactly one wins, and it is epoch 1", async () => {
    const outcomes = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const results = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, i) => `exec-${i}`),
          (executor) =>
            repo.claim(worktreeId, executor).pipe(
              Effect.map((won) => ({ executor, epoch: won.epoch })),
              Effect.catch((error) => Effect.succeed({ executor, error: error._tag })),
            ),
          { concurrency: "unbounded" },
        );
        const lease = yield* repo.leaseOf(worktreeId);
        const head = yield* repo.headOf(worktreeId);
        return { results, lease, head };
      }),
    );
    const winners = outcomes.results.filter((r) => "epoch" in r);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.epoch).toBe(1);
    expect(outcomes.results.filter((r) => "error" in r).map((r) => r.error)).toEqual(
      Array<string>(7).fill("WorktreeLeasedError"),
    );
    expect(outcomes.lease?.executorId).toBe(winners[0]?.executor);
    expect(outcomes.lease?.live).toBe(true);
    expect(outcomes.head?.headEpoch).toBe(1);
    expect(outcomes.head?.headN).toBe(-1);
  });

  it("heartbeat renews only under the holder's epoch; release lets the next claimer in", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "exec-a");
        const wrong = yield* repo.heartbeat(worktreeId, epoch + 1);
        const right = yield* repo.heartbeat(worktreeId, epoch);
        const second = yield* tagOf(repo.claim(worktreeId, "exec-b"));
        const releasedByWrongEpoch = yield* repo.release(worktreeId, epoch + 1);
        const released = yield* repo.release(worktreeId, epoch);
        const afterRelease = yield* repo.claim(worktreeId, "exec-b");
        const staleHeartbeat = yield* repo.heartbeat(worktreeId, epoch);
        return {
          wrong,
          right,
          second,
          releasedByWrongEpoch,
          released,
          afterRelease,
          staleHeartbeat,
        };
      }),
    );
    expect(result.wrong).toBe(false);
    expect(result.right).toBe(true);
    expect(result.second).toBe("WorktreeLeasedError");
    expect(result.releasedByWrongEpoch).toBe(false);
    expect(result.released).toBe(true);
    expect(result.afterRelease).toEqual({ epoch: 2 });
    expect(result.staleHeartbeat).toBe(false);
  });

  it("a lapsed lease is not an end: another executor waits for the release, which fences the holder", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const first = yield* repo.claim(worktreeId, "exec-a", 0);
        // exec-a's heartbeat lapsed (a partition): it may still be running with work unshipped.
        const lapsed = yield* tagOf(repo.claim(worktreeId, "exec-b"));
        const lapsedLease = yield* repo.leaseOf(worktreeId);
        // The holder itself may take its lapsed lease again (a pickup of the same session).
        const again = yield* repo.claim(worktreeId, "exec-a", 0);
        // Its end observed, the holder is released: now the next executor claims and fences it.
        const released = yield* repo.release(worktreeId, again.epoch);
        const releasedLease = yield* repo.leaseOf(worktreeId);
        const revived = yield* repo.heartbeat(worktreeId, again.epoch);
        const second = yield* repo.claim(worktreeId, "exec-b");
        const stale = yield* tagOf(repo.register(captureInput(worktreeId, 0, null, again.epoch)));
        const live = yield* tagOf(repo.register(captureInput(worktreeId, 0, null, second.epoch)));
        return {
          first,
          lapsed,
          lapsedHolder: lapsedLease?.executorId,
          again,
          released,
          releasedHolder: releasedLease?.executorId,
          revived,
          second,
          stale,
          live,
        };
      }),
    );
    expect(result.first.epoch).toBe(1);
    expect(result.lapsed).toBe("WorktreeLeasedError");
    expect(result.lapsedHolder).toBe("exec-a");
    expect(result.again.epoch).toBe(2);
    expect(result.released).toBe(true);
    expect(result.releasedHolder).toBeNull();
    // A released lease is not revived by the ended executor's late heartbeat.
    expect(result.revived).toBe(false);
    expect(result.second.epoch).toBe(3);
    expect(result.stale).toBe("CaptureConflictError");
    expect(result.live).toBe("ok");
  });

  it("register: the CAS advances the chain; stale epoch, wrong parent and moved head are 409s; a lost ack is not", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "exec-a");
        const zero = captureInput(worktreeId, 0, null, epoch);
        const beforeLease = yield* repo
          .register(captureInput(worktreeId, 0, null, epoch + 1))
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        const c0 = yield* repo.register(zero);
        const wrongParent = yield* repo
          .register(captureInput(worktreeId, 1, "not-the-head", epoch))
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        const c1 = yield* repo.register(one);
        const lostAck = yield* repo.register(one);
        const headMoved = yield* repo
          .register(captureInput(worktreeId, 1, zero.id, epoch, "a-different-capture"))
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        const skipped = yield* repo
          .register(captureInput(worktreeId, 3, one.id, epoch))
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        const head = yield* repo.headOf(worktreeId);
        const chain = yield* repo.listChain(worktreeId);
        return { beforeLease, c0, wrongParent, c1, lostAck, headMoved, skipped, head, chain };
      }),
    );
    expect(result.beforeLease).toMatchObject({
      _tag: "CaptureConflictError",
      reason: "stale_epoch",
    });
    expect(result.c0).toEqual({ lostAck: false });
    expect(result.wrongParent).toMatchObject({
      _tag: "CaptureConflictError",
      reason: "wrong_parent",
    });
    expect(result.c1).toEqual({ lostAck: false });
    expect(result.lostAck).toEqual({ lostAck: true });
    expect(result.headMoved).toMatchObject({ _tag: "CaptureConflictError", reason: "head_moved" });
    expect(result.skipped).toMatchObject({ _tag: "CaptureConflictError", reason: "head_moved" });
    expect(result.head?.headN).toBe(1);
    expect(result.head?.head?.id).toBe(`cap-${result.head?.worktreeId}-1-1`);
    expect(result.head?.head?.seq).toBe(10n);
    expect(result.chain.map((row) => [row.n, row.parent, row.kind])).toEqual([
      [0, null, "checkpoint"],
      [1, `cap-${result.head?.worktreeId}-0-1`, "auto"],
    ]);
  });

  it("summaries are accepted only against the chain head; the observed pass restamps them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "exec-a");
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register(zero);
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        yield* repo.register(one);
        const forOld = yield* tagOf(repo.acceptSummary(worktreeId, zero.id, "changes/x/0"));
        const forHead = yield* tagOf(repo.acceptSummary(worktreeId, one.id, "changes/x/1"));
        const again = yield* tagOf(repo.acceptSummary(worktreeId, one.id, "changes/x/1b"));
        const forUnknown = yield* tagOf(
          repo.acceptSummary(worktreeId, "never-landed", "changes/x/9"),
        );
        const observed = yield* repo.setSummaryState(one.id, "observed");
        const missing = yield* repo.setSummaryState("never-landed", "observed");
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly captureId: string;
          readonly key: string;
          readonly state: string;
        }>`
          SELECT capture_id, key, state FROM capture_summaries WHERE worktree_id = ${worktreeId}`;
        return { forOld, forHead, again, forUnknown, observed, missing, rows, oneId: one.id };
      }),
    );
    expect(result.forOld).toBe("SummaryRejectedError");
    expect(result.forHead).toBe("ok");
    expect(result.again).toBe("ok");
    expect(result.forUnknown).toBe("SummaryRejectedError");
    expect(result.observed).toBe(true);
    expect(result.missing).toBe(false);
    expect(result.rows).toEqual([
      { captureId: result.oneId, key: "changes/x/1b", state: "observed" },
    ]);
  });

  it("records packs idempotently by digest", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const key = `captures/${worktreeId}/1/packs/${"b".repeat(64)}`;
        yield* repo.recordPacks([
          { key, class: "git", bytes: 10, worktreeId, epoch: 1, platform: null },
          { key, class: "git", bytes: 10, worktreeId, epoch: 1, platform: null },
        ]);
        yield* repo.recordPacks([
          { key, class: "git", bytes: 99, worktreeId, epoch: 2, platform: null },
        ]);
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly id: string; readonly bytes: number; readonly state: string }>`
          SELECT id, bytes::int AS bytes, state FROM packs WHERE worktree_id = ${worktreeId}`;
      }),
    );
    expect(rows).toEqual([{ id: "b".repeat(64), bytes: 10, state: "uploaded" }]);
  });

  it("guard (0076): a register and a condemnation of the same chain never both land, whichever holds the row first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const sql = yield* SqlClient.SqlClient;
        const worktreeId = yield* freshWorktree;
        const key = `captures/${worktreeId}/1/packs/${"c".repeat(64)}`;
        const { epoch } = yield* repo.claim(worktreeId, "exec", 3600);
        const guardOf = Effect.map(
          repo.referenceState([worktreeId], [key]),
          (state) => state.guards.get(worktreeId) ?? -1,
        );
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, guards: [{ worktreeId, guard: yield* guardOf }] });

        /** Hold the chain row in an open transaction until released, as a statement in flight. */
        const holdRow = (statement: Effect.Effect<unknown, unknown>) =>
          Effect.gen(function* () {
            const locked = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const holder = yield* Effect.forkChild(
              sql.withTransaction(
                statement.pipe(
                  Effect.andThen(Deferred.succeed(locked, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              ),
            );
            yield* Deferred.await(locked);
            return Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder)));
          });

        // 1. A condemnation holds the row (it bumped the guard, uncommitted); a register that
        //    read the guard before it waits, then re-reads the row and misses.
        const readBeforeCondemn = yield* guardOf;
        const releaseCondemn = yield* holdRow(
          sql`UPDATE worktree_chain SET guard = guard + 1 WHERE worktree_id = ${worktreeId}`,
        );
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        const blockedRegister = yield* Effect.forkChild(
          reasonOf(repo.register({ ...one, guards: [{ worktreeId, guard: readBeforeCondemn }] })),
        );
        yield* Effect.sleep("300 millis");
        const registerWaited = blockedRegister.pollUnsafe() === undefined;
        yield* releaseCondemn;
        const registerOutcome = yield* Fiber.join(blockedRegister);
        const headAfterCondemn = (yield* repo.headOf(worktreeId))?.headN;

        // 2. A register holds the row (it moved the head and bumped the guard, uncommitted); a
        //    condemnation that read the guard before it waits, then re-reads the row and misses.
        const readBeforeRegister = yield* guardOf;
        const releaseRegister = yield* holdRow(
          sql`UPDATE worktree_chain SET guard = guard + 1 WHERE worktree_id = ${worktreeId}`,
        );
        const blockedCondemn = yield* Effect.forkChild(
          repo.condemn(worktreeId, readBeforeRegister, [key], claimOf("race")),
        );
        yield* Effect.sleep("300 millis");
        const condemnWaited = blockedCondemn.pollUnsafe() === undefined;
        yield* releaseRegister;
        const condemnOutcome = yield* Fiber.join(blockedCondemn);
        const tombstonesAfterRace = (yield* repo.referenceState([worktreeId], [key])).tombstones;

        // 3. In order: a condemnation lands, a register that read before it misses, one that
        //    reads after it sees the tombstone; once the bytes are gone, a register naming the
        //    key still misses — a condemned key never comes back (cross-repo decision 6).
        const before = yield* guardOf;
        const condemned = yield* repo.condemn(worktreeId, before, [key], claimOf("order"));
        const staleRegister = yield* reasonOf(
          repo.register({ ...one, guards: [{ worktreeId, guard: before }] }),
        );
        const seen = yield* repo.referenceState([worktreeId], [key]);
        yield* repo.finishDeletion("order", [key]);
        const gone = yield* repo.referenceState([worktreeId], [key]);
        const revived = yield* reasonOf(
          repo.register({
            ...one,
            guards: [{ worktreeId, guard: gone.guards.get(worktreeId) ?? -1 }],
            names: [key],
          }),
        );
        const after = yield* repo.referenceState([worktreeId], [key]);
        return {
          registerWaited,
          registerOutcome,
          headAfterCondemn,
          condemnWaited,
          condemnOutcome,
          tombstonesAfterRace,
          condemned,
          staleRegister,
          seen: seen.tombstones,
          gone: gone.tombstones,
          revived,
          after: after.tombstones,
        };
      }),
    );
    expect(result.registerWaited).toBe(true);
    expect(result.registerOutcome).toBe("guard_moved");
    expect(result.headAfterCondemn).toBe(0);
    expect(result.condemnWaited).toBe(true);
    expect(result.condemnOutcome).toBe(false);
    expect(result.tombstonesAfterRace).toEqual([]);
    expect(result.condemned).toBe(true);
    expect(result.staleRegister).toBe("guard_moved");
    expect(result.seen).toEqual([{ key: expect.any(String), deleted: false }]);
    expect(result.gone).toEqual([{ key: expect.any(String), deleted: true }]);
    expect(result.revived).toBe("guard_moved");
    expect(result.after).toEqual([{ key: expect.any(String), deleted: true }]);
  });

  it("deletion claims (0080): a condemned key never comes back — not while a claim holds, not once every pass finished, not once a claim lapsed (review 3 #2)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const sql = yield* SqlClient.SqlClient;
        const worktreeId = yield* freshWorktree;
        const key = `captures/${worktreeId}/1/packs/${"e".repeat(64)}`;
        const { epoch } = yield* repo.claim(worktreeId, "exec", 3600);
        const guardOf = Effect.map(
          repo.referenceState([worktreeId], [key]),
          (state) => state.guards.get(worktreeId) ?? -1,
        );
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, guards: [{ worktreeId, guard: yield* guardOf }] });
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        const tryRevive = Effect.gen(function* () {
          const state = yield* repo.referenceState([worktreeId], [key]);
          return yield* reasonOf(
            repo.register({
              ...one,
              guards: [{ worktreeId, guard: state.guards.get(worktreeId) ?? -1 }],
              names: [key],
            }),
          );
        });
        const deletedOf = Effect.map(repo.referenceState([worktreeId], [key]), (state) =>
          state.tombstones.map((tombstone) => tombstone.deleted),
        );

        // Pass A condemns; pass B condemns the same key, deletes it, and finishes first.
        yield* repo.condemn(worktreeId, yield* guardOf, [key], claimOf(`a-${worktreeId}`));
        yield* repo.condemn(worktreeId, yield* guardOf, [key], claimOf(`b-${worktreeId}`));
        yield* repo.finishDeletion(`b-${worktreeId}`, [key]);
        const whileAHolds = yield* deletedOf;
        // The channel refuses on `deleted: false`; the CAS refuses the revive on its own too.
        const reviveWhileAHolds = yield* tryRevive;
        const renewedA = yield* repo.renewDeletion(`a-${worktreeId}`, 3600);
        yield* repo.finishDeletion(`a-${worktreeId}`, [key]);
        const afterA = yield* deletedOf;
        const renewedAfterFinish = yield* repo.renewDeletion(`a-${worktreeId}`, 3600);

        // A crashed pass: its claim lapses, it can never renew it, and the key comes back.
        const other = `captures/${worktreeId}/1/packs/${"f".repeat(64)}`;
        yield* repo.condemn(worktreeId, yield* guardOf, [other], claimOf(`c-${worktreeId}`));
        yield* repo.condemn(worktreeId, yield* guardOf, [other], claimOf(`d-${worktreeId}`));
        yield* repo.finishDeletion(`d-${worktreeId}`, [other]);
        yield* sql`
          UPDATE capture_deletion_claims SET expires_at = now() - interval '1 second'
           WHERE token = ${`c-${worktreeId}`}`;
        const renewedLapsed = yield* repo.renewDeletion(`c-${worktreeId}`, 3600);
        const lapsed = (yield* repo.referenceState([worktreeId], [other])).tombstones;
        const revived = yield* tryRevive;
        return {
          whileAHolds,
          reviveWhileAHolds,
          renewedA,
          afterA,
          renewedAfterFinish,
          renewedLapsed,
          lapsed,
          revived,
        };
      }),
    );
    expect(result.whileAHolds).toEqual([false]);
    expect(result.reviveWhileAHolds).toBe("guard_moved");
    expect(result.renewedA).toBe(1);
    expect(result.afterA).toEqual([true]);
    expect(result.renewedAfterFinish).toBe(0);
    expect(result.renewedLapsed).toBe(0);
    expect(result.lapsed).toEqual([{ key: expect.any(String), deleted: true }]);
    expect(result.revived).toBe("guard_moved");
  });

  it("seals (0083): a seal names the launch that sealed, recorded only while the lease names its session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600);
        const zero = captureInput(worktreeId, 0, null, epoch);
        // A launch of another session: the lease does not name it, nothing is sealed.
        yield* repo.register({ ...zero, seal: { executorId: "launch-x", holder: "session-2" } });
        const other = yield* repo.sealedCompletion(worktreeId, "launch-x", epoch);
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        yield* repo.register({ ...one, seal: { executorId: "launch-1", holder: "session-1" } });
        return {
          other,
          byLaunch: yield* repo.sealedCompletion(worktreeId, "launch-1", epoch),
          bySession: yield* repo.sealedCompletion(worktreeId, "session-1", epoch),
          oneId: one.id,
        };
      }),
    );
    expect(result.other).toBeNull();
    expect(result.byLaunch).toMatchObject({
      executorId: "launch-1",
      captureId: result.oneId,
      n: 1,
    });
    expect(result.bySession).toBeNull();
  });

  it("a late seal (e2e8 F2): recorded on the head under its epoch while the lease names its launch; never on a capture the chain moved past, nor for another launch", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600, "launch-1");
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register(zero);
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        yield* repo.register(one);
        const lateOf = (capture: RegisterCapture, executorId: string, holder: string) =>
          repo.recordSeal({
            worktreeId,
            epoch,
            captureId: capture.id,
            n: capture.n,
            manifestKey: capture.manifestKey,
            names: [],
            seal: { executorId, holder, observation: 7 },
          });
        // Not the head: the chain moved past capture 0.
        const pastHead = yield* lateOf(zero, "launch-1", "session-1");
        // Another launch of the holder, another holder: the lease names neither.
        const otherLaunch = yield* lateOf(one, "launch-2", "session-1");
        const otherHolder = yield* lateOf(one, "launch-1", "session-2");
        const none = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        // The head, under the lease's own launch: recorded, stamped as sealantd stamped it.
        const recorded = yield* lateOf(one, "launch-1", "session-1");
        const sealed = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        // Recording it again changes nothing.
        const again = yield* lateOf(one, "launch-1", "session-1");
        return { pastHead, otherLaunch, otherHolder, none, recorded, sealed, again, oneId: one.id };
      }),
    );
    expect(result.pastHead).toBe(false);
    expect(result.otherLaunch).toBe(false);
    expect(result.otherHolder).toBe(false);
    expect(result.none).toBeNull();
    expect(result.recorded).toBe(true);
    expect(result.sealed).toMatchObject({
      executorId: "launch-1",
      captureId: result.oneId,
      n: 1,
      observation: 7,
    });
    expect(result.again).toBe(false);
  });

  it("seals (0087): a seal keeps where sealantd stamped it in the executor's own order, and none when it did not (review 2026-09-28 (6) #6)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600);
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, seal: { executorId: "launch-1", holder: "session-1" } });
        const unstamped = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        yield* repo.register({
          ...one,
          seal: {
            executorId: "launch-1",
            holder: "session-1",
            bootId: "0123456789abcdef0123456789abcdef",
            bootGeneration: 2,
            observation: 41,
          },
        });
        return { unstamped, stamped: yield* repo.sealedCompletion(worktreeId, "launch-1", epoch) };
      }),
    );
    expect(result.unstamped).toMatchObject({
      n: 0,
      bootId: null,
      bootGeneration: null,
      observation: null,
    });
    expect(result.stamped).toMatchObject({
      n: 1,
      bootId: "0123456789abcdef0123456789abcdef",
      bootGeneration: 2,
      observation: 41,
    });
  });

  it("put authority and re-verified seals (0089): the latest URL expiry per epoch; a seal's re-verification and void, reset by a newer seal (review 2026-09-28 (7) #8)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600);
        const none = yield* repo.putAuthorityUntil(worktreeId, epoch);
        const later = new Date("2026-09-28T01:20:00.000Z");
        const earlier = new Date("2026-09-28T01:05:00.000Z");
        yield* repo.recordPutAuthority(worktreeId, epoch, later);
        yield* repo.recordPutAuthority(worktreeId, epoch, earlier);
        const kept = yield* repo.putAuthorityUntil(worktreeId, epoch);
        const otherEpoch = yield* repo.putAuthorityUntil(worktreeId, epoch + 1);
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, seal: { executorId: "launch-1", holder: "session-1" } });
        const at = new Date("2026-09-28T01:21:00.000Z");
        // Another capture's id names nothing: the seal stays as it was.
        yield* repo.markSealReverified(worktreeId, epoch, "not-the-sealed-capture", at);
        const untouched = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        yield* repo.markSealReverified(worktreeId, epoch, zero.id, at);
        const reverified = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        yield* repo.voidSeal(worktreeId, epoch, zero.id, "captures/x/packs/y holds other bytes");
        yield* repo.markSealReverified(worktreeId, epoch, zero.id, new Date(at.getTime() + 1000));
        const voided = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        // A newer seal of the epoch is another capture: nothing of the old one's verdict carries.
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        yield* repo.register({ ...one, seal: { executorId: "launch-1", holder: "session-1" } });
        const newer = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        return { none, kept, otherEpoch, untouched, reverified, voided, newer };
      }),
    );
    expect(result.none).toBeNull();
    expect(result.kept?.toISOString()).toBe("2026-09-28T01:20:00.000Z");
    expect(result.otherEpoch).toBeNull();
    expect(result.untouched).toMatchObject({ reverifiedAt: null, voidReason: null });
    expect(result.reverified?.reverifiedAt?.toISOString()).toBe("2026-09-28T01:21:00.000Z");
    expect(result.voided).toMatchObject({ voidReason: "captures/x/packs/y holds other bytes" });
    expect(result.voided?.reverifiedAt?.toISOString()).toBe("2026-09-28T01:21:00.000Z");
    expect(result.newer).toMatchObject({ n: 1, reverifiedAt: null, voidReason: null });
  });

  it("a seal's re-verification is a compare-and-set against its epoch's write authority: a URL handed out since the read began voids it (review 2026-09-28 (8) #5)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600);
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, seal: { executorId: "launch-1", holder: "session-1" } });
        // Recorded only against the seal the caller checked its keys against (review 2026-09-28
        // (9) #6).
        const unchecked = yield* repo.recordPutAuthority(
          worktreeId,
          epoch,
          new Date("2026-09-28T01:00:00.000Z"),
        );
        const uncheckedAuthority = yield* repo.putAuthorityUntil(worktreeId, epoch);
        yield* repo.recordPutAuthority(worktreeId, epoch, new Date("2026-09-28T01:00:00.000Z"), [
          zero.id,
        ]);
        // Every URL expired before the read began: the mark is recorded.
        const readBegan = new Date("2026-09-28T01:10:00.000Z");
        const first = yield* repo.markSealReverified(worktreeId, epoch, zero.id, readBegan);
        const reverified = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        // A URL handed out while the next read-back ran: its authority outlives the read's start.
        const nextRead = new Date("2026-09-28T01:30:00.000Z");
        yield* repo.recordPutAuthority(worktreeId, epoch, new Date("2026-09-28T01:50:00.000Z"), [
          zero.id,
        ]);
        const raced = yield* repo.markSealReverified(worktreeId, epoch, zero.id, nextRead);
        const after = yield* repo.sealedCompletion(worktreeId, "launch-1", epoch);
        return { unchecked, uncheckedAuthority, first, reverified, raced, after };
      }),
    );
    expect(result.unchecked).toEqual({
      recorded: false,
      reason: "sealed",
      sealedCaptures: [expect.any(String)],
    });
    expect(result.uncheckedAuthority).toBeNull();
    expect(result.first).toBe(true);
    expect(result.reverified?.reverifiedAt?.toISOString()).toBe("2026-09-28T01:10:00.000Z");
    expect(result.raced).toBe(false);
    expect(result.after?.reverifiedAt?.toISOString()).toBe("2026-09-28T01:10:00.000Z");
  });

  // Review 2026-09-28 (9) #6 (the reviewer's pg_stat_activity-coordinated race, cross-repo
  // decision 26): the mark checked the epoch's write authority inside the UPDATE of the seal row
  // — a `NOT EXISTS` over the statement's snapshot, taken before it waited on that row. Authority
  // committed while it waited was never seen, and the seal was marked with that URL live.
  // Issuance and the mark now serialize on the epoch's authority row, locked before a fresh read,
  // and issuance refuses a seal it has not checked.
  it("review 9 #6 a seal's mark and write authority committed while it waits on the seal row never both stand", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const sql = yield* SqlClient.SqlClient;
        const worktreeId = yield* freshWorktree;
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600);
        const zero = captureInput(worktreeId, 0, null, epoch);
        yield* repo.register({ ...zero, seal: { executorId: "launch-1", holder: "session-1" } });
        const waiters = sql<{ readonly waiting: number }>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`.pipe(
          Effect.map((rows) => rows[0]?.waiting ?? 0),
        );
        const locked = yield* Deferred.make<void>();
        const unlock = yield* Deferred.make<void>();
        // Another verification holds the seal row, changing nothing.
        const holder = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                SELECT worktree_id FROM capture_seals
                 WHERE worktree_id = ${worktreeId} FOR UPDATE`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(unlock);
            }),
          ),
        );
        yield* Deferred.await(locked);
        const readBegan = new Date();
        const marker = yield* Effect.forkChild(
          repo.markSealReverified(worktreeId, epoch, zero.id, readBegan),
        );
        let markWaiting = false;
        for (let i = 0; i < 200 && !markWaiting; i++) {
          markWaiting = (yield* waiters) > 0;
          if (!markWaiting) yield* Effect.sleep("20 millis");
        }
        // A URL of the epoch handed out while the mark waits: its authority outlives the read.
        const issuer = yield* Effect.forkChild(
          repo.recordPutAuthority(worktreeId, epoch, new Date(readBegan.getTime() + 20 * 60_000)),
        );
        for (let i = 0; i < 100; i++) {
          if (issuer.pollUnsafe() !== undefined || (yield* waiters) > 1) break;
          yield* Effect.sleep("20 millis");
        }
        yield* Deferred.succeed(unlock, undefined);
        yield* Fiber.join(holder);
        const marked = yield* Fiber.join(marker);
        const issued = yield* Fiber.join(issuer);
        return {
          markWaiting,
          marked,
          issued,
          sealed: zero.id,
          seal: yield* repo.sealedCompletion(worktreeId, "launch-1", epoch),
          authority: yield* repo.putAuthorityUntil(worktreeId, epoch),
        };
      }),
    );
    expect(result.markWaiting).toBe(true);
    const reverifiedAt = result.seal?.reverifiedAt?.getTime() ?? null;
    const authority = result.authority?.getTime() ?? null;
    // Never both: a mark recorded and write authority recorded after the read it marks.
    expect(
      result.marked && reverifiedAt !== null && authority !== null && authority > reverifiedAt,
    ).toBe(false);
    // Here the mark went first: the issuer found the seal it had not checked, and recorded
    // nothing — overwrite-capable authority is never issued for a sealed epoch unchecked.
    expect(result.marked).toBe(true);
    expect(result.issued).toEqual({
      recorded: false,
      reason: "sealed",
      sealedCaptures: [result.sealed],
    });
    expect(result.authority).toBeNull();
  });

  // Review 2026-09-28 (10) #5, cross-repo decision 31: a seal carrying a pack of an earlier
  // epoch stands over that epoch's write authority too; no epoch is handed authority under a
  // prefix a recorded seal's objects live under unless the caller checked that seal; and a
  // holder's request records nothing once its epoch has ended.
  it("review 10 #5 a seal stands over the authority of every epoch its objects live under, and an ended epoch records none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const old = { executorId: "session-1", launchId: "launch-1" };
        const { epoch: first } = yield* repo.claim(worktreeId, old.executorId, 3600, old.launchId);
        const pack = `captures/${worktreeId}/${first}/packs/${"b".repeat(64)}`;
        yield* repo.register({ ...captureInput(worktreeId, 0, null, first), holder: old });
        const oldUntil = new Date(Date.now() + 20 * 60_000);
        const live = yield* repo.recordPutAuthority(worktreeId, first, oldUntil, [], old);
        yield* repo.release(worktreeId, first);
        const now = { executorId: "session-2", launchId: "launch-2" };
        const { epoch: second } = yield* repo.claim(worktreeId, now.executorId, 3600, now.launchId);
        // The old holder's request resumes after its epoch ended: nothing recorded.
        const ended = yield* repo.recordPutAuthority(
          worktreeId,
          first,
          new Date(Date.now() + 40 * 60_000),
          [],
          old,
        );
        const oldAuthority = yield* repo.putAuthorityUntil(worktreeId, first);
        // The next epoch seals a capture carrying the old epoch's pack.
        const one = {
          ...captureInput(worktreeId, 1, `cap-${worktreeId}-0-${first}`, second),
          holder: now,
          names: [pack],
          seal: { executorId: now.launchId, holder: now.executorId },
        };
        yield* repo.register(one);
        const seal = yield* repo.sealedCompletion(worktreeId, now.launchId, second);
        const over = yield* repo.putAuthorityUntilOver(seal?.scopes ?? []);
        // A read-back that began while the old epoch's URL lives marks nothing …
        const early = yield* repo.markSealReverified(worktreeId, second, one.id, new Date());
        // … one that began after it expired does.
        const late = yield* repo.markSealReverified(
          worktreeId,
          second,
          one.id,
          new Date(oldUntil.getTime() + 1000),
        );
        // Once it is recorded, no epoch is handed authority under its prefixes unchecked.
        const oldPrefix = yield* repo.recordPutAuthority(
          worktreeId,
          first,
          new Date(Date.now() + 60 * 60_000),
        );
        const ownPrefix = yield* repo.recordPutAuthority(
          worktreeId,
          second,
          new Date(Date.now() + 60 * 60_000),
          [],
          now,
        );
        const checked = yield* repo.recordPutAuthority(
          worktreeId,
          second,
          new Date(Date.now() + 60 * 60_000),
          [one.id],
          now,
        );
        return {
          first,
          second,
          live,
          ended,
          oldAuthority,
          oldUntil,
          seal,
          over,
          early,
          late,
          oldPrefix,
          ownPrefix,
          checked,
          sealed: one.id,
        };
      }),
    );
    expect(result.live).toEqual({ recorded: true });
    expect(result.ended).toEqual({ recorded: false, reason: "lease" });
    expect(result.oldAuthority?.getTime()).toBe(result.oldUntil.getTime());
    expect(result.seal?.scopes?.map((scope) => scope.epoch)).toEqual([result.first, result.second]);
    expect(result.over?.getTime()).toBe(result.oldUntil.getTime());
    expect(result.early).toBe(false);
    expect(result.late).toBe(true);
    expect(result.oldPrefix).toEqual({
      recorded: false,
      reason: "sealed",
      sealedCaptures: [result.sealed],
    });
    expect(result.ownPrefix).toEqual({
      recorded: false,
      reason: "sealed",
      sealedCaptures: [result.sealed],
    });
    expect(result.checked).toEqual({ recorded: true });
  });

  it("launch-bound leases (0085): another launch of the holder never retakes, renews, registers under or seals a lease its launch does not hold (review 2026-09-28 (4) #11)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const sql = yield* SqlClient.SqlClient;
        const worktreeId = yield* freshWorktree;
        // A launch's lease that lapsed without a release: only that launch takes it again.
        const lapsed = yield* repo.claim(worktreeId, "session-1", 3600, "launch-new");
        yield* sql`UPDATE worktree_leases SET expires_at = now() - interval '1 second'
                    WHERE worktree_id = ${worktreeId}`;
        const retakeOld = yield* repo.claim(worktreeId, "session-1", 3600, "launch-old").pipe(
          Effect.map(() => "ok"),
          Effect.catchTag("WorktreeLeasedError", (error) => Effect.succeed(error._tag)),
        );
        const { epoch } = yield* repo.claim(worktreeId, "session-1", 3600, "launch-new");
        const oldBeat = yield* repo.heartbeat(worktreeId, epoch, 30, {
          executorId: "session-1",
          launchId: "launch-old",
        });
        const newBeat = yield* repo.heartbeat(worktreeId, epoch, 3600, {
          executorId: "session-1",
          launchId: "launch-new",
        });
        const zero = captureInput(worktreeId, 0, null, epoch);
        const oldRegister = yield* reasonOf(
          repo.register({
            ...zero,
            holder: { executorId: "session-1", launchId: "launch-old" },
            seal: { executorId: "launch-old", holder: "session-1" },
          }),
        );
        yield* repo.register({
          ...zero,
          holder: { executorId: "session-1", launchId: "launch-new" },
          seal: { executorId: "launch-new", holder: "session-1" },
        });
        const one = captureInput(worktreeId, 1, zero.id, epoch);
        // A seal naming another launch lands the capture, never the seal.
        yield* repo.register({ ...one, seal: { executorId: "launch-old", holder: "session-1" } });
        return {
          lapsedEpoch: lapsed.epoch,
          retakeOld,
          epoch,
          oldBeat,
          newBeat,
          oldRegister,
          newSeal: yield* repo.sealedCompletion(worktreeId, "launch-new", epoch),
          oldSeal: yield* repo.sealedCompletion(worktreeId, "launch-old", epoch),
          lease: yield* repo.leaseOf(worktreeId),
          head: yield* repo.headOf(worktreeId),
        };
      }),
    );
    expect(result.retakeOld).toBe("WorktreeLeasedError");
    expect(result.epoch).toBe(result.lapsedEpoch + 1);
    expect(result.oldBeat).toBe(false);
    expect(result.newBeat).toBe(true);
    expect(result.oldRegister).toBe("stale_epoch");
    expect(result.newSeal?.n).toBe(0);
    expect(result.oldSeal).toBeNull();
    expect(result.lease?.launchId).toBe("launch-new");
    expect(result.head?.headN).toBe(1);
  });

  it(
    "a register in flight never crosses a launch handoff: the handoff waits for it, and the chain's epoch never goes back (review 2026-09-28 (5) #8)",
    { timeout: 30_000 },
    async () => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* CaptureStoreRepo;
          const sql = yield* SqlClient.SqlClient;
          const worktreeId = yield* freshWorktree;
          const foreign = yield* freshWorktree;
          const first = yield* repo.claim(worktreeId, "session-1", 3600, "launch-old");
          const zero = captureInput(worktreeId, 0, null, first.epoch);
          yield* repo.register(zero);
          const state = yield* repo.referenceState([worktreeId, foreign], []);
          const guards = [worktreeId, foreign].map((id) => ({
            worktreeId: id,
            guard: Number(state.guards.get(id) ?? -1),
          }));
          // Another transaction holds the foreign chain row the old launch's register names.
          const locked = yield* Deferred.make<void>();
          const unlock = yield* Deferred.make<void>();
          const holder = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT worktree_id FROM worktree_chain
                            WHERE worktree_id = ${foreign} FOR UPDATE`;
                yield* Deferred.succeed(locked, undefined);
                yield* Deferred.await(unlock);
              }),
            ),
          );
          yield* Deferred.await(locked);
          const order: Array<string> = [];
          const one = {
            ...captureInput(worktreeId, 1, zero.id, first.epoch),
            kind: "final" as const,
          };
          const stale = yield* Effect.forkChild(
            reasonOf(
              repo.register({
                ...one,
                guards,
                holder: { executorId: "session-1", launchId: "launch-old" },
                seal: { executorId: "launch-old", holder: "session-1" },
              }),
            ).pipe(Effect.tap(() => Effect.sync(() => order.push("register")))),
          );
          const lockWaiters = sql<{ readonly waiting: number }>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          let registerWaited = false;
          for (let tries = 0; tries < 200 && !registerWaited; tries++) {
            registerWaited = ((yield* lockWaiters)[0]?.waiting ?? 0) >= 1;
            if (!registerWaited) yield* Effect.sleep("20 millis");
          }
          // The launch handoff: the old launch released, a new launch of the session claims.
          const handoff = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* repo.release(worktreeId, first.epoch);
              const next = yield* repo.claim(worktreeId, "session-1", 3600, "launch-new");
              order.push("handoff");
              return next;
            }),
          );
          // Give the handoff every chance to commit while the register still waits.
          for (let tries = 0; tries < 50 && !order.includes("handoff"); tries++) {
            if (((yield* lockWaiters)[0]?.waiting ?? 0) >= 2) break;
            yield* Effect.sleep("20 millis");
          }
          yield* Deferred.succeed(unlock, undefined);
          yield* Fiber.join(holder);
          const said = yield* Fiber.join(stale);
          const next = yield* Fiber.join(handoff);
          return {
            registerWaited,
            said,
            order,
            next,
            lease: yield* repo.leaseOf(worktreeId),
            head: yield* repo.headOf(worktreeId),
            oldSeal: yield* repo.sealedCompletion(worktreeId, "launch-old", first.epoch),
          };
        }),
      );
      expect(result.registerWaited).toBe(true);
      expect(result.next.epoch).toBe(2);
      expect(result.lease?.epoch).toBe(2);
      expect(result.lease?.launchId).toBe("launch-new");
      // Whatever landed, the chain names the live epoch: a replacement planning from it is never
      // followed by an older launch's capture.
      expect(result.head?.headEpoch).toBe(2);
      if (result.said === "ok") {
        // It landed while the old launch still held the lease, before the handoff took.
        expect(result.order).toEqual(["register", "handoff"]);
        expect(result.oldSeal?.n).toBe(1);
      } else {
        expect(result.said).toBe("stale_epoch");
        expect(result.oldSeal).toBeNull();
      }
    },
  );

  it("seals (0080): the register CAS records a seal only when it lands and the lease names its executor; the newest epoch reads first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const first = yield* repo.claim(worktreeId, "exec-a", 3600);
        const zero = captureInput(worktreeId, 0, null, first.epoch);
        yield* repo.register({ ...zero, seal: { executorId: "exec-a", holder: "exec-a" } });
        // A register whose CAS misses (a stale parent) seals nothing.
        const missed = yield* reasonOf(
          repo.register({
            ...captureInput(worktreeId, 1, "not-the-head", first.epoch),
            seal: { executorId: "exec-a", holder: "exec-a" },
          }),
        );
        // A seal naming an executor the lease does not name lands the capture, not the seal.
        const one = captureInput(worktreeId, 1, zero.id, first.epoch);
        yield* repo.register({ ...one, seal: { executorId: "exec-b", holder: "exec-b" } });
        const forB = yield* repo.sealedCompletion(worktreeId, "exec-b");
        // The same executor seals again later in the epoch: the newer capture stands.
        const two = captureInput(worktreeId, 2, one.id, first.epoch);
        yield* repo.register({ ...two, seal: { executorId: "exec-a", holder: "exec-a" } });
        const inFirst = yield* repo.sealedCompletion(worktreeId, "exec-a", first.epoch);
        // A new epoch, the same executor: the newest epoch reads first; the old one still reads.
        yield* repo.release(worktreeId, first.epoch);
        const second = yield* repo.claim(worktreeId, "exec-a", 3600);
        const three = captureInput(worktreeId, 3, two.id, second.epoch);
        yield* repo.register({ ...three, seal: { executorId: "exec-a", holder: "exec-a" } });
        const newest = yield* repo.sealedCompletion(worktreeId, "exec-a");
        const old = yield* repo.sealedCompletion(worktreeId, "exec-a", first.epoch);
        const none = yield* repo.sealedCompletion(worktreeId, "exec-a", second.epoch + 1);
        return {
          missed,
          forB,
          inFirst,
          newest,
          old,
          none,
          ids: { two: two.id, three: three.id },
          epochs: { first: first.epoch, second: second.epoch },
        };
      }),
    );
    expect(result.missed).toBe("wrong_parent");
    expect(result.forB).toBeNull();
    expect(result.inFirst).toMatchObject({
      epoch: result.epochs.first,
      captureId: result.ids.two,
      n: 2,
      executorId: "exec-a",
    });
    expect(result.newest).toMatchObject({
      epoch: result.epochs.second,
      captureId: result.ids.three,
      n: 3,
    });
    expect(result.old?.captureId).toBe(result.ids.two);
    expect(result.none).toBeNull();
  });

  it("guard (0076): a register naming another chain's objects bumps that chain's guard, and misses if it moved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const own = yield* freshWorktree;
        const other = yield* freshWorktree;
        const { epoch } = yield* repo.claim(own, "exec", 3600);
        const state = yield* repo.referenceState([own, other], []);
        const guards = [own, other].map((worktreeId) => ({
          worktreeId,
          guard: state.guards.get(worktreeId) ?? -1,
        }));
        // Retention condemns something of the other chain after the register read.
        const condemned = yield* repo.condemn(
          other,
          state.guards.get(other) ?? -1,
          [`captures/${other}/1/packs/${"d".repeat(64)}`],
          claimOf(`other-${other}`),
        );
        const zero = captureInput(own, 0, null, epoch);
        const missed = yield* repo.register({ ...zero, guards }).pipe(
          Effect.map(() => "ok"),
          Effect.catch((error) => Effect.succeed(error.reason)),
        );
        const fresh = yield* repo.referenceState([own, other], []);
        const landed = yield* repo.register({
          ...zero,
          guards: [own, other].map((worktreeId) => ({
            worktreeId,
            guard: fresh.guards.get(worktreeId) ?? -1,
          })),
        });
        const bumped = yield* repo.referenceState([own, other], []);
        return { condemned, missed, landed, fresh, bumped };
      }),
    );
    expect(result.condemned).toBe(true);
    expect(result.missed).toBe("guard_moved");
    expect(result.landed).toEqual({ lostAck: false });
    const [own, other] = [...result.fresh.guards.keys()];
    if (own === undefined || other === undefined) throw new Error("guards missing");
    expect(result.bumped.guards.get(own)).toBe((result.fresh.guards.get(own) ?? 0) + 1);
    expect(result.bumped.guards.get(other)).toBe((result.fresh.guards.get(other) ?? 0) + 1);
  });

  it("store refs move only by versioned compare-and-swap", async () => {
    const result = await run(
      Effect.gen(function* () {
        const refs = yield* StoreRefsRepo;
        const created = yield* refs.set(PROJECT, "refs/heads/main", sha("1"), null);
        const dup = yield* tagOf(refs.set(PROJECT, "refs/heads/main", sha("2"), null));
        const moved = yield* refs.set(PROJECT, "refs/heads/main", sha("2"), created.version);
        const staleMove = yield* tagOf(
          refs.set(PROJECT, "refs/heads/main", sha("3"), created.version),
        );
        yield* refs.set(PROJECT, "refs/mend/base/x", sha("4"), null);
        const map = yield* refs.refsMap(PROJECT);
        const staleRemove = yield* tagOf(refs.remove(PROJECT, "refs/heads/main", created.version));
        yield* refs.remove(PROJECT, "refs/heads/main", moved.version);
        const gone = yield* refs.get(PROJECT, "refs/heads/main");
        return { created, dup, moved, staleMove, map, staleRemove, gone };
      }),
    );
    expect(result.created.version).toBe(1);
    expect(result.dup).toBe("StoreRefConflictError");
    expect(result.moved.version).toBe(2);
    expect(result.moved.sha).toBe("2".repeat(40));
    expect(result.staleMove).toBe("StoreRefConflictError");
    expect(result.map).toEqual({
      "refs/heads/main": "2".repeat(40),
      "refs/mend/base/x": "4".repeat(40),
    });
    expect(result.staleRemove).toBe("StoreRefConflictError");
    expect(result.gone).toBeNull();
  });

  /**
   * R5 of the decision record, cheaply: two simulated executors take random actions (claim
   * with a 0 s or 30 s lease, heartbeat, register the next capture as they believe it, release)
   * in seeded random interleavings, some steps concurrent. Invariants after every step: no
   * chain advance by an epoch below the lease's, no two captures share an `n`, the head is the
   * newest capture and the chain is dense.
   */
  it("property: random two-executor interleavings never advance the chain by a fenced epoch", async () => {
    const seed = Number(process.env["MEND_CAPTURE_PROP_SEED"] ?? 20260912);
    let state = seed >>> 0;
    const rand = () => {
      // xorshift32
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    };
    const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(rand() * items.length)]!;
    interface Executor {
      readonly name: string;
      epoch: number | null;
      knownN: number;
      knownHead: string | null;
      registered: Array<{ n: number; epoch: number }>;
    }
    const iterations = Number(process.env["MEND_CAPTURE_PROP_ITERATIONS"] ?? 300);
    const stepsPer = 6;

    await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const sql = yield* SqlClient.SqlClient;
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const worktreeId = yield* freshWorktree;
          const executors: Array<Executor> = [
            { name: "A", epoch: null, knownN: -1, knownHead: null, registered: [] },
            { name: "B", epoch: null, knownN: -1, knownHead: null, registered: [] },
          ];
          const step = (executor: Executor) => {
            const action = pick([
              "claim",
              "claim",
              "heartbeat",
              "register",
              "register",
              "register",
              "release",
              "refresh",
            ] as const);
            switch (action) {
              case "claim":
                return repo.claim(worktreeId, executor.name, pick([0, 30])).pipe(
                  Effect.map(({ epoch }) => {
                    executor.epoch = epoch;
                  }),
                  Effect.catch(() => Effect.void),
                );
              case "heartbeat":
                return executor.epoch === null
                  ? Effect.void
                  : repo.heartbeat(worktreeId, executor.epoch).pipe(Effect.asVoid);
              case "release":
                return executor.epoch === null
                  ? Effect.void
                  : repo.release(worktreeId, executor.epoch).pipe(Effect.asVoid);
              case "refresh":
                return repo.headOf(worktreeId).pipe(
                  Effect.map((head) => {
                    if (head !== null) {
                      executor.knownN = head.headN;
                      executor.knownHead = head.head?.id ?? null;
                    }
                  }),
                );
              case "register": {
                if (executor.epoch === null) return Effect.void;
                const epoch = executor.epoch;
                const n = executor.knownN + 1;
                const input = captureInput(
                  worktreeId,
                  n,
                  executor.knownHead,
                  epoch,
                  `cap-${worktreeId}-${executor.name}-${n}-${epoch}-${Math.floor(rand() * 1e9)}`,
                );
                return repo.register(input).pipe(
                  Effect.map(() => {
                    executor.registered.push({ n, epoch });
                    executor.knownN = n;
                    executor.knownHead = input.id;
                  }),
                  Effect.catch(() => Effect.void),
                );
              }
            }
          };
          for (let s = 0; s < stepsPer; s += 1) {
            if (rand() < 0.3) {
              yield* Effect.all([step(executors[0]!), step(executors[1]!)], {
                concurrency: "unbounded",
              });
            } else {
              yield* step(pick(executors));
            }
            // Invariants, read straight from the tables.
            const [lease] = yield* sql<{ readonly epoch: number }>`
              SELECT epoch::int AS epoch FROM worktree_leases WHERE worktree_id = ${worktreeId}`;
            const rows = yield* sql<{
              readonly n: number;
              readonly epoch: number;
              readonly id: string;
              readonly parent: string | null;
            }>`
              SELECT n, epoch::int AS epoch, id, parent FROM captures
               WHERE worktree_id = ${worktreeId} ORDER BY n`;
            const [chain] = yield* sql<{
              readonly headN: number;
              readonly headCapture: string | null;
              readonly headEpoch: number;
            }>`
              SELECT head_n, head_capture, head_epoch::int AS head_epoch
                FROM worktree_chain WHERE worktree_id = ${worktreeId}`;
            const leaseEpoch = Number(lease?.epoch ?? 0);
            // Dense, parent-linked chain; the head is the newest row.
            rows.forEach((row, index) => {
              expect(row.n).toBe(index);
              expect(row.parent).toBe(index === 0 ? null : rows[index - 1]?.id);
              // A capture's epoch never exceeds the lease epoch that existed when it landed,
              // and the chain's epochs are non-decreasing (a fenced epoch never re-advances).
              expect(row.epoch).toBeLessThanOrEqual(leaseEpoch);
              if (index > 0) expect(row.epoch).toBeGreaterThanOrEqual(rows[index - 1]?.epoch ?? 0);
            });
            expect(chain?.headN).toBe(rows.length - 1);
            expect(chain?.headCapture).toBe(rows.at(-1)?.id ?? null);
            expect(Number(chain?.headEpoch)).toBeGreaterThanOrEqual(rows.at(-1)?.epoch ?? 0);
          }
          // What each executor believes it registered is exactly what landed under its epoch.
          const landed = yield* sql<{ readonly n: number; readonly epoch: number }>`
            SELECT n, epoch::int AS epoch FROM captures WHERE worktree_id = ${worktreeId} ORDER BY n`;
          const believed = executors
            .flatMap((executor) => executor.registered)
            .toSorted((a, b) => a.n - b.n);
          expect(believed).toEqual(landed.map((row) => ({ n: row.n, epoch: Number(row.epoch) })));
        }
      }),
    );
  }, 120_000);

  it("pack index bindings (0099): one digest per key while a binding lives; extended and read back", async () => {
    const key = `captures/wt-bound-${process.pid}/1/g0/packs/${"a".repeat(64)}.idx`;
    const first = "1".repeat(64);
    const other = "2".repeat(64);
    const t0 = new Date("2026-10-02T12:00:00.000Z");
    const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const reserved = yield* repo.reserveBoundIndex(key, first, t0, minutes(10));
        // The same bytes again: extended, never shortened, and no longer fresh.
        const again = yield* repo.reserveBoundIndex(key, first, minutes(1), minutes(5));
        const conflict = yield* repo.reserveBoundIndex(key, other, minutes(2), minutes(12));
        const live = yield* repo.boundIndexesAmong([key, "captures/none.idx"], minutes(9));
        yield* repo.extendBoundIndex(key, first, minutes(9), minutes(15));
        yield* repo.extendBoundIndex(key, other, minutes(9), minutes(60));
        const extended = yield* repo.boundIndexesAmong([key], minutes(14));
        // Dead at 15 minutes: other bytes may be bound, and that reservation is fresh.
        const dead = yield* repo.boundIndexesAmong([key], minutes(15));
        const replaced = yield* repo.reserveBoundIndex(key, other, minutes(15), minutes(25));
        const kept = yield* repo.boundIndexesAmong([key], minutes(16));
        return { reserved, again, conflict, live, extended, dead, replaced, kept };
      }),
    );
    expect(result.reserved).toEqual({ outcome: "reserved", fresh: true });
    expect(result.again).toEqual({ outcome: "reserved", fresh: false });
    expect(result.conflict).toEqual({ outcome: "conflict" });
    expect(result.live).toEqual([{ key, sha256: first, until: minutes(10) }]);
    expect(result.extended).toEqual([{ key, sha256: first, until: minutes(15) }]);
    expect(result.dead).toEqual([]);
    expect(result.replaced).toEqual({ outcome: "reserved", fresh: true });
    expect(result.kept).toEqual([{ key, sha256: other, until: minutes(25) }]);
  });

  it("pack index bindings (0099): two reservations of one key at once never both bind other bytes", async () => {
    const key = `captures/wt-race-${process.pid}/1/g0/packs/${"b".repeat(64)}.idx`;
    const now = new Date();
    const until = new Date(now.getTime() + 60_000);
    const outcomes = await run(
      Effect.flatMap(CaptureStoreRepo, (repo) =>
        Effect.all(
          Array.from({ length: 8 }, (_, n) =>
            repo.reserveBoundIndex(key, String(n % 2).repeat(64), now, until),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    );
    // Whichever digest got there first holds the key: its four reserve, the other four conflict.
    expect(outcomes.filter((outcome) => outcome.outcome === "reserved")).toHaveLength(4);
    expect(outcomes.filter((outcome) => outcome.outcome === "conflict")).toHaveLength(4);
    expect(
      outcomes.filter((outcome) => outcome.outcome === "reserved" && outcome.fresh),
    ).toHaveLength(1);
  });

  it("pack index bindings (0099): the same bytes bound again never shorten a binding, and an extension finds its binding or says so", async () => {
    const key = `captures/wt-extend-${process.pid}/1/g0/packs/${"c".repeat(64)}.idx`;
    const digest = "3".repeat(64);
    const t0 = new Date("2026-10-02T13:00:00.000Z");
    const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        yield* repo.reserveBoundIndex(key, digest, t0, minutes(20));
        // The URL was signed late: its binding is extended past what the reservation said.
        const extended = yield* repo.extendBoundIndex(key, digest, minutes(7), minutes(27));
        // A second call for the same bytes worked its expiry out earlier (Astra review: it
        // overwrote 27 with 21, and the seal stood while the first URL could still be used).
        yield* repo.reserveBoundIndex(key, digest, minutes(1), minutes(21));
        const kept = yield* repo.boundIndexesAmong([key], minutes(22));
        // An extension to an earlier time shortens nothing either.
        const earlier = yield* repo.extendBoundIndex(key, digest, minutes(2), minutes(5));
        const still = yield* repo.boundIndexesAmong([key], minutes(22));
        // No binding of these bytes to extend: said, so the URL does not leave.
        const other = yield* repo.extendBoundIndex(key, "4".repeat(64), minutes(8), minutes(30));
        const none = yield* repo.extendBoundIndex(`${key}.gone`, digest, minutes(8), minutes(30));
        // A binding that lapsed is not revived by a call that stalled past it (Astra review,
        // third pass): a seal may have stood over other bytes since.
        const lapsed = yield* repo.extendBoundIndex(key, digest, minutes(28), minutes(48));
        const gone = yield* repo.boundIndexesAmong([key], minutes(28));
        return { extended, kept, earlier, still, other, none, lapsed, gone };
      }),
    );
    expect(result.extended).toBe(true);
    expect(result.kept).toEqual([{ key, sha256: digest, until: minutes(27) }]);
    expect(result.earlier).toBe(true);
    expect(result.still).toEqual([{ key, sha256: digest, until: minutes(27) }]);
    expect(result.other).toBe(false);
    expect(result.none).toBe(false);
    expect(result.lapsed).toBe(false);
    expect(result.gone).toEqual([]);
  });

  it("pack index bindings (0099): only bindings long dead are swept, never one renewed", async () => {
    const dead = `captures/wt-sweep-${process.pid}/1/g0/packs/${"d".repeat(64)}.idx`;
    const renewed = `captures/wt-sweep-${process.pid}/1/g0/packs/${"e".repeat(64)}.idx`;
    const other = `captures/wt-sweep-${process.pid}/1/g0/packs/${"f".repeat(64)}.idx`;
    const digest = "5".repeat(64);
    const t0 = new Date("2026-10-01T09:00:00.000Z");
    const hours = (n: number) => new Date(t0.getTime() + n * 3_600_000);
    const left = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* CaptureStoreRepo;
        yield* repo.reserveBoundIndex(dead, digest, t0, hours(0.25));
        yield* repo.reserveBoundIndex(renewed, digest, t0, hours(0.25));
        // Three hours on: `renewed` is bound again, and the sweep that runs with any
        // reservation takes `dead` only.
        yield* repo.reserveBoundIndex(renewed, digest, hours(3), hours(3.25));
        yield* repo.reserveBoundIndex(other, digest, hours(3), hours(3.25));
        const rows = yield* sql<{ readonly key: string }>`
          SELECT key FROM capture_bound_indexes
           WHERE key IN (${dead}, ${renewed}, ${other}) ORDER BY key`;
        return rows.map((row) => row.key);
      }),
    );
    expect(left).toEqual([renewed, other].toSorted());
  });

  it("launch answers (0100): what a launch listed when it planned is kept, and the latest plan replaces it", async () => {
    const launch = `launch:answers-${process.pid}`;
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const never = yield* repo.launchAnswers(launch);
        yield* repo.noteLaunchAnswers(launch, ["present", "sha256"]);
        const first = yield* repo.launchAnswers(launch);
        yield* repo.noteLaunchAnswers(launch, []);
        return { never, first, replanned: yield* repo.launchAnswers(launch) };
      }),
    );
    expect(result).toEqual({ never: null, first: ["present", "sha256"], replanned: [] });
  });

  it("sealAuthorityOver: what is on record and whether it is whole, in one read", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* CaptureStoreRepo;
        const here = yield* freshWorktree;
        const gone = yield* freshWorktree;
        const scopes = [
          { worktreeId: here, epoch: 1 },
          { worktreeId: here, epoch: 2 },
          { worktreeId: gone, epoch: 1 },
        ];
        const now = new Date();
        const later = new Date(now.getTime() + 10 * 60_000);
        const none = yield* repo.sealAuthorityOver(scopes, now);
        yield* repo.recordPutAuthority(gone, 1, later);
        const recorded = yield* repo.sealAuthorityOver(scopes, now);
        // The server this one replaced may have bound an index URL nothing recorded: until
        // the cutover the record is not whole, whatever it holds.
        yield* sql`INSERT INTO capture_bound_index_cutover (until) VALUES (${later})`;
        const beforeCutover = yield* repo.sealAuthorityOver(scopes, now);
        const afterCutover = yield* repo.sealAuthorityOver(scopes, later);
        yield* sql`DELETE FROM capture_bound_index_cutover`;
        // A worktree that is gone took its authority with it: seen gone, never as "no authority".
        yield* sql`DELETE FROM worktrees WHERE id = ${gone}`;
        return {
          none,
          recorded,
          beforeCutover,
          afterCutover,
          afterDelete: yield* repo.sealAuthorityOver(scopes, now),
          own: yield* repo.sealAuthorityOver(scopes.slice(0, 2), now),
          empty: yield* repo.sealAuthorityOver([], now),
          later,
        };
      }),
    );
    expect(result.none).toEqual({ until: null, spokenFor: true });
    expect(result.recorded).toEqual({ until: result.later, spokenFor: true });
    expect(result.beforeCutover).toEqual({ until: result.later, spokenFor: false });
    expect(result.afterCutover).toEqual({ until: result.later, spokenFor: true });
    expect(result.afterDelete).toEqual({ until: null, spokenFor: false });
    expect(result.own).toEqual({ until: null, spokenFor: true });
    expect(result.empty).toEqual({ until: null, spokenFor: true });
  });
});

/** Every migration before 0099, then `seed`, then 0099: the minutes its cutover is ahead. */
const upTo0099 = (seed: Effect.Effect<void, unknown, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
    for (const [name, migration] of ordered) {
      if (name.localeCompare("0099") >= 0) continue;
      yield* migration;
    }
    yield* seed;
    const [, migration] = ordered.find(([name]) => name.startsWith("0099")) ?? [];
    if (migration === undefined) return yield* Effect.die("no 0099");
    yield* migration;
    const [row] = yield* sql<{ readonly minutes: number | null }>`
      SELECT (SELECT round(extract(epoch FROM max(until) - now()) / 60)::int
                FROM capture_bound_index_cutover) AS minutes`;
    return row?.minutes ?? null;
  });

// Astra review 2026-10-02: the server before 0099 kept its pack index bindings in memory. A URL
// it bound in its last minutes outlives it, and nothing in the new table says so.
describe.skipIf(!reachable)("migration 0099 over a server that bound index URLs in memory", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const databases = {
    used: `mend_bound_cutover_used_${stamp}`,
    fresh: `mend_bound_cutover_fresh_${stamp}`,
  };
  const on = (database: string) => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    const layer = MendDBLive.pipe(
      Layer.provideMerge(
        PgClient.layer({
          url: Redacted.make(url.toString()),
          transformResultNames: Str.snakeToCamel,
          transformQueryNames: Str.camelToSnake,
        }),
      ),
    );
    return <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
  };

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const database of Object.values(databases)) {
          yield* sql.unsafe(`CREATE DATABASE ${database}`);
        }
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const database of Object.values(databases)) {
          yield* sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        }
      }),
    );
  });

  it("a database with worktrees waits out the old server's longest URL once; one without waits for nothing", async () => {
    const used = await on(databases.used)(
      upTo0099(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO projects (id, name, store_path, default_branch, organization_id)
            VALUES ('p-used', 'web', '/store/p/repo.git', 'main',
                    (SELECT id FROM organizations LIMIT 1))`;
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES ('wt-used', 'p-used', 'wt-used', 'wt-used', 'mend/wt/wt-used', 'abc')`;
        }),
      ),
    );
    expect(used).toBe(20);
    expect(await on(databases.fresh)(upTo0099(Effect.void))).toBeNull();
  });
});

// Review 2026-09-28 (10) #5, seals recorded before 0092: each gets every epoch prefix its
// capture's sections and manifest name, and its mark — made against its own epoch — is dropped.
describe.skipIf(!reachable)("migration 0092 over seals recorded before it", () => {
  const LEGACY_DB = `mend_capture_seal_scopes_${process.pid}_${Date.now()}`;
  const legacyUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${LEGACY_DB}`;
    return url.toString();
  })();
  const legacyLayer = CaptureStoreRepoLive.pipe(
    Layer.provideMerge(
      MendDBLive.pipe(
        Layer.provideMerge(
          PgClient.layer({
            url: Redacted.make(legacyUrl),
            transformResultNames: Str.snakeToCamel,
            transformQueryNames: Str.camelToSnake,
          }),
        ),
      ),
    ),
  );
  const legacy = <A, E>(effect: Effect.Effect<A, E, CaptureStoreRepo | SqlClient.SqlClient>) =>
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

  it("names every epoch a legacy seal's capture carries objects of, and reads it back again", async () => {
    const result = await legacy(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* CaptureStoreRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        for (const [name, migration] of ordered) {
          if (name.localeCompare("0092") >= 0) continue;
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-legacy', 'web', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        for (const id of ["wt-legacy", "wt-source"]) {
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${id}, 'p-legacy', ${id}, ${id}, ${`mend/wt/${id}`}, 'abc')`;
        }
        const sections = {
          git: { packs: [`captures/wt-legacy/3/packs/${"c".repeat(64)}.pack`] },
          workspace: {
            root: `captures/wt-legacy/2/trees/${"d".repeat(64)}`,
            packs: [`captures/wt-source/7/packs/${"e".repeat(64)}`],
          },
        };
        yield* sql`
          INSERT INTO captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key,
                                sections, git_fsck)
          VALUES ('cap-legacy', 'wt-legacy', 4, NULL, 4, 40, 'final',
                  ${`captures/wt-legacy/4/manifests/${"f".repeat(64)}`},
                  ${JSON.stringify(sections)}::jsonb, 'verified')`;
        yield* sql`
          INSERT INTO capture_seals (worktree_id, epoch, executor_id, capture_id, n, reverified_at)
          VALUES ('wt-legacy', 4, 'launch-legacy', 'cap-legacy', 4, now())`;
        const [, migration] = ordered.find(([name]) => name.startsWith("0092")) ?? [];
        if (migration === undefined) return yield* Effect.die("no 0092");
        yield* migration;
        return yield* repo.sealedCompletion(WorktreeId.make("wt-legacy"), "launch-legacy", 4);
      }),
    );
    expect(result?.scopes).toEqual([
      { worktreeId: "wt-legacy", epoch: 2 },
      { worktreeId: "wt-legacy", epoch: 3 },
      { worktreeId: "wt-legacy", epoch: 4 },
      { worktreeId: "wt-source", epoch: 7 },
    ]);
    expect(result?.reverifiedAt).toBeNull();
  });
});

// Review 2026-09-28 (13) #1: a git step the Mend host could not finish recorded a sound capture
// `failed`, and why was never stored. 0094 puts every `failed` row back to `unverified`, once, so
// the next plan, register or seal re-ask verifies it again; the other outcomes stay as they were.
describe.skipIf(!reachable)("migration 0094 over git sections recorded failed before it", () => {
  const LEGACY_DB = `mend_capture_git_fsck_${process.pid}_${Date.now()}`;
  const legacyUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${LEGACY_DB}`;
    return url.toString();
  })();
  const legacyLayer = CaptureStoreRepoLive.pipe(
    Layer.provideMerge(
      MendDBLive.pipe(
        Layer.provideMerge(
          PgClient.layer({
            url: Redacted.make(legacyUrl),
            transformResultNames: Str.snakeToCamel,
            transformQueryNames: Str.camelToSnake,
          }),
        ),
      ),
    ),
  );
  const legacy = <A, E>(effect: Effect.Effect<A, E, CaptureStoreRepo | SqlClient.SqlClient>) =>
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

  it("puts every failed git section back to unverified and leaves the others", async () => {
    const result = await legacy(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* CaptureStoreRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        for (const [name, migration] of ordered) {
          if (name.localeCompare("0094") >= 0) continue;
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-legacy', 'web', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-legacy', 'p-legacy', 'wt-legacy', 'wt-legacy', 'mend/wt/wt-legacy', 'abc')`;
        const outcomes = ["verified", "failed", "unverified", "failed"] as const;
        for (const [at, outcome] of outcomes.entries()) {
          yield* sql`
            INSERT INTO captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key,
                                  sections, git_fsck)
            VALUES (${`cap-${at}`}, 'wt-legacy', ${at}, NULL, 1, ${at * 10}, 'turn',
                    ${`captures/wt-legacy/1/manifests/${String(at).repeat(64)}`},
                    '{}'::jsonb, ${outcome})`;
        }
        const [, migration] = ordered.find(([name]) => name.startsWith("0094")) ?? [];
        if (migration === undefined) return yield* Effect.die("no 0094");
        yield* migration;
        const after: Array<string | undefined> = [];
        for (const at of outcomes.keys())
          after.push((yield* repo.captureById(`cap-${at}`))?.gitFsck);
        return after;
      }),
    );
    expect(result).toEqual(["verified", "unverified", "unverified", "unverified"]);
  });
});
