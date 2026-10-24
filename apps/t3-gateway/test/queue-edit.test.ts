import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  emptyQueue,
  newEntry,
  reorder,
  edit,
  startQueued,
  type SessionView,
  type ThreadQueue,
} from "../src/queue.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * `queued-run.edit`, `queued-run.reorder` and `queued-run.start` (ADR 0012, phase 2): what still
 * waits in the gateway's queue can be rewritten, moved and sent first; what is on its way to Mend
 * cannot.
 */

type Item = OrchestrationV2ThreadStreamItem;

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

let commands = 0;
const commandId = () => CommandId.make(`edit-command-${++commands}`);
const THREAD = ThreadId.make("session-1");

const message = (messageId: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: THREAD,
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const turnInputs = (mend: FakeMend) =>
  mend.workbench.calls
    .filter((call) => call.method === "POST" && call.path.endsWith("/turns"))
    .map((call) =>
      typeof call.body === "object" && call.body !== null && "input" in call.body
        ? call.body.input
        : null,
    );

const errorTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

describe("editing and reordering the queue", () => {
  it.live("rewrites and moves waiting messages, and sends them in their new order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");
        const { rpc } = yield* pairAndConnect(mend, "EDIT");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        for (const [id, text] of [
          ["message-a", "First"],
          ["message-b", "Second"],
          ["message-c", "Third"],
        ] as const) {
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message(id, text));
        }
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const runOf = (messageId: string) => {
          const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
          if (run === undefined) throw new Error(`no run for ${messageId}`);
          return run.id;
        };

        // Third goes first; Second gets new words.
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queued-run.reorder",
          commandId: commandId(),
          threadId: THREAD,
          runId: runOf("message-c"),
          beforeRunId: runOf("message-a"),
        });
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.userMessageId === "message-c" &&
            item.event.payload.queuePosition === 1,
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queued-run.edit",
          commandId: commandId(),
          threadId: THREAD,
          runId: runOf("message-b"),
          text: "Second, with tests",
        });
        // t3code shows a queued row from its message: the edit is a message upsert.
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.id === "message-b" &&
            item.event.payload.text === "Second, with tests",
        );
        // Moving one to the end, and refusing an empty edit.
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queued-run.reorder",
          commandId: commandId(),
          threadId: THREAD,
          runId: runOf("message-a"),
          beforeRunId: null,
        });
        const empty = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.edit",
            commandId: commandId(),
            threadId: THREAD,
            runId: runOf("message-a"),
            text: "  ",
          }),
        );
        assert.strictEqual(errorTag(empty), "OrchestrationV2DispatchCommandError");

        mend.workbench.setTurn(open, "completed");
        yield* eventually(() => turnInputs(mend).length === 1, "the first queued message");
        assert.deepStrictEqual(turnInputs(mend), ["Third"]);

        // On its way to Mend, a message is neither rewritten nor moved.
        const sent = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.edit",
            commandId: commandId(),
            threadId: THREAD,
            runId: runOf("message-c"),
            text: "Too late",
          }),
        );
        assert.strictEqual(errorTag(sent), "OrchestrationV2DispatchCommandError");

        for (const expected of [
          ["Third", "Second, with tests"],
          ["Third", "Second, with tests", "First"],
        ]) {
          const turns = mend.workbench.turns.get("session-1") ?? [];
          const last = turns.at(-1);
          if (last !== undefined && last.status === "running")
            mend.workbench.setTurn(last, "completed");
          yield* eventually(() => turnInputs(mend).length === expected.length, "the next message");
          assert.deepStrictEqual(turnInputs(mend), expected);
        }
      }),
    ),
  );
});

describe("sending a held message now", () => {
  it.live("sends the chosen message first once the queue was held, then the rest in order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");
        const { rpc } = yield* pairAndConnect(mend, "SEND-NOW");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        for (const [id, text] of [
          ["message-a", "First"],
          ["message-b", "Second"],
          ["message-c", "Third"],
        ] as const) {
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message(id, text));
        }
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const runOf = (messageId: string) => {
          const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
          if (run === undefined) throw new Error(`no run for ${messageId}`);
          return run.id;
        };
        const running = projection.runs.find((run) => run.status === "running");
        assert.isDefined(running);
        if (running === undefined) return;

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "run.interrupt",
          commandId: commandId(),
          threadId: THREAD,
          runId: running.id,
          holdQueue: true,
        });
        yield* eventually(() => open.status === "interrupted", "the interrupt");
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.userMessageId === "message-a" &&
            item.event.payload.queueHeld === true,
        );
        // Sent now only once the gateway has seen the turn stop, as t3code's server takes it.
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === running.id &&
            item.event.payload.status === "interrupted",
        );
        assert.deepStrictEqual(turnInputs(mend), []);

        // A run that is not waiting in the queue is refused in t3code's words.
        const notWaiting = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.start",
            commandId: commandId(),
            threadId: THREAD,
            runId: running.id,
          }),
        );
        assert.include(
          Exit.isFailure(notWaiting) ? String(Cause.squash(notWaiting.cause)) : "",
          "A queued user message can only be sent now while the thread is stopped.",
        );

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queued-run.start",
          commandId: commandId(),
          threadId: THREAD,
          runId: runOf("message-c"),
        });
        yield* eventually(() => turnInputs(mend).length === 1, "the message sent now");
        assert.deepStrictEqual(turnInputs(mend), ["Third"]);

        // On its way to Mend, it is not sent again.
        const again = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.start",
            commandId: commandId(),
            threadId: THREAD,
            runId: runOf("message-c"),
          }),
        );
        assert.strictEqual(errorTag(again), "OrchestrationV2DispatchCommandError");

        for (const expected of [
          ["Third", "First"],
          ["Third", "First", "Second"],
        ]) {
          const last = (mend.workbench.turns.get("session-1") ?? []).at(-1);
          if (last !== undefined && last.status === "running")
            mend.workbench.setTurn(last, "completed");
          yield* eventually(() => turnInputs(mend).length === expected.length, "the next message");
          assert.deepStrictEqual(turnInputs(mend), expected);
        }
      }),
    ),
  );
});

/** The messages still waiting, in the order the client shows them. */
const queuedOrder = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
    .map((run) => run.userMessageId);

describe("sending a queued message now while a turn runs", () => {
  it.live("refuses it as t3code's server does, and the queue keeps its order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");
        const { rpc } = yield* pairAndConnect(mend, "SEND-NOW-BUSY");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("message-a", "First"));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("message-b", "Second"));
        const before = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.deepStrictEqual(queuedOrder(before.runs), ["message-a", "message-b"]);
        const second = before.runs.find((run) => run.userMessageId === "message-b");
        assert.isDefined(second);
        if (second === undefined) return;

        const refused = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.start",
            commandId: commandId(),
            threadId: THREAD,
            runId: second.id,
          }),
        );
        assert.strictEqual(errorTag(refused), "OrchestrationV2DispatchCommandError");
        assert.include(
          Exit.isFailure(refused) ? String(Cause.squash(refused.cause)) : "",
          "A queued user message can only be sent now while the thread is stopped.",
        );
        const after = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.deepStrictEqual(queuedOrder(after.runs), ["message-a", "message-b"]);

        mend.workbench.setTurn(open, "completed");
        yield* eventually(() => turnInputs(mend).length === 1, "the first queued message");
        assert.deepStrictEqual(turnInputs(mend), ["First"]);
      }),
    ),
  );
});

describe("an edit is kept before it is acknowledged (594-R2-1)", () => {
  it.live(
    "refuses an edit the state file will not keep: the old text stays, live and after a restart",
    () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-edit-")), "state.sqlite");
      const onGateway = <A, E, R>(mend: FakeMend, test: Effect.Effect<A, E, R>) =>
        Effect.scoped(test).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.addTurn("session-1", "A long job");
        yield* onGateway(
          mend,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "EDIT-KEPT");
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("message-edited", "Old instruction"),
            );
            const before = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: THREAD,
            });
            const run = before.runs.find(
              (candidate) => candidate.userMessageId === "message-edited",
            );
            assert.isDefined(run);
            const database = new DatabaseSync(statePath);
            database.exec(
              "CREATE TRIGGER refuse_edit BEFORE INSERT ON queued_messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
            );
            database.close();
            const exit = yield* Effect.exit(
              rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "queued-run.edit",
                commandId: commandId(),
                threadId: THREAD,
                runId: run?.id ?? RunId.make("missing"),
                text: "New instruction",
              }),
            );
            assert.strictEqual(errorTag(exit), "OrchestrationV2DispatchCommandError");
            const after = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: THREAD,
            });
            assert.strictEqual(
              after.messages.find((candidate) => candidate.id === "message-edited")?.text,
              "Old instruction",
            );
          }),
        );
        yield* onGateway(
          mend,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "EDIT-KEPT-AFTER");
            const restored = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: THREAD,
            });
            assert.strictEqual(
              restored.messages.find((candidate) => candidate.id === "message-edited")?.text,
              "Old instruction",
            );
          }),
        );
      });
    },
  );
});

const queueOf = (...states: ReadonlyArray<"queued" | "launching" | "sending">): ThreadQueue => {
  const queue = emptyQueue();
  states.forEach((state, index) => {
    const entry = newEntry({
      runId: `run-${index}`,
      messageId: `message-${index}`,
      text: `text ${index}`,
      requestedAt: "2026-10-10T09:00:00.000Z",
      token: "mdt",
      sender: "bearer",
    });
    entry.state = state;
    queue.entries.push(entry);
  });
  return queue;
};
const order = (queue: ThreadQueue) => queue.entries.map((entry) => entry.runId);

describe("the queue's own rules", () => {
  it("moves a waiting message before another, or after the last one waiting", () => {
    const queue = queueOf("sending", "queued", "queued", "queued");
    assert.isTrue(reorder(queue, "run-3", "run-1"));
    assert.deepStrictEqual(order(queue), ["run-0", "run-3", "run-1", "run-2"]);
    assert.isTrue(reorder(queue, "run-3", null));
    assert.deepStrictEqual(order(queue), ["run-0", "run-1", "run-2", "run-3"]);
  });

  it("sends a waiting message first, and only once the thread is stopped", () => {
    const idle: SessionView = {
      known: true,
      agentLive: true,
      turnOpen: false,
      status: "running",
      updatedAt: null,
      summary: null,
      evidence: 1,
    };
    const queue = queueOf("queued", "queued", "queued");
    queue.held = true;
    assert.strictEqual(startQueued(queue, { ...idle, turnOpen: true }, "run-2"), "busy");
    assert.strictEqual(startQueued(queue, idle, "run-9"), "gone");
    assert.deepStrictEqual(order(queue), ["run-0", "run-1", "run-2"]);
    assert.isTrue(queue.held);
    assert.strictEqual(startQueued(queue, idle, "run-2"), "started");
    assert.deepStrictEqual(order(queue), ["run-2", "run-0", "run-1"]);
    assert.isFalse(queue.held);
    for (const onItsWay of ["launching", "sending"] as const) {
      const busy = queueOf(onItsWay, "queued");
      assert.strictEqual(startQueued(busy, idle, "run-1"), "busy");
      assert.strictEqual(startQueued(busy, idle, "run-0"), "gone");
    }
  });

  it("never moves or rewrites a message on its way, nor puts one before it", () => {
    const queue = queueOf("sending", "queued");
    assert.isFalse(reorder(queue, "run-0", null));
    assert.isFalse(reorder(queue, "run-1", "run-0"));
    assert.isFalse(edit(queue, "run-0", "new"));
    assert.isTrue(edit(queue, "run-1", "new"));
    assert.strictEqual(queue.entries[1]?.text, "new");
    assert.deepStrictEqual(order(queue), ["run-0", "run-1"]);
  });

  it("moves the only waiting message to the end behind what is on its way, never ahead of it", () => {
    const sending = queueOf("sending", "queued");
    assert.isTrue(reorder(sending, "run-1", null));
    assert.deepStrictEqual(order(sending), ["run-0", "run-1"]);
    const launching = queueOf("launching", "queued");
    assert.isTrue(reorder(launching, "run-1", null));
    assert.deepStrictEqual(order(launching), ["run-0", "run-1"]);
  });
});
