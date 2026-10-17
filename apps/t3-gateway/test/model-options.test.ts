import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { nextEffortLineOf, nextModelLineOf } from "../src/model-options.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * The traits picker on a started thread (ADR 0012, phase 3): Mend sets the reasoning effort and the
 * service tier per launch of the agent. A changed effort applies from the agent's next start, as
 * the runtime mode does, and the thread says so until then; Mend records no tier, so a changed tier
 * is refused with t3code's own dispatch error and the picker never shows one the agent lacks.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const THREAD = ThreadId.make("session-1");
let commands = 0;
const commandId = () => CommandId.make(`options-command-${++commands}`);

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];

const selection = (
  options: ReadonlyArray<{ readonly id: string; readonly value: string }>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [...options],
});

const send = (
  rpc: Rpc,
  text: string,
  modelSelection: ModelSelection | undefined,
  threadId: ThreadId = THREAD,
) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId: MessageId.make(`message-${commands}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    ...(modelSelection === undefined ? {} : { modelSelection }),
  });

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const errorOf = (exit: Exit.Exit<unknown, unknown>): { _tag?: string; message?: string } => {
  if (!Exit.isFailure(exit)) return {};
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null ? error : {};
};

const notices = (value: { readonly turnItems: ReadonlyArray<{ readonly type: string }> }) =>
  value.turnItems.flatMap((item) =>
    item.type === "system_notice" && "message" in item && typeof item.message === "string"
      ? [item.message]
      : [],
  );

/** A Codex session whose agent recorded `effort` when it started. */
const sessionRunningOn = (mend: FakeMend, effort: string | null) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
  const agent = mend.workbench.agents.get("session-1");
  if (agent?.protocolOptions != null) {
    mend.workbench.agents.set("session-1", {
      ...agent,
      protocolOptions: { ...agent.protocolOptions, effort },
    });
  }
};

describe("reasoning effort on a started thread", () => {
  it.live("shows the effort the agent runs on", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        sessionRunningOn(mend, "medium");
        const { rpc } = yield* pairAndConnect(mend, "EFFORT-SHOWN");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.deepStrictEqual(projection.thread.modelSelection.options, [
          { id: "reasoningEffort", value: "medium" },
        ]);
      }),
    ),
  );

  it.effect("applies a changed effort from the agent's next start, saying so until it does", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        sessionRunningOn(mend, "medium");
        const { rpc } = yield* pairAndConnect(mend, "EFFORT-NEXT");
        const projection = () =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD });

        // The picker moved to High: the message goes, and the effort waits for the next start.
        yield* send(rpc, "Think harder", selection([{ id: "reasoningEffort", value: "high" }]));
        yield* TestClock.withLive(
          eventually(() => mend.workbench.turns.get("session-1")?.length === 1, "the turn"),
        );
        const chosen = yield* projection();
        assert.deepStrictEqual(chosen.thread.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
        ]);
        assert.include(notices(chosen), nextEffortLineOf("high", "medium"));
        // The running agent is not touched: Mend sets an effort per launch.
        assert.strictEqual(mend.workbench.launches.length, 0);

        // The idle stop; the next message launches the agent on High.
        const first = mend.workbench.turns.get("session-1")?.[0];
        if (first !== undefined) mend.workbench.setTurn(first, "completed");
        mend.workbench.stopAgent("session-1");
        yield* send(rpc, "Carry on", selection([{ id: "reasoningEffort", value: "high" }]));
        // A send that finds the agent gone waits out its backoff, then reads and launches.
        yield* timers.drive(
          { within: "1 second", deadline: "5 seconds" },
          () => mend.workbench.launches.length === 1,
          "the launch",
        );
        assert.deepStrictEqual(mend.workbench.launches[0]?.body, {
          mode: "protocol",
          effort: "high",
        });
        yield* TestClock.withLive(
          eventually(
            () => mend.workbench.agents.get("session-1")?.protocolOptions?.effort === "high",
            "the agent on High",
          ),
        );
        yield* TestClock.withLive(
          eventually(() => mend.workbench.turns.get("session-1")?.length === 2, "its turn"),
        );
        const applied = yield* projection();
        assert.deepStrictEqual(applied.thread.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
        ]);
        assert.notInclude(notices(applied), nextEffortLineOf("high", "medium"));
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("lets go of a chosen effort set back to the running one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        sessionRunningOn(mend, "medium");
        const { rpc } = yield* pairAndConnect(mend, "EFFORT-BACK");
        yield* send(rpc, "Harder", selection([{ id: "reasoningEffort", value: "xhigh" }]));
        yield* send(rpc, "Never mind", selection([{ id: "reasoningEffort", value: "medium" }]));
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.deepStrictEqual(projection.thread.modelSelection.options, [
          { id: "reasoningEffort", value: "medium" },
        ]);
        assert.isFalse(notices(projection).some((line) => line.includes("reasoning effort")));
      }),
    ),
  );
});

describe("service tier on a started thread", () => {
  it.live("refuses a changed tier with t3code's dispatch error, and sends nothing", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        sessionRunningOn(mend, null);
        const { rpc } = yield* pairAndConnect(mend, "TIER");
        const fast = yield* Effect.exit(
          send(rpc, "Faster", selection([{ id: "serviceTier", value: "fast" }])),
        );
        const error = errorOf(fast);
        assert.strictEqual(error._tag, "OrchestrationV2DispatchCommandError");
        assert.include(error.message ?? "", "service tier");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.lengthOf(projection.runs, 0);
        // The tier it shows (Standard) is no change.
        yield* send(rpc, "As before", selection([{ id: "serviceTier", value: "default" }]));
        yield* eventually(() => mend.workbench.turns.get("session-1")?.length === 1, "the turn");
      }),
    ),
  );

  it.effect("keeps a launched thread on the tier it asked for, naming it on every relaunch", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "TIER-LAUNCH");
        const threadId = ThreadId.make("draft-fast");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: commandId(),
          threadId,
          projectId: ProjectId.make("project-1"),
          title: "Fast one",
          modelSelection: selection([{ id: "serviceTier", value: "fast" }]),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
          initialMessage: {
            messageId: MessageId.make("message-fast"),
            text: "Go",
            attachments: [],
          },
        });
        yield* TestClock.withLive(
          eventually(() => mend.workbench.launches.length === 1, "the launch"),
        );
        const sessionId = mend.workbench.launches[0]?.sessionId ?? "";
        yield* TestClock.withLive(
          eventually(() => mend.workbench.turns.get(sessionId)?.length === 1, "the turn"),
        );
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        });
        assert.deepInclude(projection.thread.modelSelection.options ?? [], {
          id: "serviceTier",
          value: "fast",
        });
        const standard = yield* Effect.exit(
          send(rpc, "Slower", selection([{ id: "serviceTier", value: "default" }]), threadId),
        );
        assert.strictEqual(errorOf(standard)._tag, "OrchestrationV2DispatchCommandError");

        // The idle stop: Mend recorded the agent, but no tier, so the relaunch names it again.
        const first = mend.workbench.turns.get(sessionId)?.[0];
        if (first !== undefined) mend.workbench.setTurn(first, "completed");
        mend.workbench.stopAgent(sessionId);
        yield* send(rpc, "Again", selection([{ id: "serviceTier", value: "fast" }]), threadId);
        // A send that finds the agent gone waits out its backoff, then reads and launches.
        yield* timers.drive(
          { within: "1 second", deadline: "5 seconds" },
          () => mend.workbench.launches.length === 2,
          "the relaunch",
        );
        assert.deepStrictEqual(mend.workbench.launches[1]?.body, {
          mode: "protocol",
          speed: "fast",
        });
      }),
    ).pipe(withGatewayTimers),
  );
});

describe("model on a started thread", () => {
  const onModel = (
    model: string,
    options: ReadonlyArray<{ readonly id: string; readonly value: string }> = [],
  ): ModelSelection => ({ ...selection(options), model });
  const pick = (rpc: Rpc, modelSelection: ModelSelection) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "thread.model-selection.set",
      commandId: commandId(),
      threadId: THREAD,
      modelSelection,
    });
  const astraLine = nextModelLineOf(
    {
      harness: "codex",
      runningModel: "gpt-6.1-sol",
      nextModel: null,
      runningEffort: null,
      nextEffort: null,
      tier: null,
    },
    "gpt-6.1-astra",
  );

  it.effect("relaunches the same session on a picked model, saying so until it does", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        sessionRunningOn(mend, "medium");
        const { rpc } = yield* pairAndConnect(mend, "MODEL-NEXT");
        const projection = () =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD });

        yield* pick(rpc, onModel("gpt-6.1-astra"));
        const chosen = yield* projection();
        assert.strictEqual(chosen.thread.modelSelection.model, "gpt-6.1-astra");
        assert.include(notices(chosen), astraLine);
        assert.strictEqual(mend.workbench.launches.length, 0);

        yield* send(rpc, "Before the switch", onModel("gpt-6.1-astra"));
        yield* TestClock.withLive(
          eventually(() => mend.workbench.turns.get("session-1")?.length === 1, "the turn"),
        );
        assert.strictEqual(mend.workbench.launches.length, 0);

        const first = mend.workbench.turns.get("session-1")?.[0];
        if (first !== undefined) mend.workbench.setTurn(first, "completed");
        mend.workbench.stopAgent("session-1");
        yield* send(rpc, "After the switch", onModel("gpt-6.1-astra"));
        yield* timers.drive(
          { within: "1 second", deadline: "5 seconds" },
          () => mend.workbench.launches.length === 1,
          "the launch",
        );
        assert.deepStrictEqual(mend.workbench.launches[0], {
          sessionId: "session-1",
          body: { mode: "protocol", model: "gpt-6.1-astra" },
        });
        yield* TestClock.withLive(
          eventually(
            () =>
              mend.workbench.agents.get("session-1")?.protocolOptions?.model === "gpt-6.1-astra",
            "the agent on the picked model",
          ),
        );
        yield* TestClock.withLive(
          eventually(() => mend.workbench.turns.get("session-1")?.length === 2, "its turn"),
        );
        const applied = yield* projection();
        assert.strictEqual(applied.thread.modelSelection.model, "gpt-6.1-astra");
        assert.notInclude(notices(applied), astraLine);
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("takes a model with a message, and lets go of it set back to the running one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        sessionRunningOn(mend, "medium");
        const { rpc } = yield* pairAndConnect(mend, "MODEL-BACK");
        const high = [{ id: "reasoningEffort", value: "high" }];
        yield* send(rpc, "Switch", onModel("gpt-6.1-astra", high));
        const chosen = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.deepStrictEqual(chosen.thread.modelSelection, onModel("gpt-6.1-astra", high));
        assert.include(notices(chosen), astraLine);
        yield* pick(rpc, onModel("gpt-6.1-sol", high));
        const back = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(back.thread.modelSelection.model, "gpt-6.1-sol");
        assert.notInclude(notices(back), astraLine);
        assert.include(notices(back), nextEffortLineOf("high", "medium"));
      }),
    ),
  );

  it.live("refuses another provider, and sends nothing", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        sessionRunningOn(mend, null);
        const { rpc } = yield* pairAndConnect(mend, "MODEL-PROVIDER");
        const claude: ModelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "fable",
        };
        const switched = yield* Effect.exit(send(rpc, "As Claude", claude));
        assert.strictEqual(errorOf(switched)._tag, "OrchestrationV2DispatchCommandError");
        assert.include(errorOf(switched).message ?? "", "another provider");
        const picked = yield* Effect.exit(pick(rpc, claude));
        assert.strictEqual(errorOf(picked)._tag, "OrchestrationV2DispatchCommandError");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.lengthOf(projection.runs, 0);
        assert.strictEqual(projection.thread.modelSelection.model, "gpt-6.1-sol");
      }),
    ),
  );

  it.live("keeps a picked model across a gateway restart", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-model-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      sessionRunningOn(mend, null);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "MODEL-KEPT-1");
        yield* pick(rpc, onModel("gpt-6.1-astra"));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "MODEL-KEPT-2");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(projection.thread.modelSelection.model, "gpt-6.1-astra");
        assert.include(notices(projection), astraLine);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});
