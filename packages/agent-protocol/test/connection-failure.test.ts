import fs from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect } from "effect";

import { ClaudeAdapter, CodexAdapter } from "../src/index.ts";
import { ignore, makeWire } from "./steering-wire.ts";

/** What a pinned harness printed, captured against a closed port with a fake key. */
const captured = (file: string): ReadonlyArray<Record<string, unknown>> =>
  fs
    .readFileSync(new URL(`./fixtures/endpoint/${file}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

/** A result as Claude Code 2.1.292 prints it when no request reached the API. */
const claudeApiError = (result: string, status: number | null = null) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: status,
  result,
  usage: { input_tokens: 0, output_tokens: 0 },
});

const claudeTurnEnd = (...lines: ReadonlyArray<Record<string, unknown>>) =>
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
    yield* session.sendTurn("say pong");
    for (const line of lines) wire.push(line);
    yield* wire.drain;
    return events.find((event) => event._tag === "turn.completed");
  });

describe("a Claude turn that could not connect", () => {
  it.effect(
    "reads what Claude Code 2.1.292 printed for a closed port as a refused connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const completed = yield* claudeTurnEnd(...captured("claude-2.1.292-closed-port.ndjson"));
          expect(completed).toMatchObject({
            status: "failed",
            error:
              "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
            unreachable: "connection-refused",
          });
        }),
      ),
  );

  it.effect("fails with Claude's words and says why, for each way Claude words it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cases = [
          [
            "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
            "connection-refused",
          ],
          [
            "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
            "host-not-found",
          ],
          ["Request timed out", "timed-out"],
        ] as const;
        for (const [words, cause] of cases) {
          const completed = yield* claudeTurnEnd(claudeApiError(words));
          expect(completed).toMatchObject({ status: "failed", error: words, unreachable: cause });
        }
      }),
    ),
  );

  it.effect("leaves an error the API answered, and a finished turn, as they were", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refused = yield* claudeTurnEnd(
          claudeApiError("API Error: 401 Invalid authentication credentials", 401),
        );
        expect(refused).toMatchObject({ status: "completed" });
        expect(refused).not.toHaveProperty("unreachable");
        const done = yield* claudeTurnEnd({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "pong",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        expect(done).toMatchObject({ status: "completed", error: null });
        expect(done).not.toHaveProperty("unreachable");
      }),
    ),
  );
});

/** The turn end Codex 0.160.1's app-server sends when its provider's endpoint does not answer. */
const codexConnectionFailed = (httpStatusCode: number | null) => ({
  method: "turn/completed",
  params: {
    threadId: "native",
    turn: {
      id: "one",
      status: "failed",
      error: {
        message: "Connection failed: error sending request",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode } },
        additionalDetails: null,
      },
    },
  },
});

const codexTurnEnd = (...ended: ReadonlyArray<Record<string, unknown>>) =>
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
    const turnId = ended.flatMap((line) => {
      const params = line["params"];
      return typeof params === "object" && params !== null && "turnId" in params
        ? [String(params.turnId)]
        : [];
    })[0];
    wire.push({
      method: "turn/started",
      params: { threadId: "native", turn: { id: turnId ?? "one" } },
    });
    for (const line of ended) wire.push(line);
    yield* wire.drain;
    return events.find((event) => event._tag === "turn.completed");
  });

describe("a Codex turn that could not connect", () => {
  it.effect(
    "reads what Codex 0.160.1's app-server sent for a closed port as a failed connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lines = captured("codex-0.160.1-closed-port.ndjson").map((line) => ({
            ...line,
            params: { ...Object(line["params"]), threadId: "native" },
          }));
          expect(yield* codexTurnEnd(...lines)).toMatchObject({
            status: "failed",
            error: "Connection failed: error sending request",
            unreachable: "connection-failed",
          });
        }),
      ),
  );

  it.effect("fails with Codex's words and says the connection failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(yield* codexTurnEnd(codexConnectionFailed(null))).toMatchObject({
          status: "failed",
          error: "Connection failed: error sending request",
          unreachable: "connection-failed",
        });
      }),
    ),
  );

  it.effect("leaves a failure the endpoint answered as it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const answered = yield* codexTurnEnd(codexConnectionFailed(502));
        expect(answered).toMatchObject({ status: "failed" });
        expect(answered).not.toHaveProperty("unreachable");
      }),
    ),
  );
});
