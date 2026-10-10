import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it.live(
    "a committed branch change on a clean tree is the branch's, never shown as uncommitted",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          // A real repository: the session's branch committed one line, and its tree is clean.
          const dir = mkdtempSync(join(tmpdir(), "t3-gateway-vcs-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
          );
          const git = (...args: ReadonlyArray<string>) =>
            execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
              cwd: dir,
            }).toString();
          git("init", "-q", "-b", "main");
          writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
          git("add", "-A");
          git("commit", "-q", "-m", "base");
          const base = git("rev-parse", "HEAD").trim();
          git("checkout", "-q", "-b", "mend/wt-session-1");
          writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
          git("commit", "-q", "-am", "the agent's commit");
          assert.strictEqual(git("status", "--porcelain"), "");
          // Mend's change stats: the worktree against its base, as `git diff --numstat` counts.
          const counted = git("diff", "--numstat", base)
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => line.split("\t").map(Number));
          const stats = {
            files: counted.length,
            additions: counted.reduce((sum, [added = 0]) => sum + added, 0),
            deletions: counted.reduce((sum, [, deleted = 0]) => sum + deleted, 0),
          };
          assert.deepStrictEqual(stats, { files: 1, additions: 1, deletions: 0 });

          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
          mend.workbench.stats.set("change-session-1", stats);
          const { rpc } = yield* pairAndConnect(mend, "REAL-GIT");
          const status = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isFalse(status.hasWorkingTreeChanges);
          assert.deepStrictEqual(status.workingTree, { files: [], insertions: 0, deletions: 0 });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "main",
            insertions: 1,
            deletions: 0,
          });
        }),
      ),
  );
});
