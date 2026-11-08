import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CodexAdapter } from "../src/index.ts";
import { ignore, makeWire } from "./steering-wire.ts";

const codexError = (message: string, willRetry: boolean) => ({
  method: "error",
  params: {
    threadId: "native",
    turnId: "one",
    willRetry,
    error: {
      message,
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } },
      additionalDetails: "Connection failed: error sending request",
    },
  },
});

const startCodex = Effect.gen(function* () {
  let push: (value: unknown) => void = ignore;
  const wire = yield* makeWire((frame) => {
    if (typeof frame["id"] !== "number") return;
    push({
      id: frame["id"],
      result: frame["method"] === "thread/start" ? { thread: { id: "native" } } : {},
    });
  });
  push = wire.push;
  const events: AgentEvent[] = [];
  yield* CodexAdapter.start(wire.transport, {
    cwd: "/repo",
    permissionMode: "ask",
    onEvent: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  });
  wire.push({ method: "turn/started", params: { threadId: "native", turn: { id: "one" } } });
  return { wire, events };
});

describe("Codex errors", () => {
  it.effect("a reconnect Codex will retry keeps the conversation going", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { wire, events } = yield* startCodex;
        wire.push(codexError("Reconnecting... 1/5", true));
        wire.push({
          method: "turn/completed",
          params: { threadId: "native", turn: { id: "one", status: "completed" } },
        });
        yield* wire.drain;
        expect(events.filter((event) => event._tag === "runtime.error")).toEqual([]);
        expect(events).toContainEqual({ _tag: "runtime.warning", message: "Reconnecting... 1/5" });
        expect(events.filter((event) => event._tag === "turn.completed")).toHaveLength(1);
      }),
    ),
  );

  it.effect("an error Codex will not retry ends it with Codex's own words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { wire, events } = yield* startCodex;
        wire.push(codexError("Connection failed: error sending request", false));
        yield* wire.drain;
        expect(events).toContainEqual({
          _tag: "runtime.error",
          message: "Connection failed: error sending request",
        });
      }),
    ),
  );
});
