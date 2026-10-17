import { WS_METHODS, type VcsStatusStreamEvent } from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * VCS status (ADR 0012, phase 2): the thread's branch and its change's totals, from Mend's
 * `GET /api/changes/:id/stats`, kept current while the client watches.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const WORKTREE = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
const STORE = "/var/lib/mend/store/project-1/repo.git";
type Event = VcsStatusStreamEvent;
const statsReadsOf = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.path.endsWith("/stats")).length;
const isUpdate = (event: Event): event is Extract<Event, { _tag: "localUpdated" }> =>
  event._tag === "localUpdated";

describe("VCS status", () => {
  it.effect("reports the thread's branch and change, and follows it as turns change it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 10, deletions: 3 });
        const { rpc } = yield* pairAndConnect(mend, "VCS");

        const status = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.strictEqual(status.refName, "mend/wt-session-1");
        assert.isFalse(status.isDefaultRef);
        assert.isTrue(status.isRepo);
        assert.isTrue(status.hasPrimaryRemote);
        assert.isTrue(status.hasWorkingTreeChanges);
        assert.deepStrictEqual(status.workingTree, { files: [], insertions: 0, deletions: 0 });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "main",
          insertions: 10,
          deletions: 3,
        });
        // Mend tracks no upstream for a session's branch: nothing is claimed about one.
        assert.isFalse(status.hasUpstream);
        assert.strictEqual(status.aheadCount, 0);
        assert.isNull(status.pr);

        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        const snapshot = yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
          ),
        );
        assert.isNull(snapshot.remote);
        assert.strictEqual(snapshot.local.branchChanges?.insertions, 10);

        // A turn changes the worktree; the status follows.
        mend.workbench.stats.set("change-session-1", { files: 3, additions: 25, deletions: 3 });
        mend.workbench.addTurn("session-1", "Add a parser");
        // Changes within a second are read once, a second after the first of them.
        yield* timers.runOut("1 second", "the status refresh window");
        const updated = yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "localUpdated" }> =>
              event._tag === "localUpdated",
          ),
        );
        assert.strictEqual(updated.local.branchChanges?.insertions, 25);

        // The project's root is its default branch, with no change of its own.
        const root = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: STORE });
        assert.strictEqual(root.refName, "main");
        assert.isTrue(root.isDefaultRef);
        assert.isFalse(root.hasWorkingTreeChanges);
        assert.isUndefined(root.branchChanges);

        const elsewhere = yield* Effect.exit(rpc[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp" }));
        assert.isTrue(Exit.isFailure(elsewhere));
        if (Exit.isFailure(elsewhere)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(elsewhere.cause));
          assert.strictEqual(error?._tag, "GitManagerError");
        }
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("lists the project's branches as Mend reports them, and the thread's own", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.branches.set("project-1", [
          { name: "main", isDefault: true },
          { name: "release/1.x", isDefault: false },
        ]);
        const { rpc } = yield* pairAndConnect(mend, "REFS");

        // The project's root: every branch its store holds, a non-default base among them.
        const root = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE });
        assert.deepStrictEqual(root.refs, [
          { name: "main", current: true, isDefault: true, worktreePath: null },
          { name: "release/1.x", current: false, isDefault: false, worktreePath: null },
        ]);
        assert.isTrue(root.isRepo);
        assert.isNull(root.nextCursor);
        assert.strictEqual(root.totalCount, 2);
        const release = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE, query: "release/1.x" });
        assert.deepStrictEqual(
          release.refs.map((ref) => ref.name),
          ["release/1.x"],
        );

        // A thread: its own branch, current in its worktree, before the project's.
        const thread = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: WORKTREE });
        assert.deepStrictEqual(thread.refs, [
          { name: "mend/wt-session-1", current: true, isDefault: false, worktreePath: WORKTREE },
          { name: "main", current: false, isDefault: true, worktreePath: null },
          { name: "release/1.x", current: false, isDefault: false, worktreePath: null },
        ]);
        // Mend lists no remote refs, so none is claimed.
        const remote = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: WORKTREE, refKind: "remote" });
        assert.deepStrictEqual(remote.refs, []);

        const elsewhere = yield* Effect.exit(rpc[WS_METHODS.vcsListRefs]({ cwd: "/tmp" }));
        assert.isTrue(Exit.isFailure(elsewhere));
        if (Exit.isFailure(elsewhere)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(elsewhere.cause));
          assert.strictEqual(error?._tag, "GitCommandError");
        }
      }),
    ),
  );

  it.live(
    "pages many branches as t3code asks: limit, cursor, and the count of them all (R648-2)",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.branches.set("project-1", [
            { name: "main", isDefault: true },
            ...Array.from({ length: 30 }, (_, index) => ({
              name: `feature-${index + 1}`,
              isDefault: false,
            })),
          ]);
          const { rpc } = yield* pairAndConnect(mend, "REFS-PAGES");
          const first = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE, limit: 1 });
          assert.deepStrictEqual(
            first.refs.map((ref) => ref.name),
            ["main"],
          );
          assert.strictEqual(first.nextCursor, 1);
          assert.strictEqual(first.totalCount, 31);
          const next = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE, limit: 1, cursor: 1 });
          assert.deepStrictEqual(
            next.refs.map((ref) => ref.name),
            ["feature-1"],
          );
          assert.strictEqual(next.nextCursor, 2);
          const last = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE, cursor: 30 });
          assert.deepStrictEqual(
            last.refs.map((ref) => ref.name),
            ["feature-30"],
          );
          assert.isNull(last.nextCursor);
          const past = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE, limit: 1, cursor: 999 });
          assert.deepStrictEqual(past.refs, []);
          assert.isNull(past.nextCursor);
          assert.strictEqual(past.totalCount, 31);
        }),
      ),
  );

  it.live("invents no ref when the store holds none", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.branches.set("project-1", []);
        const { rpc } = yield* pairAndConnect(mend, "REFS-EMPTY");
        const root = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: STORE });
        assert.deepStrictEqual(root.refs, []);
        assert.strictEqual(root.totalCount, 0);
        // A thread still has its own branch: Mend's session names it.
        const thread = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: WORKTREE });
        assert.deepStrictEqual(
          thread.refs.map((ref) => ref.name),
          ["mend/wt-session-1"],
        );
      }),
    ),
  );

  it.effect("follows every session in the worktree, as each adds to its one change", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.addSession({ id: "session-2", projectId: "project-1", joins: "session-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "SHARED-VCS");
        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
          ),
        );
        // The other session's turn moves the change.
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 25, deletions: 0 });
        mend.workbench.addTurn("session-2", "Add a lexer");
        yield* timers.runOut("1 second", "the status refresh window");
        const updated = yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "localUpdated" }> =>
              event._tag === "localUpdated",
          ),
        );
        assert.strictEqual(updated.local.branchChanges?.insertions, 25);
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("never calls a worktree clean while its change has files, committed or not", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 0, additions: 0, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "CLEAN");
        const clean = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.isFalse(clean.hasWorkingTreeChanges);
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 1, deletions: 0 });
        const changed = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.isTrue(changed.hasWorkingTreeChanges);
        assert.deepStrictEqual(changed.workingTree, { files: [], insertions: 0, deletions: 0 });
        assert.deepStrictEqual(changed.branchChanges, {
          baseRef: "main",
          insertions: 1,
          deletions: 0,
        });
      }),
    ),
  );

  it.effect("sends what a refresh read down the status stream at once", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "REFRESH");
        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
          ),
        );
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 30, deletions: 0 });
        const refreshed = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.strictEqual(refreshed.branchChanges?.insertions, 30);
        const updated = yield* TestClock.withLive(
          stream.next(
            (event): event is Extract<Event, { _tag: "localUpdated" }> =>
              event._tag === "localUpdated",
          ),
        );
        assert.strictEqual(updated.local.branchChanges?.insertions, 30);
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("never sends an older read after a newer one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "ORDER");
        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        yield* stream.next(
          (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
        );
        const refresh = rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE }).pipe(
          Effect.map((status) => status.branchChanges?.insertions),
        );

        // A read of 20 is slow to answer; the change moves to 30 and another refresh asks.
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 20, deletions: 0 });
        const held = mend.workbench.holdNextStatsRead();
        const slow = yield* Effect.forkScoped(refresh);
        yield* Effect.promise(() => held.entered);
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 30, deletions: 0 });
        const later = yield* Effect.forkScoped(refresh);
        // Long enough for the later refresh to have read and answered, were it not held back.
        yield* Effect.sleep("300 millis");
        held.release();
        assert.strictEqual(yield* Fiber.join(slow), 20);
        assert.strictEqual(yield* Fiber.join(later), 30);

        const shown: Array<number | undefined> = [];
        for (;;) {
          const update = yield* Effect.option(stream.next(isUpdate, "400 millis"));
          if (Option.isNone(update)) break;
          shown.push(update.value.local.branchChanges?.insertions);
        }
        assert.deepStrictEqual(shown, [20, 30]);
      }),
    ),
  );

  it.live("opens a stream on the newer read when an older one answers after it subscribed", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 20, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "OPENING");
        const held = mend.workbench.holdNextStatsRead();
        const slow = yield* Effect.forkScoped(rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE }));
        yield* Effect.promise(() => held.entered);
        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 30, deletions: 0 });
        // Long enough for the subscription to be waiting behind the read in flight.
        yield* Effect.sleep("300 millis");
        held.release();
        yield* Fiber.join(slow);
        const snapshot = yield* stream.next(
          (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
        );
        assert.strictEqual(snapshot.local.branchChanges?.insertions, 30);
        assert.isTrue(
          yield* stream.quiet((event) => event._tag === "localUpdated"),
          "no older read follows the snapshot",
        );
      }),
    ),
  );

  it.live("reads Mend twice for a burst of refreshes, however many", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "BURST");
        const refresh = rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE }).pipe(
          Effect.map((status) => status.branchChanges?.insertions),
        );

        const held = mend.workbench.holdNextStatsRead();
        const first = yield* Effect.forkScoped(refresh);
        yield* Effect.promise(() => held.entered);
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 40, deletions: 0 });
        const burst = yield* Effect.forkScoped(
          Effect.all(
            Array.from({ length: 24 }, () => refresh),
            { concurrency: "unbounded" },
          ),
        );
        // Long enough for every ask of the burst to reach the gateway behind the read in flight.
        yield* Effect.sleep("300 millis");
        held.release();
        assert.strictEqual(yield* Fiber.join(first), 10);
        assert.deepStrictEqual(
          yield* Fiber.join(burst),
          Array.from({ length: 24 }, () => 40),
        );
        assert.strictEqual(statsReadsOf(mend), 2);
      }),
    ),
  );

  it.effect(
    "fails a read whose body stalls at Mend's deadline, and reads again for the asks behind it",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const timers = yield* GatewayTimers;
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
          mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
          const { rpc } = yield* pairAndConnect(mend, "BODYSTALL");
          const refresh = rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });

          // Mend sends its 200 and the first byte of the body, then nothing.
          const held = mend.workbench.holdNextStatsRead("mid-body");
          const first = yield* Effect.forkScoped(Effect.exit(refresh));
          yield* Effect.promise(() => held.entered);
          const next = yield* Effect.forkScoped(refresh);
          yield* timers.runOut("2 minutes", "the status read's deadline");

          const stalled = yield* Fiber.join(first);
          assert.isTrue(Exit.isFailure(stalled));
          if (Exit.isFailure(stalled)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(stalled.cause));
            assert.strictEqual(error?._tag, "GitManagerError");
            assert.include(error?.message ?? "", "within 2 minutes");
          }
          assert.strictEqual((yield* Fiber.join(next)).branchChanges?.insertions, 10);
          assert.strictEqual(statsReadsOf(mend), 2);
          held.release();
        }),
      ).pipe(withGatewayTimers),
  );

  it.live("fails every refresh a failed read covers with that read, and reads again after", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "FAILBURST");
        const refresh = rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });

        const held = mend.workbench.holdNextStatsRead();
        const first = yield* Effect.forkScoped(refresh);
        yield* Effect.promise(() => held.entered);
        // The read behind the one in flight finds no change at Mend.
        mend.workbench.stats.delete("change-session-1");
        const burst = yield* Effect.forkScoped(
          Effect.all(
            Array.from({ length: 24 }, () => Effect.exit(refresh)),
            { concurrency: "unbounded" },
          ),
        );
        // Long enough for every ask of the burst to reach the gateway behind the read in flight.
        yield* Effect.sleep("300 millis");
        held.release();
        assert.strictEqual((yield* Fiber.join(first)).branchChanges?.insertions, 10);
        const outcomes = yield* Fiber.join(burst);
        assert.isTrue(outcomes.every(Exit.isFailure));
        assert.strictEqual(statsReadsOf(mend), 2);

        mend.workbench.stats.set("change-session-1", { files: 1, additions: 20, deletions: 0 });
        assert.strictEqual((yield* refresh).branchChanges?.insertions, 20);
        assert.strictEqual(statsReadsOf(mend), 3);
      }),
    ),
  );

  it.effect("fails every refresh a read covers when Mend never answers it, once", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "SILENCE");
        const refresh = rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });

        const firstHeld = mend.workbench.holdNextStatsRead();
        const first = yield* Effect.forkScoped(refresh);
        yield* Effect.promise(() => firstHeld.entered);
        const queued = yield* Effect.forkScoped(
          Effect.all(
            Array.from({ length: 3 }, () => Effect.exit(refresh)),
            { concurrency: "unbounded" },
          ),
        );
        // Long enough for every ask to reach the gateway behind the read in flight.
        yield* TestClock.withLive(Effect.sleep("300 millis"));
        // The read that answers them gets no answer at all.
        const secondHeld = mend.workbench.holdNextStatsRead();
        firstHeld.release();
        assert.strictEqual((yield* Fiber.join(first)).branchChanges?.insertions, 10);
        yield* Effect.promise(() => secondHeld.entered);
        yield* timers.runOut("2 minutes", "the second read's deadline");

        const outcomes = yield* Fiber.join(queued);
        assert.isTrue(outcomes.every(Exit.isFailure));
        assert.strictEqual(statsReadsOf(mend), 2);
        secondHeld.release();
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("refuses to remove a worktree: the grant leaves out source-control:write", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "KEEPWT");
        // What t3code would send after deleting a thread, asked to delete its worktree too. It
        // never asks: the scope the removal needs is not granted (`auth.ts`).
        const removal = yield* Effect.exit(
          rpc[WS_METHODS.vcsRemoveWorktree]({ cwd: STORE, path: WORKTREE, force: true }),
        );
        assert.isTrue(Exit.isFailure(removal));
        if (Exit.isFailure(removal)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(removal.cause));
          assert.strictEqual(error?._tag, "EnvironmentAuthorizationError");
          assert.include(error?.message ?? "", "source-control:write");
        }
        assert.isFalse(
          mend.workbench.calls.some((call) => call.method === "DELETE"),
          "nothing in Mend is removed",
        );
      }),
    ),
  );
});
