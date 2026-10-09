import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
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
  restoredQueue,
  SENDER_GONE,
  SENT_BEFORE_RESTART,
  storedOf,
  type StoredQueue,
} from "../src/queue.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * The gateway's queue survives a restart (ADR 0012, "State", phase 2): kept in its own state file,
 * by bearer session and never by device token, and sent after a restart without waiting for a
 * client to come back.
 */

type Item = OrchestrationV2ThreadStreamItem;

let commands = 0;
const commandId = () => CommandId.make(`kept-command-${++commands}`);

const message = (messageId: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: ThreadId.make("session-1"),
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

const runEvent =
  (accept: (run: OrchestrationV2Run) => boolean) =>
  (item: Item): item is Extract<Item, { kind: "event" }> =>
    item.kind === "event" && item.event.type === "run.updated" && accept(item.event.payload);

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const turnPosts = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith("/turns"));

const freshStatePath = () => join(mkdtempSync(join(tmpdir(), "t3-gateway-queue-")), "state.sqlite");

/** Runs `test` against a gateway on `statePath`, then stops that gateway. */
const gateway = <A, E, R>(mend: FakeMend, statePath: string, test: Effect.Effect<A, E, R>) =>
  Effect.scoped(test).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));

describe("a queue kept across a restart", () => {
  it.live(
    "sends a queued message after a restart, with no client connected, as the same run",
    () => {
      const statePath = freshStatePath();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");

        const runId = yield* gateway(
          mend,
          statePath,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "BEFORE");
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: ThreadId.make("session-1"),
              }),
            );
            yield* thread.next(
              (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
            );
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("message-kept", "Then this"),
            );
            const queued = yield* thread.next(
              runEvent((run) => run.userMessageId === "message-kept" && run.status === "queued"),
            );
            return queued.event.type === "run.updated" ? queued.event.payload.id : null;
          }),
        );
        assert.isTrue(runId?.startsWith("t3-run:"));
        assert.strictEqual(turnPosts(mend).length, 0);

        // The state file names the sender by bearer session; no device token is in a queue row.
        const database = new DatabaseSync(statePath);
        const rows = database.prepare("SELECT * FROM queued_messages").all();
        database.close();
        assert.strictEqual(rows.length, 1);
        const token = mend.claims[0]?.token ?? "";
        assert.isAbove(token.length, 0);
        assert.notInclude(JSON.stringify(rows), token);

        yield* gateway(
          mend,
          statePath,
          Effect.gen(function* () {
            // No client connects: the gateway brings the person's hub back on its own.
            yield* eventually(() => mend.workbench.eventStreams > 0, "the restored hub");
            mend.workbench.setTurn(open, "completed");
            yield* eventually(() => turnPosts(mend).length === 1, "the kept message's turn");
            assert.deepStrictEqual(turnPosts(mend)[0]?.body, { input: "Then this" });

            // A client that comes back sees it as the run it queued.
            const { rpc } = yield* pairAndConnect(mend, "AFTER");
            const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make("session-1"),
            });
            const sent = projection.runs.find((run) => run.userMessageId === "message-kept");
            assert.strictEqual(sent?.id, runId);
          }),
        );
      });
    },
  );

  it.live("keeps a held queue held across a restart until the client resumes it", () => {
    const statePath = freshStatePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const open = mend.workbench.addTurn("session-1", "A long job");

      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "HOLD");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](message("message-held", "Wait"));
          // t3code's interrupt always holds the queue.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "run.interrupt",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            runId: RunId.make(open.id),
            holdQueue: true,
          });
        }),
      );

      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RESUME");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make("session-1"),
          });
          const held = projection.runs.find((run) => run.userMessageId === "message-held");
          assert.strictEqual(held?.status, "queued");
          assert.isTrue(held?.queueHeld);
          yield* Effect.sleep("300 millis");
          assert.strictEqual(turnPosts(mend).length, 0);

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
          });
          yield* eventually(() => turnPosts(mend).length === 1, "the resumed message");
          assert.deepStrictEqual(turnPosts(mend)[0]?.body, { input: "Wait" });
        }),
      );
    });
  });
});

/** A kept message as the state file has it now. */
const keptRow = (statePath: string, messageId: string) => {
  const database = new DatabaseSync(statePath);
  const row = database
    .prepare("SELECT state, error FROM queued_messages WHERE message_id = ?")
    .get(messageId);
  database.close();
  return row;
};

/** Queues one message behind an open turn on a gateway, which then stops. */
const queueBehind = (mend: FakeMend, statePath: string, command: ReturnType<typeof message>) =>
  gateway(
    mend,
    statePath,
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "BEFORE");
      const thread = yield* feed(
        rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: ThreadId.make("session-1") }),
      );
      yield* thread.next(
        (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
      );
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
      yield* thread.next(
        runEvent((run) => run.userMessageId === command.messageId && run.status === "queued"),
      );
    }),
  );

describe("a kept message is sent once, by someone who may", () => {
  it.live("a command the client re-sends after a restart is the message already kept", () => {
    const statePath = freshStatePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const open = mend.workbench.addTurn("session-1", "A long job");
      const command = message("message-once", "Only once");
      yield* queueBehind(mend, statePath, command);

      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AGAIN");
          // The client saw no answer before the restart, so it sends the same command again.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
          mend.workbench.setTurn(open, "completed");
          yield* eventually(() => turnPosts(mend).length === 1, "the kept message's turn");
          yield* Effect.sleep("500 millis");
          assert.strictEqual(turnPosts(mend).length, 1);
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make("session-1"),
          });
          assert.strictEqual(
            projection.runs.filter((run) => run.userMessageId === "message-once").length,
            1,
          );
        }),
      );
    });
  });

  it.live(
    "fails a kept message whose session was deleted in Mend while the gateway was down",
    () => {
      const statePath = freshStatePath();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.addTurn("session-1", "A long job");
        yield* queueBehind(mend, statePath, message("message-orphan", "Nowhere to go"));
        mend.workbench.removeSession("session-1");

        yield* gateway(
          mend,
          statePath,
          eventually(
            () => keptRow(statePath, "message-orphan")?.state === "failed",
            "the orphaned message to fail",
          ),
        );
        assert.strictEqual(turnPosts(mend).length, 0);
        assert.strictEqual(mend.workbench.launches.length, 0);
      });
    },
  );

  it.live("fails a kept message whose sender may no longer steer the session: Mend refuses", () => {
    const statePath = freshStatePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const open = mend.workbench.addTurn("session-1", "A long job");
      yield* queueBehind(mend, statePath, message("message-unsteered", "Not mine now"));
      // The owner turned shared control off while the gateway was down.
      mend.workbench.control.set("session-1", false);

      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          yield* eventually(() => mend.workbench.eventStreams > 0, "the restored hub");
          mend.workbench.setTurn(open, "completed");
          yield* eventually(
            () => keptRow(statePath, "message-unsteered")?.state === "failed",
            "the refused message to fail",
          );
        }),
      );
      assert.lengthOf(mend.workbench.turns.get("session-1") ?? [], 1);
    });
  });

  it.live("never acknowledges a queued message the state file refused (593-R2-1)", () => {
    const statePath = freshStatePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.addTurn("session-1", "A long job");
      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "REFUSED-QUEUE");
          const database = new DatabaseSync(statePath);
          database.exec(
            "CREATE TRIGGER refuse_queue BEFORE INSERT ON queued_messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
          );
          database.close();
          // Behind an open turn: before, it showed as queued and was gone after a restart.
          const exit = yield* Effect.exit(
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              message("message-refused", "Must be kept"),
            ),
          );
          assert.isTrue(Exit.isFailure(exit));
          const error = Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : undefined;
          assert.include(JSON.stringify(error), "could not write this to its state file");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make("session-1"),
          });
          assert.isFalse(projection.runs.some((run) => run.userMessageId === "message-refused"));
        }),
      );
    });
  });

  it.live(
    "sends a taken message once even when its turn's ids could not be kept (593-R2-2)",
    () => {
      const statePath = freshStatePath();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const command = message("message-once", "Only once");
        yield* gateway(
          mend,
          statePath,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "UNRECORDED");
            const database = new DatabaseSync(statePath);
            database.exec(
              "CREATE TRIGGER refuse_ids BEFORE INSERT ON message_ids BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
            );
            database.close();
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
            yield* eventually(() => turnPosts(mend).length === 1, "the turn");
            yield* Effect.sleep("100 millis");
          }),
        );
        const first = mend.workbench.turns.get("session-1")?.[0];
        if (first !== undefined) mend.workbench.setTurn(first, "completed");
        // The client re-sends the exact command after the restart: it is the message Mend took.
        yield* gateway(
          mend,
          statePath,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "UNRECORDED-AFTER");
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
            yield* Effect.sleep("400 millis");
            assert.strictEqual(turnPosts(mend).length, 1);
          }),
        );
      });
    },
  );

  it.live("never sends a message it could not keep as on its way", () => {
    const statePath = freshStatePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const open = mend.workbench.addTurn("session-1", "A long job");

      yield* gateway(
        mend,
        statePath,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "UNKEPT");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("message-unkept", "Keep me first"),
          );
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-unkept" && run.status === "queued"),
          );
          // The state file stops taking writes.
          const database = new DatabaseSync(statePath);
          database.exec("DROP TABLE queued_messages");
          database.close();
          mend.workbench.setTurn(open, "completed");
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-unkept" && run.status === "failed"),
          );
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make("session-1"),
          });
          assert.include(JSON.stringify(projection), "could not write this message");
          assert.strictEqual(turnPosts(mend).length, 0);
        }),
      );
    });
  });
});

const stored = (state: StoredQueue["entries"][number]["state"], sender = "bearer-1") => ({
  runId: `run-${state}`,
  messageId: `message-${state}`,
  text: state,
  requestedAt: "2026-10-10T09:00:00.000Z",
  sender,
  state,
  error: state === "failed" ? "Mend refused it." : null,
  launches: state === "launching" ? 1 : 0,
  imageIds: [],
});

describe("what a restart makes of each message", () => {
  it("queues again what waited, fails what was on its way, and keeps what settled", () => {
    const queue = restoredQueue(
      {
        held: true,
        entries: [
          stored("queued"),
          stored("launching"),
          stored("sending"),
          stored("failed"),
          stored("cancelled"),
        ],
      },
      () => "mdt_token",
    );
    assert.deepStrictEqual(
      queue.entries.map((entry) => [entry.state, entry.error]),
      [
        ["queued", null],
        ["queued", null],
        ["failed", SENT_BEFORE_RESTART],
        ["failed", "Mend refused it."],
        ["cancelled", null],
      ],
    );
    // A launch it already asked for still counts toward its limit.
    assert.strictEqual(queue.entries[1]?.launches, 1);
    assert.isTrue(queue.held);
    assert.deepStrictEqual(
      storedOf(queue).entries.map((entry) => entry.state),
      ["queued", "queued", "failed", "failed", "cancelled"],
    );
  });

  it("fails a message whose sender is no longer paired, and lets go of a hold with nothing queued", () => {
    const queue = restoredQueue({ held: true, entries: [stored("queued", "gone")] }, () => null);
    assert.strictEqual(queue.entries[0]?.state, "failed");
    assert.strictEqual(queue.entries[0]?.error, SENDER_GONE);
    assert.isFalse(queue.held);
  });
});
