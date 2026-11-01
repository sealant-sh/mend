import { readFileSync } from "node:fs";

import { ClaudeAdapter, type AgentProtocolError } from "@mend/agent-protocol";
import { ORCHESTRATION_V2_WS_METHODS as methods, RunId } from "@mend/t3-contracts";
import { Cause, Effect, Queue, Schema, Stream } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import type { FakeTurn } from "./support/fake-workbench.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { inputOf, message, posts, projectionWhen, setup, threadId } from "./support/steering.ts";

const object = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownSync(object);
const recording = readFileSync(
  new URL(
    "../../../packages/agent-protocol/test/fixtures/steering/claude_transcript.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => decodeObject(JSON.parse(line)))
  .filter((step) => step["type"] === "emit_inbound")
  .map((step) => decodeObject(step["frame"]));

describe("Claude steering through the gateway and real adapter", () => {
  for (const reason of ["aborted_streaming", "aborted_tools"]) {
    it.live(`${reason} continues the person's steer in the running turn`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        return yield* Effect.gen(function* () {
          const turn = setup(mend, "claude");
          mend.workbench.steerDelivery = { _tag: "Accepted", evidence: "transport-written" };
          const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError | Cause.Done>();
          const acknowledged = yield* Queue.unbounded<void>();
          const sent: Array<Readonly<Record<string, unknown>>> = [];
          const turns = new Map<string, FakeTurn>();
          const adapter = yield* ClaudeAdapter.start(
            {
              send: (bytes) =>
                Effect.sync(() => {
                  sent.push(decodeObject(JSON.parse(new TextDecoder().decode(bytes))));
                }),
              output: Stream.fromQueue(output),
              acknowledgeOutput: () => Queue.offer(acknowledged, undefined).pipe(Effect.asVoid),
              close: () => Effect.void,
            },
            {
              cwd: "/workspace/repo",
              permissionMode: "bypass",
              controlJournal: { recorded: [], record: () => Effect.void },
              onEvent: (event) =>
                Effect.sync(() => {
                  if (event._tag === "turn.started") {
                    turn.providerTurnId = event.providerTurnId;
                    turns.set(event.providerTurnId, turn);
                  } else if (event._tag === "harness-turn.started") {
                    const opened = mend.workbench.addTurn(threadId, event.reason);
                    const own = { ...opened, origin: "harness" as const, author: null };
                    mend.workbench.turns.set(threadId, [
                      ...(mend.workbench.turns.get(threadId) ?? []).filter(
                        (row) => row.id !== own.id,
                      ),
                      own,
                    ]);
                    turns.set(event.providerTurnId, own);
                  } else if (event._tag === "turn.completed") {
                    const completed = turns.get(event.providerTurnId);
                    if (completed !== undefined)
                      mend.workbench.setTurn(completed, event.status, event.error);
                  } else if (
                    event._tag === "item.updated" &&
                    event.item.kind === "assistant-message"
                  ) {
                    const owner = turns.get(event.item.providerTurnId);
                    if (owner !== undefined)
                      mend.workbench.addItem(owner, {
                        kind: event.item.kind,
                        text: event.item.text,
                        status: event.item.status,
                      });
                  }
                }),
            },
          );
          const push = (frame: Readonly<Record<string, unknown>>) =>
            Queue.offer(output, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)).pipe(
              Effect.andThen(Queue.take(acknowledged)),
            );
          const nativeTurnId = yield* adapter.sendTurn(turn.input);
          // Play the recorded startup before steering an already live Claude turn.
          for (const frame of recording) {
            if (frame["type"] === "result") break;
            yield* push(frame);
          }
          mend.workbench.onSteer = (receipt) =>
            Effect.runPromise(
              adapter.steer({ id: receipt.id, expectedTurnId: nativeTurnId, input: receipt.input }),
            ).then(() => undefined);
          const { rpc } = yield* pairAndConnect(mend, "CLAUDE-REPLAY");
          const cmd = message("Actually tell me a joke", {
            type: "steer_active",
            targetRunId: RunId.make(turn.id),
          });
          yield* rpc[methods.dispatchCommand](cmd);
          assert.deepInclude(sent[1], { priority: "now", uuid: turn.steers[0]?.id });
          assert.strictEqual(turn.status, "running");

          let afterAbort = false;
          for (const frame of recording) {
            if (frame["terminal_reason"] === "aborted_streaming") {
              afterAbort = true;
              yield* push({ ...frame, terminal_reason: reason });
              // Mend enables these events; the older recording did not. Idle between Claude's
              // aborted segment and continuation must not settle the logical turn.
              yield* push({ type: "system", subtype: "session_state_changed", state: "idle" });
              const during = yield* rpc[methods.getThreadProjection]({ threadId });
              assert.strictEqual(during.runs[0]?.status, "running");
            } else if (afterAbort) yield* push(frame);
          }
          const done = yield* projectionWhen(rpc, (projection) =>
            projection.messages.some((item) => item.text === "steering fixture observed"),
          );
          assert.lengthOf(done.runs, 1);
          assert.lengthOf(done.attempts, 1);
          assert.strictEqual(done.runs[0]?.status, "completed");
          assert.strictEqual(inputOf(done, cmd.messageId)?.runId, turn.id);
          assert.isTrue(
            done.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.messageId === cmd.messageId &&
                item.inputIntent === "steer",
            ),
          );
          assert.isFalse(
            done.messages.some((item) => item.text.includes("started a turn on its own")),
          );
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/turns"), 0);

          // A later init with no prompt really is Claude's own turn and keeps its label.
          yield* push({ type: "system", subtype: "init", uuid: "unprompted" });
          const own = yield* projectionWhen(rpc, (projection) => projection.runs.length === 2);
          assert.isTrue(
            own.messages.some(
              (item) => item.role === "system" && item.text === "Claude started a turn on its own",
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
    );
  }
});
