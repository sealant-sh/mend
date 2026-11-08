import { describe, expect, it } from "@effect/vitest";
import { type AgentEvent, turnSelectionOf } from "@mend/domain/workbench";
import { Effect } from "effect";

import { ClaudeAdapter } from "../src/index.ts";
import { makeWire } from "./steering-wire.ts";

describe("Claude command output", () => {
  it.effect(
    "keeps Bash running until its result and records terminal output on the same item",
    () =>
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
          yield* session.sendTurn("Run tests", turnSelectionOf("claude", null, null));
          const block = {
            type: "tool_use",
            id: "bash-1",
            name: "Bash",
            input: { command: "pnpm test" },
          };
          wire.push({
            type: "stream_event",
            event: { type: "content_block_start", index: 0, content_block: block },
          });
          wire.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
          wire.push({ type: "assistant", message: { id: "message-1", content: [block] } });
          yield* wire.drain;
          const items = () =>
            events.flatMap((event) => (event._tag === "item.updated" ? [event.item] : []));
          expect(items().at(-1)).toMatchObject({
            providerItemId: "bash-1",
            status: "in-progress",
            text: null,
          });
          wire.push({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "bash-1", content: "rendered wrapper" },
              ],
            },
            tool_use_result: {
              stdout: "\u001b[32mpassed\u001b[0m",
              stderr: "warning\n",
              interrupted: false,
            },
          });
          yield* wire.drain;
          expect(items().at(-1)).toMatchObject({
            providerItemId: "bash-1",
            kind: "command-execution",
            status: "completed",
            text: "\u001b[32mpassed\u001b[0m\nwarning\n",
          });
          expect(new Set(items().map((item) => item.providerItemId))).toEqual(new Set(["bash-1"]));
        }),
      ),
  );

  it.effect("records failed Shell results made of text blocks", () =>
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
        yield* session.sendTurn("Run tests", turnSelectionOf("claude", null, null));
        wire.push({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "shell-1", name: "Shell", input: { command: "false" } },
            ],
          },
        });
        wire.push({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "shell-1",
                is_error: true,
                content: [{ type: "text", text: "command failed" }],
              },
            ],
          },
        });
        yield* wire.drain;
        expect(
          events.flatMap((event) => (event._tag === "item.updated" ? [event.item] : [])).at(-1),
        ).toMatchObject({
          providerItemId: "shell-1",
          kind: "command-execution",
          status: "failed",
          text: "command failed",
        });
      }),
    ),
  );

  it.effect("keeps batched command results separate from a shared structured envelope", () =>
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
        yield* session.sendTurn("Run two commands", turnSelectionOf("claude", null, null));
        wire.push({
          type: "assistant",
          message: {
            content: ["one", "two"].map((id) => ({
              type: "tool_use",
              id,
              name: "Bash",
              input: { command: `echo ${id}` },
            })),
          },
        });
        wire.push({
          type: "user",
          message: {
            content: ["one", "two"].map((id) => ({
              type: "tool_result",
              tool_use_id: id,
              content: id,
            })),
          },
          tool_use_result: { stdout: "unattributed", stderr: "" },
        });
        yield* wire.drain;
        expect(
          events.flatMap((event) =>
            event._tag === "item.updated" && event.item.status === "completed"
              ? [[event.item.providerItemId, event.item.text]]
              : [],
          ),
        ).toEqual([
          ["one", "one"],
          ["two", "two"],
        ]);
      }),
    ),
  );
});
