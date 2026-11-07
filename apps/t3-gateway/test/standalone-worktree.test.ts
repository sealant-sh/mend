import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const ROOT = "/var/lib/mend/store/project-1/repo.git";
const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const creates = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith("/worktrees"));

describe("standalone worktree creation", () => {
  it.live("creates the requested branch without a session, then joins that durable checkout", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "STANDALONE");
        const made = yield* rpc[WS_METHODS.vcsCreateWorktree]({
          cwd: ROOT,
          refName: "main",
          newRefName: "feature/health",
          path: null,
        });
        assert.strictEqual(made.worktree.refName, "feature/health");
        assert.match(made.worktree.path, /^\/var\/lib\/mend\/store\/project-1\/worktrees\//);
        assert.strictEqual(mend.workbench.sessions.size, 0);
        assert.strictEqual(mend.workbench.worktrees.size, 1);
        assert.deepStrictEqual(creates(mend)[0]?.body, {
          name: null,
          base: null,
          targetBranch: { refName: "main", newRefName: "feature/health" },
        });
        const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("standalone-join"),
          threadId: ThreadId.make("standalone-thread"),
          projectId: ProjectId.make("project-1"),
          title: "Use the prepared worktree",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "existing_worktree", worktreePath: made.worktree.path },
        });
        assert.strictEqual(launched.projection.thread.worktreePath, made.worktree.path);
        assert.strictEqual(launched.projection.thread.branch, "feature/health");
        assert.strictEqual(mend.workbench.worktrees.size, 1);
        assert.strictEqual(creates(mend).length, 1);
        assert.strictEqual(
          mend.workbench.calls.filter(
            (call) => call.path.endsWith("/projects/project-1/sessions") && call.method === "POST",
          ).length,
          0,
        );
      }),
    ),
  );

  it.live(
    "returns the actual checkout name when an existing remote ref becomes a local branch",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "STANDALONE-REMOTE");
          const made = yield* rpc[WS_METHODS.vcsCreateWorktree]({
            cwd: ROOT,
            refName: "origin/topic",
            path: null,
          });
          assert.strictEqual(made.worktree.refName, "topic");
          assert.deepStrictEqual(creates(mend)[0]?.body, {
            name: null,
            base: null,
            targetBranch: { refName: "origin/topic" },
          });
          assert.strictEqual(mend.workbench.sessions.size, 0);
        }),
      ),
  );

  it.live("refuses an unknown project before creating anything", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "STANDALONE-BOUNDARY");
        const refused = yield* Effect.exit(
          rpc[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/unknown-repository",
            refName: "main",
            path: null,
          }),
        );
        assert.isTrue(Exit.isFailure(refused));
        if (Exit.isFailure(refused)) assert.include(String(refused.cause), "GitCommandError");
        assert.strictEqual(creates(mend).length, 0);
        assert.strictEqual(mend.workbench.worktrees.size, 0);
      }),
    ),
  );

  it.live("preserves Mend's branch collision refusal without moving the first checkout", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "STANDALONE-COLLISION");
        const input = { cwd: ROOT, refName: "main", newRefName: "feature/health", path: null };
        const first = yield* rpc[WS_METHODS.vcsCreateWorktree](input);
        const refused = yield* Effect.exit(rpc[WS_METHODS.vcsCreateWorktree](input));
        assert.isTrue(Exit.isFailure(refused));
        if (Exit.isFailure(refused)) assert.include(String(refused.cause), "already exists");
        assert.strictEqual(mend.workbench.worktrees.size, 1);
        assert.strictEqual(
          Array.from(mend.workbench.worktrees.values())[0]?.branch,
          first.worktree.refName,
        );
        assert.strictEqual(mend.workbench.sessions.size, 0);
      }),
    ),
  );
});
