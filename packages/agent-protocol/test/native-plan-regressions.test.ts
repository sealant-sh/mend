import { describe, expect, it } from "@effect/vitest";
import { type AgentEvent, turnSelectionOf } from "@mend/domain/workbench";
import { Effect } from "effect";

import { ClaudeAdapter } from "../src/index.ts";
import { isObject, makeWire } from "./steering-wire.ts";

const selection = (mode: "plan" | "default") => turnSelectionOf("claude", "test", "high", mode);

describe("native Plan callback policy", () => {
  for (const permissionMode of ["ask", "bypass"] as const) {
    it.effect(`denies unresolved Plan callbacks without approvals under ${permissionMode}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const wire = yield* makeWire();
          const events: AgentEvent[] = [];
          const session = yield* ClaudeAdapter.start(wire.transport, {
            cwd: "/repo",
            model: "test",
            effort: "high",
            permissionMode,
            onEvent: (event) => Effect.sync(() => void events.push(event)),
          });
          yield* session.sendTurn("plan", selection("plan"));
          // Actual CLI callback shapes. Native-allowed tools never reach this boundary.
          for (const [id, request] of [
            [
              "write",
              {
                tool_name: "Write",
                input: { file_path: "/repo/file", content: "x" },
                decision_reason_type: "mode",
              },
            ],
            [
              "shell",
              { tool_name: "Bash", input: { command: "printf x > file" }, blocked_path: "/repo" },
            ],
            [
              "read-ask",
              {
                tool_name: "Read",
                input: { file_path: "/repo/file" },
                matched_ask_rule: { source: "userSettings" },
              },
            ],
          ] as const) {
            wire.push({
              type: "control_request",
              request_id: id,
              request: { subtype: "can_use_tool", ...request },
            });
          }
          yield* wire.drain;
          expect(events.filter((event) => event._tag === "request.opened")).toEqual([]);
          for (const id of ["write", "shell", "read-ask"])
            expect(
              wire.sent.find(
                (frame) => isObject(frame["response"]) && frame["response"]["request_id"] === id,
              ),
            ).toMatchObject({ response: { response: { behavior: "deny" } } });
          wire.push({ type: "result", subtype: "success", uuid: "done" });
          yield* wire.drain;
          yield* session.sendTurn("default", selection("default"));
          wire.push({
            type: "control_request",
            request_id: "default-write",
            request: {
              subtype: "can_use_tool",
              tool_name: "Write",
              input: { file_path: "/repo/file", content: "x" },
            },
          });
          yield* wire.drain;
          expect(events.filter((event) => event._tag === "request.opened")).toMatchObject([
            { request: { providerRequestId: "default-write", kind: "tool-permission" } },
          ]);
        }),
      ),
    );
  }
});
