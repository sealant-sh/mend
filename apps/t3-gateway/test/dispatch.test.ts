import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { mendAnswersOf, mendDecisionOf } from "../src/commands.ts";
import { openGatewayState } from "../src/state.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Phase 1's commands (ADR 0012, "The surface"): a follow-up, also after the idle stop; the
 * gateway's queue; an interrupt that holds it; and answers to what the agent asks under `ask`.
 */

const withGateway = <A, E, R>(
  test: (mend: FakeMend) => Effect.Effect<A, E, R>,
  statePath?: string,
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(
      Effect.scoped,
      Effect.provide(gatewayTestLayer(mend.url, statePath)),
    );
  });

type Item = OrchestrationV2ThreadStreamItem;

let commands = 0;
const commandId = () => CommandId.make(`command-${++commands}`);

const message = (threadId: string, messageId: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

/** The next upsert of a run that `accept` takes. */
const runEvent =
  (accept: (run: OrchestrationV2Run) => boolean) =>
  (item: Item): item is Extract<Item, { kind: "event" }> =>
    item.kind === "event" && item.event.type === "run.updated" && accept(item.event.payload);

/** Waits for a condition on the fake Mend, as a client waits for Mend to act. */
const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const setup = (
  mend: FakeMend,
  options: { readonly steer?: boolean; readonly ask?: boolean } = {},
) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({
    id: "session-1",
    projectId: "project-1",
    harness: "codex",
    permissionMode: options.ask === true ? "ask" : "bypass",
    ...(options.steer === undefined ? {} : { steer: options.steer }),
  });
};

const posts = (mend: FakeMend, suffix: string) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

describe("message.dispatch", () => {
  it.live(
    "sends a follow-up as a turn, queues the next behind it, and keeps the client's ids",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "FOLLOWUP");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );

          // The first message goes straight to the live agent.
          const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-a", "Add a test"),
          );
          assert.isAbove(result.sequence, 0);
          yield* eventually(() => posts(mend, "/turns").length === 1, "the first turn");
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, { input: "Add a test" });
          const running = yield* thread.next(
            runEvent((run) => run.userMessageId === "message-a" && run.status === "running"),
          );
          const runId = running.event.type === "run.updated" ? running.event.payload.id : null;
          assert.isTrue(runId?.startsWith("t3-run:"));

          // The second waits behind it, in the gateway's queue.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-b", "Then run it"),
          );
          const queued = yield* thread.next(
            runEvent((run) => run.userMessageId === "message-b" && run.status === "queued"),
          );
          assert.isTrue(
            queued.event.type === "run.updated" && queued.event.payload.queuePosition === 1,
          );
          assert.strictEqual(posts(mend, "/turns").length, 1);

          // The turn ends; the queued message goes out, and the first run kept its id.
          const turn = mend.workbench.turns.get("session-1")?.[0];
          assert.isDefined(turn);
          if (turn === undefined) return;
          mend.workbench.setTurn(turn, "completed");
          yield* thread.next(runEvent((run) => run.id === runId && run.status === "completed"));
          yield* eventually(() => posts(mend, "/turns").length === 2, "the queued turn");
          assert.deepStrictEqual(posts(mend, "/turns")[1]?.body, { input: "Then run it" });
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-b" && run.status === "running"),
          );
        }),
      ),
  );

  it.live("launches a stopped session again with the message, naming no options", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend, { ask: true });
        // The 15-minute idle stop ended the agent.
        mend.workbench.stopAgent("session-1");
        const { rpc } = yield* pairAndConnect(mend, "RELAUNCH");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        const snapshot = yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        assert.strictEqual(snapshot.projection.providerSessions[0]?.status, "stopped");

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-c", "Pick it up again"),
        );
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-c" && run.status === "preparing"),
        );
        yield* eventually(() => posts(mend, "/launch").length === 1, "the launch");
        // Mend reuses what the agent last recorded (ask stays ask): the gateway names nothing.
        assert.deepStrictEqual(posts(mend, "/launch")[0]?.body, {
          mode: "protocol",
          prompt: "Pick it up again",
        });
        assert.strictEqual(posts(mend, "/turns").length, 0);
        // The launch's opening turn is the message: same run, same message, now running.
        const adopted = yield* thread.next(
          runEvent((run) => run.userMessageId === "message-c" && run.status === "running"),
        );
        assert.isTrue(
          adopted.event.type === "run.updated" && adopted.event.payload.id.startsWith("t3-run:"),
        );
      }),
    ),
  );

  it.live("refuses a session the person may not steer, with t3code's authorization error", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend, { steer: false });
        const { rpc } = yield* pairAndConnect(mend, "NOTMINE");
        const exit = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("session-1", "message-d", "Hi")),
        );
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.strictEqual(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag,
            "EnvironmentAuthorizationError",
          );
        }
        assert.strictEqual(posts(mend, "/turns").length, 0);

        // A command Mend has no equivalent for is the command's own typed refusal.
        const fork = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
          }).pipe(
            Effect.andThen(
              rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.archive",
                commandId: commandId(),
                threadId: ThreadId.make("session-1"),
              }),
            ),
          ),
        );
        assert.isTrue(Exit.isFailure(fork));
        if (Exit.isFailure(fork)) {
          assert.strictEqual(
            Option.getOrUndefined(Cause.findErrorOption(fork.cause))?._tag,
            "OrchestrationV2DispatchCommandError",
          );
          assert.isFalse(Cause.hasDies(fork.cause));
        }
      }),
    ),
  );
});

describe("run.interrupt and the queue", () => {
  it.live(
    "interrupts the turn, holds the queue until it is resumed, and cancels a queued run",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const turn = mend.workbench.addTurn("session-1", "A long job");
          const { rpc } = yield* pairAndConnect(mend, "INTERRUPT");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-next", "Next"),
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-later", "Later"),
          );
          const later = yield* thread.next(
            runEvent((run) => run.userMessageId === "message-later" && run.status === "queued"),
          );
          const laterId =
            later.event.type === "run.updated" ? later.event.payload.id : RunId.make("none");

          // t3code always interrupts with holdQueue.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "run.interrupt",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            runId: RunId.make(turn.id),
            holdQueue: true,
          });
          assert.strictEqual(posts(mend, `/turns/${turn.id}/interrupt`).length, 1);
          // The queue is held before the turn ends, so nothing slips out behind it.
          yield* thread.next(runEvent((run) => run.status === "queued" && run.queueHeld === true));
          yield* thread.next(runEvent((run) => run.id === turn.id && run.status === "interrupted"));
          // Held: nothing goes out though no turn is open.
          assert.isTrue(
            yield* thread.quiet(
              (item) =>
                item.kind === "event" &&
                item.event.type === "run.updated" &&
                item.event.payload.status === "starting",
            ),
          );
          assert.strictEqual(posts(mend, "/turns").length, 0);

          // The later message is taken back; it never reaches Mend.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.cancel",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            runId: laterId,
          });
          yield* thread.next(runEvent((run) => run.id === laterId && run.status === "cancelled"));

          // Resumed: the next message goes out.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
          });
          yield* eventually(() => posts(mend, "/turns").length === 1, "the resumed turn");
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, { input: "Next" });
        }),
      ),
  );
});

describe("runtime-request.respond", () => {
  it.live("answers an approval and a question through Mend, and a dismissal cancels", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend, { ask: true });
        const turn = mend.workbench.addTurn("session-1", "Clean up");
        const approval = mend.workbench.addRequest(turn, {
          kind: "command-approval",
          title: "rm -rf dist",
        });
        const question = mend.workbench.addRequest(turn, {
          kind: "user-input",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which packages?",
              options: [
                { label: "all", description: null },
                { label: "web", description: "Only the web app" },
              ],
              multiSelect: true,
            },
          ],
        });
        const another = mend.workbench.addRequest(turn, { kind: "user-input", questions: [] });
        const { rpc } = yield* pairAndConnect(mend, "APPROVE");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        const snapshot = yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        const asked = snapshot.projection.turnItems.find(
          (item) => item.type === "user_input_request",
        );
        assert.isTrue(
          asked?.type === "user_input_request" &&
            asked.questions[0]?.options[0]?.description === "all" &&
            asked.questions[0]?.multiSelect === true,
        );

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "runtime-request.respond",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          requestId: RuntimeRequestId.make(approval.id),
          decision: "acceptForSession",
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "runtime-request.respond",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          requestId: RuntimeRequestId.make(question.id),
          answers: { scope: ["all", "web"] },
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.user-input.dismiss",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          requestId: RuntimeRequestId.make(another.id),
        });
        assert.deepStrictEqual(
          posts(mend, "/respond").map((call) => [call.path, call.body]),
          [
            [`/api/requests/${approval.id}/respond`, { decision: "accept-for-session" }],
            [`/api/requests/${question.id}/respond`, { answers: { scope: ["all", "web"] } }],
            [`/api/requests/${another.id}/respond`, { decision: "cancel" }],
          ],
        );
        const resolved = yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "runtime-request.updated" &&
            item.event.payload.id === approval.id &&
            item.event.payload.status === "resolved",
        );
        assert.isTrue(
          resolved.event.type === "runtime-request.updated" &&
            resolved.event.payload.decision === "acceptForSession",
        );

        // Answered once: a second answer is the command's typed refusal.
        const again = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "runtime-request.respond",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            requestId: RuntimeRequestId.make(approval.id),
            decision: "accept",
          }),
        );
        assert.isTrue(Exit.isFailure(again));
        if (Exit.isFailure(again)) {
          assert.strictEqual(
            Option.getOrUndefined(Cause.findErrorOption(again.cause))?._tag,
            "OrchestrationV2DispatchCommandError",
          );
        }
      }),
    ),
  );
});

describe("the id map", () => {
  it.live("keeps the client's run and message ids for a turn across a gateway restart", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-ids-")), "state.sqlite");
    return Effect.gen(function* () {
      yield* withGateway(
        (mend) =>
          Effect.gen(function* () {
            setup(mend);
            const { rpc } = yield* pairAndConnect(mend, "IDS");
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("session-1", "message-kept", "Remember me"),
            );
            yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
          }),
        statePath,
      );
      const ids = yield* Effect.scoped(
        openGatewayState(statePath).pipe(Effect.flatMap((state) => state.listTurnIds())),
      );
      assert.strictEqual(ids.length, 1);
      assert.strictEqual(ids[0]?.messageId, "message-kept");
      assert.isTrue(ids[0]?.runId.startsWith("t3-run:"));
    });
  });

  it("maps t3code's answers and decisions to Mend's", () => {
    assert.strictEqual(mendDecisionOf("acceptAlways"), "accept-for-session");
    assert.strictEqual(mendDecisionOf("decline"), "decline");
    assert.deepStrictEqual(mendAnswersOf({ a: "yes", b: ["x", "y"], c: { answers: ["z"] } }), {
      a: ["yes"],
      b: ["x", "y"],
      c: ["z"],
    });
  });
});
