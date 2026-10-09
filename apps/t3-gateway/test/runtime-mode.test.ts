import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type RuntimeMode,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { nextModeLineOf } from "../src/thread-projection.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * The runtime-mode switch (ADR 0012, phase 3: "the next launch"): Mend sets a permission mode per
 * launch, so a mode chosen in t3code applies from the agent's next start, and the thread says so
 * until then.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const THREAD = ThreadId.make("session-1");
let commands = 0;
const commandId = () => CommandId.make(`mode-command-${++commands}`);

const setMode = (runtimeMode: RuntimeMode) =>
  ({
    type: "thread.runtime-mode.set",
    commandId: commandId(),
    threadId: THREAD,
    runtimeMode,
  }) as const;

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

/** The system notices of a thread. */
const notices = (value: { readonly turnItems: ReadonlyArray<{ readonly type: string }> }) =>
  value.turnItems.flatMap((item) =>
    item.type === "system_notice" && "message" in item && typeof item.message === "string"
      ? [item.message]
      : [],
  );

describe("the runtime-mode switch", () => {
  it.live("applies a mode from the agent's next start, saying so until it does", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "MODE");
        const projection = () =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required"));
        const chosen = yield* projection();
        assert.strictEqual(chosen.thread.runtimeMode, "approval-required");
        assert.include(notices(chosen), nextModeLineOf("ask"));
        // The running agent is not touched: Mend sets a mode per launch.
        assert.strictEqual(mend.workbench.launches.length, 0);

        // The 15-minute idle stop; the next message launches the agent asking first.
        mend.workbench.stopAgent("session-1");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: commandId(),
          createdBy: "user",
          creationSource: "web",
          threadId: THREAD,
          messageId: MessageId.make("message-after"),
          text: "Carry on",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        yield* eventually(() => mend.workbench.launches.length === 1, "the launch");
        assert.deepStrictEqual(mend.workbench.launches[0]?.body, {
          mode: "protocol",
          permissionMode: "ask",
        });
        // Once the agent runs asking, there is nothing left to say.
        yield* eventually(
          () => mend.workbench.agents.get("session-1")?.protocolOptions?.permissionMode === "ask",
          "the asking agent",
        );
        yield* eventually(
          () => mend.workbench.turns.get("session-1")?.length === 1,
          "the message's turn",
        );
        const applied = yield* projection();
        assert.strictEqual(applied.thread.runtimeMode, "approval-required");
        assert.notInclude(notices(applied), nextModeLineOf("ask"));
      }),
    ),
  );

  it.live("refuses modes Mend has not, and sessions the person may not steer", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1", steer: false });
        const { rpc } = yield* pairAndConnect(mend, "MODE-REFUSED");
        const between = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("auto-accept-edits")),
        );
        assert.strictEqual(tagOf(between), "OrchestrationV2DispatchCommandError");
        const notMine = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required")),
        );
        assert.strictEqual(tagOf(notMine), "EnvironmentAuthorizationError");
      }),
    ),
  );
});
