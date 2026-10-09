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
import * as Effect from "effect/Effect";

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

const stored = (state: StoredQueue["entries"][number]["state"], sender = "bearer-1") => ({
  runId: `run-${state}`,
  messageId: `message-${state}`,
  text: state,
  requestedAt: "2026-10-10T09:00:00.000Z",
  sender,
  state,
  error: state === "failed" ? "Mend refused it." : null,
  launches: state === "launching" ? 1 : 0,
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
