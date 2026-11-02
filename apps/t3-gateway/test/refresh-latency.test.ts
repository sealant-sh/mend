import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

type Item = OrchestrationV2ThreadStreamItem;

describe("output while project metadata refreshes", () => {
  it.live("streams stored text before a blocked project read answers", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const turn = mend.workbench.addTurn("session-1", "Say hello");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "REFRESH");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        const blocked = Promise.withResolvers<void>();
        const reached = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(() => blocked.resolve()));
        mend.workbench.holdProjectDetail = { until: blocked.promise, reached: reached.resolve };
        mend.workbench.emit({ type: "project", projectId: "project-1" });
        yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("5 seconds"));
        mend.workbench.addItem(turn, {
          kind: "assistant-message",
          text: "Hello",
          status: "in-progress",
        });
        const text =
          (value: string) =>
          (item: Item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "turn-item.updated" &&
            item.event.payload.type === "assistant_message" &&
            item.event.payload.text === value;
        yield* thread.next(text("Hello"), "500 millis");
        const item = mend.workbench.items.get("session-1")?.[0];
        assert.isDefined(item);
        if (item !== undefined) mend.workbench.updateItem(item, { text: "Hello again" });
        yield* thread.next(text("Hello again"), "500 millis");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );
});
