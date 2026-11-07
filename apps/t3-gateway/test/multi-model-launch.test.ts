import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

/** Pinned v0.1.2 sends one worktree bootstrap per selected model, concurrently. */
const target = (
  id: string,
  provider: "codex" | "claudeAgent",
  model: string,
  baseRef = "main",
): OrchestrationV2ThreadLaunchInput => ({
  commandId: CommandId.make(`fanout-${id}`),
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: "Compare implementations",
  modelSelection: { instanceId: ProviderInstanceId.make(provider), model },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "worktree", baseRef },
  initialMessage: {
    messageId: MessageId.make(`message-${id}`),
    text: "Add a health check",
    attachments: [],
  },
});

describe("multi-model worktree bootstrap", () => {
  it.live("advertises fanout and starts each model in its own owned worktree", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc, client } = yield* pairAndConnect(mend, "MULTI-MODEL");
        const requests = [
          target("fanout-codex", "codex", "gpt-6.1-sol"),
          target("fanout-claude", "claudeAgent", "claude-sonnet-4-6"),
        ];
        const launched = yield* Effect.all(
          requests.map((input) => rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](input)),
          { concurrency: "unbounded" },
        );
        const sessions = Array.from(mend.workbench.sessions.values());
        assert.lengthOf(sessions, 2);
        assert.strictEqual(new Set(sessions.map((session) => session.worktreeId)).size, 2);
        assert.strictEqual(
          new Set(launched.map((result) => result.projection.thread.worktreePath)).size,
          2,
        );
        for (let index = 0; index < requests.length; index++) {
          const request = requests[index];
          const result = launched[index];
          assert.isDefined(request);
          assert.isDefined(result);
          if (request === undefined || result === undefined) continue;
          assert.strictEqual(
            result.projection.thread.modelSelection?.model,
            request.modelSelection.model,
          );
          assert.isNotNull(result.projection.thread.worktreePath);
        }
        assert.isTrue(sessions.every((session) => session.ownerUserId === "user-1"));
        assert.isTrue(sessions.every((session) => session.baseRef === "main"));
        assert.strictEqual(mend.workbench.localWorktrees.size, 0);
        for (let attempt = 0; attempt < 100; attempt++) {
          const sent = Array.from(mend.workbench.turns.values()).flat();
          if (sent.length === 2) break;
          yield* Effect.sleep("50 millis");
        }
        const turns = Array.from(mend.workbench.turns.values()).flat();
        assert.lengthOf(turns, 2);
        assert.isTrue(turns.every((turn) => turn.input === "Add a health check"));
        assert.sameMembers(
          sessions.map((session) => session.model),
          ["gpt-6.1-sol", "claude-sonnet-4-6"],
        );
        const descriptor = yield* client.metadata.descriptor();
        assert.isTrue(descriptor.capabilities.requiredWorktreeBootstrap);
      }),
    ),
  );

  it.live("keeps a failed target separate and never falls back to Local", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "MULTI-MODEL-REFUSAL");
        const results = yield* Effect.all(
          [
            Effect.exit(
              rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](target("kept", "codex", "gpt-6.1-sol")),
            ),
            Effect.exit(
              rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
                target("refused", "claudeAgent", "claude-sonnet-4-6", "no-such-branch"),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.isTrue(Exit.isSuccess(results[0]));
        assert.isTrue(Exit.isFailure(results[1]));
        assert.strictEqual(mend.workbench.sessions.size, 1);
        assert.strictEqual(mend.workbench.worktrees.size, 1);
        assert.strictEqual(mend.workbench.localWorktrees.size, 0);
        assert.strictEqual(
          mend.workbench.calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/local-worktree"),
          ).length,
          0,
        );
      }),
    ),
  );
});
