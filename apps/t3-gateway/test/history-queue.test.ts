import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  MessageId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS as methods,
} from "@mend/t3-contracts";
import { Effect } from "effect";

import {
  newEntry,
  emptyQueue,
  nextStep,
  DEFAULT_QUEUE_TIMINGS,
  restoredQueue,
  storedOf,
} from "../src/queue.ts";
import { describe, it, assert } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const position = { historyRevision: 0, worktreeEpoch: 0 };
const view = {
  known: true,
  agentLive: true,
  turnOpen: false,
  status: "running",
  updatedAt: null,
  summary: null,
  evidence: 1,
  historyPosition: { historyRevision: 1, worktreeEpoch: 1 },
};
const input = {
  runId: "draft",
  messageId: "message",
  text: "Keep my exact words",
  requestedAt: "2026-11-05T00:00:00Z",
  token: "fake-device",
  sender: "person",
  historyPosition: position,
  postId: "20a6ca2d-3280-45c6-8348-e8bd39dd6bcb",
};

describe("drafts across a history change", () => {
  it("holds the words before selecting a send or launch", () => {
    const queue = emptyQueue();
    queue.entries.push(newEntry(input));
    assert.isNull(nextStep(queue, view, 0, DEFAULT_QUEUE_TIMINGS));
    assert.strictEqual(queue.entries[0]?.text, input.text);
    assert.isTrue(queue.held);
  });

  it("does not renew a restored legacy draft on reconnect", () => {
    const queue = emptyQueue();
    queue.entries.push(newEntry({ ...input, historyPosition: undefined, postId: undefined }));
    const restored = restoredQueue(storedOf(queue), () => "fake-device");
    assert.isNull(nextStep(restored, view, 0, DEFAULT_QUEUE_TIMINGS));
    assert.strictEqual(restored.entries[0]?.text, input.text);
    assert.isTrue(restored.held);
  });
});

const until = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      yield* Effect.sleep("20 millis");
    }
    throw new Error("The expected queue observation did not arrive.");
  });
const dispatch = {
  type: "message.dispatch",
  commandId: CommandId.make("draft-history"),
  createdBy: "user",
  creationSource: "web",
  threadId: ThreadId.make("session"),
  messageId: MessageId.make("draft-message"),
  text: "Keep my exact words",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
} as const;
const resumeCommand = {
  type: "queue.resume",
  commandId: CommandId.make("explicit-resume"),
  threadId: ThreadId.make("session"),
} as const;

describe("durable keyed sends", () => {
  it.live("keeps a stale draft held until an explicit resume adopts the new position", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const wb = mend.workbench;
      wb.addProject("project", "Mend");
      wb.addSession({ id: "session", projectId: "project" });
      const open = wb.addTurn("session", "Earlier turn");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "HISTORY");
        yield* rpc[methods.dispatchCommand](dispatch);
        wb.nativeHistories.set("session", {
          observations: [],
          fork: null,
          position: { historyRevision: 1, worktreeEpoch: 1 },
        });
        wb.setTurn(open, "completed");
        yield* Effect.sleep("150 millis");
        const snapshot = yield* rpc[methods.getThreadProjection]({ threadId: dispatch.threadId });
        assert.isTrue(
          snapshot.runs.find((run) => run.userMessageId === dispatch.messageId)?.queueHeld,
        );
        assert.lengthOf(
          wb.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages")),
          0,
        );
        yield* rpc[methods.dispatchCommand](resumeCommand);
        yield* until(() => wb.messageReceipts.size === 1);
        const post = wb.calls.find(
          (call) => call.method === "POST" && call.path.endsWith("/messages"),
        );
        assert.include(JSON.stringify(post?.body), '"historyRevision":1');
        assert.include(JSON.stringify(post?.body), dispatch.text);
        assert.lengthOf(wb.turns.get("session") ?? [], 2);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "resolves a lost POST after reload with the original key and bytes, even at a newer revision",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const wb = mend.workbench;
        wb.addProject("project", "Mend");
        wb.addSession({ id: "session", projectId: "project" });
        const statePath = join(mkdtempSync(join(tmpdir(), "mend-rollback-queue-")), "state.sqlite");
        wb.loseMessageAnswerOnce = true;
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "LOST");
          yield* rpc[methods.dispatchCommand](dispatch);
          yield* until(() => wb.messageReceipts.size === 1);
          yield* Effect.sleep("100 millis");
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
        wb.nativeHistories.set("session", {
          observations: [],
          fork: null,
          position: { historyRevision: 1, worktreeEpoch: 1 },
        });
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RESOLVE");
          yield* Effect.sleep("100 millis");
          const posts = () =>
            wb.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));
          assert.lengthOf(posts(), 1, "reconnect must not repeat an uncertain POST");
          yield* rpc[methods.dispatchCommand](resumeCommand);
          assert.lengthOf(posts(), 2);
          assert.deepEqual(posts()[1]?.body, posts()[0]?.body);
          assert.lengthOf(wb.turns.get("session") ?? [], 1);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      }),
  );
});
