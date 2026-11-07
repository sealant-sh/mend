import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect } from "effect";

import { ClaudeAdapter } from "../src/index.ts";
import { makeWire } from "./steering-wire.ts";

describe("Claude recorded context", () => {
  it.effect("records the last root model call separately from the completed turn totals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          onEvent: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });
        yield* session.sendTurn("Work");
        wire.push({
          type: "assistant",
          message: {
            id: "root",
            model: "claude-test",
            content: [{ type: "text", text: "Done" }],
            usage: {
              input_tokens: 3,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 20,
              output_tokens: 7,
            },
          },
        });
        wire.push({
          type: "assistant",
          parent_tool_use_id: "child",
          message: {
            id: "child",
            model: "claude-test",
            content: [],
            usage: { input_tokens: 99999, output_tokens: 99999 },
          },
        });
        wire.push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: 30,
            output_tokens: 70,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
          modelUsage: { "claude-test": { contextWindow: 200000 } },
        });
        yield* wire.drain;
        const completed = events.find((event) => event._tag === "turn.completed");
        expect(completed?.usage).toEqual({
          inputTokens: 30,
          outputTokens: 70,
          cachedInputTokens: 1200,
          totalTokens: 100,
          contextTokens: 130,
          contextWindow: 200000,
        });
        yield* session.sendTurn("Stop before a model response");
        wire.push({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        yield* wire.drain;
        const last = events.filter((event) => event._tag === "turn.completed").at(-1);
        expect(last?.usage?.contextTokens).toBeUndefined();
      }),
    ),
  );
});
