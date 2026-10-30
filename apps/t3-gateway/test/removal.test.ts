import { SessionId, WorktreeId } from "@mend/domain";
import { RemovalBlocker } from "@mend/domain/workbench";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ShellStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * Removing a worktree or a project from t3code (decision 11): t3code's "Delete the worktree too?"
 * and "Remove project" go through to Mend's own removals, and Mend's refusals reach the person in
 * words for someone outside Mend. t3code always asks to force; the gateway never passes it on.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const STORE = "/var/lib/mend/store/project-1/repo.git";
const WORKTREE = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
const WORKTREE_ID = "worktree-session-1";
/** What t3code sends once the only thread on a worktree is deleted and the person said yes. */
const REMOVE = { cwd: STORE, path: WORKTREE, force: true } as const;

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];
type ShellItem = OrchestrationV2ShellStreamItem;

let commands = 0;
const commandId = () => CommandId.make(`removal-command-${++commands}`);

const failureOf = (exit: Exit.Exit<unknown, unknown>): { _tag?: string; message?: string } => {
  if (!Exit.isFailure(exit)) return {};
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null ? error : {};
};

const encodeBlockers = Schema.encodeSync(Schema.Array(RemovalBlocker));

/** Mend's 409 for a refused removal, with the in-Mend words a client from before it prints. */
const refused = (
  scope: "worktree" | "project",
  blockers: ReadonlyArray<RemovalBlocker>,
  forceWouldLift: boolean,
) => ({
  status: 409,
  body: {
    _tag: "RemovalRefused",
    scope,
    blockers: encodeBlockers(blockers),
    forceWouldLift,
    message:
      "not removed · Land it or discard it before removal, or pass force=true to remove it anyway.",
  },
});

const unlanded = (standing: Extract<RemovalBlocker, { _tag: "Unlanded" }>["standing"]) =>
  ({
    _tag: "Unlanded",
    worktreeId: WorktreeId.make(WORKTREE_ID),
    worktreeName: "wt-session-1",
    owner: { userId: "user-1", name: "Ada" },
    standing,
  }) as const;

const FILES = [
  { path: "src/a.ts", additions: 10, deletions: 2 },
  { path: "src/b.ts", additions: 2, deletions: 1 },
];

const deletes = (mend: FakeMend) => mend.workbench.calls.filter((call) => call.method === "DELETE");

const worktreeDeletes = (mend: FakeMend) =>
  deletes(mend).filter((call) => call.path.startsWith("/api/worktrees/"));

/** Nothing the gateway sent Mend for a removal asks it to force one. */
const assertNeverForced = (mend: FakeMend) => {
  for (const call of deletes(mend)) {
    assert.strictEqual(call.query, "", `${call.path} carries no query`);
    assert.isUndefined(call.body, `${call.path} carries no body`);
    assert.isFalse(
      call.headerNames.some((name) => name.includes("force")),
      `${call.path} carries no force header`,
    );
  }
};

const deleteThread = (rpc: Rpc, threadId: string) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "thread.delete",
    commandId: commandId(),
    threadId: ThreadId.make(threadId),
  });

describe("Removing a worktree from t3code", () => {
  it.live("removes a worktree Mend can let go, and never asks Mend to force it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const { rpc } = yield* pairAndConnect(mend, "REMOVE");
        yield* deleteThread(rpc, "session-1");

        yield* rpc[WS_METHODS.vcsRemoveWorktree](REMOVE);

        assert.isFalse(mend.workbench.worktrees.has(WORKTREE_ID), "Mend removed the worktree");
        assert.deepStrictEqual(
          worktreeDeletes(mend).map((call) => call.path),
          [`/api/worktrees/${WORKTREE_ID}`],
        );
        assertNeverForced(mend);
        // What t3code asks next, for the project's own status.
        yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: STORE });
      }),
    ),
  );

  it.live("refuses a change with no remote in decision Q3's words, exactly", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.worktreeRemovalAnswers.set(
          WORKTREE_ID,
          refused("worktree", [unlanded({ _tag: "no-remote", files: FILES })], true),
        );
        const { rpc } = yield* pairAndConnect(mend, "NOREMOTE");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(
          error.message,
          "This worktree has work that is not on any remote. Remove it from Mend if you mean to discard it.",
        );
        assert.isTrue(mend.workbench.worktrees.has(WORKTREE_ID), "Mend keeps the worktree");
        assertNeverForced(mend);
      }),
    ),
  );

  it.live(
    "refuses a change never landed on origin, naming its files and sending the person to Mend",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({
            id: "session-1",
            projectId: "project-1",
            live: false,
          });
          mend.workbench.worktreeRemovalAnswers.set(
            WORKTREE_ID,
            refused("worktree", [unlanded({ _tag: "never-landed", files: FILES })], true),
          );
          const { rpc } = yield* pairAndConnect(mend, "UNLANDED");

          const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

          assert.strictEqual(
            error.message,
            "This worktree has work that is not on origin · 2 files · +12 −3 · src/a.ts +10 −2, src/b.ts +2 −1. Land it from Mend, or remove it from Mend if you mean to discard it.",
          );
        }),
      ),
  );

  it.live("refuses a teammate's worktree, naming who started its change", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.worktreeRemovalAnswers.set(WORKTREE_ID, {
          status: 403,
          body: {
            _tag: "RemovalForbidden",
            owner: { userId: "user-2", name: "Grace" },
            message: "not removed · only Grace, who started this worktree's change, removes it.",
          },
        });
        const { rpc } = yield* pairAndConnect(mend, "TEAMMATE");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Only Grace, who started this worktree's change, can remove it. Mend keeps it.",
        );
      }),
    ),
  );

  it.live("refuses a worktree whose change has no provable owner without asking Mend", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const worktree = mend.workbench.worktrees.get(WORKTREE_ID);
        if (worktree !== undefined) worktree.changeOwnerUserId = null;
        const { rpc } = yield* pairAndConnect(mend, "OWNERLESS");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Mend cannot tell who started this worktree's change, so it keeps it. Remove it from Mend.",
        );
        assert.deepStrictEqual(worktreeDeletes(mend), []);
      }),
    ),
  );

  it.live("refuses a worktree whose owner Mend's history cannot prove, without asking Mend", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const worktree = mend.workbench.worktrees.get(WORKTREE_ID);
        if (worktree !== undefined) worktree.changeOwnerProven = false;
        const { rpc } = yield* pairAndConnect(mend, "UNPROVEN");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Mend cannot tell who started this worktree's change, so it keeps it. Remove it from Mend.",
        );
        assert.deepStrictEqual(worktreeDeletes(mend), []);
      }),
    ),
  );

  it.live("answers a worktree Mend no longer has as removed", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const { rpc } = yield* pairAndConnect(mend, "GONE");
        mend.workbench.worktrees.delete(WORKTREE_ID);

        yield* rpc[WS_METHODS.vcsRemoveWorktree](REMOVE);

        assert.deepStrictEqual(worktreeDeletes(mend), []);
      }),
    ),
  );

  it.live("refuses a path that is not one of the project's worktrees without asking Mend", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addProject("project-2", "other");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const { rpc } = yield* pairAndConnect(mend, "NOTHERE");

        for (const input of [
          {
            ...REMOVE,
            path: "/var/lib/mend/store/project-1/worktrees/../repo.git",
          },
          {
            ...REMOVE,
            path: "/var/lib/mend/store/project-1/worktrees/wt-session-1/src",
          },
          { ...REMOVE, path: "/var/lib/mend/store/project-1/worktrees/" },
          { ...REMOVE, cwd: "/var/lib/mend/store/project-2/repo.git" },
          { ...REMOVE, cwd: "/somewhere/else" },
        ]) {
          const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](input)));
          assert.strictEqual(error._tag, "EnvironmentAuthorizationError", input.path);
        }
        assert.deepStrictEqual(worktreeDeletes(mend), []);
        assert.isTrue(mend.workbench.worktrees.has(WORKTREE_ID));
      }),
    ),
  );

  it.live("says Mend's answer is not known when Mend fails the removal itself", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.worktreeRemovalAnswers.set(WORKTREE_ID, {
          status: 503,
          body: { _tag: "ServiceUnavailable" },
        });
        const { rpc } = yield* pairAndConnect(mend, "DOWN");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Mend answered 503, so whether this worktree was removed is not known. Check it in Mend.",
        );
      }),
    ),
  );

  it.live("keeps the worktree when Mend's refusal cannot be read, and never offers force", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.worktreeRemovalAnswers.set(WORKTREE_ID, {
          status: 409,
          body: {
            _tag: "RemovalRefused",
            scope: "worktree",
            blockers: [{ _tag: "SomethingNewer" }],
            forceWouldLift: true,
            message: "not removed · or pass force=true to remove it anyway.",
          },
        });
        const { rpc } = yield* pairAndConnect(mend, "UNREADABLE");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Mend did not remove this worktree (409 RemovalRefused). Check it in Mend.",
        );
      }),
    ),
  );

  it.effect("waits for the deleted thread's removal in the worktree before asking Mend", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.removalLeavesWorkspace = true;
        const { rpc } = yield* pairAndConnect(mend, "SETTLE");
        yield* deleteThread(rpc, "session-1");

        const removal = yield* Effect.forkScoped(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE));
        yield* timers.parked("45 seconds", "the wait for the thread's removal");
        assert.deepStrictEqual(worktreeDeletes(mend), [], "Mend is not asked while it saves");

        // Mend finishes removing the session: its workspace stopped and saved.
        mend.workbench.removeSession("session-1");
        yield* timers.drive(
          { within: "1 second", deadline: "45 seconds" },
          () => worktreeDeletes(mend).length > 0,
          "the worktree removal",
        );
        yield* Fiber.join(removal);
        assert.isFalse(mend.workbench.worktrees.has(WORKTREE_ID));
      }),
    ).pipe(withGatewayTimers),
  );

  it.effect("asks Mend at once for a teammate's worktree, without waiting for a save", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
          ownerUserId: "user-2",
        });
        mend.workbench.addSession({
          id: "session-2",
          projectId: "project-1",
          live: false,
          joins: "session-1",
        });
        mend.workbench.removalLeavesWorkspace = true;
        mend.workbench.worktreeRemovalAnswers.set(WORKTREE_ID, {
          status: 403,
          body: {
            _tag: "RemovalForbidden",
            owner: { userId: "user-2", name: "Grace" },
            message: "not removed · only Grace, who started this worktree's change, removes it.",
          },
        });
        const { rpc } = yield* pairAndConnect(mend, "NOWAIT");
        yield* deleteThread(rpc, "session-2");

        const error = failureOf(yield* Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)));

        assert.strictEqual(
          error.message,
          "Only Grace, who started this worktree's change, can remove it. Mend keeps it.",
        );
        assert.strictEqual(worktreeDeletes(mend).length, 1);
      }),
    ).pipe(withGatewayTimers),
  );

  it.effect("asks Mend anyway once a save outlasts the wait, and shows what Mend says", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.removalLeavesWorkspace = true;
        const { rpc } = yield* pairAndConnect(mend, "OUTLAST");
        yield* deleteThread(rpc, "session-1");

        const removal = yield* Effect.forkScoped(
          Effect.exit(rpc[WS_METHODS.vcsRemoveWorktree](REMOVE)),
        );
        yield* timers.runOut(
          "45 seconds",
          "the wait for the thread's removal",
          Effect.sync(() =>
            assert.deepStrictEqual(worktreeDeletes(mend), [], "Mend is not asked within the wait"),
          ),
        );
        const error = failureOf(yield* Fiber.join(removal));

        assert.strictEqual(
          error.message,
          "This worktree's last session is still saving its files. Mend keeps the worktree; remove it from Mend once the save has finished.",
        );
        assert.strictEqual(worktreeDeletes(mend).length, 1);
      }),
    ).pipe(withGatewayTimers),
  );
});

describe("Removing a project from t3code", () => {
  const remove = (rpc: Rpc, force?: boolean) =>
    rpc[WS_METHODS.projectsMutate]({
      type: "project.delete",
      commandId: commandId(),
      projectId: ProjectId.make("project-1"),
      ...(force === undefined ? {} : { force }),
    });

  it.live("removes the project in Mend without force, and its threads leave the shell", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        const { rpc } = yield* pairAndConnect(mend, "PROJECT");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
        );

        // Both of t3code's remove buttons send force.
        const project = yield* remove(rpc, true);

        assert.strictEqual(project.id, "project-1");
        assert.strictEqual(project.workspaceRoot, STORE);
        assert.isNotNull(project.deletedAt);
        assert.deepStrictEqual(
          deletes(mend).map((call) => call.path),
          ["/api/projects/project-1"],
        );
        assertNeverForced(mend);
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "thread.removed" }> =>
            item.kind === "thread.removed" && item.threadId === "session-1",
          "4 seconds",
        );
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "project.removed" }> =>
            item.kind === "project.removed" && item.projectId === "project-1",
          "4 seconds",
        );
      }),
    ),
  );

  it.live(
    "keeps a removed project gone when a read that began before the removal lands after it",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({
            id: "session-1",
            projectId: "project-1",
            live: false,
          });
          const { rpc } = yield* pairAndConnect(mend, "STALE");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          const release = Promise.withResolvers<void>();
          const reached = Promise.withResolvers<void>();
          mend.workbench.holdProjectDetail = {
            until: release.promise,
            reached: reached.resolve,
          };
          // A change in the project: the gateway reads it again, and that read is held.
          mend.workbench.emit({ type: "project", projectId: "project-1" });
          yield* Effect.promise(() => reached.promise);
          // Later reads of the project fail, so only Mend's answer to the removal can publish it.
          mend.workbench.projectDetailFailures = 10;

          yield* remove(rpc, true);
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "project.removed" }> =>
              item.kind === "project.removed" && item.projectId === "project-1",
            "4 seconds",
          );
          release.resolve();

          assert.isTrue(
            yield* shell.quiet(
              (item) => item.kind === "project.updated" || item.kind === "thread.updated",
              "1 second",
            ),
            "the read from before the removal brings nothing back",
          );
        }),
      ),
  );

  it.live(
    "keeps a removed project gone when a full read that began before the removal lands after it",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({
            id: "session-1",
            projectId: "project-1",
            live: false,
          });
          const { rpc } = yield* pairAndConnect(mend, "STALEALL");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          const held = () => {
            const release = Promise.withResolvers<void>();
            const reached = Promise.withResolvers<void>();
            return { release, reached };
          };
          const removal = held();
          const read = held();
          mend.workbench.holds.push(
            {
              method: "DELETE",
              path: /^\/api\/projects\/project-1$/,
              until: removal.release.promise,
              reached: removal.reached.resolve,
              before: true,
            },
            {
              method: "GET",
              path: /^\/api\/sessions\/session-1\/turns$/,
              until: read.release.promise,
              reached: read.reached.resolve,
            },
          );
          // The removal is with Mend when a full read starts: it reads the project as it still
          // is, then holds on the thread's turns.
          const removing = yield* Effect.forkChild(remove(rpc, true));
          yield* Effect.promise(() => removal.reached.promise);
          mend.workbench.emit({ type: "resync" });
          yield* Effect.promise(() => read.reached.promise);
          mend.workbench.projectDetailFailures = 10;
          removal.release.resolve();
          yield* Fiber.join(removing);
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "project.removed" }> =>
              item.kind === "project.removed" && item.projectId === "project-1",
            "4 seconds",
          );
          read.release.resolve();

          assert.isTrue(
            yield* shell.quiet(
              (item) => item.kind === "project.updated" || item.kind === "thread.updated",
              "1 second",
            ),
            "the full read from before the removal brings nothing back",
          );
        }),
      ),
  );

  it.live("refuses in words naming every blocking worktree and whose work it is", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          live: false,
        });
        mend.workbench.projectRemovalAnswers.set(
          "project-1",
          refused(
            "project",
            [
              {
                _tag: "SessionLive",
                worktreeId: WorktreeId.make("worktree-session-2"),
                worktreeName: "wt-session-2",
                sessionId: SessionId.make("session-2"),
                owner: { userId: "user-1", name: "Ada" },
                role: "inhabitant",
                activity: "live",
              },
              {
                ...unlanded({ _tag: "never-landed", files: FILES }),
                owner: { userId: "user-2", name: "Grace" },
              },
            ],
            false,
          ),
        );
        const { rpc } = yield* pairAndConnect(mend, "PROJECTKEPT");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
        );

        const error = failureOf(yield* Effect.exit(remove(rpc, true)));

        assert.strictEqual(error._tag, "ProjectMutationError");
        assert.strictEqual(
          error.message,
          "Mend kept this project. Ada's session in wt-session-2 is live. wt-session-1 holds Grace's change, which is not on origin. Stop, land or remove those in Mend, then remove the project again.",
        );
        assert.isTrue(
          yield* shell.quiet(
            (item) => item.kind === "project.removed" || item.kind === "thread.removed",
          ),
          "nothing leaves the shell",
        );
        assertNeverForced(mend);
      }),
    ),
  );

  it.live("says what Mend answered, and never that the project was kept, when Mend fails it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1", live: false });
        mend.workbench.projectRemovalAnswers.set("project-1", {
          status: 500,
          body: { _tag: "InternalError", reference: "0123456789abcdef", message: "internal error" },
        });
        const { rpc } = yield* pairAndConnect(mend, "FAILED");

        const error = failureOf(yield* Effect.exit(remove(rpc, true)));

        assert.strictEqual(
          error.message,
          "Mend answered 500, so whether this project was removed is not known. Check it in Mend.",
        );
      }),
    ),
  );

  it.live("says who may remove a project Mend does not let the person remove", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.projectRemovalAnswers.set("project-1", {
          status: 404,
          body: { _tag: "NotFound", id: "project-1" },
        });
        const { rpc } = yield* pairAndConnect(mend, "NOTYOURS");

        const error = failureOf(yield* Effect.exit(remove(rpc)));

        assert.strictEqual(error._tag, "ProjectMutationError");
        assert.strictEqual(
          error.message,
          "Mend keeps this project. Only an organization owner, or the creator of a private project, can remove it.",
        );
      }),
    ),
  );

  it.live("still refuses creating or editing a project", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "EDIT");

        const update = failureOf(
          yield* Effect.exit(
            rpc[WS_METHODS.projectsMutate]({
              type: "project.update",
              commandId: commandId(),
              projectId: ProjectId.make("project-1"),
              title: "renamed",
            }),
          ),
        );
        const create = failureOf(
          yield* Effect.exit(
            rpc[WS_METHODS.projectsMutate]({
              type: "project.create",
              commandId: commandId(),
              projectId: ProjectId.make("project-new"),
              title: "new",
              workspaceRoot: "/tmp/new",
            }),
          ),
        );

        for (const error of [update, create]) {
          assert.strictEqual(error._tag, "ProjectMutationError");
          assert.strictEqual(error.message, "Projects are adopted and edited in Mend.");
        }
        assert.deepStrictEqual(deletes(mend), []);
      }),
    ),
  );
});
