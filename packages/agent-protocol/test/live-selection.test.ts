import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { ClaudeAdapter } from "../src/index.ts";
import { ignore, isObject, makeWire, type JsonObject } from "./steering-wire.ts";

const selection = { harness: "claude", model: "claude-sonnet-4-6", effort: "high" } as const;
const launch = { cwd: "/repo", permissionMode: "ask", model: "launch", effort: "low" } as const;

const acknowledgedWire = Effect.gen(function* () {
  let answer: (frame: unknown) => void = ignore;
  let failEffort = false;
  const wire = yield* makeWire((frame) => {
    if (frame["type"] !== "control_request") return;
    const request = frame["request"];
    const failed = failEffort && isObject(request) && request["subtype"] === "apply_flag_settings";
    answer({
      type: "control_response",
      response: failed
        ? { subtype: "error", request_id: frame["request_id"], error: "effort refused" }
        : { subtype: "success", request_id: frame["request_id"] },
    });
  });
  answer = wire.push;
  return {
    ...wire,
    refuseEffort: (value: boolean) => {
      failEffort = value;
    },
  };
});

const requests = (sent: ReadonlyArray<JsonObject>) =>
  sent.map((frame) => (frame["type"] === "control_request" ? frame["request"] : frame["type"]));

const finishTurn = (wire: {
  readonly push: (value: unknown) => void;
  readonly drain: Effect.Effect<void>;
}) => {
  wire.push({ type: "result", subtype: "success", session_id: "native", is_error: false });
  wire.push({ type: "system", subtype: "session_state_changed", state: "idle" });
  return wire.drain;
};

describe("Claude live model and effort", () => {
  it.effect("waits for both acknowledgements before writing the next user frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const session = yield* ClaudeAdapter.start(wire.transport, launch);
        const sending = yield* session.sendTurn("next", selection).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const model = wire.sent.at(-1);
        expect(requests(wire.sent)).toEqual([{ subtype: "set_model", model: selection.model }]);
        wire.push({
          type: "control_response",
          response: { subtype: "success", request_id: model?.["request_id"] },
        });
        yield* wire.drain;
        yield* Effect.yieldNow;
        expect(requests(wire.sent)).toEqual([
          { subtype: "set_model", model: selection.model },
          { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
        ]);
        wire.push({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: wire.sent.at(-1)?.["request_id"],
            response: {},
          },
        });
        yield* Fiber.join(sending);
        expect(wire.sent.at(-1)?.["type"]).toBe("user");
        yield* finishTurn(wire);
        yield* session.sendTurn("same", selection);
        expect(requests(wire.sent).filter((frame) => frame !== "user")).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "sends no prompt after a partial failure and positively reapplies the full choice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* acknowledgedWire;
          const session = yield* ClaudeAdapter.start(wire.transport, launch);
          wire.refuseEffort(true);
          const error = yield* session.sendTurn("refused", selection).pipe(Effect.flip);
          expect(error._tag).toBe("AgentProtocolError");
          expect(wire.sent.some((frame) => frame["type"] === "user")).toBe(false);
          wire.refuseEffort(false);
          yield* session.sendTurn("accepted", selection);
          expect(requests(wire.sent)).toEqual([
            { subtype: "set_model", model: selection.model },
            { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
            { subtype: "set_model", model: selection.model },
            { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
            "user",
          ]);
        }),
      ),
  );

  it.effect(
    "requires idle replacement to restore user-settings effort and preserves background work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* acknowledgedWire;
          const session = yield* ClaudeAdapter.start(wire.transport, launch);
          const reset = { ...selection, effort: null };
          const replacement = yield* session.sendTurn("reset", reset).pipe(Effect.flip);
          expect(replacement._tag).toBe("AgentSelectionRequiresReplacementError");
          expect(wire.sent).toEqual([]);
          wire.push({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "shell", task_type: "local_bash", description: "server" }],
          });
          yield* wire.drain;
          const refused = yield* session.sendTurn("reset", reset).pipe(Effect.flip);
          expect(refused._tag).toBe("AgentProtocolError");
          expect(refused.message).toContain("background work");
          expect(wire.sent).toEqual([]);
          yield* session.sendTurn("ordinary live choice", selection);
          expect(wire.sent.at(-1)?.["type"]).toBe("user");
        }),
      ),
  );

  it.effect("restores the default model live and refuses invalid effort without a prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* acknowledgedWire;
        const session = yield* ClaudeAdapter.start(wire.transport, launch);
        const invalid = yield* session
          .sendTurn("invalid", { ...selection, effort: "ultra" })
          .pipe(Effect.flip);
        expect(invalid._tag).toBe("AgentProtocolError");
        expect(wire.sent).toEqual([]);
        yield* session.sendTurn("model default", { ...selection, model: null });
        expect(requests(wire.sent)[0]).toEqual({ subtype: "set_model", model: null });
      }),
    ),
  );

  it.effect("reapplies the complete selection after an interrupted control wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const session = yield* ClaudeAdapter.start(wire.transport, launch);
        const interrupted = yield* session.sendTurn("cancelled", selection).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(wire.sent.at(-1)?.["type"]).toBe("control_request");
        yield* Fiber.interrupt(interrupted);
        const retry = yield* session
          .sendTurn("original", { harness: "claude", model: launch.model, effort: launch.effort })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(wire.sent.at(-1)?.["request"]).toEqual({
          subtype: "set_model",
          model: launch.model,
        });
        wire.push({
          type: "control_response",
          response: { subtype: "success", request_id: wire.sent.at(-1)?.["request_id"] },
        });
        yield* wire.drain;
        yield* Effect.yieldNow;
        expect(wire.sent.at(-1)?.["request"]).toEqual({
          subtype: "apply_flag_settings",
          settings: { effortLevel: launch.effort },
        });
        wire.push({
          type: "control_response",
          response: { subtype: "success", request_id: wire.sent.at(-1)?.["request_id"] },
        });
        yield* Fiber.join(retry);
        expect(wire.sent.filter((frame) => frame["type"] === "user")).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "does not resend historical controls during replay and reapplies before a new prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* acknowledgedWire;
          const session = yield* ClaudeAdapter.start(wire.transport, {
            ...launch,
            sharedControl: false,
            providerSessionId: "native",
            rehydrate: { replayProviderTurnIds: [], resolvedProviderRequestIds: new Set() },
          });
          wire.push({
            type: "control_response",
            response: { subtype: "success", request_id: "historical" },
          });
          yield* wire.drain;
          expect(wire.sent).toEqual([]);
          yield* session.sendTurn("new", selection);
          expect(requests(wire.sent)).toEqual([
            { subtype: "set_model", model: selection.model },
            { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
            "user",
          ]);
        }),
      ),
  );
});
