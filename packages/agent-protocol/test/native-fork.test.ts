import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect, Exit } from "effect";

import { ClaudeAdapter, CodexAdapter } from "../src/index.ts";
import { isObject, makeWire } from "./steering-wire.ts";

const cutoff = {
  provider: "codex",
  threadId: "source-native",
  throughTurnId: "selected-native-turn",
  historyMode: "paginated",
} as const;
const cwd = "/workspace/repo";
const ignoreFrame = (_value: unknown): void => undefined;

describe("first child native bootstrap", () => {
  it.effect("Codex forks and binds the selected response before any child prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let push: (value: unknown) => void = ignoreFrame;
        const wire = yield* makeWire((frame) => {
          if (frame["method"] === "initialize") push({ id: frame["id"], result: {} });
          if (frame["method"] === "thread/fork")
            push({
              id: frame["id"],
              result: {
                thread: {
                  id: "child-native",
                  forkedFromId: cutoff.threadId,
                  historyMode: "paginated",
                  cliVersion: "0.162.1",
                  turns: [{ id: cutoff.throughTurnId }],
                },
              },
            });
          if (frame["method"] === "turn/start")
            push({ id: frame["id"], result: { turn: { id: "child-turn" } } });
        });
        push = wire.push;
        const events: AgentEvent[] = [];
        const session = yield* CodexAdapter.start(wire.transport, {
          cwd,
          permissionMode: "ask",
          nativeFork: {
            cutoff,
            sourcePath: "/private/retained.jsonl",
            childSessionId: "allocated-child",
          },
          onEvent: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });
        expect(events).toEqual([{ _tag: "session.ready", providerSessionId: "child-native" }]);
        expect(wire.sent.map((frame) => frame["method"])).toEqual([
          "initialize",
          "initialized",
          "thread/fork",
        ]);
        expect(wire.sent[2]?.["params"]).toMatchObject({
          threadId: cutoff.threadId,
          path: "/private/retained.jsonl",
          lastTurnId: cutoff.throughTurnId,
        });
        yield* session.sendTurn("first child message");
        const sent = wire.sent.find((frame) => frame["method"] === "turn/start");
        expect(sent?.["params"]).toMatchObject({ threadId: "child-native" });
      }),
    ),
  );

  it.effect("Codex refuses an unproved fork and never starts an empty conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let push: (value: unknown) => void = ignoreFrame;
        const wire = yield* makeWire((frame) => {
          if (frame["method"] === "initialize") push({ id: frame["id"], result: {} });
          if (frame["method"] === "thread/fork")
            push({
              id: frame["id"],
              result: {
                thread: {
                  id: "child-native",
                  historyMode: "paginated",
                  cliVersion: "0.162.1",
                  turns: [],
                },
              },
            });
        });
        push = wire.push;
        const result = yield* CodexAdapter.start(wire.transport, {
          cwd,
          permissionMode: "ask",
          nativeFork: {
            cutoff,
            sourcePath: "/private/retained.jsonl",
            childSessionId: "allocated-child",
          },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(wire.sent.map((frame) => frame["method"])).toEqual([
          "initialize",
          "initialized",
          "thread/fork",
        ]);
      }),
    ),
  );

  it.effect("Claude waits for no-prompt initialize before announcing the allocated child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let push: (value: unknown) => void = ignoreFrame;
        const wire = yield* makeWire((frame) => {
          if (
            frame["type"] === "control_request" &&
            isObject(frame["request"]) &&
            frame["request"]["subtype"] === "initialize"
          )
            push({
              type: "control_response",
              response: { subtype: "success", request_id: frame["request_id"] },
            });
        });
        push = wire.push;
        const events: AgentEvent[] = [];
        yield* ClaudeAdapter.start(wire.transport, {
          cwd,
          permissionMode: "ask",
          nativeFork: {
            cutoff: {
              provider: "claude",
              sessionId: "11111111-1111-4111-8111-111111111111",
              throughMessageId: "22222222-2222-4222-8222-222222222222",
            },
            sourcePath: "/private/retained.jsonl",
            childSessionId: "33333333-3333-4333-8333-333333333333",
          },
          onEvent: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });
        expect(wire.sent).toHaveLength(1);
        expect(wire.sent[0]?.["request"]).toEqual({ subtype: "initialize" });
        expect(events).toEqual([
          { _tag: "session.ready", providerSessionId: "33333333-3333-4333-8333-333333333333" },
        ]);
      }),
    ),
  );
});
