import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CodexAdapter } from "../src/index.ts";
import { ignore, makeWire } from "./steering-wire.ts";

const usage = (threadId: string, turnId: string, total: number, last: number) => ({
  method: "thread/tokenUsage/updated",
  params: {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        inputTokens: total - 17,
        cachedInputTokens: 28160,
        outputTokens: 17,
        totalTokens: total,
      },
      last: { totalTokens: last },
      modelContextWindow: 258400,
    },
  },
});

describe("Codex recorded usage", () => {
  it.effect("keeps context separate from cumulative counts and isolates each native turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
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
        wire.push(usage("native", "one", 42877, 21450));
        wire.push(usage("child", "child-turn", 99999, 99999));
        wire.push({
          method: "turn/completed",
          params: { threadId: "native", turn: { id: "one", status: "completed" } },
        });
        wire.push({ method: "turn/started", params: { threadId: "native", turn: { id: "two" } } });
        wire.push({
          method: "turn/completed",
          params: { threadId: "native", turn: { id: "two", status: "interrupted" } },
        });
        yield* wire.drain;
        const completed = events.filter((event) => event._tag === "turn.completed");
        expect(completed).toHaveLength(2);
        expect(completed[0]?.usage).toEqual({
          inputTokens: 42860,
          cachedInputTokens: 28160,
          outputTokens: 17,
          totalTokens: 42877,
          contextTokens: 21450,
          contextWindow: 258400,
        });
        expect(completed[1]?.usage).toBeNull();
      }),
    ),
  );
});
