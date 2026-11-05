import { describe, expect, it } from "@effect/vitest";
import { type AgentEvent, turnSelectionOf } from "@mend/domain/workbench";
import { Deferred, Effect, Fiber } from "effect";

import { ClaudeAdapter } from "../src/index.ts";
import { isObject, makeWire, type JsonObject } from "./steering-wire.ts";

const planFile = "/home/person/.claude/plans/current-plan.md";
const savedFile = "/workspace/harness-home/people/person/.claude/plans/current-plan.md";
// Claude 2.1.318, real local CLI + fake Anthropic endpoint. The managed directory link
// produces a safetyCheck ask, even after set_permission_mode acknowledged Plan.
const planWrite = (id: string, toolName = "Write", changes: JsonObject = {}) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: toolName,
    tool_use_id: `tool:${id}`,
    input:
      toolName === "Edit"
        ? { file_path: planFile, old_string: "# Plan", new_string: "# Revised plan" }
        : { file_path: planFile, content: "# Plan" },
    blocked_path: savedFile,
    decision_reason_type: "safetyCheck",
    classifier_approvable: true,
    ...changes,
  },
});
const selection = (mode: "plan" | "default") => turnSelectionOf("claude", "test", "high", mode);
const options = (events: AgentEvent[], permissionMode: "ask" | "bypass") => ({
  cwd: "/workspace/repo",
  model: "test",
  effort: "high",
  permissionMode,
  // Faithful execution-boundary capability: the native transcript names this one
  // plan, and the executor confirms precisely this managed link and regular leaf.
  claudePlanFile: (filePath: string, blockedPath: string) =>
    Effect.succeed(filePath === planFile && blockedPath === savedFile),
  onEvent: (event: AgentEvent) => Effect.sync(() => void events.push(event)),
});
const opened = (events: AgentEvent[]) =>
  events.flatMap((event) => (event._tag === "request.opened" ? [event.request] : []));
const reply = (sent: ReadonlyArray<JsonObject>, id: string) =>
  sent.find((frame) => isObject(frame["response"]) && frame["response"]["request_id"] === id);
const finish = { type: "result", subtype: "success", uuid: "result" };

describe("Claude's own managed plan file", () => {
  for (const permissionMode of ["ask", "bypass"] as const) {
    it.effect(
      `answers Write and native Edit without an approval under ${permissionMode} Plan`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const wire = yield* makeWire();
            const events: AgentEvent[] = [];
            const session = yield* ClaudeAdapter.start(
              wire.transport,
              options(events, permissionMode),
            );
            yield* session.sendTurn("plan", selection("plan"));
            for (const tool of ["Write", "Edit"]) {
              wire.push(planWrite(tool, tool));
              yield* wire.drain;
              // Check the person-facing failure first: baseline opens this exact Write.
              expect(opened(events), `${tool} of Claude's own plan opened human approval`).toEqual(
                [],
              );
              expect(reply(wire.sent, tool)).toMatchObject({
                type: "control_response",
                response: {
                  request_id: tool,
                  response: {
                    behavior: "allow",
                    updatedInput: planWrite(tool, tool).request.input,
                  },
                },
              });
            }
            wire.push(finish);
            yield* wire.drain;
            yield* session.sendTurn("implement", selection("default"));
            expect(wire.sent.at(-2)?.["request"]).toEqual({
              subtype: "set_permission_mode",
              mode: permissionMode === "ask" ? "default" : "bypassPermissions",
            });
            wire.push(planWrite("default"));
            yield* wire.drain;
            expect(opened(events).map((request) => request.providerRequestId)).toEqual(["default"]);
            expect(reply(wire.sent, "default")).toBeUndefined();
          }),
        ),
    );
  }

  it.effect(
    "keeps real project writes, foreign paths, children and native safety objections pending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* makeWire();
          const events: AgentEvent[] = [];
          const session = yield* ClaudeAdapter.start(wire.transport, options(events, "ask"));
          yield* session.sendTurn("plan", selection("plan"));
          const cases = [
            { input: { file_path: "/workspace/repo/index.ts", content: "changed" } },
            { input: { file_path: "/workspace/repo/.claude/plans/current-plan.md", content: "x" } },
            { input: { file_path: "/home/other/.claude/plans/current-plan.md", content: "x" } },
            { input: { file_path: planFile.replace("current-plan", "sibling"), content: "x" } },
            { input: { file_path: planFile.replace("plans/", "plans/../plans/"), content: "x" } },
            { blocked_path: savedFile.replace("current-plan", "other") },
            { agent_id: "child" },
            { parent_tool_use_id: "parent" },
            { tool_name: "Bash", input: { command: `echo x > ${planFile}` } },
            { tool_name: "mcp__Write" },
            { decision_reason_type: "rule", matched_ask_rule: { source: "userSettings" } },
            { classifier_approvable: false },
            { server_policy_ask_only: true },
            { default_to_no: true },
            { requires_user_interaction: true },
            { suppress_always_allow_rule: true },
            { decision_reason_code: "permission_check_crashed" },
            { decision_reason_type: "other" },
            { input: { file_path: planFile, content: "x", host: "other" } },
          ];
          for (const [index, changes] of cases.entries())
            wire.push(planWrite(`held:${index}`, "Write", changes));
          yield* wire.drain;
          expect(opened(events).map((request) => request.providerRequestId)).toEqual(
            cases.map((_, i) => `held:${i}`),
          );
          expect(wire.sent.filter((frame) => frame["type"] === "control_response")).toEqual([]);
        }),
      ),
  );

  it.effect("grants nothing before admission, after completion or once cancellation starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        const session = yield* ClaudeAdapter.start(wire.transport, {
          ...options(events, "ask"),
          controlJournal: { recorded: [], record: () => Effect.void },
        });
        wire.push(planWrite("before"));
        yield* wire.drain;
        expect(reply(wire.sent, "before")).toMatchObject({
          response: { response: { behavior: "deny" } },
        });
        yield* session.sendTurn("plan", selection("plan"));
        wire.push(planWrite("during"));
        yield* wire.drain;
        expect(reply(wire.sent, "during")).toMatchObject({
          response: { response: { behavior: "allow" } },
        });
        wire.push(finish);
        wire.push(planWrite("after"));
        yield* wire.drain;
        expect(reply(wire.sent, "after")).toMatchObject({
          response: { response: { behavior: "deny" } },
        });
        yield* session.sendTurn("plan again", selection("plan"));
        yield* session.interrupt();
        wire.push(planWrite("cancelled"));
        yield* wire.drain;
        expect(reply(wire.sent, "cancelled")).not.toMatchObject({
          response: { response: { behavior: "allow" } },
        });
      }),
    ),
  );

  it.effect("keeps the native approval when execution-owned plan identity is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        const { claudePlanFile: _check, ...withoutPlanScope } = options(events, "ask");
        const session = yield* ClaudeAdapter.start(wire.transport, withoutPlanScope);
        yield* session.sendTurn("plan", selection("plan"));
        wire.push(planWrite("unknown-plan"));
        yield* wire.drain;
        expect(opened(events).map((request) => request.providerRequestId)).toEqual([
          "unknown-plan",
        ]);
        expect(reply(wire.sent, "unknown-plan")).toBeUndefined();
      }),
    ),
  );

  it.effect("does not allow the file if Stop begins while native metadata is being read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        const checking = yield* Deferred.make<void>();
        const checked = yield* Deferred.make<boolean>();
        const session = yield* ClaudeAdapter.start(wire.transport, {
          ...options(events, "ask"),
          controlJournal: { recorded: [], record: () => Effect.void },
          claudePlanFile: () =>
            Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(checked))),
        });
        yield* session.sendTurn("plan", selection("plan"));
        wire.push(planWrite("stopping"));
        yield* Deferred.await(checking);
        const stop = yield* session.interrupt().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(checked, true);
        yield* wire.drain;
        yield* Fiber.join(stop);
        expect(reply(wire.sent, "stopping")).not.toMatchObject({
          response: { response: { behavior: "allow" } },
        });
      }),
    ),
  );

  for (const mode of ["plan", "default"] as const) {
    it.effect(
      `rehydrates the admitted ${mode} turn instead of inferring it from launch settings`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const wire = yield* makeWire();
            const events: AgentEvent[] = [];
            const rehydrate = {
              replayProviderTurnIds: ["active"],
              resolvedProviderRequestIds: new Set<string>(),
              turnSelections: new Map([["active", selection(mode)]]),
              completedProviderTurnIds: new Set<string>(),
            };
            yield* ClaudeAdapter.start(wire.transport, { ...options(events, "ask"), rehydrate });
            wire.push(planWrite("replayed"));
            yield* wire.drain;
            if (mode === "plan") {
              expect(opened(events)).toEqual([]);
              expect(reply(wire.sent, "replayed")).toMatchObject({
                response: { response: { behavior: "allow" } },
              });
            } else {
              expect(opened(events).map((request) => request.providerRequestId)).toEqual([
                "replayed",
              ]);
              expect(reply(wire.sent, "replayed")).toBeUndefined();
            }
          }),
        ),
    );
  }

  it.effect("does not reopen or reanswer a completed Plan turn's replayed callback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wire = yield* makeWire();
        const events: AgentEvent[] = [];
        const rehydrate = {
          replayProviderTurnIds: ["completed"],
          resolvedProviderRequestIds: new Set<string>(),
          turnSelections: new Map([["completed", selection("plan")]]),
          completedProviderTurnIds: new Set(["completed"]),
        };
        yield* ClaudeAdapter.start(wire.transport, { ...options(events, "ask"), rehydrate });
        wire.push(planWrite("historical"));
        yield* wire.drain;
        expect(opened(events)).toEqual([]);
        expect(reply(wire.sent, "historical")).toBeUndefined();
      }),
    ),
  );
});
