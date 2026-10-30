import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { EventId, ThreadId, OrchestrationV2ThreadProjection } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { NO_LIFECYCLE } from "../src/lifecycle.ts";
import { MendTurnSteer, type MendTurn } from "../src/mend-workbench.ts";
import { emptyQueue, newEntry, storedOf } from "../src/queue.ts";
import { type ThreadSource, utc } from "../src/shell.ts";
import { openGatewayState } from "../src/state.ts";
import { shownOf, steerStep, type SteerRecord } from "../src/steering.ts";
import { threadProjectionOf } from "../src/thread-projection.ts";
import { afterAll, assert, describe, it } from "./support/effect-vitest.ts";
import {
  deriveThreadQueueWorkflowState,
  applyOrchestrationV2ProjectionEvent,
} from "./support/upstream/steering-client.mjs";

const scratch = (await promisify(execFile)("mktemp", ["-d", "-t", "steer.XXXXXX"])).stdout.trim();
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const at = "2026-10-30T00:00:00.000Z";
const turn: MendTurn = {
  id: "turn",
  sessionId: "session",
  ordinal: 0,
  author: "alice",
  steerSender: "alice",
  input: "Start",
  status: "running",
  providerTurnId: "native",
  error: null,
  createdAt: at,
  startedAt: at,
  endedAt: null,
};
const record: SteerRecord = {
  clientSteerId: "0b7e9f4c-7d0a-4f5e-9a51-3c2b8f1d6e01",
  messageId: "message",
  runId: "original-run",
  targetTurnId: "turn",
  targetRunId: "turn",
  text: "Kept words",
  imageIds: [],
  requestedAt: at,
  sender: "bearer-session",
  author: "alice",
  intent: "steer",
  promotion: null,
  phase: {
    kind: "posting",
    input: "Kept words",
    images: [],
    processId: "process",
    unconfirmed: 0,
  },
};
const receipt = (delivery: MendTurnSteer["delivery"]): MendTurnSteer => ({
  id: "steer",
  sessionId: "session",
  processId: "process",
  turnId: "turn",
  author: "alice",
  ordinal: 0,
  input: "Kept words",
  clientSteerId: record.clientSteerId,
  queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
  delivery,
  createdAt: at,
  updatedAt: at,
});
const source = (): ThreadSource => ({
  threadId: ThreadId.make("session"),
  project: {
    id: "project",
    name: "Mend",
    storePath: "/store/project/repo.git",
    defaultBranch: "main",
    createdAt: at,
    updatedAt: at,
  },
  session: {
    id: "session",
    projectId: "project",
    worktreeId: "worktree",
    harness: "codex",
    model: "test-model",
    label: "Test",
    worktree: "worktree",
    branch: "test",
    baseSha: "a".repeat(40),
    baseRef: "main",
    status: "running",
    ownerUserId: "alice",
    createdAt: at,
    updatedAt: at,
  },
  agent: {
    id: "process",
    kind: "agent-protocol",
    harness: "codex",
    status: "running",
    providerSessionId: "native-session",
    protocolOptions: { model: "test-model", effort: null, permissionMode: "bypass" },
    createdAt: at,
    exitedAt: null,
  },
  changeId: null,
  turns: [turn],
  requests: [],
  runIds: new Map(),
  messageIds: new Map(),
  pending: [],
  steers: [],
  turnCheckpoints: new Map(),
  sharedWorktree: false,
  nextMode: null,
  archivedAt: null,
  lifecycle: NO_LIFECYCLE,
  lastVisitedAt: null,
  nextModel: null,
  nextEffort: null,
  imagesOf: () => [],
  queueHeld: false,
  notices: { sharedWorkspace: null, waiting: null, retirement: null },
});

describe("steering state and client projection", () => {
  it("never lets a receipt with different input hide the kept message", () => {
    const other = {
      ...receipt({ _tag: "Queued", turnId: "different", reason: "turn-ended" }),
      input: "Different input",
    };
    const projection = threadProjectionOf(
      { ...source(), steers: [shownOf(record)], turns: [{ ...turn, steers: [other] }] },
      [],
    );
    assert.strictEqual(
      projection.messages.find((message) => message.id === record.messageId)?.text,
      "Kept words",
    );
    assert.lengthOf(
      projection.messages.filter((message) => message.id === record.messageId),
      1,
    );
  });

  it("upstream's reducer enables promotion from live graph events and disables it on completion", () => {
    const original = source();
    let projection = threadProjectionOf({ ...original, turns: [] }, []);
    const full = threadProjectionOf(original, []);
    Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadProjection))(full);
    const base = { id: EventId.make("event"), occurredAt: utc(at), threadId: original.threadId };
    for (const run of full.runs)
      projection = applyOrchestrationV2ProjectionEvent(projection, {
        ...base,
        type: "run.updated",
        runId: run.id,
        payload: run,
      });
    assert.isFalse(deriveThreadQueueWorkflowState(projection).canPromoteToSteer);
    for (const attempt of full.attempts)
      projection = applyOrchestrationV2ProjectionEvent(projection, {
        ...base,
        type: "run-attempt.updated",
        payload: attempt,
      });
    for (const node of full.nodes)
      projection = applyOrchestrationV2ProjectionEvent(projection, {
        ...base,
        type: "node.updated",
        payload: node,
      });
    for (const providerTurn of full.providerTurns)
      projection = applyOrchestrationV2ProjectionEvent(projection, {
        ...base,
        type: "provider-turn.updated",
        payload: providerTurn,
      });
    assert.isTrue(deriveThreadQueueWorkflowState(projection).canPromoteToSteer);
    for (const run of full.runs)
      projection = applyOrchestrationV2ProjectionEvent(projection, {
        ...base,
        type: "run.updated",
        runId: run.id,
        payload: { ...run, status: "completed" },
      });
    assert.isFalse(deriveThreadQueueWorkflowState(projection).canPromoteToSteer);
  });

  it("keeps every admitted delivery completed except late NotSent, whose error belongs to its input", () => {
    for (const delivery of [
      { _tag: "Sending" },
      { _tag: "Accepted", evidence: "provider-acknowledged" },
      { _tag: "Unknown", reason: "new-server-reason" },
      { _tag: "NotSent", reason: "new-server-reason" },
    ] as const) {
      const turns = [{ ...turn, steers: [receipt(delivery)] }];
      const step = steerStep(
        record,
        { kind: "read", checked: false },
        { sessionId: "session", turns, caller: false },
      );
      const steers =
        step.kind === "settled"
          ? step.kept === null
            ? []
            : [step.kept]
          : [shownOf(step.kind === "unchanged" ? record : step.record)];
      const projection = threadProjectionOf({ ...source(), steers, turns }, []);
      Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadProjection))(projection);
      const input = projection.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === record.messageId,
      );
      assert.strictEqual(input?.status, delivery._tag === "NotSent" ? "failed" : "completed");
      assert.lengthOf(
        projection.messages.filter((message) => message.id === record.messageId),
        1,
      );
      assert.lengthOf(
        projection.turnItems.filter((item) => item.type === "system_notice"),
        0,
      );
      assert.strictEqual(projection.runs[0]?.status, "running");
      if (delivery._tag === "NotSent")
        assert.strictEqual(
          projection.turnItems.find((item) => item.type === "error")?.parentItemId,
          input?.id,
        );
    }
  });

  it("never puts back a promotion once Mend's receipt for it was read", () => {
    const promoted: SteerRecord = {
      ...record,
      intent: "promoted_queued_to_steer",
      promotion: {
        successors: [],
        entry: {
          runId: record.runId,
          messageId: record.messageId,
          text: record.text,
          requestedAt: at,
          sender: record.sender,
          state: "queued",
          error: null,
          launches: 0,
          imageIds: [],
          workspacePreparation: null,
          preparationFailed: false,
        },
      },
      phase: {
        kind: "observed",
        input: "Kept words",
        images: [],
        processId: "process",
        receipt: receipt({ _tag: "Sending" }),
      },
    };
    const step = steerStep(
      promoted,
      { kind: "answered", answer: { kind: "refused", reason: "Refused", notSender: false } },
      {
        sessionId: "session",
        turns: [{ ...turn, steers: [receipt({ _tag: "Sending" })] }],
        caller: true,
      },
    );
    assert.strictEqual(step.kind, "unchanged");
  });

  it.effect("rolls back the whole queue transfer if the durable claim fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = join(scratch, `state-${++files}.sqlite`);
        const state = yield* openGatewayState(path);
        const queue = emptyQueue();
        queue.entries.push(
          newEntry({
            runId: "original-run",
            messageId: "message",
            text: "Kept words",
            requestedAt: at,
            token: "never-stored",
            sender: "bearer-session",
          }),
        );
        queue.held = true;
        yield* state.saveQueue("alice", "session", storedOf(queue));
        const db = new DatabaseSync(path);
        db.exec(
          "CREATE TRIGGER refuse_steer BEFORE INSERT ON steer_messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
        );
        queue.entries = [];
        queue.steers = [record];
        assert.isTrue(
          Exit.isFailure(
            yield* state.saveQueue("alice", "session", storedOf(queue)).pipe(Effect.exit),
          ),
        );
        const kept = yield* state.loadQueues("alice");
        assert.isTrue(kept[0]?.queue.held);
        assert.strictEqual(kept[0]?.queue.entries[0]?.messageId, "message");
        assert.lengthOf(kept[0]?.queue.steers ?? [], 0);
        assert.notInclude(
          JSON.stringify(db.prepare("SELECT * FROM queued_messages").all()),
          "never-stored",
        );
        db.close();
      }),
    ),
  );
});
