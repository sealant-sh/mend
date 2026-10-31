import type { AgentEvent } from "@mend/domain/workbench";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Effect, Fiber } from "effect";

import {
  AgentProtocolError,
  ClaudeAdapter,
  CodexAdapter,
  type AgentTransport,
} from "../src/index.ts";
import { ignore, makeWire, type JsonObject } from "./steering-wire.ts";

const refusingSend = (transport: AgentTransport, refuses: () => boolean): AgentTransport => ({
  ...transport,
  send: (bytes) =>
    refuses()
      ? Effect.fail(
          new AgentProtocolError({
            adapter: "codex",
            operation: "transport.send",
            message: "pipe write failed",
            cause: null,
          }),
        )
      : transport.send(bytes),
});

const startCodex = Effect.fn("test.startCodex")(function* (
  answerTurn: (id: unknown, push: (value: unknown) => void) => void,
  refuses: () => boolean = () => false,
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
        return answerTurn(id, push);
    }
  });
  push = wire.push;
  const events: Array<AgentEvent> = [];
  const session = yield* CodexAdapter.start(refusingSend(wire.transport, refuses), {
    cwd: "/workspace/repo",
    permissionMode: "bypass",
    onEvent: (event) => Effect.sync(() => events.push(event)),
  });
  return { wire, session, events };
});

const turnStarts = (sent: ReadonlyArray<JsonObject>) =>
  sent.filter((frame) => frame["method"] === "turn/start");

describe("Codex turn delivery", () => {
  it.effect("nothing is written once the app-server's output has ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: { turn: { id: "t" } } }));
        yield* codex.wire.end;
        while (!codex.events.some((event) => event._tag === "runtime.error")) {
          yield* Effect.yieldNow;
        }
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "not-written" });
        expect(turnStarts(codex.wire.sent)).toEqual([]);
      }),
    ),
  );

  it.effect("nothing is written once Mend closed the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: { turn: { id: "t" } } }));
        yield* codex.session.close();
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "not-written" });
        expect(turnStarts(codex.wire.sent)).toEqual([]);
      }),
    ),
  );

  it.effect("delivery is uncertain when Codex does not answer within 60 seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex(() => undefined);
        const sending = yield* codex.session.sendTurn("start").pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("60 seconds");
        expect(yield* Fiber.join(sending)).toMatchObject({
          _tag: "AgentTurnDeliveryError",
          certainty: "uncertain",
        });
        expect(turnStarts(codex.wire.sent)).toHaveLength(1);
      }),
    ),
  );

  it.effect("delivery is uncertain when the output ends while turn/start waits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let end: Effect.Effect<void> = Effect.void;
        const codex = yield* startCodex(() => Effect.runFork(end));
        end = codex.wire.end;
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "uncertain" });
      }),
    ),
  );

  it.effect("delivery is uncertain when writing turn/start fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let refuses = false;
        const codex = yield* startCodex(ignore, () => refuses);
        refuses = true;
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "uncertain" });
      }),
    ),
  );

  it.effect("delivery is uncertain when Codex answers without a turn id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) => push({ id, result: {} }));
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "uncertain" });
      }),
    ),
  );

  it.effect("a turn Codex refuses fails with its words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codex = yield* startCodex((id, push) =>
          push({ id, error: { code: -32600, message: "model unavailable" } }),
        );
        const error = yield* codex.session.sendTurn("start").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentProtocolError", message: "model unavailable" });
      }),
    ),
  );
});

const startClaude = Effect.fn("test.startClaude")(function* (refuses: () => boolean) {
  const wire = yield* makeWire();
  const events: Array<AgentEvent> = [];
  const session = yield* ClaudeAdapter.start(refusingSend(wire.transport, refuses), {
    cwd: "/workspace/repo",
    providerSessionId: "05f72f7d-81d5-4db9-a3cf-234191cf79f9",
    permissionMode: "bypass",
    onEvent: (event) => Effect.sync(() => events.push(event)),
  });
  return { wire, session, events };
});

const userFrames = (sent: ReadonlyArray<JsonObject>) =>
  sent.filter((frame) => frame["type"] === "user");

describe("Claude turn delivery", () => {
  it.effect("delivery is uncertain when writing the turn fails, and the next turn is sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let refuses = true;
        const claude = yield* startClaude(() => refuses);
        const error = yield* claude.session.sendTurn("first").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "uncertain" });
        expect(claude.events.some((event) => event._tag === "turn.started")).toBe(false);
        refuses = false;
        const turnId = yield* claude.session.sendTurn("second");
        expect(claude.events.filter((event) => event._tag === "turn.started")).toEqual([
          { _tag: "turn.started", providerTurnId: turnId },
        ]);
        expect(userFrames(claude.wire.sent)).toHaveLength(1);
      }),
    ),
  );

  it.effect("writes nothing once Mend closed the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const claude = yield* startClaude(() => false);
        yield* claude.session.close();
        const error = yield* claude.session.sendTurn("first").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "not-written" });
        expect(userFrames(claude.wire.sent)).toEqual([]);
      }),
    ),
  );

  it.effect("writes nothing while its own turn is in progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const claude = yield* startClaude(() => false);
        yield* claude.session.sendTurn("first");
        const error = yield* claude.session.sendTurn("second").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "AgentTurnDeliveryError", certainty: "not-written" });
        expect(userFrames(claude.wire.sent)).toHaveLength(1);
      }),
    ),
  );
});
