import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  WS_METHODS,
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
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { mendAnswersOf, mendDecisionOf } from "../src/commands.ts";
import type { QueueTimings } from "../src/queue.ts";
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
  options: {
    readonly hubIdleTimeToLive?: Duration.Input;
    readonly queueTimings?: Partial<QueueTimings>;
  } = {},
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(
      Effect.scoped,
      Effect.provide(gatewayTestLayer(mend.url, statePath, options)),
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
    "never sends a second turn while one is open, though a read from before it was sent lands after",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const open = mend.workbench.addTurn("session-1", "A long job");
          const { rpc } = yield* pairAndConnect(mend, "STALE-READ");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-first", "First"),
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-second", "Second"),
          );
          // Every read of the turns answers late what it read when asked.
          mend.workbench.turnsReadDelayMs = 300;
          mend.workbench.setTurn(open, "completed");
          // A second pointer while the first read is under way: its read starts once that one
          // lands, around when "First" is sent, and may answer from before Mend took it.
          yield* Effect.sleep("100 millis");
          mend.workbench.emit({
            type: "agent-conversation",
            sessionId: "session-1",
            projectId: "project-1",
          });
          yield* eventually(() => posts(mend, "/turns").length === 1, "the first message");
          // "First" runs in Mend: nothing else goes out, whatever read lands late.
          yield* Effect.sleep("1500 millis");
          assert.strictEqual(posts(mend, "/turns").length, 1);
          mend.workbench.turnsReadDelayMs = 0;
          const [, first] = mend.workbench.turns.get("session-1") ?? [];
          if (first !== undefined) mend.workbench.setTurn(first, "completed");
          yield* eventually(() => posts(mend, "/turns").length === 2, "the second message");
        }),
      ),
  );

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

  it.live(
    "launches a stopped session again with the message, bringing the agent up, then sending the message as a turn",
    () =>
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
          // No prompt and no options: the launch only brings the agent up, on what it last
          // recorded (mend#493), so ask stays ask and nothing the gateway cached can go stale.
          assert.deepStrictEqual(posts(mend, "/launch")[0]?.body, { mode: "protocol" });
          // Once Mend reports the agent live, the message goes out as a turn, whose id Mend answers.
          yield* eventually(() => posts(mend, "/turns").length === 1, "the message's turn");
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, { input: "Pick it up again" });
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

describe("review round 1", () => {
  it.live("a queued message outlives its last client", () =>
    withGateway(
      (mend) =>
        Effect.gen(function* () {
          setup(mend);
          const turn = mend.workbench.addTurn("session-1", "A long job");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { rpc } = yield* pairAndConnect(mend, "LEAVING");
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
                message("session-1", "message-left", "Then this"),
              );
            }),
          );
          // The client is gone for longer than an idle hub lives.
          yield* Effect.sleep("800 millis");
          mend.workbench.setTurn(turn, "completed");
          yield* eventually(() => posts(mend, "/turns").length === 1, "the queued turn");
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, { input: "Then this" });
        }),
      undefined,
      { hubIdleTimeToLive: "200 millis" },
    ),
  );

  it.live("a launch that fails after it answered fails the message with Mend's reason", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.stopAgent("session-1");
        mend.workbench.launchBringsAgentUp = false;
        const { rpc } = yield* pairAndConnect(mend, "LAUNCHFAILS");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-doomed", "Try this"),
        );
        yield* eventually(() => posts(mend, "/launch").length === 1, "the launch");
        yield* Effect.sleep("200 millis");
        // Provisioning fails after the launch answered.
        mend.workbench.failSession("session-1", "launch failed: Transport error (POST /v1/users)");
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-doomed" && run.status === "failed"),
        );
        const failure = yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "turn-item.updated" &&
            item.event.payload.type === "error",
        );
        assert.isTrue(
          failure.event.type === "turn-item.updated" &&
            failure.event.payload.type === "error" &&
            failure.event.payload.failure.message ===
              "launch failed: Transport error (POST /v1/users)",
        );
        assert.strictEqual(posts(mend, "/turns").length, 0);
        // The queue is not blocked: the next message launches again.
        mend.workbench.launchBringsAgentUp = true;
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-again", "Try again"),
        );
        yield* eventually(() => posts(mend, "/launch").length === 2, "the second launch");
        yield* eventually(() => posts(mend, "/turns").length === 1, "its turn");
      }),
    ),
  );

  it.live("a message taken back while the session launches never goes out", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.stopAgent("session-1");
        mend.workbench.launchLiveDelayMs = 800;
        const { rpc } = yield* pairAndConnect(mend, "TAKEBACK");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-back", "Never mind"),
        );
        const preparing = yield* thread.next(
          runEvent((run) => run.userMessageId === "message-back" && run.status === "preparing"),
        );
        const runId =
          preparing.event.type === "run.updated" ? preparing.event.payload.id : RunId.make("none");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "run.interrupt",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          runId,
          holdQueue: true,
        });
        yield* thread.next(runEvent((run) => run.id === runId && run.status === "cancelled"));
        // The agent comes up; nothing is sent, and no turn is interrupted.
        yield* Effect.sleep("1500 millis");
        assert.strictEqual(posts(mend, "/turns").length, 0);
        assert.strictEqual(posts(mend, "/interrupt").length, 0);
      }),
    ),
  );

  it.live("a command sent twice at once is one message", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "TWICE");
        const command = message("session-1", "message-once", "Only once");
        yield* Effect.all(
          [
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command),
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command),
          ],
          { concurrency: 2 },
        );
        yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
        yield* Effect.sleep("300 millis");
        assert.strictEqual(posts(mend, "/turns").length, 1);
      }),
    ),
  );
});

describe("review round 2", () => {
  it.live("a 401 on a message's own send refuses its device and closes its socket", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "SEND401");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        mend.workbench.turnsUnauthorized = true;
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-401", "Sent by a revoked device"),
        );
        yield* eventually(() => posts(mend, "/turns").length === 1, "the send");
        // The socket closes without waiting for the device poll.
        yield* Effect.gen(function* () {
          for (;;) {
            const probe = yield* Effect.exit(
              rpc[WS_METHODS.serverProbe]({}).pipe(Effect.timeout("1 second")),
            );
            if (probe._tag === "Failure") return;
            yield* Effect.sleep("100 millis");
          }
        }).pipe(Effect.timeout("3 seconds"));
      }),
    ),
  );

  it.live(
    "revoking the last device fails what was queued, releases the lease, and stops reading",
    () =>
      withGateway(
        (mend) =>
          Effect.gen(function* () {
            setup(mend);
            mend.workbench.addTurn("session-1", "A long job");
            yield* Effect.scoped(
              Effect.gen(function* () {
                const { rpc } = yield* pairAndConnect(mend, "LASTDEVICE");
                yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
                  message("session-1", "message-queued", "Behind it"),
                );
                mend.revoke(mend.claims[0]?.token ?? "");
                mend.workbench.emit({ type: "user", userId: "user-1", facet: "devices" });
              }),
            );
            // The hub stops Mend's stream and is not held by the queue it failed.
            yield* eventually(() => mend.workbench.eventStreams === 0, "the stream to close");
            const reads = mend.workbench.calls.length;
            yield* Effect.sleep("1 second");
            assert.strictEqual(mend.workbench.calls.length, reads);
            assert.strictEqual(posts(mend, "/turns").length, 0);
          }),
        undefined,
        { hubIdleTimeToLive: "200 millis" },
      ),
  );

  it.live("interrupting a message on its way honours holdQueue", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.stopAgent("session-1");
        mend.workbench.launchLiveDelayMs = 600;
        const { rpc } = yield* pairAndConnect(mend, "HOLDONWAY");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-1", "First"),
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-2", "Second"),
        );
        const first = yield* thread.next(
          runEvent((run) => run.userMessageId === "message-1" && run.status === "preparing"),
        );
        const runId =
          first.event.type === "run.updated" ? first.event.payload.id : RunId.make("none");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "run.interrupt",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          runId,
          holdQueue: true,
        });
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-2" && run.queueHeld === true),
        );
        // The agent comes up: the second message stays held.
        yield* Effect.sleep("1200 millis");
        assert.strictEqual(posts(mend, "/turns").length, 0);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queue.resume",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
        });
        yield* eventually(() => posts(mend, "/turns").length === 1, "the resumed message");
        assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, { input: "Second" });
      }),
    ),
  );

  it.live("a session that had failed before the relaunch does not fail the message", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        // An earlier launch failed; the session reads failed when the follow-up arrives.
        mend.workbench.failSession("session-1", "launch failed: an earlier attempt");
        const { rpc } = yield* pairAndConnect(mend, "STALEFAIL");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-ok", "Works now"),
        );
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-ok" && run.status === "running"),
        );
        assert.strictEqual(posts(mend, "/turns").length, 1);
      }),
    ),
  );

  it.live("another client's turn with the same text is never taken for the message", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.stopAgent("session-1");
        mend.workbench.launchLiveDelayMs = 600;
        const { rpc } = yield* pairAndConnect(mend, "SAMETEXT");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("session-1", "message-mine", "Run the tests"),
        );
        yield* eventually(() => posts(mend, "/launch").length === 1, "the launch");
        // Someone else's turn with the same words lands while the agent comes up.
        const theirs = mend.workbench.addTurn("session-1", "Run the tests", "completed");
        yield* eventually(() => posts(mend, "/turns").length === 1, "the message's own turn");
        const mine = yield* thread.next(
          runEvent((run) => run.userMessageId === "message-mine" && run.status !== "preparing"),
        );
        // Theirs keeps its own id and message; ours is the turn POST /turns answered.
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("session-1"),
        });
        const theirRun = projection.runs.find((run) => run.id === theirs.id);
        assert.isDefined(theirRun);
        assert.notStrictEqual(theirRun?.userMessageId, "message-mine");
        assert.isTrue(mine.event.type === "run.updated" && mine.event.payload.id !== theirs.id);
      }),
    ),
  );

  it.live("a session removed with queued work fails it and lets the hub go", () =>
    withGateway(
      (mend) =>
        Effect.gen(function* () {
          setup(mend);
          mend.workbench.addTurn("session-1", "A long job");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { rpc } = yield* pairAndConnect(mend, "REMOVED");
              const thread = yield* feed(
                rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                  threadId: ThreadId.make("session-1"),
                }),
              );
              yield* thread.next(
                (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
              );
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
                message("session-1", "message-orphan", "Behind it"),
              );
              const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
              mend.workbench.removeSession("session-1");
              yield* shell.next(
                (item): item is Extract<typeof item, { kind: "thread.removed" }> =>
                  item.kind === "thread.removed",
              );
            }),
          );
          // No client and nothing that can progress: the hub goes, and its stream with it.
          yield* eventually(() => mend.workbench.eventStreams === 0, "the hub to go");
          assert.strictEqual(posts(mend, "/turns").length, 0);
        }),
      undefined,
      { hubIdleTimeToLive: "200 millis" },
    ),
  );
});

describe("review round 3", () => {
  // Reproduction from the round-3 review (repro-wedge.test.ts), kept as a regression test.
  it.live("a relaunch Mend forgets neither wedges the queue nor holds the hub", () =>
    withGateway(
      (mend) =>
        Effect.gen(function* () {
          const { workbench } = mend;
          setup(mend);
          const session = workbench.sessions.get("session-1");
          workbench.stopAgent("session-1");
          workbench.launchBringsAgentUp = false;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { rpc } = yield* pairAndConnect(mend, "WEDGE");
              const thread = yield* feed(
                rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                  threadId: ThreadId.make("session-1"),
                }),
              );
              yield* thread.next(
                (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
              );
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
                message("session-1", "message-first", "first"),
              );
              const preparing = yield* thread.next(
                runEvent(
                  (run) => run.userMessageId === "message-first" && run.status === "preparing",
                ),
              );
              const runId =
                preparing.event.type === "run.updated"
                  ? preparing.event.payload.id
                  : RunId.make("none");
              yield* Effect.sleep("300 millis");
              // Mend restarts mid-launch: the row reads settled `stopped` again, updatedAt unchanged.
              if (session !== undefined) session.status = "stopped";
              workbench.emit({ type: "session", sessionId: "session-1", projectId: "project-1" });
              yield* Effect.sleep("300 millis");
              // Taken back, it stops blocking at once: the next message moves.
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "run.interrupt",
                commandId: commandId(),
                threadId: ThreadId.make("session-1"),
                runId,
                holdQueue: false,
              });
              yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
                message("session-1", "message-second", "second"),
              );
              yield* eventually(() => posts(mend, "/launch").length === 2, "the second launch");
              // And a launch that never brings the agent up fails at its deadline.
              yield* thread.next(
                runEvent(
                  (run) => run.userMessageId === "message-second" && run.status === "failed",
                ),
              );
            }),
          );
          // Nothing can progress: the hub goes after its idle time.
          yield* eventually(() => workbench.eventStreams === 0, "the hub to go");
          assert.strictEqual(posts(mend, "/turns").length, 0);
        }),
      undefined,
      { hubIdleTimeToLive: "200 millis", queueTimings: { launchDeadlineMs: 1_000 } },
    ),
  );

  // Reproduction from the round-3 review (repro-hotloop.test.ts), kept as a regression test.
  it.live(
    "a 409 while the row reads running is retried after a backoff and a fresh read, not looped",
    () =>
      withGateway(
        (mend) =>
          Effect.gen(function* () {
            setup(mend);
            const { rpc } = yield* pairAndConnect(mend, "HOTLOOP");
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: ThreadId.make("session-1"),
              }),
            );
            yield* thread.next(
              (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
            );
            mend.workbench.turnsNotLive = true;
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("session-1", "message-busy", "hello"),
            );
            yield* Effect.sleep("1 second");
            const tried = posts(mend, "/turns").length;
            assert.isAtMost(tried, 2, `POST /turns ${tried} times in 1 s`);
            // Mend takes turns again: after its backoff and a fresh read, the message goes out.
            mend.workbench.turnsNotLive = false;
            yield* thread.next(
              runEvent((run) => run.userMessageId === "message-busy" && run.status === "running"),
              "10 seconds",
            );
            assert.isAtMost(posts(mend, "/turns").length, tried + 2);
          }),
        undefined,
        { queueTimings: { retryBaseMs: 500, retryMaxMs: 1_000 } },
      ),
  );

  it.live("a message Mend keeps answering not-live fails at its deadline with Mend's reason", () =>
    withGateway(
      (mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "NOTLIVEDEADLINE");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          mend.workbench.turnsNotLive = true;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-stuck", "hello"),
          );
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-stuck" && run.status === "failed"),
            "10 seconds",
          );
          const failure = yield* thread.next(
            (item): item is Extract<Item, { kind: "event" }> =>
              item.kind === "event" &&
              item.event.type === "turn-item.updated" &&
              item.event.payload.type === "error",
          );
          assert.isTrue(
            failure.event.type === "turn-item.updated" &&
              failure.event.payload.type === "error" &&
              failure.event.payload.failure.message.includes("ProtocolSessionNotLive"),
          );
          assert.isAtMost(posts(mend, "/turns").length, 6);
        }),
      undefined,
      { queueTimings: { retryBaseMs: 200, retryMaxMs: 400, sendDeadlineMs: 1_500 } },
    ),
  );

  it.live(
    "a relaunch that races another client's launch waits for the agent instead of failing",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          mend.workbench.stopAgent("session-1");
          mend.workbench.launchRefusal =
            "starting · a launch of this session is already under way · nothing new started";
          mend.workbench.launchLiveDelayMs = 500;
          const { rpc } = yield* pairAndConnect(mend, "RACE");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-race", "Go on"),
          );
          yield* eventually(() => posts(mend, "/turns").length === 1, "the message's turn");
          assert.strictEqual(posts(mend, "/launch").length, 1);
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-race" && run.status === "running"),
          );
        }),
      ),
  );
});

describe("review round 4", () => {
  // Reproduction from the round-4 review (repro-deadline-carry.test.ts), kept as a regression test.
  it.live(
    "a relaunch starts the send deadline and backoff again for the new agent",
    () =>
      withGateway(
        (mend) =>
          Effect.gen(function* () {
            const { workbench } = mend;
            setup(mend);
            const { rpc } = yield* pairAndConnect(mend, "CARRY");
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: ThreadId.make("session-1"),
              }),
            );
            yield* thread.next(
              (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
            );
            // The idle stop has claimed the session: 409s while the row still reads running.
            workbench.turnsNotLive = true;
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("session-1", "message-carry", "hello"),
            );
            yield* Effect.sleep("400 millis");
            // The stop finishes and the gateway relaunches; the new agent outlasts the send deadline.
            workbench.turnsNotLive = false;
            workbench.launchLiveDelayMs = 2_500;
            workbench.stopAgent("session-1");
            yield* eventually(() => posts(mend, "/launch").length === 1, "the relaunch");
            // Its row reads running a moment before its protocol host attaches: one more 409.
            yield* Effect.sleep("2400 millis");
            workbench.turnsNotLive = true;
            yield* Effect.sleep("600 millis");
            workbench.turnsNotLive = false;
            yield* thread.next(
              runEvent((run) => run.userMessageId === "message-carry" && run.status === "running"),
              "5 seconds",
            );
            assert.strictEqual(workbench.turns.get("session-1")?.length ?? 0, 1);
          }),
        undefined,
        { queueTimings: { retryBaseMs: 100, retryMaxMs: 200, sendDeadlineMs: 2_000 } },
      ),
    20_000,
  );

  // Reproduction from the round-4 review (repro-cancel-flip.test.ts), kept as a regression test.
  it.live(
    "a message taken back while its launch is in flight stays cancelled when the launch fails",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { workbench } = mend;
          setup(mend);
          workbench.stopAgent("session-1");
          workbench.launchAnswerDelayMs = 800;
          workbench.launchFailStatus = 500;
          const { rpc } = yield* pairAndConnect(mend, "FLIP");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("session-1", "message-flip", "hello"),
          );
          const preparing = yield* thread.next(
            runEvent((run) => run.userMessageId === "message-flip" && run.status === "preparing"),
          );
          const runId =
            preparing.event.type === "run.updated"
              ? preparing.event.payload.id
              : RunId.make("none");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "run.interrupt",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            runId,
            holdQueue: false,
          });
          yield* thread.next(runEvent((run) => run.id === runId && run.status === "cancelled"));
          // The launch answers 500 after the take-back: the run is not rewritten.
          const after = yield* thread
            .next(runEvent((run) => run.id === runId))
            .pipe(Effect.timeout("2 seconds"), Effect.option);
          assert.isTrue(after._tag === "None", "the cancelled run changed again");
          assert.strictEqual(posts(mend, "/launch").length, 1);
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
