import { RunId, ORCHESTRATION_V2_WS_METHODS as methods } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { inputOf, message, posts, projectionWhen, setup, threadId } from "./support/steering.ts";

describe("conversation reads with native history", () => {
  it.live("projects an admitted queued message while native history is still reading", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.steerDelivery = { _tag: "Queued", turnId: "assigned", reason: "turn-ended" };
        const { rpc } = yield* pairAndConnect(mend, "HISTORY-READ");
        yield* rpc[methods.getThreadProjection]({ threadId });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        mend.workbench.holds.push({
          method: "GET",
          path: /\/native-history$/,
          reached: () => entered.resolve(),
          until: release.promise,
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
        yield* rpc[methods.dispatchCommand](
          message("carried", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
        );
        yield* Effect.promise(() => entered.promise);
        const projection = yield* projectionWhen(rpc, (current) => {
          const input = inputOf(current, "carried");
          return input?.type === "user_message" && input.inputIntent === "turn_start";
        });
        const input = inputOf(projection, "carried");
        assert.strictEqual(
          projection.runs.find((run) => run.id === input?.runId)?.status,
          "queued",
        );
        assert.lengthOf(
          projection.messages.filter((item) => item.id === "carried"),
          1,
        );
        assert.lengthOf(posts(mend, "/steer"), 1);
        assert.lengthOf(posts(mend, "/turns"), 0);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
