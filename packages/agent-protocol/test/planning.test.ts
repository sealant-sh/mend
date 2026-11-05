import { describe, expect, it } from "@effect/vitest";
import { type AgentEvent, turnSelectionOf } from "@mend/domain/workbench";
import { Deferred, Effect, Fiber } from "effect";
import { ClaudeAdapter, CodexAdapter } from "../src/index.ts";
import { ignore, isObject, makeWire } from "./steering-wire.ts";

const selection = (harness: "claude" | "codex", mode: "plan" | "default") => turnSelectionOf(harness, "test", "high", mode);

describe("native planning", () => {
  it.effect("Codex resets collaboration and keeps one typed proposal across deltas", () => Effect.scoped(Effect.gen(function* () {
    let push: (value: unknown) => void = ignore;
    const wire = yield* makeWire(frame => {
      if (typeof frame["id"] !== "number") return;
      const method = frame["method"];
      push({ id: frame["id"], result: method === "thread/start" ? { thread: { id: "native" } } : method === "turn/start" ? { turn: { id: "turn" } } : {} });
    });
    push = wire.push;
    const events: AgentEvent[] = [];
    const session = yield* CodexAdapter.start(wire.transport, { cwd: "/repo", permissionMode: "ask", onEvent: e => Effect.sync(() => { events.push(e); }) });
    yield* session.sendTurn("plan", selection("codex", "plan"));
    yield* session.sendTurn("implement", selection("codex", "default"));
    expect(wire.sent.filter(f => f["method"] === "turn/start").map(f => isObject(f["params"]) ? f["params"]["collaborationMode"] : null)).toEqual(["plan", "default"].map(mode => ({ mode, settings: { model: "test", reasoning_effort: "high", developer_instructions: null } })));
    wire.push({ method: "item/started", params: { turnId: "turn", item: { id: "proposal", type: "plan", text: "" } } });
    wire.push({ method: "item/plan/delta", params: { turnId: "turn", itemId: "proposal", delta: "# Plan" } });
    wire.push({ method: "turn/plan/updated", params: { turnId: "turn", plan: [{ step: "todo", status: "pending" }] } });
    wire.push({ method: "item/completed", params: { turnId: "turn", item: { id: "proposal", type: "plan", text: "# Plan\n\nFull markdown" } } });
    yield* wire.drain;
    const items = events.flatMap(e => e._tag === "item.updated" ? [e.item] : []);
    expect(items.map(i => i.providerItemId)).toEqual(["proposal", "proposal", "proposal"]);
    expect(items.at(-1)).toMatchObject({ data: { _tag: "ProposedPlan" }, text: "# Plan\n\nFull markdown", status: "completed" });
    expect(items[1]?.text).toBe("# Plan");
  })));

  for (const permissionMode of ["ask", "bypass"] as const) {
    it.effect(`Claude acknowledges Plan and restores ${permissionMode} before the prompt`, () => Effect.scoped(Effect.gen(function* () {
      let push: (value: unknown) => void = ignore;
      const events: AgentEvent[] = [];
      const durable = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const wire = yield* makeWire(frame => {
        if (frame["type"] === "control_request") push({ type: "control_response", response: { subtype: "success", request_id: frame["request_id"] } });
      }, false);
      push = wire.push;
      const session = yield* ClaudeAdapter.start(wire.transport, { cwd: "/repo", permissionMode, model: "test", effort: "high", onEvent: e => Effect.gen(function* () {
        events.push(e);
        if (e._tag === "item.updated" && e.item.kind === "plan") { yield* Deferred.succeed(durable, undefined); yield* Deferred.await(release); }
      }) });
      yield* session.sendTurn("plan", selection("claude", "plan"));
      expect(wire.sent.at(-2)?.["request"]).toEqual({ subtype: "set_permission_mode", mode: "plan" });
      wire.push({ type: "control_request", request_id: "exit", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", tool_use_id: "tool", input: { plan: "# Proposal" } } });
      yield* Deferred.await(durable);
      expect(wire.sent.some(f => isObject(f["response"]) && f["response"]["request_id"] === "exit")).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* wire.drain;
      expect(wire.sent.at(-1)).toMatchObject({ type: "control_response", response: { request_id: "exit", response: { behavior: "deny" } } });
      expect(events.some(e => e._tag === "request.opened")).toBe(false);
      expect(events.find(e => e._tag === "item.updated" && e.item.kind === "plan")).toMatchObject({ item: { providerItemId: "proposed-plan:tool", text: "# Proposal", data: { _tag: "ProposedPlan" } } });
      wire.push({ type: "result", subtype: "success", is_error: false });
      wire.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      yield* wire.drain;
      yield* session.sendTurn("implement", selection("claude", "default"));
      expect(wire.sent.at(-2)?.["request"]).toEqual({ subtype: "set_permission_mode", mode: permissionMode === "ask" ? "default" : "bypassPermissions" });
    })));
  }

  it.effect("Claude sends no prompt when a mode control is refused", () => Effect.scoped(Effect.gen(function* () {
    const wire = yield* makeWire(undefined, false);
    const session = yield* ClaudeAdapter.start(wire.transport, { cwd: "/repo", model: "test", effort: "high", permissionMode: "ask" });
    const sending = yield* session.sendTurn("plan", selection("claude", "plan")).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    expect(wire.sent.at(-1)?.["request"]).toEqual({ subtype: "set_permission_mode", mode: "plan" });
    wire.push({ type: "control_response", response: { subtype: "error", request_id: wire.sent.at(-1)?.["request_id"], error: "mode refused" } });
    expect((yield* Fiber.join(sending)).message).toContain("mode refused");
    expect(wire.sent.some(f => f["type"] === "user")).toBe(false);
  })));
});
