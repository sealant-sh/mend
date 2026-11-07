import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type RuntimeMode,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { nextModeLineOf } from "../src/model-options.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { message, posts, setup } from "./support/steering.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * Permission choices apply to new turns in a live process and remain available for relaunch.
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
  it.live("captures a queued permission choice without restarting the live process", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const active = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "MODE-LIVE-TURN");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required"));
        const queued = {
          ...message("ask-queued", { type: "queue_after_active" }),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        };
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](queued);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("full-access"));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          ...queued,
          commandId: commandId(),
        });
        mend.workbench.setTurn(active, "completed");
        yield* eventually(() => posts(mend, "/turns").length === 1, "the queued turn");
        assert.nestedPropertyVal(posts(mend, "/turns")[0]?.body, "selection.permissionMode", "ask");
        assert.lengthOf(mend.workbench.launches, 0);
      }),
    ),
  );

  it.effect("also applies the captured mode when an idle process needs relaunch", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "MODE");
        const projection = () =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required"));
        const chosen = yield* projection();
        assert.strictEqual(chosen.thread.runtimeMode, "approval-required");
        assert.include(notices(chosen), nextModeLineOf("ask"));
        assert.isTrue(
          chosen.providerSessions[0]?.capabilities.sessions.supportsRuntimeModeSwitchInSession,
        );
        // Selecting a mode does not restart the running process.
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
        // A send that finds the agent gone waits out its backoff, then reads and launches.
        yield* timers.drive(
          { within: "1 second", deadline: "5 seconds" },
          () => mend.workbench.launches.length === 1,
          "the launch",
        );
        assert.deepStrictEqual(mend.workbench.launches[0]?.body, {
          mode: "protocol",
          permissionMode: "ask",
        });
        // Once the agent runs asking, there is nothing left to say.
        yield* TestClock.withLive(
          eventually(
            () => mend.workbench.agents.get("session-1")?.protocolOptions?.permissionMode === "ask",
            "the asking agent",
          ),
        );
        yield* TestClock.withLive(
          eventually(
            () => mend.workbench.turns.get("session-1")?.length === 1,
            "the message's turn",
          ),
        );
        const applied = yield* projection();
        assert.strictEqual(applied.thread.runtimeMode, "approval-required");
        assert.notInclude(notices(applied), nextModeLineOf("ask"));
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("refuses a mode the state file cannot keep, so a restart never loosens it", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-mode-")), "state.sqlite");
    const runningAs = (mend: FakeMend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, `MODE-${++commands}`);
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        return { rpc, mode: projection.thread.runtimeMode };
      });
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      yield* Effect.gen(function* () {
        const { rpc, mode } = yield* runningAs(mend);
        assert.strictEqual(mode, "full-access");
        // The state file stops taking next-start modes (a full disk, say).
        const database = new DatabaseSync(statePath);
        database.exec(
          "CREATE TRIGGER refuse BEFORE INSERT ON next_modes BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        );
        database.close();
        const refused = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required")),
        );
        assert.strictEqual(tagOf(refused), "OrchestrationV2DispatchCommandError");
        const after = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(after.thread.runtimeMode, "full-access");
        assert.notInclude(notices(after), nextModeLineOf("ask"));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      // Once the file takes it, the choice is kept across a restart.
      const database = new DatabaseSync(statePath);
      database.exec("DROP TRIGGER refuse;");
      database.close();
      yield* Effect.gen(function* () {
        const { rpc } = yield* runningAs(mend);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](setMode("approval-required"));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      yield* Effect.gen(function* () {
        const { mode } = yield* runningAs(mend);
        assert.strictEqual(mode, "approval-required");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

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
