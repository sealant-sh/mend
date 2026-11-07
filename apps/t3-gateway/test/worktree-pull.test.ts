import { WS_METHODS } from "@mend/t3-contracts";
import { Effect } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("pinned T3 worktree pull", () => {
  it.live("pulls the owner's worktree without starting a turn or a landing", () => Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
    yield* Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "PULL-OWNER");
      const turns = mend.workbench.turns.size;
      const result = yield* rpc[WS_METHODS.vcsPull]({ cwd: "/var/lib/mend/store/project-1/worktrees/wt-session-1" });
      assert.deepStrictEqual(result, { status: "pulled", refName: "mend/wt-session-1", upstreamRef: "origin/mend/wt-session-1" });
      assert.isTrue(mend.workbench.calls.some((call) => call.method === "POST" && call.path.endsWith("/pull")));
      assert.isFalse(mend.workbench.calls.some((call) => call.path.endsWith("/land")));
      assert.strictEqual(mend.workbench.turns.size, turns);
    }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
  }).pipe(Effect.scoped));
});
