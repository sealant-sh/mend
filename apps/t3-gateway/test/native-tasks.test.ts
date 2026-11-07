import {
  NodeId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import { Effect, Exit } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { pairAndConnect } from "./support/rpc.ts";
import {
  commandId,
  gateway,
  posts,
  projectionWhen,
  setup,
  snapshot,
  threadId,
} from "./support/steering.ts";

const task = (taskId: string, toolUseId: string | null = null) => ({
  taskId,
  taskType: "local_workflow",
  workflow: "review",
  description: "Review the change",
  status: "running",
  summary: null,
  error: null,
  phases: [{ index: 1, title: "Read" }],
  agents: [
    {
      index: 1,
      label: "reader",
      phaseIndex: 1,
      state: "running",
      model: "haiku",
      tokens: 10,
      toolCalls: 2,
      durationMs: 30,
      lastTool: "Read",
      preview: null,
    },
  ],
  totalTokens: 10,
  toolUses: 2,
  durationMs: 30,
  toolUseId,
});

const subagentEvent = (
  item: OrchestrationV2ThreadStreamItem,
): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
  item.kind === "event" && item.event.type === "subagent.updated";

// Ordinary use: someone starts a native Agent/Workflow, sees its parent turn finish,
// and checks progress or presses Stop while that task continues in the background.
describe("native tasks in T3", () => {
  it.live("keeps one workflow card, streams progress after the turn, and reopens its result", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend, "claude");
      const launch = mend.workbench.addItem(turn, {
        kind: "tool-call",
        title: "Workflow",
        data: { name: "Workflow", input: { script: "review()" } },
        status: "completed",
      });
      const recorded = task("wf-1", launch.providerItemId);
      const item = mend.workbench.addItem(turn, {
        kind: "task",
        data: recorded,
        status: "in-progress",
      });
      mend.workbench.setTurn(turn, "completed");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "NATIVE-WORKFLOW");
          const stream = yield* feed(rpc[methods.subscribeThread]({ threadId }));
          const first = (yield* stream.next(snapshot)).projection;
          assert.lengthOf(first.subagents, 1);
          const agent = first.subagents[0];
          assert.isDefined(agent);
          if (agent === undefined) return;
          assert.strictEqual(agent.nativeTaskRef?.nativeId, "wf-1");
          assert.strictEqual(agent.status, "running");
          assert.strictEqual(agent.workflow?.agents[0]?.state, "running");
          assert.strictEqual(agent.workflow?.totalTokens, 10);
          assert.deepStrictEqual(
            first.turnItems.filter((row) => row.type === "subagent").map((row) => row.id),
            [launch.id],
          );
          assert.isFalse(first.turnItems.some((row) => row.id === item.id));
          assert.include(
            (first.providerThreads[0]?.pendingBackgroundTasks ?? []).map((work) => work.taskId),
            "wf-1",
          );

          mend.workbench.updateItem(item, {
            status: "completed",
            data: {
              ...recorded,
              status: "completed",
              summary: "Reviewed",
              agents: [{ ...recorded.agents[0], state: "done", tokens: 42 }],
              totalTokens: 42,
            },
          });
          const updated = yield* stream.next(subagentEvent);
          assert.strictEqual(updated.event.type, "subagent.updated");
          if (updated.event.type === "subagent.updated") {
            assert.strictEqual(updated.event.payload.id, agent.id);
            assert.strictEqual(updated.event.payload.status, "completed");
            assert.strictEqual(updated.event.payload.workflow?.agents[0]?.state, "completed");
            assert.strictEqual(updated.event.payload.result, "Reviewed");
          }
          const reopened = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.lengthOf(reopened.subagents, 1);
          assert.strictEqual(reopened.subagents[0]?.id, agent.id);
          assert.isEmpty(reopened.providerThreads[0]?.pendingBackgroundTasks);
        }),
      );
    }),
  );

  it.live(
    "shows synchronous Agent calls, preserves unknown tasks, and settles on session stop",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend, "claude");
        const agent = mend.workbench.addItem(turn, {
          kind: "tool-call",
          title: "Agent",
          data: { name: "Agent", input: { prompt: "Read", description: "Reader", model: "haiku" } },
          status: "in-progress",
        });
        const unknown = mend.workbench.addItem(turn, {
          kind: "task",
          data: { taskId: "future", future: true },
        });
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "NATIVE-SYNC");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.strictEqual(projection.subagents[0]?.model, "haiku");
            assert.strictEqual(projection.subagents[0]?.prompt, "Read");
            assert.isTrue(
              projection.turnItems.some(
                (row) => row.id === unknown.id && row.type === "dynamic_tool",
              ),
            );
            mend.workbench.stopAgent(threadId);
            const stopped = yield* projectionWhen(
              rpc,
              (value) => value.providerSessions[0]?.status === "stopped",
            );
            assert.strictEqual(stopped.subagents[0]?.status, "interrupted");
            assert.strictEqual(
              stopped.turnItems.find((row) => row.id === agent.id)?.status,
              "interrupted",
            );
          }),
        );
      }),
  );

  it.live("folds Codex receiver lifecycle into the spawn card", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      const spawn = mend.workbench.addItem(turn, {
        kind: "tool-call",
        data: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          prompt: "Read the code",
          receiverThreadIds: ["child-1"],
          agentsStates: { "child-1": { status: "running", message: null } },
        },
      });
      mend.workbench.addItem(turn, {
        kind: "tool-call",
        data: {
          type: "collabAgentToolCall",
          tool: "wait",
          receiverThreadIds: ["child-1"],
          agentsStates: { "child-1": { status: "completed", message: "Read it" } },
        },
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "NATIVE-CODEX");
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.lengthOf(projection.subagents, 1);
          assert.strictEqual(projection.subagents[0]?.status, "completed");
          assert.strictEqual(projection.subagents[0]?.result, "Read it");
          assert.strictEqual(projection.subagents[0]?.prompt, "Read the code");
          assert.strictEqual(
            projection.turnItems.find((row) => row.id === spawn.id)?.type,
            "subagent",
          );
        }),
      );
    }),
  );

  it.live(
    "stops the recorded task through Mend, refuses unknown tasks and preserves Mend's rights",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend, "claude");
        mend.workbench.addItem(turn, {
          kind: "task",
          data: task("wf-stop"),
          status: "in-progress",
        });
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "NATIVE-STOP");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            const agent = projection.subagents[0];
            assert.isDefined(agent);
            if (agent === undefined) return;
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(
                  rpc[methods.stopWorkflow]({ threadId, subagentId: NodeId.make("unknown") }),
                ),
              ),
            );
            assert.isEmpty(posts(mend, "/waiting/end"));
            mend.workbench.ownership.set(threadId, false);
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(rpc[methods.stopWorkflow]({ threadId, subagentId: agent.id })),
              ),
            );
            mend.workbench.ownership.set(threadId, true);
            yield* rpc[methods.stopWorkflow]({ threadId, subagentId: agent.id });
            yield* rpc[methods.dispatchCommand]({
              type: "subagent.stop",
              commandId: commandId(),
              threadId,
              runId: RunId.make(turn.id),
              subagentId: agent.id,
            });
            assert.deepStrictEqual(posts(mend, "/waiting/end").at(-1)?.body, {
              kind: "task",
              id: "wf-stop",
            });
          }),
        );
      }),
  );

  it.live("thread Stop ends earlier background tasks even when its latest turn is completed", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const earlier = setup(mend, "claude");
      mend.workbench.addItem(earlier, {
        kind: "task",
        data: task("wf-earlier"),
        status: "in-progress",
      });
      mend.workbench.setTurn(earlier, "completed");
      const latest = mend.workbench.addTurn(threadId, "Status?");
      mend.workbench.setTurn(latest, "completed");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "NATIVE-STOP-ALL");
          yield* rpc[methods.getThreadProjection]({ threadId });
          yield* rpc[methods.dispatchCommand]({
            type: "run.interrupt",
            commandId: commandId(),
            threadId,
            runId: RunId.make(latest.id),
            holdQueue: true,
          });
          assert.deepStrictEqual(
            posts(mend, "/waiting/end").map((call) => call.body),
            [{ kind: "task", id: "wf-earlier" }],
          );
          assert.isEmpty(posts(mend, "/interrupt"));
        }),
      );
    }),
  );
  it.live("ends the exact endable waiting work and reports what cannot be stopped", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      mend.workbench.setTurn(turn, "completed");
      mend.workbench.sharedControl.set(threadId, "2026-10-01T00:00:00.000Z");
      mend.workbench.livePeople.set(threadId, [{ accountId: "other", name: "Bob" }]);
      mend.workbench.waits.set(threadId, {
        turnId: turn.id,
        line: "Waits for background work",
        since: turn.createdAt,
        work: [
          { kind: "goal", id: "goal-1", description: "Finish", endable: true },
          { kind: "wakeup", id: "wake-1", description: "Later", endable: false },
        ],
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "NATIVE-WAITING");
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.lengthOf(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], 2);
          const result = yield* Effect.exit(
            rpc[methods.dispatchCommand]({
              type: "run.interrupt",
              commandId: commandId(),
              threadId,
              runId: RunId.make(turn.id),
              holdQueue: true,
            }),
          );
          assert.isTrue(Exit.isFailure(result));
          assert.deepStrictEqual(
            posts(mend, "/waiting/end").map((call) => call.body),
            [{ kind: "goal", id: "goal-1" }],
          );
        }),
      );
    }),
  );
  it.live("still interrupts the parent when Mend refuses to end background work", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend, "claude");
      mend.workbench.addItem(turn, {
        kind: "task",
        data: task("someone-elses-work"),
        status: "in-progress",
      });
      mend.workbench.ownership.set(threadId, false);
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "NATIVE-PARTIAL-STOP");
          yield* rpc[methods.getThreadProjection]({ threadId });
          const result = yield* Effect.exit(
            rpc[methods.dispatchCommand]({
              type: "run.interrupt",
              commandId: commandId(),
              threadId,
              runId: RunId.make(turn.id),
              holdQueue: true,
            }),
          );
          assert.isTrue(Exit.isFailure(result));
          assert.strictEqual(turn.status, "interrupted");
        }),
      );
    }),
  );
});
