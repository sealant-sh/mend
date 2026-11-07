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

type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;

describe("recorded thread progress", () => {
  it.live("streams Claude and Codex checklists as plans and keeps them after reopening", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        const turn = workbench.addTurn("session-1", "Make a plan");
        const todo = workbench.addItem(turn, {
          kind: "tool-call",
          title: "TodoWrite",
          data: {
            type: "tool_use",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Inspect", status: "completed" },
                { content: "Build", status: "in_progress" },
              ],
            },
          },
        });
        const { rpc } = yield* pairAndConnect(mend, "PROGRESS");
        const threadId = ThreadId.make("session-1");
        const stream = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }));
        const opened = yield* stream.next((entry) => entry.kind === "snapshot");
        if (opened.kind !== "snapshot") throw new Error("Expected a snapshot");
        const checklist = opened.projection.turnItems.find((item) => item.id === todo.id);
        assert.strictEqual(checklist?.type, "todo_list");
        if (checklist?.type !== "todo_list") throw new Error("Expected a checklist");
        assert.deepStrictEqual(
          checklist.steps.map((step) => [step.text, step.status]),
          [
            ["Inspect", "completed"],
            ["Build", "running"],
          ],
        );
        assert.strictEqual(opened.projection.plans[0]?.id, checklist.planId);
        assert.isTrue(opened.projection.providerSessions[0]?.capabilities.planning.emitsTodoList);

        workbench.updateItem(todo, {
          data: {
            type: "todoList",
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Build", status: "completed" },
            ],
            explanation: "Done",
          },
        });
        const updated = yield* stream.next(
          (entry): entry is EventItem =>
            entry.kind === "event" &&
            entry.event.type === "plan.updated" &&
            entry.event.payload.kind === "todo_list" &&
            entry.event.payload.steps.every((step) => step.status === "completed"),
        );
        assert.strictEqual(updated.kind, "event");
        const reopened = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
        );
        const snapshot = yield* reopened.next((entry) => entry.kind === "snapshot");
        if (snapshot.kind !== "snapshot") throw new Error("Expected a snapshot");
        const plan = snapshot.projection.plans[0];
        assert.strictEqual(plan?.status, "completed");
        assert.isTrue(plan?.kind === "todo_list" && plan.explanation === "Done");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("settles an interrupted command after Stop and on a fresh subscription", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "codex" });
        const turn = workbench.addTurn("session-1", "Run sleep 45");
        const command = workbench.addItem(turn, {
          kind: "command-execution",
          status: "in-progress",
          data: { command: "sleep 45" },
        });
        const { rpc } = yield* pairAndConnect(mend, "STOP-PROGRESS");
        const threadId = ThreadId.make("session-1");
        const stream = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }));
        const opened = yield* stream.next((entry) => entry.kind === "snapshot");
        if (opened.kind !== "snapshot") throw new Error("Expected a snapshot");
        assert.strictEqual(
          opened.projection.turnItems.find((item) => item.id === command.id)?.status,
          "running",
        );
        workbench.setTurn(turn, "interrupted");
        yield* stream.next(
          (entry): entry is EventItem =>
            entry.kind === "event" &&
            entry.event.type === "run.updated" &&
            entry.event.payload.status === "interrupted",
        );
        const reopened = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
        );
        const snapshot = yield* reopened.next((entry) => entry.kind === "snapshot");
        if (snapshot.kind !== "snapshot") throw new Error("Expected a snapshot");
        const stopped = snapshot.projection.turnItems.find((item) => item.id === command.id);
        assert.strictEqual(stopped?.status, "interrupted");
        assert.isNotNull(stopped?.completedAt);
        assert.strictEqual(workbench.items.get("session-1")?.[0]?.status, "in-progress");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
