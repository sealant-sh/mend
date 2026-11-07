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
        const proposal = workbench.addItem(turn, {
          kind: "plan",
          text: "# Proposal",
          data: { _tag: "ProposedPlan" },
          status: "completed",
        });
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
        assert.strictEqual(
          opened.projection.plans.find((plan) => plan.kind === "todo_list")?.id,
          checklist.planId,
        );
        assert.lengthOf(
          opened.projection.turnItems.filter((item) => item.type === "proposed_plan"),
          1,
        );
        assert.deepInclude(
          opened.projection.turnItems.find((item) => item.id === proposal.id),
          { type: "proposed_plan", markdown: "# Proposal" },
        );
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
        const plan = snapshot.projection.plans.find((entry) => entry.kind === "todo_list");
        assert.strictEqual(plan?.status, "completed");
        assert.isTrue(plan?.kind === "todo_list" && plan.explanation === "Done");
        assert.lengthOf(
          snapshot.projection.plans.filter((entry) => entry.kind === "proposed_plan"),
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("streams one shared Claude task checklist per turn and replays its progress", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        const turn = workbench.addTurn("session-1", "Build with a checklist");
        for (const [id, subject] of [
          ["1", "Inspect"],
          ["2", "Build"],
          ["3", "Verify"],
        ]) {
          workbench.addItem(turn, {
            kind: "plan",
            status: "completed",
            title: "TaskCreate",
            data: { name: "TaskCreate", input: { subject }, result: { task: { id, subject } } },
          });
        }
        const { rpc } = yield* pairAndConnect(mend, "CLAUDE-TASKS");
        const threadId = ThreadId.make("session-1");
        const stream = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }));
        const opened = yield* stream.next((entry) => entry.kind === "snapshot");
        if (opened.kind !== "snapshot") throw new Error("Expected a snapshot");
        const checklist = opened.projection.turnItems.filter((item) => item.type === "todo_list");
        assert.lengthOf(checklist, 1);
        assert.deepStrictEqual(
          checklist[0]?.steps.map((step) => [step.id, step.text, step.status]),
          [
            ["1", "Inspect", "pending"],
            ["2", "Build", "pending"],
            ["3", "Verify", "pending"],
          ],
        );
        for (const taskId of ["1", "2", "3"]) {
          workbench.addItem(turn, {
            kind: "plan",
            status: "completed",
            title: "TaskUpdate",
            data: {
              name: "TaskUpdate",
              parentToolUseId: "child",
              input: { taskId, status: "completed" },
              result: `Updated task #${taskId}`,
            },
          });
        }
        yield* stream.next(
          (entry): entry is EventItem =>
            entry.kind === "event" &&
            entry.event.type === "plan.updated" &&
            entry.event.payload.kind === "todo_list" &&
            entry.event.payload.status === "completed",
        );
        workbench.setTurn(turn, "completed");
        const next = workbench.addTurn("session-1", "Refine task list");
        workbench.addItem(next, {
          kind: "plan",
          status: "completed",
          title: "TaskUpdate",
          data: {
            name: "TaskUpdate",
            input: { taskId: "2", status: "in_progress" },
            result: { success: false },
          },
        });
        workbench.addItem(next, {
          kind: "plan",
          status: "completed",
          title: "TaskUpdate",
          data: {
            name: "TaskUpdate",
            input: { taskId: "3", status: "deleted" },
            result: { success: true },
          },
        });
        workbench.addItem(next, {
          kind: "plan",
          status: "failed",
          title: "TaskUpdate",
          data: {
            name: "TaskUpdate",
            input: { taskId: "1", status: "in_progress" },
            result: "Updated task #1",
          },
        });
        const reopened = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
        );
        const snapshot = yield* reopened.next((entry) => entry.kind === "snapshot");
        if (snapshot.kind !== "snapshot") throw new Error("Expected a snapshot");
        const lists = snapshot.projection.turnItems.filter((item) => item.type === "todo_list");
        assert.lengthOf(lists, 2);
        assert.strictEqual(lists[0]?.id, checklist[0]?.id);
        assert.deepStrictEqual(
          lists[1]?.steps.map((step) => [step.id, step.status]),
          [
            ["1", "completed"],
            ["2", "completed"],
          ],
        );
        assert.lengthOf(
          snapshot.projection.plans.filter((plan) => plan.kind === "todo_list"),
          2,
        );
        workbench.addItem(next, {
          kind: "plan",
          status: "completed",
          title: "TaskList",
          data: {
            name: "TaskList",
            result: { tasks: [{ id: "4", subject: "Next step", status: "in_progress" }] },
          },
        });
        yield* stream.next(
          (entry): entry is EventItem =>
            entry.kind === "event" &&
            entry.event.type === "plan.updated" &&
            entry.event.payload.kind === "todo_list" &&
            entry.event.payload.steps[0]?.id === "4" &&
            entry.event.payload.steps[0]?.status === "running",
        );
        workbench.addItem(next, {
          kind: "plan",
          status: "completed",
          title: "TaskList",
          data: { name: "TaskList", result: { tasks: [] } },
        });
        yield* stream.next(
          (entry): entry is EventItem =>
            entry.kind === "event" &&
            entry.event.type === "plan.updated" &&
            entry.event.payload.kind === "todo_list" &&
            entry.event.payload.steps.length === 0,
        );
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
