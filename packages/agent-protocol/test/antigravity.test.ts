import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, AgentEventItem, TurnSelection } from "@mend/domain/workbench";
import { Effect, Queue, Stream } from "effect";

import {
  ANTIGRAVITY_CONVERSATION_NOT_FOUND,
  AgentProtocolError,
  AntigravityAdapter,
  type AgentStartOptions,
  type AgentTransport,
} from "../src/index.ts";

/**
 * Frames recorded from agy 1.5.13's `agy acp --stdio` on 2026-11-22 (paths rewritten to
 * /workspace/repo): the handshake's answers, a turn that ran `echo hi > hello.txt` after asking
 * permission, and a turn that thought, edited notes.txt and read it back.
 */
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/antigravity/${name}`, import.meta.url), "utf8");

const handshake = (): JsonObject => {
  const value: unknown = JSON.parse(fixture("handshake.json"));
  if (!isObject(value)) throw new Error("expected the recorded handshake");
  return value;
};

const recordedTurn = (name: string): ReadonlyArray<JsonObject> =>
  fixture(name)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) throw new Error("expected a recorded frame");
      return value;
    });

/** The session a recorded turn ran in: its updates name it, and the adapter reads only its own. */
const sessionOf = (frames: ReadonlyArray<JsonObject>): string => {
  const params = frames[0]?.["params"];
  const id = isObject(params) ? params["sessionId"] : undefined;
  if (typeof id !== "string") throw new Error("expected a session id");
  return id;
};

/** The prompt's answer is the last frame; it answers whatever id this run's prompt carried. */
const answering = (frames: ReadonlyArray<JsonObject>, promptId: unknown) =>
  frames.map((frame, index) => (index === frames.length - 1 ? { ...frame, id: promptId } : frame));

interface Agent {
  readonly sent: Array<JsonObject>;
  readonly events: Array<AgentEvent>;
  readonly push: (frame: unknown) => void;
  /** Waits until the adapter handled every pushed frame. */
  readonly drain: () => Effect.Effect<void>;
  readonly transport: AgentTransport;
  readonly configured: Array<{ readonly configId: unknown; readonly value: unknown }>;
}

/**
 * A recording fake of agy: it answers the handshake and config requests as agy 1.5.13 did, and a
 * prompt with `onPrompt`. Every frame Mend wrote is in `sent`.
 */
const fakeAgy = (input: {
  readonly sessionId: string;
  readonly onPrompt?: (id: unknown, agent: Agent) => void;
  readonly resumeError?: string;
}) =>
  Effect.gen(function* () {
    const recorded = handshake();
    const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError>();
    const handled = yield* Queue.unbounded<number>();
    let pushed = 0;
    let acknowledged = 0;
    const config: JsonObject = { model: "gemini-4-neon", thought_level: "high", mode: "default" };
    const agent: Agent = {
      sent: [],
      events: [],
      configured: [],
      push: (frame) => {
        pushed += 1;
        Queue.offerUnsafe(output, new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
      },
      drain: () =>
        Effect.gen(function* () {
          let seen = acknowledged;
          while (seen < pushed) seen = yield* Queue.take(handled);
        }),
      transport: {
        send: (bytes) =>
          Effect.sync(() => {
            const message: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (!isObject(message)) throw new Error("expected an object line");
            agent.sent.push(message);
            answer(message);
          }),
        output: Stream.fromQueue(output),
        acknowledgeOutput: () =>
          Effect.sync(() => {
            acknowledged += 1;
            Queue.offerUnsafe(handled, acknowledged);
          }),
        close: () => Queue.shutdown(output),
      },
    };
    const configOptions = () =>
      Object.entries(config).map(([id, currentValue]) => ({ id, currentValue }));
    const answer = (message: JsonObject) => {
      const { id, method } = message;
      const params = isObject(message["params"]) ? message["params"] : {};
      switch (method) {
        case "initialize":
        case "authenticate":
          return agent.push({ jsonrpc: "2.0", id, result: recorded[method] });
        case "session/new": {
          const result = isObject(recorded[method]) ? recorded[method] : {};
          return agent.push({
            jsonrpc: "2.0",
            id,
            result: { ...result, sessionId: input.sessionId },
          });
        }
        case "session/resume":
          return agent.push(
            input.resumeError === undefined
              ? { jsonrpc: "2.0", id, result: { configOptions: configOptions() } }
              : { jsonrpc: "2.0", id, error: { code: -32603, message: input.resumeError } },
          );
        case "session/set_config_option": {
          agent.configured.push({ configId: params["configId"], value: params["value"] });
          // agy 1.5.13's words for a model the account does not have.
          if (params["configId"] === "model" && params["value"] === "nope-model")
            return agent.push({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Unknown model ID: nope-model" },
            });
          if (typeof params["configId"] === "string") config[params["configId"]] = params["value"];
          return agent.push({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
        }
        case "session/prompt":
          return input.onPrompt?.(id, agent);
        default:
          return undefined;
      }
    };
    return agent;
  });

const start = (agent: Agent, options: Partial<AgentStartOptions> = {}) =>
  AntigravityAdapter.start(agent.transport, {
    cwd: "/workspace/repo",
    permissionMode: "bypass",
    onEvent: (event) => Effect.sync(() => void agent.events.push(event)),
    ...options,
  });

const itemsOf = (events: ReadonlyArray<AgentEvent>): ReadonlyMap<string, AgentEventItem> => {
  const items = new Map<string, AgentEventItem>();
  for (const event of events)
    if (event._tag === "item.updated") items.set(event.item.providerItemId, event.item);
  return items;
};

const completionOf = (events: ReadonlyArray<AgentEvent>, turnId: string) =>
  events.find(
    (event): event is Extract<AgentEvent, { readonly _tag: "turn.completed" }> =>
      event._tag === "turn.completed" && event.providerTurnId === turnId,
  );

const answersTo = (agent: Agent, id: unknown) =>
  agent.sent.filter((message) => message["id"] === id && message["method"] === undefined);

const choice = (patch: Partial<TurnSelection>): TurnSelection => ({
  harness: "antigravity",
  model: null,
  effort: null,
  interactionMode: "default",
  ...patch,
});

const commandTurn = recordedTurn("command-turn.jsonl");
const editTurn = recordedTurn("edit-turn.jsonl");

describe("AntigravityAdapter", () => {
  it.effect("answers a bypass turn's permission itself and records the command it ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* fakeAgy({
          sessionId: sessionOf(commandTurn),
          onPrompt: (id, fake) => answering(commandTurn, id).forEach(fake.push),
        });
        const session = yield* start(agent);
        const turnId = yield* session.sendTurn("Run echo hi > hello.txt, then say done.");
        yield* agent.drain();

        // The recorded ask was answered with agy's own allow option, and no person was asked.
        expect(answersTo(agent, "1").map((message) => message["result"])).toEqual([
          { outcome: { outcome: "selected", optionId: "allow" } },
        ]);
        expect(agent.events.some((event) => event._tag === "request.opened")).toBe(false);

        const items = itemsOf(agent.events);
        const command = items.get("call_4617910286385018650");
        expect(command).toMatchObject({
          providerTurnId: turnId,
          kind: "command-execution",
          status: "completed",
          title: "echo hi > hello.txt",
          data: { command: "echo hi > hello.txt", exitCode: 0 },
        });
        expect(command?.text).toContain("Command exited with code 0.");
        expect(
          [...items.values()]
            .filter((item) => item.kind === "assistant-message")
            .map((item) => item.text),
        ).toEqual(["done"]);
        expect(completionOf(agent.events, turnId)).toMatchObject({
          status: "completed",
          error: null,
          usage: {
            inputTokens: 11211,
            outputTokens: 106,
            cachedInputTokens: 6912,
            totalTokens: 18229,
            contextWindow: 1048576,
            contextTokens: 9169,
          },
        });
      }),
    ),
  );

  it.effect("asks the person in an ask turn and sends the option they chose", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asking = commandTurn.findIndex(
          (frame) => frame["method"] === "session/request_permission",
        );
        let promptId: unknown = null;
        const agent = yield* fakeAgy({
          sessionId: sessionOf(commandTurn),
          // agy waits for the answer: only what it sent up to its question arrives first.
          onPrompt: (id, fake) => {
            promptId = id;
            commandTurn.slice(0, asking + 1).forEach(fake.push);
          },
        });
        const session = yield* start(agent, { permissionMode: "ask" });
        const turnId = yield* session.sendTurn("Run echo hi > hello.txt, then say done.");
        yield* agent.drain();

        const opened = agent.events.find((event) => event._tag === "request.opened");
        expect(opened).toMatchObject({
          request: {
            providerTurnId: turnId,
            providerItemId: "call_4617910286385018650",
            kind: "command-approval",
            title: "echo hi > hello.txt",
          },
        });
        expect(answersTo(agent, "1")).toEqual([]);

        if (opened?._tag !== "request.opened") throw new Error("expected a request");
        yield* session.respond(opened.request.providerRequestId, "decline");
        expect(answersTo(agent, "1").map((message) => message["result"])).toEqual([
          { outcome: { outcome: "selected", optionId: "deny" } },
        ]);

        answering(commandTurn.slice(asking + 1), promptId).forEach(agent.push);
        yield* agent.drain();
        expect(completionOf(agent.events, turnId)?.status).toBe("completed");
      }),
    ),
  );

  it.effect("records an edit as a file change with its diff, between the words around it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* fakeAgy({
          sessionId: sessionOf(editTurn),
          onPrompt: (id, fake) => answering(editTurn, id).forEach(fake.push),
        });
        const session = yield* start(agent);
        const turnId = yield* session.sendTurn("Plan, edit notes.txt, read it back, say ok.");
        yield* agent.drain();

        const items = [...itemsOf(agent.events).values()];
        expect(items.map((item) => [item.kind, item.status])).toEqual([
          ["reasoning", "completed"],
          ["assistant-message", "completed"],
          ["file-change", "completed"],
          ["tool-call", "completed"],
          ["assistant-message", "completed"],
        ]);
        expect(items[1]?.text).toBe(
          "Plan:\n1. Edit [notes.txt](file:///workspace/repo/notes.txt) to replace `line one` with `line ONE`.\n2. Read [notes.txt](file:///workspace/repo/notes.txt) back to verify the change, then reply `ok`.",
        );
        expect(items[2]?.data).toMatchObject({
          changes: [
            {
              path: "/workspace/repo/notes.txt",
              diff: "--- /workspace/repo/notes.txt\n+++ /workspace/repo/notes.txt\n-line one\n+line ONE",
            },
          ],
        });
        expect(items[4]?.text).toBe("\n\nok");
        expect(completionOf(agent.events, turnId)?.status).toBe("completed");
      }),
    ),
  );

  it.effect("sets only the choices that change, and refuses a model before any prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const prompts: Array<unknown> = [];
        const agent = yield* fakeAgy({
          sessionId: sessionOf(commandTurn),
          onPrompt: (id, fake) => {
            prompts.push(id);
            fake.push({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          },
        });
        const session = yield* start(agent);

        yield* session.sendTurn(
          "plan it",
          choice({ model: "gemini-3.8-flash", effort: "low", interactionMode: "plan" }),
        );
        yield* agent.drain();
        expect(agent.configured).toEqual([
          { configId: "model", value: "gemini-3.8-flash" },
          { configId: "thought_level", value: "low" },
          { configId: "mode", value: "plan" },
        ]);

        // Nulls restore what the session started with, so the last turn's choice never sticks.
        agent.configured.length = 0;
        yield* session.sendTurn("go", choice({}));
        yield* agent.drain();
        expect(agent.configured).toEqual([
          { configId: "model", value: "gemini-4-neon" },
          { configId: "thought_level", value: "high" },
          { configId: "mode", value: "default" },
        ]);

        agent.configured.length = 0;
        yield* session.sendTurn("again", choice({}));
        yield* agent.drain();
        expect(agent.configured).toEqual([]);

        const refused = yield* session
          .sendTurn("nope", choice({ model: "nope-model" }))
          .pipe(Effect.flip);
        expect(refused._tag).toBe("AgentProtocolError");
        expect(prompts).toHaveLength(3);
      }),
    ),
  );

  it.effect("interrupts with session/cancel and reads the cancelled answer as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let promptId: unknown = null;
        const agent = yield* fakeAgy({
          sessionId: sessionOf(commandTurn),
          onPrompt: (id) => {
            promptId = id;
          },
        });
        const session = yield* start(agent);
        const turnId = yield* session.sendTurn("Count to 200.");
        yield* session.interrupt();
        expect(agent.sent.at(-1)).toEqual({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: sessionOf(commandTurn) },
        });
        agent.push({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        yield* agent.drain();
        expect(completionOf(agent.events, turnId)?.status).toBe("interrupted");
        expect((yield* session.quiescence()).quiescent).toBe(true);
      }),
    ),
  );

  it.effect(
    "after a restart, ends the turn a replayed answer names and reopens no answered ask",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessionId = sessionOf(commandTurn);
          const agent = yield* fakeAgy({ sessionId });
          // The previous Mend process sent turn-a (answered) and then turn-b (still running).
          yield* start(agent, {
            providerSessionId: sessionId,
            permissionMode: "ask",
            rehydrate: {
              replayProviderTurnIds: ["turn-a", "turn-b"],
              resolvedProviderRequestIds: new Set(["s:1"]),
            },
          });
          expect(agent.sent).toEqual([]);
          answering(commandTurn, "p:turn-a").forEach(agent.push);
          yield* agent.drain();

          expect(agent.events.some((event) => event._tag === "request.opened")).toBe(false);
          expect(itemsOf(agent.events).get("call_4617910286385018650")?.providerTurnId).toBe(
            "turn-a",
          );
          expect(completionOf(agent.events, "turn-a")?.status).toBe("completed");
          expect(completionOf(agent.events, "turn-b")).toBeUndefined();
        }),
      ),
  );

  it.effect("fails a resume of a conversation agy cannot read, and starts none in its place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* fakeAgy({
          sessionId: "unused",
          resumeError:
            "Failed to read session 00000000-0000-4000-8000-000000000000; retry, or load it with session/load",
        });
        const error = yield* start(agent, {
          providerSessionId: "00000000-0000-4000-8000-000000000000",
        }).pipe(Effect.flip);
        expect(error.message).toBe(ANTIGRAVITY_CONVERSATION_NOT_FOUND);
        expect(agent.sent.some((message) => message["method"] === "session/new")).toBe(false);
      }),
    ),
  );
});
