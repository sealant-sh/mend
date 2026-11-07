import { describe, expect, it } from "@effect/vitest";
import { type AgentEvent, turnSelectionOf } from "@mend/domain/workbench";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { ClaudeAdapter, CodexAdapter } from "../src/index.ts";
import { ignore, isObject, makeWire } from "./steering-wire.ts";

const selection = (harness: "claude" | "codex", mode: "plan" | "default") =>
  turnSelectionOf(harness, "test", "high", mode);

describe("native planning", () => {
  it.effect("Codex resets collaboration and keeps one typed proposal across deltas", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let push: (value: unknown) => void = ignore;
        const wire = yield* makeWire((frame) => {
          if (typeof frame["id"] !== "number") return;
          const method = frame["method"];
          push({
            id: frame["id"],
            result:
              method === "thread/start"
                ? { thread: { id: "native" } }
                : method === "turn/start"
                  ? { turn: { id: "turn" } }
                  : {},
          });
        });
        push = wire.push;
        const events: AgentEvent[] = [];
        const session = yield* CodexAdapter.start(wire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          onEvent: (e) =>
            Effect.sync(() => {
              events.push(e);
            }),
        });
        yield* session.sendTurn("plan", selection("codex", "plan"));
        yield* session.sendTurn("implement", selection("codex", "default"));
        expect(
          wire.sent
            .filter((f) => f["method"] === "turn/start")
            .map((f) => (isObject(f["params"]) ? f["params"]["collaborationMode"] : null)),
        ).toEqual(
          ["plan", "default"].map((mode) => ({
            mode,
            settings: { model: "test", reasoning_effort: "high", developer_instructions: null },
          })),
        );
        wire.push({
          method: "item/started",
          params: { turnId: "turn", item: { id: "proposal", type: "plan", text: "" } },
        });
        wire.push({
          method: "item/plan/delta",
          params: { turnId: "turn", itemId: "proposal", delta: "# Plan" },
        });
        wire.push({
          method: "turn/plan/updated",
          params: { turnId: "turn", plan: [{ step: "todo", status: "pending" }] },
        });
        wire.push({
          method: "item/completed",
          params: {
            turnId: "turn",
            item: { id: "proposal", type: "plan", text: "# Plan\n\nFull markdown" },
          },
        });
        yield* wire.drain;
        const items = events.flatMap((e) => (e._tag === "item.updated" ? [e.item] : []));
        const proposals = items.filter((item) => item.providerItemId === "proposal");
        expect(proposals).toHaveLength(3);
        expect(proposals.at(-1)).toMatchObject({
          data: { _tag: "ProposedPlan" },
          text: "# Plan\n\nFull markdown",
          status: "completed",
        });
        expect(proposals[1]?.text).toBe("# Plan");
        expect(items.filter((item) => item.providerItemId !== "proposal")).toMatchObject([
          {
            providerItemId: "plan:turn",
            kind: "plan",
            status: "completed",
            data: { type: "todoList", plan: [{ step: "todo", status: "pending" }] },
          },
        ]);
      }),
    ),
  );

  for (const permissionMode of ["ask", "bypass"] as const) {
    it.effect(`Claude acknowledges Plan and restores ${permissionMode} before the prompt`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          let push: (value: unknown) => void = ignore;
          const events: AgentEvent[] = [];
          const durable = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const wire = yield* makeWire((frame) => {
            if (frame["type"] === "control_request")
              push({
                type: "control_response",
                response: { subtype: "success", request_id: frame["request_id"] },
              });
          }, false);
          push = wire.push;
          const session = yield* ClaudeAdapter.start(wire.transport, {
            cwd: "/repo",
            permissionMode,
            model: "test",
            effort: "high",
            onEvent: (e) =>
              Effect.gen(function* () {
                events.push(e);
                if (e._tag === "item.updated" && e.item.kind === "plan") {
                  yield* Deferred.succeed(durable, undefined);
                  yield* Deferred.await(release);
                }
              }),
          });
          yield* session.sendTurn("plan", selection("claude", "plan"));
          expect(wire.sent.at(-2)?.["request"]).toEqual({
            subtype: "set_permission_mode",
            mode: "plan",
          });
          wire.push({
            type: "control_request",
            request_id: "exit",
            request: {
              subtype: "can_use_tool",
              tool_name: "ExitPlanMode",
              tool_use_id: "tool",
              input: { plan: "# Proposal" },
            },
          });
          yield* Deferred.await(durable);
          expect(
            wire.sent.some(
              (f) => isObject(f["response"]) && f["response"]["request_id"] === "exit",
            ),
          ).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* wire.drain;
          expect(wire.sent.at(-1)).toMatchObject({
            type: "control_response",
            response: { request_id: "exit", response: { behavior: "deny" } },
          });
          expect(events.some((e) => e._tag === "request.opened")).toBe(false);
          expect(
            events.find((e) => e._tag === "item.updated" && e.item.kind === "plan"),
          ).toMatchObject({
            item: {
              providerItemId: "proposed-plan:tool",
              text: "# Proposal",
              data: { _tag: "ProposedPlan" },
            },
          });
          wire.push({ type: "result", subtype: "success", is_error: false });
          wire.push({ type: "system", subtype: "session_state_changed", state: "idle" });
          yield* wire.drain;
          yield* session.sendTurn("implement", selection("claude", "default"));
          expect(wire.sent.at(-2)?.["request"]).toEqual({
            subtype: "set_permission_mode",
            mode: permissionMode === "ask" ? "default" : "bypassPermissions",
          });
        }),
      ),
    );
  }

  it.effect("Claude sends no prompt when a mode control is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire(undefined, false);
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/repo",
          model: "test",
          effort: "high",
          permissionMode: "ask",
        });
        const sending = yield* session
          .sendTurn("plan", selection("claude", "plan"))
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        expect(wire.sent.at(-1)?.["request"]).toEqual({
          subtype: "set_permission_mode",
          mode: "plan",
        });
        wire.push({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: wire.sent.at(-1)?.["request_id"],
            error: "mode refused",
          },
        });
        expect((yield* Fiber.join(sending)).message).toContain("mode refused");
        expect(wire.sent.some((f) => f["type"] === "user")).toBe(false);
      }),
    ),
  );
});

it.effect(
  "Claude times out a missing mode acknowledgement without a prompt and permits retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire(undefined, false);
        const session = yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          model: "test",
          effort: "high",
        });
        const failed = yield* session
          .sendTurn("unacknowledged", selection("claude", "plan"))
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("16 seconds");
        expect((yield* Fiber.join(failed)).message).toContain("did not acknowledge");
        expect(wire.sent.some((frame) => frame["type"] === "user")).toBe(false);
        const retry = yield* session
          .sendTurn("retry", selection("claude", "default"))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        wire.push({
          type: "control_response",
          response: { subtype: "success", request_id: wire.sent.at(-1)?.["request_id"] },
        });
        yield* Fiber.join(retry);
        expect(wire.sent.at(-2)?.["request"]).toEqual({
          subtype: "set_permission_mode",
          mode: "default",
        });
        expect(wire.sent.filter((frame) => frame["type"] === "user")).toHaveLength(1);
      }),
    ),
);

it.effect(
  "Claude replays one proposal identity, denies duplicates, ignores child/empty plans, and steers without mode controls",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        yield* ClaudeAdapter.start(wire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          providerSessionId: "native",
          controlJournal: { recorded: [], record: () => Effect.void },
          rehydrate: {
            replayProviderTurnIds: ["historical"],
            resolvedProviderRequestIds: new Set(),
          },
          onEvent: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });
        wire.push({ type: "system", subtype: "init", session_id: "native" });
        const callback = {
          type: "control_request",
          request_id: "proposal-callback",
          request: {
            subtype: "can_use_tool",
            tool_name: "ExitPlanMode",
            tool_use_id: "tool",
            input: { plan: "# Durable plan" },
          },
        };
        wire.push(callback);
        wire.push(callback);
        wire.push({
          type: "assistant",
          message: {
            id: "message",
            content: [
              {
                type: "tool_use",
                id: "tool",
                name: "ExitPlanMode",
                input: { plan: "# Durable plan" },
              },
            ],
          },
        });
        wire.push({
          type: "assistant",
          parent_tool_use_id: "parent",
          message: {
            content: [
              { type: "tool_use", id: "child", name: "ExitPlanMode", input: { plan: "# Child" } },
            ],
          },
        });
        wire.push({
          ...callback,
          request_id: "empty",
          request: { ...callback.request, tool_use_id: "blank", input: { plan: "  " } },
        });
        wire.push({ type: "result", subtype: "success", is_error: false });
        wire.push({ type: "system", subtype: "session_state_changed", state: "idle" });
        yield* wire.drain;
        const proposals = events.flatMap((event) =>
          event._tag === "item.updated" && event.item.kind === "plan" ? [event.item] : [],
        );
        expect(new Set(proposals.map((item) => item.providerItemId))).toEqual(
          new Set(["proposed-plan:tool"]),
        );
        expect(proposals.at(-1)).toMatchObject({
          providerTurnId: "historical",
          text: "# Durable plan",
          status: "completed",
        });
        expect(events.some((event) => event._tag === "request.opened")).toBe(false);
        expect(wire.sent.filter((frame) => frame["type"] === "control_response")).toHaveLength(3);
        expect(wire.sent.some((frame) => frame["type"] === "user")).toBe(false);
        let answer: (value: unknown) => void = ignore;
        const liveWire = yield* makeWire((frame) => {
          if (
            frame["type"] === "control_request" &&
            isObject(frame["request"]) &&
            frame["request"]["subtype"] !== "interrupt"
          )
            answer({
              type: "control_response",
              response: { subtype: "success", request_id: frame["request_id"] },
            });
        });
        answer = liveWire.push;
        const live = yield* ClaudeAdapter.start(liveWire.transport, {
          cwd: "/repo",
          permissionMode: "ask",
          model: "test",
          effort: "high",
          controlJournal: { recorded: [], record: () => Effect.void },
        });
        const turn = yield* live.sendTurn("plan", selection("claude", "plan"));
        const count = liveWire.sent.length;
        yield* live.steer({ id: "steer", input: "refinement words", expectedTurnId: turn });
        expect(liveWire.sent.slice(count)).toMatchObject([{ type: "user", priority: "now" }]);
      }),
    ),
);
