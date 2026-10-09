import { assert, describe, it } from "@effect/vitest";
import { WS_METHODS, type VcsStatusStreamEvent } from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

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

describe("VCS status", () => {
  it.live("reports the thread's branch and change, and follows it as turns change it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 10, deletions: 3 });
        const { rpc } = yield* pairAndConnect(mend, "VCS");

        const status = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.strictEqual(status.refName, "mend/wt-session-1");
        assert.isFalse(status.isDefaultRef);
        assert.isTrue(status.isRepo);
        assert.isTrue(status.hasPrimaryRemote);
        // Mend's totals are the branch against its base; it has no read of uncommitted work.
        assert.isFalse(status.hasWorkingTreeChanges);
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
        const snapshot = yield* stream.next(
          (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
        );
        assert.isNull(snapshot.remote);
        assert.strictEqual(snapshot.local.branchChanges?.insertions, 10);

        // A turn changes the worktree; the status follows.
        mend.workbench.stats.set("change-session-1", { files: 3, additions: 25, deletions: 3 });
        mend.workbench.addTurn("session-1", "Add a parser");
        const updated = yield* stream.next(
          (event): event is Extract<Event, { _tag: "localUpdated" }> =>
            event._tag === "localUpdated",
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
    ),
  );

  it.live("follows every session in the worktree, as each adds to its one change", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.addSession({ id: "session-2", projectId: "project-1", joins: "session-1" });
        mend.workbench.stats.set("change-session-1", { files: 1, additions: 10, deletions: 0 });
        const { rpc } = yield* pairAndConnect(mend, "SHARED-VCS");
        const stream = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        yield* stream.next(
          (event): event is Extract<Event, { _tag: "snapshot" }> => event._tag === "snapshot",
        );
        // The other session's turn moves the change.
        mend.workbench.stats.set("change-session-1", { files: 2, additions: 25, deletions: 0 });
        mend.workbench.addTurn("session-2", "Add a lexer");
        const updated = yield* stream.next(
          (event): event is Extract<Event, { _tag: "localUpdated" }> =>
            event._tag === "localUpdated",
        );
        assert.strictEqual(updated.local.branchChanges?.insertions, 25);
      }),
    ),
  );
});
