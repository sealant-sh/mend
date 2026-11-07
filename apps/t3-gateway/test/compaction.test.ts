import { ProviderDriverKind, ORCHESTRATION_V2_WS_METHODS as methods } from "@mend/t3-contracts";
import { Effect } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { gateway, setup, threadId } from "./support/steering.ts";

describe("native compaction in the T3 timeline", () => {
  for (const harness of ["codex", "claude"]) {
    it.live(`projects recorded ${harness} compaction with its native status and counts`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend, harness, "/compact");
        mend.workbench.addItem(turn, {
          kind: "other",
          status: "completed",
          title: null,
          data:
            harness === "codex"
              ? { type: "contextCompaction" }
              : { _tag: "ClaudeCompaction", beforeTokenCount: 40000, afterTokenCount: 12000 },
        });
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, `COMPACT-${harness}`);
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            const card = projection.turnItems.find((item) => item.type === "compaction");
            assert.deepInclude(card, {
              type: "compaction",
              status: "completed",
              title: "Context compacted",
              driver: ProviderDriverKind.make(harness === "codex" ? "codex" : "claudeAgent"),
            });
            if (harness === "claude")
              assert.deepInclude(card, { beforeTokenCount: 40000, afterTokenCount: 12000 });
          }),
        );
      }),
    );
  }
});
