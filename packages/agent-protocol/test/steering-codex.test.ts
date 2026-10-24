import { isDeepStrictEqual } from "node:util";

import type { AgentEvent } from "@mend/domain/workbench";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  AgentSteerDeliveryError,
  AgentSteerRefusedError,
  CodexAdapter,
  type AgentSession,
} from "../src/index.ts";
import {
  ignore,
  isObject,
  makeRecordingPeer,
  makeWire,
  readTranscript,
  type JsonObject,
  type TranscriptStep,
} from "./steering-wire.ts";

const INITIAL = "Respond with exactly: steering fixture initial response";
const STEER = "Actually, respond with exactly: steering fixture observed";

const textOf = (params: unknown): string | null => {
  const input = isObject(params) ? params["input"] : null;
  const first = Array.isArray(input) ? input[0] : null;
  return isObject(first) && typeof first["text"] === "string" ? first["text"] : null;
};

const matchCodex = (expected: TranscriptStep, actual: JsonObject): ReadonlyArray<string> => {
  const method = expected.frame["method"];
  if (actual["method"] !== method) {
    return [`method ${String(actual["method"])}, recorded ${String(method)}`];
  }
  if (method === "turn/start" && textOf(actual["params"]) !== textOf(expected.frame["params"])) {
    return ["turn/start input differs from the recording"];
  }
  if (method === "turn/steer" && !isDeepStrictEqual(actual["params"], expected.frame["params"])) {
    return [`params ${JSON.stringify(actual["params"])}`];
  }
  return [];
};

describe("Codex steering, recorded (fixtures/steering/codex_transcript.ndjson)", () => {
  it.effect("one turn/steer on the exact turn: no second turn/start, one turn, both answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = makeRecordingPeer(readTranscript("codex_transcript.ndjson"), {
          skip: () => false,
          match: matchCodex,
        });
        const wire = yield* makeWire(peer.onSend);
        peer.connect(wire.push);
        const events: Array<AgentEvent> = [];
        const completed = yield* Deferred.make<void>();
        const session = yield* CodexAdapter.start(wire.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: (event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(
                event._tag === "turn.completed"
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
              ),
            ),
        });

        const turnId = yield* session.sendTurn(INITIAL);
        const acceptance = yield* session.steer({
          id: "steer-1",
          expectedTurnId: turnId,
          input: STEER,
        });
        yield* Deferred.await(completed);
        yield* wire.drain;

        expect(turnId).toBe("01a0d5ed-670e-7032-9a87-707c736491a6");
        expect(acceptance).toEqual({ _tag: "ProviderAcknowledged", providerTurnId: turnId });
        expect(peer.mismatches).toEqual([]);
        expect(peer.remaining()).toEqual([]);
        expect(wire.sent.map((frame) => frame["method"])).toEqual([
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
          "turn/steer",
        ]);
        expect(events.filter((event) => event._tag === "turn.started")).toEqual([
          { _tag: "turn.started", providerTurnId: turnId },
        ]);
        expect(events.some((event) => event._tag === "harness-turn.started")).toBe(false);
        const completions = events.filter((event) => event._tag === "turn.completed");
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({ providerTurnId: turnId, status: "completed" });
        const finished = events.flatMap((event) =>
          event._tag === "item.updated" && event.item.status === "completed" ? [event.item] : [],
        );
        expect(finished.map((item) => [item.providerTurnId, item.kind, item.text ?? null])).toEqual(
          [
            [turnId, "user-message", null],
            [turnId, "assistant-message", "steering fixture initial response"],
            [turnId, "user-message", null],
            [turnId, "assistant-message", "steering fixture observed"],
          ],
        );
      }),
    ),
  );
});

const startCodex = Effect.fn("test.startCodex")(function* (
  answerSteer: (id: unknown, push: (value: unknown) => void) => void,
) {
  let push: (value: unknown) => void = ignore;
  const wire = yield* makeWire((frame) => {
    const id = frame["id"];
    switch (frame["method"]) {
      case "initialize":
        return push({ id, result: {} });
      case "thread/start":
        return push({ id, result: { thread: { id: "thread-1" } } });
      case "turn/start":
        push({ id, result: { turn: { id: "turn-1" } } });
        return push({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
      case "turn/steer":
        return answerSteer(id, push);
    }
  });
  push = wire.push;
  const events: Array<AgentEvent> = [];
  const session: AgentSession = yield* CodexAdapter.start(wire.transport, {
    cwd: "/workspace/repo",
    permissionMode: "bypass",
    onEvent: (event) => Effect.sync(() => events.push(event)),
  });
  return { wire, session, events };
});

const steerFrames = (sent: ReadonlyArray<JsonObject>) =>
  sent.filter((frame) => frame["method"] === "turn/steer");

const STEER_INPUT = { id: "steer-1", expectedTurnId: "turn-1", input: "use the other file" };

describe("Codex steering, synthetic", () => {
  it.effect("sends exactly turn/steer with the expected turn and no client message id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: { turnId: "turn-1" } }));
        yield* codex.session.sendTurn("start");
        const acceptance = yield* codex.session.steer(STEER_INPUT);
        expect(acceptance).toEqual({ _tag: "ProviderAcknowledged", providerTurnId: "turn-1" });
        expect(steerFrames(codex.wire.sent)).toEqual([
          {
            method: "turn/steer",
            id: 3,
            params: {
              threadId: "thread-1",
              input: [{ type: "text", text: "use the other file" }],
              expectedTurnId: "turn-1",
            },
          },
        ]);
        expect(codex.session.activeSteering).toEqual({ supported: true, interruptsTools: false });
      }),
    ),
  );

  const refusals: ReadonlyArray<
    readonly [number, string, AgentSteerRefusedError["reason"], string | null]
  > = [
    [-32600, "no active turn to steer", "no-active-turn", null],
    [-32600, "expected active turn id `turn-1` but found `turn-2`", "target-changed", "turn-2"],
    [-32600, "cannot steer a review turn", "review-turn", null],
    [-32600, "cannot steer a compact turn", "compact-turn", null],
    [-32600, "active turn uses a different output schema", "output-schema", null],
    [-32600, "input must not be empty", "invalid-input", null],
    [-32600, "expectedTurnId must not be empty", "invalid-input", null],
    [-32600, "Server is draining; retry after reconnecting", "server-draining", null],
    [-32601, "Method not found: turn/steer", "unsupported", null],
  ];
  for (const [code, message, reason, actualTurnId] of refusals) {
    it.effect(`refuses as ${reason} on ${code} "${message}"`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const codex = yield* startCodex((id, push) => push({ id, error: { code, message } }));
          yield* codex.session.sendTurn("start");
          const error = yield* codex.session.steer(STEER_INPUT).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AgentSteerRefusedError);
          expect(error).toMatchObject({
            adapter: "codex",
            reason,
            expectedTurnId: "turn-1",
            actualTurnId,
            message,
          });
        }),
      ),
    );
  }

  const unknowns: ReadonlyArray<readonly [string, unknown]> = [
    ["an internal error", { error: { code: -32603, message: "failed to steer turn: closed" } }],
    ["words Mend does not know", { error: { code: -32600, message: "steering is paused" } }],
    [
      "a mismatch about another turn",
      { error: { code: -32600, message: "expected active turn id `turn-7` but found `turn-2`" } },
    ],
    [
      "a mismatch with trailing words",
      { error: { code: -32600, message: "expected active turn id `turn-1` but found `turn-2`." } },
    ],
    ["a reply for another turn", { result: { turnId: "turn-9" } }],
    ["a reply without a turn id", { result: {} }],
    ["a reply that is not an object", { result: null }],
  ];
  for (const [label, answer] of unknowns) {
    it.effect(`delivery is uncertain after ${label}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const codex = yield* startCodex((id, push) =>
            push({ id, ...(isObject(answer) ? answer : {}) }),
          );
          yield* codex.session.sendTurn("start");
          const error = yield* codex.session.steer(STEER_INPUT).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AgentSteerDeliveryError);
          expect(error).toMatchObject({ adapter: "codex", certainty: "uncertain" });
        }),
      ),
    );
  }

  it.effect("delivery is uncertain when Codex does not answer within 60 seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex(() => undefined);
        yield* codex.session.sendTurn("start");
        const steering = yield* codex.session
          .steer(STEER_INPUT)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("60 seconds");
        const error = yield* Fiber.join(steering);
        expect(error).toMatchObject({ _tag: "AgentSteerDeliveryError", certainty: "uncertain" });
        expect(steerFrames(codex.wire.sent)).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses locally, writing nothing, with no turn or another turn running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: { turnId: "turn-1" } }));
        const idle = yield* codex.session.steer(STEER_INPUT).pipe(Effect.flip);
        expect(idle).toMatchObject({ reason: "no-active-turn", actualTurnId: null });
        yield* codex.session.sendTurn("start");
        const other = yield* codex.session
          .steer({ ...STEER_INPUT, expectedTurnId: "turn-0" })
          .pipe(Effect.flip);
        expect(other).toMatchObject({
          reason: "target-changed",
          expectedTurnId: "turn-0",
          actualTurnId: "turn-1",
        });
        expect(steerFrames(codex.wire.sent)).toEqual([]);
      }),
    ),
  );

  it.effect("an acknowledgement after the turn completed is still accepted and moves nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => {
          push({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
          push({ id, result: { turnId: "turn-1" } });
        });
        yield* codex.session.sendTurn("start");
        const acceptance = yield* codex.session.steer(STEER_INPUT);
        expect(acceptance).toEqual({ _tag: "ProviderAcknowledged", providerTurnId: "turn-1" });
        expect(codex.events.filter((event) => event._tag === "turn.completed")).toHaveLength(1);
        const after = yield* codex.session
          .steer({ ...STEER_INPUT, id: "steer-2" })
          .pipe(Effect.flip);
        expect(after).toMatchObject({ reason: "no-active-turn" });
        expect(steerFrames(codex.wire.sent)).toHaveLength(1);
      }),
    ),
  );

  it.effect("output keeps flowing while turn/steer waits for its answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let answer: () => void = ignore;
        const codex = yield* startCodex((id, push) => {
          answer = () => push({ id, result: { turnId: "turn-1" } });
        });
        yield* codex.session.sendTurn("start");
        const steering = yield* codex.session.steer(STEER_INPUT).pipe(Effect.forkChild);
        codex.wire.push({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "msg-1", type: "agentMessage", text: "still working" },
          },
        });
        yield* codex.wire.drain;
        expect(
          codex.events.some(
            (event) => event._tag === "item.updated" && event.item.text === "still working",
          ),
        ).toBe(true);
        expect(steering.pollUnsafe()).toBeUndefined();
        answer();
        expect(yield* Fiber.join(steering)).toEqual({
          _tag: "ProviderAcknowledged",
          providerTurnId: "turn-1",
        });
      }),
    ),
  );

  it.effect("nothing is written once the app-server's output has ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: { turnId: "turn-1" } }));
        yield* codex.session.sendTurn("start");
        yield* codex.wire.end;
        while (!codex.events.some((event) => event._tag === "runtime.error")) {
          yield* Effect.yieldNow;
        }
        const error = yield* codex.session.steer(STEER_INPUT).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentSteerDeliveryError", certainty: "not-written" });
        expect(steerFrames(codex.wire.sent)).toEqual([]);
      }),
    ),
  );
});
