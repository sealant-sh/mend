import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent } from "@mend/domain/workbench";
import { Effect, Fiber, Option, Queue, Stream } from "effect";

import {
  AgentProtocolError,
  CODEX_THREAD_NOT_FOUND,
  ClaudeAdapter,
  CodexAdapter,
  createNdjsonDecoder,
  type AgentTransport,
} from "../src/index.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const line = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const parseLine = (bytes: Uint8Array): JsonObject => {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isObject(value)) throw new Error("expected object line");
  return value;
};

const makeTransport = Effect.fn("test.makeTransport")(function* (
  onSend: (message: JsonObject, push: (value: unknown) => void) => void,
  onAcknowledge?: () => void,
) {
  const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError>();
  const sent: JsonObject[] = [];
  const push = (value: unknown): void => {
    Queue.offerUnsafe(output, line(value));
  };
  const transport: AgentTransport = {
    send: (bytes) =>
      Effect.sync(() => {
        const message = parseLine(bytes);
        sent.push(message);
        onSend(message, push);
      }),
    output: Stream.fromQueue(output),
    ...(onAcknowledge === undefined ? {} : { acknowledgeOutput: () => Effect.sync(onAcknowledge) }),
    close: () => Queue.shutdown(output),
  };
  return { transport, sent, push, end: Queue.shutdown(output) };
});

const codexTransport = makeTransport((message, push) => {
  const id = message["id"];
  const method = message["method"];
  if (typeof id !== "number") return;
  if (method === "initialize") push({ id, result: {} });
  if (method === "thread/start" || method === "thread/resume") {
    push({ id, result: { thread: { id: "thread-1" } } });
  }
  if (method === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
  if (method === "turn/interrupt") push({ id, result: {} });
});

const firstEvent = <T extends AgentEvent["_tag"]>(events: Stream.Stream<AgentEvent>, tag: T) =>
  events.pipe(
    Stream.filter(
      (event): event is Extract<AgentEvent, { readonly _tag: T }> => event._tag === tag,
    ),
    Stream.runHead,
  );

describe("NDJSON framing", () => {
  it("preserves split JSON lines and split UTF-8 code points", () => {
    const decoder = createNdjsonDecoder();
    const bytes = new TextEncoder().encode('{"text":"héllo"}\n{"n":2}\n');
    const split = bytes.indexOf(0xc3) + 1;
    expect(decoder.push(bytes.slice(0, split))).toEqual([]);
    expect(decoder.atLineBoundary()).toBe(false);
    expect(decoder.push(bytes.slice(split, bytes.length - 2))).toEqual(['{"text":"héllo"}']);
    expect(decoder.atLineBoundary()).toBe(false);
    expect(decoder.push(bytes.slice(bytes.length - 2))).toEqual(['{"n":2}']);
    expect(decoder.atLineBoundary()).toBe(true);
    expect(decoder.finish()).toEqual([]);
  });
});

describe("CodexAdapter", () => {
  it.effect("fails startup when the pipe dies during initialize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transport: AgentTransport = {
          send: () => Effect.void,
          output: Stream.empty,
          close: () => Effect.void,
        };
        const error = yield* CodexAdapter.start(transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(AgentProtocolError);
        expect(error.message).toContain("output ended");
      }),
    ),
  );

  it.effect("initializes, starts a thread, and starts a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          model: "gpt-test",
          effort: "high",
        });
        const providerTurnId = yield* session.sendTurn("inspect replay");
        expect(providerTurnId).toBe("turn-1");
        expect(fake.sent.map((message) => message["method"])).toEqual([
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
        ]);
        expect(fake.sent[2]?.["params"]).toEqual({
          cwd: "/workspace/repo",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        });
        expect(fake.sent[3]?.["params"]).toEqual({
          threadId: "thread-1",
          input: [{ type: "text", text: "inspect replay" }],
          model: "gpt-test",
          effort: "high",
        });
      }),
    ),
  );

  it.effect("holds an approval response until a person answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
        });
        yield* session.sendTurn("run it");
        const openedFiber = yield* firstEvent(session.events, "request.opened").pipe(
          Effect.forkChild,
        );
        fake.push({
          id: 42,
          method: "item/commandExecution/requestApproval",
          params: { turnId: "turn-1", itemId: "item-1", command: ["pnpm", "test"] },
        });
        const opened = yield* Fiber.join(openedFiber);
        expect(Option.getOrThrow(opened).request.providerRequestId).toBe("n:42");
        expect(fake.sent.some((message) => message["id"] === 42)).toBe(false);

        yield* session.respond("n:42", "accept-for-session");
        expect(fake.sent.find((message) => message["id"] === 42)).toEqual({
          id: 42,
          result: { decision: "acceptForSession" },
        });
      }),
    ),
  );

  it.effect("maps structured user input answers to Codex's native answer objects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
        });
        yield* session.sendTurn("ask me");
        const openedFiber = yield* firstEvent(session.events, "request.opened").pipe(
          Effect.forkChild,
        );
        fake.push({
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            turnId: "turn-1",
            itemId: "item-1",
            questions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which files?",
                options: [{ label: "All", description: "Every changed file" }],
              },
            ],
          },
        });
        yield* Fiber.join(openedFiber);
        yield* session.respondInput("s:input-1", { scope: ["All"] });
        expect(fake.sent.find((message) => message["id"] === "input-1")).toEqual({
          id: "input-1",
          result: { answers: { scope: { answers: ["All"] } } },
        });
      }),
    ),
  );

  it.effect("projects complete lines before acknowledging their output cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: string[] = [];
        const fake = yield* makeTransport(
          (message, push) => {
            const id = message["id"];
            const method = message["method"];
            if (typeof id !== "number") return;
            if (method === "initialize") push({ id, result: {} });
            if (method === "thread/start") {
              push({ id, result: { thread: { id: "thread-1" } } });
            }
            if (method === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
          },
          () => order.push("ack"),
        );
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: (event) =>
            Effect.sync(() => {
              if (event._tag === "item.updated") order.push("event");
            }),
        });
        yield* session.sendTurn("inspect");
        yield* Effect.yieldNow;
        order.length = 0;
        const itemFiber = yield* firstEvent(session.events, "item.updated").pipe(Effect.forkChild);
        fake.push({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { id: "item-1", type: "agentMessage", text: "hello" },
          },
        });
        yield* Fiber.join(itemFiber);
        yield* Effect.yieldNow;
        expect(order).toEqual(["event", "ack"]);
      }),
    ),
  );

  it.effect("turns malformed provider lines into warnings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
        });
        const warningFiber = yield* firstEvent(session.events, "runtime.warning").pipe(
          Effect.forkChild,
        );
        // A valid JSON scalar is still malformed for the object-only provider protocol.
        fake.push("not json");
        const warning = yield* Fiber.join(warningFiber);
        expect(Option.getOrThrow(warning).message).toContain("non-object");
      }),
    ),
  );
});

describe("ClaudeAdapter", () => {
  it.effect("sends user turns and answers permission control requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => undefined);
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          providerSessionId: "11111111-1111-4111-8111-111111111111",
          permissionMode: "ask",
        });
        const turnId = yield* session.sendTurn("edit the file");
        const openedFiber = yield* firstEvent(session.events, "request.opened").pipe(
          Effect.forkChild,
        );
        fake.push({
          type: "control_request",
          request_id: "permission-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Edit",
            input: { file_path: "/workspace/repo/a.ts" },
          },
        });
        const opened = yield* Fiber.join(openedFiber);
        expect(Option.getOrThrow(opened).request.providerTurnId).toBe(turnId);
        yield* session.respond("permission-1", "accept-for-session");
        expect(fake.sent.at(-1)).toEqual({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "permission-1",
            response: {
              behavior: "allow",
              updatedInput: { file_path: "/workspace/repo/a.ts" },
              updatedPermissions: [
                {
                  type: "addRules",
                  rules: [{ toolName: "Edit" }],
                  behavior: "allow",
                  destination: "session",
                },
              ],
            },
          },
        });
      }),
    ),
  );
});

const collectItems = () => {
  const items: Array<{ id: string; turn: string; text: string | null }> = [];
  const onEvent = (event: AgentEvent) =>
    Effect.sync(() => {
      if (event._tag === "item.updated") {
        items.push({
          id: event.item.providerItemId,
          turn: event.item.providerTurnId,
          text: event.item.text,
        });
      }
    });
  return { items, onEvent };
};

const claudeControlRequest = (requestId: string) => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "can_use_tool", tool_name: "Edit", input: {} },
});

describe("rehydrate (restart policy v2)", () => {
  const SESS = "22222222-2222-4222-8222-222222222222";

  /** One finished claude turn whose text block has no wire id — identity comes from fallback ids. */
  const claudeTurnWire = [
    {
      type: "stream_event",
      session_id: SESS,
      event: { type: "message_start", message: { id: "msg_1" } },
    },
    {
      type: "stream_event",
      session_id: SESS,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      session_id: SESS,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
    },
    {
      type: "stream_event",
      session_id: SESS,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    },
    { type: "stream_event", session_id: SESS, event: { type: "content_block_stop", index: 0 } },
    {
      type: "assistant",
      session_id: SESS,
      message: { id: "msg_1", content: [{ type: "text", text: "hello" }] },
    },
    { type: "result", subtype: "success", session_id: SESS },
  ];

  it.effect("claude replays a finished turn with the same item identity as the live run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Live run: the turn id is minted by sendTurn, the item ids fall back
        // to turn-scoped ordinals because the wire carries no block ids.
        const live = yield* makeTransport(() => undefined);
        const liveItems = collectItems();
        const liveSession = yield* ClaudeAdapter.start(live.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: liveItems.onEvent,
        });
        const turnId = yield* liveSession.sendTurn("go");
        for (const wire of claudeTurnWire) live.push(wire);
        yield* firstEvent(liveSession.events, "turn.completed");

        // Rehydrated run: same wire replayed from 0, the dispatched turn id
        // supplied from the durable record instead of a fresh mint.
        const replay = yield* makeTransport(() => undefined);
        const replayItems = collectItems();
        const replaySession = yield* ClaudeAdapter.start(replay.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: replayItems.onEvent,
          rehydrate: { replayProviderTurnIds: [turnId], resolvedProviderRequestIds: new Set() },
        });
        for (const wire of claudeTurnWire) replay.push(wire);
        const completed = yield* firstEvent(replaySession.events, "turn.completed");
        expect(Option.getOrThrow(completed).providerTurnId).toBe(turnId);
        expect(replayItems.items).toEqual(liveItems.items);
        // No user message re-sent: replay is read-only until a new turn arrives.
        expect(replay.sent).toEqual([]);
      }),
    ),
  );

  it.effect("claude skips control requests already resolved before the restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => undefined);
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "ask",
          rehydrate: {
            replayProviderTurnIds: ["turn-a"],
            resolvedProviderRequestIds: new Set(["perm-answered"]),
          },
        });
        const openedFiber = yield* firstEvent(session.events, "request.opened").pipe(
          Effect.forkChild,
        );
        fake.push(claudeControlRequest("perm-answered"));
        fake.push(claudeControlRequest("perm-open"));
        const opened = yield* Fiber.join(openedFiber);
        expect(Option.getOrThrow(opened).request.providerRequestId).toBe("perm-open");
        // Close answers only the genuinely-pending request, never the replayed one.
        yield* session.close();
        const answered = fake.sent.flatMap((message) => {
          const response = message["response"];
          return isObject(response) ? [response["request_id"]] : [];
        });
        expect(answered).toEqual(["perm-open"]);
      }),
    ),
  );

  /** A Codex whose `thread/resume` answers `error`, and whose `thread/start` would succeed. */
  const resumeFailingWith = (resumeError: { readonly code: number; readonly message: string }) =>
    Effect.gen(function* () {
      const fake = yield* makeTransport((message, push) => {
        const id = message["id"];
        const method = message["method"];
        if (typeof id !== "number") return;
        if (method === "initialize") push({ id, result: {} });
        if (method === "thread/resume") push({ id, error: resumeError });
        if (method === "thread/start") push({ id, result: { thread: { id: "thread-new" } } });
      });
      const error = yield* CodexAdapter.start(fake.transport, {
        cwd: "/workspace/repo",
        permissionMode: "bypass",
        providerSessionId: GONE_THREAD,
      }).pipe(Effect.flip);
      return { error, methods: fake.sent.map((message) => message["method"]) };
    });
  const GONE_THREAD = "0199b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b";

  it.effect("a resume whose thread Codex cannot find fails, and never starts a new thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Codex's own words (codex-rs 59f18e8): `thread/resume` by id when the rollout is gone
        // (`thread_store_resume_read_error`, -32600 invalid request), and its other thread routes.
        for (const message of [
          `no rollout found for thread id ${GONE_THREAD}`,
          `thread not found: ${GONE_THREAD}`,
        ]) {
          const { error, methods } = yield* resumeFailingWith({ code: -32600, message });
          expect(error).toBeInstanceOf(AgentProtocolError);
          expect(error.message).toBe(CODEX_THREAD_NOT_FOUND);
          expect(methods).toEqual(["initialize", "initialized", "thread/resume"]);
        }
      }),
    ),
  );

  it.effect(
    "resumes a conversation home's thread by the full path of its rollout, and asks for the experimental API",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* codexTransport;
          const path = `/run/mend/conv/s-1/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${GONE_THREAD}.jsonl`;
          yield* CodexAdapter.start(fake.transport, {
            cwd: "/workspace/repo",
            permissionMode: "bypass",
            providerSessionId: GONE_THREAD,
            providerSessionPath: path,
          });
          expect(fake.sent[0]?.["params"]).toEqual({
            clientInfo: { name: "mend", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          });
          expect(fake.sent[2]?.["method"]).toBe("thread/resume");
          expect(fake.sent[2]?.["params"]).toMatchObject({ threadId: GONE_THREAD, path });
        }),
      ),
  );

  it.effect("a resume that fails for another reason fails with Codex's own words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // None of these is a missing thread, whatever words they share with one.
        for (const message of [
          "rollout is corrupt",
          "unknown model: gpt-9",
          "unknown error",
          "failed to read thread: no such file or directory (os error 2)",
          `session ${GONE_THREAD} is archived. Run \`codex unarchive ${GONE_THREAD}\` to unarchive it first.`,
        ]) {
          const { error, methods } = yield* resumeFailingWith({ code: -32603, message });
          expect(error.message).toBe(message);
          expect(methods).not.toContain("thread/start");
        }
      }),
    ),
  );

  it.effect("codex rehydrates without a handshake and epoch-scopes new rpc ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport((message, push) => {
          const id = message["id"];
          // Only epoch-scoped string ids get answers — a numeric id would be
          // the previous Mend process's numbering.
          if (typeof id !== "string") return;
          if (message["method"] === "turn/start") push({ id, result: { turn: { id: "turn-9" } } });
        });
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          providerSessionId: "thread-1",
          rehydrate: { replayProviderTurnIds: [], resolvedProviderRequestIds: new Set() },
        });
        const ready = yield* firstEvent(session.events, "session.ready");
        expect(Option.getOrThrow(ready).providerSessionId).toBe("thread-1");
        // The peer never observed a disconnect: no initialize, no thread/resume.
        expect(fake.sent).toEqual([]);
        // A stale replayed response to the old process's id 0 resolves nothing.
        fake.push({ id: 0, result: { turn: { id: "stale" } } });
        const turnId = yield* session.sendTurn("continue");
        expect(turnId).toBe("turn-9");
        expect(fake.sent.map((message) => message["method"])).toEqual(["turn/start"]);
        expect(typeof fake.sent[0]?.["id"]).toBe("string");
      }),
    ),
  );

  it.effect("codex replay skips server requests already resolved before the restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => undefined);
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          providerSessionId: "thread-1",
          rehydrate: { replayProviderTurnIds: [], resolvedProviderRequestIds: new Set(["n:7"]) },
        });
        const openedFiber = yield* firstEvent(session.events, "request.opened").pipe(
          Effect.forkChild,
        );
        fake.push({
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { turnId: "turn-a", command: "ls" },
        });
        fake.push({
          id: 8,
          method: "item/commandExecution/requestApproval",
          params: { turnId: "turn-a", command: "rm -rf /" },
        });
        const opened = yield* Fiber.join(openedFiber);
        expect(Option.getOrThrow(opened).request.providerRequestId).toBe("n:8");
        // Close cancels only the genuinely-pending request.
        yield* session.close();
        const answeredIds = fake.sent.flatMap((message) =>
          "result" in message ? [message["id"]] : [],
        );
        expect(answeredIds).toEqual([8]);
      }),
    ),
  );
});

describe("regression: reviewer findings", () => {
  it.effect("claude keeps items distinct across assistant messages in one turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => {});
        const latest = new Map<string, { text: string | null; kind: string }>();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          providerSessionId: "11111111-2222-4333-8444-555566667777",
          onEvent: (event) =>
            Effect.sync(() => {
              if (event._tag === "item.updated") {
                latest.set(event.item.providerItemId, {
                  text: event.item.text,
                  kind: event.item.kind,
                });
              }
            }),
        });
        const turnId = yield* session.sendTurn("two steps");
        const push = (event: unknown) =>
          fake.push({
            type: "stream_event",
            session_id: "11111111-2222-4333-8444-555566667777",
            event,
          });
        // Assistant message #1: text block at index 0.
        push({ type: "message_start" });
        push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "one" } });
        push({ type: "content_block_stop", index: 0 });
        // Assistant message #2 reuses index 0. Its item must not overwrite message #1's.
        push({ type: "message_start" });
        push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
        push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "two" } });
        // Await the projection of the second message's delta before asserting.
        yield* session.events.pipe(
          Stream.filter((event) => event._tag === "item.updated" && event.item.text === "two"),
          Stream.runHead,
        );
        const texts = [...latest.entries()]
          .filter(([, item]) => item.kind === "assistant-message")
          .map(([id, item]) => ({ id, text: item.text }));
        expect(texts).toHaveLength(2);
        expect(texts.map((item) => item.text).toSorted()).toEqual(["one", "two"]);
        expect(new Set(texts.map((item) => item.id)).size).toBe(2);
        expect(texts.every((item) => item.id.startsWith(`${turnId}:m`))).toBe(true);
      }),
    ),
  );

  it.effect("claude does not duplicate a text block echoed by a per-block assistant event", () =>
    // Captured live 2026-08-28 (PoC session 59e473f4): with --include-partial-messages the
    // CLI streams a thinking block at index 0 and the text at index 1, then echoes EACH
    // completed block as its own `assistant` event whose content array holds just that one
    // block. Keying the echo by its position in that array (always 0) attributed the text
    // to the thinking block's id, leaving two identical assistant-message items.
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => {});
        const latest = new Map<string, { text: string | null; kind: string }>();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          providerSessionId: "11111111-2222-4333-8444-555566667777",
          onEvent: (event) =>
            Effect.sync(() => {
              if (event._tag === "item.updated") {
                latest.set(event.item.providerItemId, {
                  text: event.item.text,
                  kind: event.item.kind,
                });
              }
            }),
        });
        yield* session.sendTurn("ground this");
        const push = (event: unknown) =>
          fake.push({
            type: "stream_event",
            session_id: "11111111-2222-4333-8444-555566667777",
            parent_tool_use_id: null,
            event,
          });
        push({ type: "message_start", message: { id: "msg_01AB", content: [] } });
        push({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
        push({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "" },
        });
        fake.push({
          type: "assistant",
          session_id: "11111111-2222-4333-8444-555566667777",
          parent_tool_use_id: null,
          message: {
            id: "msg_01AB",
            role: "assistant",
            content: [{ type: "thinking", thinking: "" }],
          },
        });
        push({ type: "content_block_stop", index: 0 });
        push({ type: "content_block_start", index: 1, content_block: { type: "text" } });
        push({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Let me ground this." },
        });
        fake.push({
          type: "assistant",
          session_id: "11111111-2222-4333-8444-555566667777",
          parent_tool_use_id: null,
          message: {
            id: "msg_01AB",
            role: "assistant",
            content: [{ type: "text", text: "Let me ground this." }],
          },
        });
        push({ type: "content_block_stop", index: 1 });
        fake.push({
          type: "result",
          session_id: "11111111-2222-4333-8444-555566667777",
          subtype: "success",
        });
        yield* firstEvent(session.events, "turn.completed");
        const messages = [...latest.entries()].filter(
          ([, item]) => item.kind === "assistant-message",
        );
        expect(messages.map(([, item]) => item.text)).toEqual(["Let me ground this."]);
      }),
    ),
  );

  it.effect("codex refuses to answer a request it is not holding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
        });
        const error = yield* session.respond("n:99", "accept").pipe(Effect.flip);
        expect(error).toBeInstanceOf(AgentProtocolError);
        // No stray JSON-RPC response left for an id nothing is waiting on.
        expect(fake.sent.some((message) => message["id"] === 99)).toBe(false);
      }),
    ),
  );
});

/** The adapter has read every line pushed so far: its output fiber runs on its own. */
const drained = Effect.sleep("25 millis");

const kinds = (work: ReadonlyArray<{ readonly kind: string; readonly id: string }>) =>
  work.map((entry) => `${entry.kind}:${entry.id}`);

describe("quiescence (docs/adr/0016, decision 6)", () => {
  it.live("Claude: an open turn, then idle once it says so, with nothing in the background", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport(() => undefined);
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          providerSessionId: "11111111-1111-4111-8111-111111111111",
          permissionMode: "bypass",
        });
        expect((yield* session.quiescence()).quiescent).toBe(true);
        yield* session.sendTurn("go");
        fake.push({ type: "system", subtype: "session_state_changed", state: "running" });
        yield* drained;
        expect((yield* session.quiescence()).openTurn).toBe(true);
        fake.push({ type: "result", subtype: "success" });
        yield* drained;
        // The result is in, but Claude still says it runs: it may flush a held result, or go on
        // with a background agent's answer. Only its `idle` ends the turn for a new sender.
        const after = yield* session.quiescence();
        expect(after.openTurn).toBe(true);
        expect(after.quiescent).toBe(false);
        expect(after.settleMs).toBeGreaterThan(0);
        fake.push({ type: "system", subtype: "session_state_changed", state: "idle" });
        yield* drained;
        expect(yield* session.quiescence()).toEqual({
          quiescent: true,
          openTurn: false,
          work: [],
          settleMs: 0,
        });
      }),
    ),
  );

  it.live(
    "Claude: background tasks as a level, paused tasks, monitors, wakeups and session crons",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeTransport(() => undefined);
          const session = yield* ClaudeAdapter.start(fake.transport, {
            cwd: "/workspace/repo",
            providerSessionId: "11111111-1111-4111-8111-111111111111",
            permissionMode: "bypass",
          });
          const turn = yield* session.sendTurn("start the background work");
          fake.push({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              { task_id: "agent-1", task_type: "local_agent", description: "Agent A" },
              { task_id: "bash-1", task_type: "local_bash", description: "npm test" },
              {
                task_id: "watcher",
                task_type: "local_bash",
                description: "ambient",
                ambient: true,
              },
              {
                task_id: "monitor-1",
                task_type: "local_bash",
                description: "watch the build",
                ambient: true,
              },
            ],
          });
          // A Monitor's task, a wakeup and two crons, one durable (the worktree's, not the session's).
          fake.push({
            type: "assistant",
            message: {
              id: "m1",
              content: [
                {
                  type: "tool_use",
                  id: "tu-monitor",
                  name: "Monitor",
                  input: { description: "watch the build", timeout_ms: 60000 },
                },
                {
                  type: "tool_use",
                  id: "tu-wake",
                  name: "ScheduleWakeup",
                  input: { delaySeconds: 600 },
                },
                {
                  type: "tool_use",
                  id: "tu-cron",
                  name: "CronCreate",
                  input: { cron: "*/5 * * * *", prompt: "check" },
                },
                {
                  type: "tool_use",
                  id: "tu-durable",
                  name: "CronCreate",
                  input: { cron: "0 9 * * *", prompt: "standup", durable: true },
                },
              ],
            },
          });
          const result = (id: string, output: unknown) =>
            fake.push({
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
              },
              tool_use_result: output,
            });
          result("tu-monitor", { taskId: "monitor-1", timeoutMs: 60000, persistent: false });
          result("tu-wake", {
            scheduledFor: Date.now() + 600_000,
            clampedDelaySeconds: 600,
            wasClamped: false,
          });
          result("tu-cron", { id: "cron-1", humanSchedule: "every 5 minutes", recurring: true });
          result("tu-durable", {
            id: "cron-2",
            humanSchedule: "daily",
            recurring: true,
            durable: true,
          });
          fake.push({
            type: "system",
            subtype: "task_updated",
            task_id: "bash-2",
            patch: { status: "paused" },
          });
          fake.push({ type: "result", subtype: "success" });
          fake.push({ type: "system", subtype: "session_state_changed", state: "idle" });
          yield* drained;
          const busy = yield* session.quiescence();
          expect(busy.quiescent).toBe(false);
          expect(kinds(busy.work).toSorted()).toEqual([
            "cron:cron-1",
            "monitor:monitor-1",
            "paused-task:bash-2",
            "sub-agent:agent-1",
            "task:bash-1",
            "wakeup:tu-wake",
          ]);
          expect(
            busy.work
              .filter((entry) => entry.endable)
              .map((entry) => entry.id)
              .toSorted(),
          ).toEqual(["agent-1", "bash-1", "bash-2", "monitor-1"]);
          // A task stopped from the waiting line: Claude's stop_task.
          yield* session.endWork({ kind: "task", id: "bash-1" });
          expect(fake.sent.at(-1)).toMatchObject({
            type: "control_request",
            request: { subtype: "stop_task", task_id: "bash-1" },
          });
          // A monitor is a task: stop_task ends it, a persistent one included (review of
          // mend#572, P3-2).
          yield* session.endWork({ kind: "monitor", id: "monitor-1" });
          expect(fake.sent.at(-1)).toMatchObject({
            type: "control_request",
            request: { subtype: "stop_task", task_id: "monitor-1" },
          });
          // What ends on its own, or is waited for with a bound, is not Mend's to stop.
          const refused = yield* session.endWork({ kind: "cron", id: "cron-1" }).pipe(Effect.flip);
          expect(refused.message).toContain("Claude ends a cron on its own");
          // A task first reported outside any turn sits on the last turn the conversation ran.
          const reported = yield* firstEvent(session.events, "item.updated").pipe(Effect.forkChild);
          fake.push({
            type: "system",
            subtype: "task_started",
            task_id: "late-1",
            task_type: "local_bash",
            description: "late",
          });
          expect(Option.getOrThrow(yield* Fiber.join(reported)).item.providerTurnId).toBe(turn);
          // Everything ends: the level empties, the monitor and the paused task report their end, the
          // cron is deleted, and the wakeup fires as a turn of Claude's own.
          fake.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
          fake.push({
            type: "system",
            subtype: "task_notification",
            task_id: "monitor-1",
            status: "completed",
          });
          fake.push({
            type: "system",
            subtype: "task_updated",
            task_id: "bash-2",
            patch: { status: "completed" },
          });
          fake.push({
            type: "assistant",
            message: {
              id: "m2",
              content: [
                { type: "tool_use", id: "tu-del", name: "CronDelete", input: { id: "cron-1" } },
              ],
            },
          });
          result("tu-del", { id: "cron-1" });
          yield* drained;
          expect(kinds((yield* session.quiescence()).work)).toEqual(["wakeup:tu-wake"]);
        }),
      ),
  );

  it.effect(
    "Claude rehydrated for a person's process asks again for its live background tasks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeTransport(() => undefined);
          yield* ClaudeAdapter.start(fake.transport, {
            cwd: "/workspace/repo",
            providerSessionId: "11111111-1111-4111-8111-111111111111",
            permissionMode: "bypass",
            steering: true,
            rehydrate: { replayProviderTurnIds: [], resolvedProviderRequestIds: new Set() },
          });
          // A repeated `initialize` is answered with the current set; nothing else is sent.
          expect(fake.sent).toEqual([
            {
              type: "control_request",
              request_id: expect.any(String),
              request: { subtype: "initialize" },
            },
          ]);
        }),
      ),
  );

  it.live(
    "Codex: sub-agent threads, background terminals, an active goal, and the 1 s settle",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const state = {
            terminals: [{ processId: "42", command: "npm run dev", itemId: "i", cwd: "/" }],
            goal: "active" as string | null,
          };
          const fake = yield* makeTransport((message, push) => {
            const id = message["id"];
            const method = message["method"];
            if (typeof id !== "number") return;
            if (method === "initialize") push({ id, result: {} });
            if (method === "thread/start") push({ id, result: { thread: { id: "thread-1" } } });
            if (method === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
            if (method === "thread/backgroundTerminals/list")
              push({ id, result: { data: state.terminals, nextCursor: null } });
            if (method === "thread/backgroundTerminals/terminate") {
              state.terminals = [];
              push({ id, result: { terminated: true } });
            }
            if (method === "thread/goal/get") {
              push({
                id,
                result: {
                  goal:
                    state.goal === null
                      ? null
                      : { threadId: "thread-1", objective: "ship it", status: state.goal },
                },
              });
            }
            if (method === "thread/goal/clear") {
              state.goal = null;
              push({ id, result: {} });
            }
          });
          const session = yield* CodexAdapter.start(fake.transport, {
            cwd: "/workspace/repo",
            permissionMode: "bypass",
            steering: true,
          });
          fake.push({
            method: "turn/started",
            params: { threadId: "child-1", turn: { id: "child-turn" } },
          });
          yield* drained;
          const busy = yield* session.quiescence();
          expect(kinds(busy.work)).toEqual(["sub-agent:child-1", "terminal:42", "goal:thread-1"]);
          yield* session.endWork({ kind: "terminal", id: "42" });
          yield* session.endWork({ kind: "goal", id: "thread-1" });
          expect(fake.sent.map((message) => message["method"])).toContain(
            "thread/backgroundTerminals/terminate",
          );
          expect(
            fake.sent.find((message) => message["method"] === "thread/goal/clear")?.["params"],
          ).toEqual({
            threadId: "thread-1",
            origin: "user",
          });
          // The child's turn ends: settled only 1 s later.
          fake.push({
            method: "turn/completed",
            params: { threadId: "child-1", turn: { id: "child-turn", status: "completed" } },
          });
          yield* drained;
          const settling = yield* session.quiescence();
          expect(settling.work).toEqual([]);
          expect(settling.quiescent).toBe(false);
          expect(settling.settleMs).toBeGreaterThan(500);
          yield* Effect.sleep("1 second");
          expect((yield* session.quiescence()).quiescent).toBe(true);
        }),
      ),
  );

  it.live('Codex: a method it refuses is "cannot tell", never "no work"', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport((message, push) => {
          const id = message["id"];
          const method = message["method"];
          if (typeof id !== "number") return;
          if (method === "initialize") push({ id, result: {} });
          if (method === "thread/start") push({ id, result: { thread: { id: "thread-1" } } });
          if (method === "thread/backgroundTerminals/list" || method === "thread/goal/get") {
            push({ id, error: { code: -32601, message: `Method not found: ${method}` } });
          }
        });
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          steering: true,
        });
        yield* drained;
        // An older Codex that refuses both: running terminals would read as none, and the
        // staging would kill them after 10 s (review of mend#572, P3-3). It is waited for.
        const looked = yield* session.quiescence();
        expect(looked.quiescent).toBe(false);
        expect(kinds(looked.work)).toEqual([
          "unknown:thread/backgroundTerminals/list",
          "unknown:thread/goal/get",
        ]);
        expect(looked.work.every((work) => !work.endable)).toBe(true);
      }),
    ),
  );

  it.live("Codex: a turn it starts on its own is the harness's, never a turn Mend sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* codexTransport;
        const events: Array<AgentEvent> = [];
        yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: (event) => Effect.sync(() => events.push(event)),
        });
        fake.push({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "goal-turn" } },
        });
        yield* drained;
        expect(events.filter((event) => event._tag === "harness-turn.started")).toEqual([
          {
            _tag: "harness-turn.started",
            providerTurnId: "goal-turn",
            reason: "Codex started a turn on its own",
          },
        ]);
      }),
    ),
  );
});
