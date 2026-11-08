import { describe, expect, it } from "@effect/vitest";
import { turnSelectionOf } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CodexAdapter, type AgentStartOptions } from "../src/index.ts";
import { ignore, isObject, makeWire } from "./steering-wire.ts";

const makeCodex = Effect.fn("test.makeCapabilityGatedCodex")(function* (
  alreadyInitialized = false,
) {
  let experimentalApi = alreadyInitialized;
  let push: (value: unknown) => void = ignore;
  let turns = 0;
  const wire = yield* makeWire((frame) => {
    const id = frame["id"];
    if (typeof id !== "number" && typeof id !== "string") return;
    const params = isObject(frame["params"]) ? frame["params"] : {};
    switch (frame["method"]) {
      case "initialize": {
        const capabilities = params["capabilities"];
        experimentalApi = isObject(capabilities) && capabilities["experimentalApi"] === true;
        push({ id, result: {} });
        break;
      }
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
        push({
          id,
          result: {
            thread: {
              id: "native",
              forkedFromId: "source",
              historyMode: "paginated",
              cliVersion: "0.162.1",
              turns: [{ id: "selected" }],
            },
          },
        });
        break;
      case "turn/start":
        if (params["collaborationMode"] !== undefined && !experimentalApi) {
          push({
            id,
            error: {
              code: -32600,
              message: "turn/start.collaborationMode requires experimentalApi capability",
            },
          });
        } else {
          turns += 1;
          push({ id, result: { turn: { id: `turn-${turns}` } } });
        }
        break;
    }
  });
  push = wire.push;
  return wire;
});

const connections: ReadonlyArray<{
  readonly name: string;
  readonly options: Partial<AgentStartOptions>;
  readonly method: string;
}> = [
  { name: "fresh thread", options: {}, method: "thread/start" },
  { name: "resume by id", options: { providerSessionId: "native" }, method: "thread/resume" },
  {
    name: "native resume by path",
    options: { providerSessionId: "native", providerSessionPath: "/retained/rollout.jsonl" },
    method: "thread/resume",
  },
  {
    name: "native fork",
    options: {
      nativeBootstrap: {
        kind: "seed",
        purpose: "fork",
        cutoff: {
          provider: "codex",
          threadId: "source",
          throughTurnId: "selected",
          historyMode: "paginated",
        },
        sourcePath: "/retained/rollout.jsonl",
        childSessionId: "child",
      },
    },
    method: "thread/fork",
  },
  { name: "shared control", options: { sharedControl: true }, method: "thread/start" },
];

describe("Codex turn capability negotiation", () => {
  for (const { name, options, method } of connections) {
    it.effect(`${name} admits Default, Plan and resetting Default on one connection`, () =>
      Effect.gen(function* () {
        const wire = yield* makeCodex();
        const session = yield* CodexAdapter.start(wire.transport, {
          ...options,
          cwd: "/repo",
          permissionMode: "ask",
        });
        expect(wire.sent.map((frame) => frame["method"])).toEqual([
          "initialize",
          "initialized",
          method,
        ]);
        expect(wire.sent.find((frame) => frame["method"] === method)).toMatchObject({
          params: { config: { "tools.update_plan.enabled": true } },
        });
        let turnId = yield* session.sendTurn("ordinary first message");
        expect(turnId).toBe("turn-1");
        for (const [mode, expectedTurn] of [
          ["plan", "turn-2"],
          ["default", "turn-3"],
        ] as const) {
          wire.push({
            method: "turn/completed",
            params: { threadId: "native", turn: { id: turnId, status: "completed" } },
          });
          yield* wire.drain;
          turnId = yield* session.sendTurn(mode, turnSelectionOf("codex", "test", "high", mode));
          expect(turnId).toBe(expectedTurn);
        }
        expect(
          wire.sent
            .filter((frame) => frame["method"] === "turn/start")
            .map((frame) => {
              const params = frame["params"];
              const collaboration = isObject(params) ? params["collaborationMode"] : null;
              return isObject(collaboration) ? collaboration["mode"] : null;
            }),
        ).toEqual(["default", "plan", "default"]);
        expect(wire.sent.filter((frame) => frame["method"] === "initialize")).toHaveLength(1);
      }),
    );
  }

  it.effect(
    "rehydrate keeps the existing connection's negotiation without initializing again",
    () =>
      Effect.gen(function* () {
        const wire = yield* makeCodex(true);
        const session = yield* CodexAdapter.start(wire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          providerSessionId: "native",
          rehydrate: { replayProviderTurnIds: [], resolvedProviderRequestIds: new Set() },
        });
        expect(wire.sent).toEqual([]);
        expect(yield* session.sendTurn("continue")).toBe("turn-1");
        expect(wire.sent.map((frame) => frame["method"])).toEqual(["model/list", "turn/start"]);
      }),
  );
});
