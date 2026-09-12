import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
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
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES (${PROJECT}, 'capture-fixture', NULL, '/store/capture-fixture/repo.git', 'main')`;
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

  it("an expired lease is claimable and fences the previous holder", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const worktreeId = yield* freshWorktree;
        const first = yield* repo.claim(worktreeId, "exec-a", 0);
        const second = yield* repo.claim(worktreeId, "exec-b");
        const stale = yield* tagOf(repo.register(captureInput(worktreeId, 0, null, first.epoch)));
        const live = yield* tagOf(repo.register(captureInput(worktreeId, 0, null, second.epoch)));
        return { first, second, stale, live };
      }),
    );
    expect(result.first.epoch).toBe(1);
    expect(result.second.epoch).toBe(2);
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
});
