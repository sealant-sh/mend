import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CodexAdapter } from "../src/index.ts";
import { ignore, makeWire } from "./steering-wire.ts";

const connectionFailed = { httpConnectionFailed: { httpStatusCode: null } };

const codexError = (
  message: string,
  willRetry: boolean,
  turnId: string | null,
  codexErrorInfo: object = connectionFailed,
) => ({
  method: "error",
  params: {
    threadId: "native",
    ...(turnId === null ? {} : { turnId }),
    willRetry,
    error: { message, codexErrorInfo, additionalDetails: null, misalignment: null },
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
        wire.push(codexError("Reconnecting... 1/5", true, "one"));
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

  it.effect(
    "a turn that cannot connect fails with Codex's words and the conversation goes on",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { wire, events } = yield* startCodex;
          const disconnected = { responseStreamDisconnected: { httpStatusCode: null } };
          for (const attempt of [1, 2, 3, 4, 5]) {
            wire.push(codexError(`Reconnecting... ${attempt}/5`, true, "one", disconnected));
          }
          wire.push(codexError("Connection failed: error sending request", false, "one"));
          wire.push({
            method: "turn/completed",
            params: {
              threadId: "native",
              turn: {
                id: "one",
                items: [],
                status: "failed",
                error: {
                  message: "Connection failed: error sending request",
                  codexErrorInfo: connectionFailed,
                  additionalDetails: null,
                },
              },
            },
          });
          yield* wire.drain;
          expect(events.filter((event) => event._tag === "runtime.error")).toEqual([]);
          const completed = events.filter((event) => event._tag === "turn.completed");
          expect(completed).toHaveLength(1);
          expect(completed[0]).toMatchObject({
            status: "failed",
            error: "Connection failed: error sending request",
          });
        }),
      ),
  );

  it.effect("an error outside any turn ends the conversation with Codex's own words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { wire, events } = yield* startCodex;
        wire.push(codexError("Connection failed: error sending request", false, null));
        yield* wire.drain;
        expect(events).toContainEqual({
          _tag: "runtime.error",
          message: "Connection failed: error sending request",
        });
      }),
    ),
  );
});
