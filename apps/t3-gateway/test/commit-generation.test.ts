import { WS_METHODS } from "@mend/t3-contracts";
import { Effect, Stream } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

// An ordinary Commit with an empty message uses T3's default writer, including its effort hint.
describe("commit message generation in pinned T3", () => {
  it.live("generates with the default selected model even when the typed message is blank", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.stats.set("change-session-1", { files: 1, additions: 1, deletions: 0 });
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "GENERATED-COMMIT");
        const config = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.isTrue(config.providers.every((provider) => provider.supportsTextGeneration));
        const selected = config.settings.textGenerationModelSelection;
        assert.deepStrictEqual(selected.options, [{ id: "reasoningEffort", value: "low" }]);
        const events = yield* rpc[WS_METHODS.gitRunStackedAction]({
          actionId: "default-generation",
          cwd: "/var/lib/mend/store/project-1/worktrees/wt-session-1",
          action: "commit",
          commitMessage: "   ",
        }).pipe(Stream.runCollect);
        const ended = events.find((event) => event.kind === "action_finished");
        assert.strictEqual(ended?.kind === "action_finished" ? ended.result.commit.status : null, "created");
        const request = mend.workbench.calls.find((call) => call.path.endsWith("/commit"));
        assert.deepStrictEqual(request?.body, {
          message: "   ",
          writer: {
            provider: "codex",
            model: selected.model,
            instructions: "Follow the repository's commit conventions.",
          },
        });
        assert.strictEqual(mend.workbench.turns.size, 0);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );
});
