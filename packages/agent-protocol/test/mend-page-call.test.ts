import { describe, expect, it } from "@effect/vitest";
import { isShownAsPage, mendPageCallOf } from "@mend/agent-conversation";
import type { AgentEvent, AgentEventItem } from "@mend/domain/workbench";
import { Effect, Queue, Stream } from "effect";

import {
  type AgentTransport,
  ClaudeAdapter,
  CodexAdapter,
  compactMendPageCall,
  isMendPageTool,
  mendPageReferenceIn,
} from "../src/index.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const HTML = `<!doctype html><style>.bar{height:24px}</style><div class=bar>${"p99 ".repeat(2_000)}</div>`;
const PAGE_ID = "8b3f6a0e-2b7c-4c1e-9d55-3f1e0c2a7b91";
const REFUSAL = {
  _tag: "MendMcpFailure",
  code: "invalid_request",
  message: "The page sets a height in vh units; give charts fixed pixel heights.",
};
const RESULT = {
  htmlRender: { attachmentId: PAGE_ID, title: "Latency", height: 420 },
  message: "ok",
};

const fakeTransport = Effect.fn("test.fakeTransport")(function* (
  answer: (message: JsonObject, push: (value: unknown) => void) => void,
) {
  const output = yield* Queue.unbounded<Uint8Array>();
  const acknowledged = yield* Queue.unbounded<number>();
  let pushed = 0;
  let projected = 0;
  const push = (value: unknown) => {
    pushed += 1;
    Queue.offerUnsafe(output, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  };
  const transport: AgentTransport = {
    send: (bytes) =>
      Effect.sync(() => {
        const message: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (isObject(message)) answer(message, push);
      }),
    output: Stream.fromQueue(output),
    acknowledgeOutput: () =>
      Effect.sync(() => {
        projected += 1;
        Queue.offerUnsafe(acknowledged, projected);
      }),
    close: () => Queue.shutdown(output),
  };
  const drain = Effect.gen(function* () {
    let observed = projected;
    while (observed < pushed) observed = yield* Queue.take(acknowledged);
  });
  return { transport, push, drain };
});

const recorded = () => {
  const items: Array<AgentEventItem> = [];
  const onEvent = (event: AgentEvent) =>
    Effect.sync(() => {
      if (event._tag === "item.updated") items.push(event.item);
    });
  return { items, onEvent };
};

const asDto = (item: AgentEventItem) => ({
  id: item.providerItemId,
  seq: 1,
  turnId: "turn",
  kind: item.kind,
  status: item.status,
  title: item.title,
  text: item.text,
  data: JSON.parse(JSON.stringify(item.data)),
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
});

describe("a call to Mend's html_render as the harness records it", () => {
  it.effect("Claude: the tool_use keeps its identity, never the HTML, and learns its page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(() => undefined);
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("chart it");
        const block = {
          type: "tool_use",
          id: "toolu_page",
          name: "mcp__mend__html_render",
          input: { html: HTML, title: "Latency", height: 420 },
        };
        fake.push({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_1" } },
        });
        fake.push({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { ...block, input: {} },
          },
        });
        fake.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
        fake.push({ type: "assistant", message: { id: "msg_1", content: [block] } });
        fake.push({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_page",
                content: [{ type: "text", text: JSON.stringify(RESULT) }],
              },
            ],
          },
        });
        yield* fake.drain;
        const updates = seen.items.filter((item) => item.providerItemId === "toolu_page");
        expect(updates.length).toBeGreaterThanOrEqual(3);
        for (const update of updates) {
          expect(JSON.stringify(update)).not.toContain("p99");
          expect(mendPageCallOf(asDto(update))).not.toBeNull();
        }
        const last = updates.at(-1);
        expect(last).toMatchObject({
          kind: "tool-call",
          status: "completed",
          title: "mcp__mend__html_render",
          data: {
            type: "tool_use",
            id: "toolu_page",
            name: "mcp__mend__html_render",
            input: { title: "Latency", height: 420 },
            mendPageCall: { attachmentId: PAGE_ID, failure: null },
          },
        });
        expect(last === undefined ? null : mendPageCallOf(asDto(last))).toEqual({
          attachmentId: PAGE_ID,
          failure: null,
        });
        expect(last !== undefined && isShownAsPage(asDto(last))).toBe(true);
      }),
    ),
  );

  it.effect("Claude: a call the tool refused is failed, keeps the refusal, and stays shown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(() => undefined);
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("chart it");
        const block = {
          type: "tool_use",
          id: "toolu_refused",
          name: "mcp__mend__html_render",
          input: { html: HTML, title: "Tall", height: 420 },
        };
        fake.push({ type: "assistant", message: { id: "msg_2", content: [block] } });
        fake.push({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_refused",
                is_error: true,
                content: [{ type: "text", text: JSON.stringify(REFUSAL) }],
              },
            ],
          },
        });
        yield* fake.drain;
        const last = seen.items.filter((item) => item.providerItemId === "toolu_refused").at(-1);
        expect(last?.status).toBe("failed");
        expect(last === undefined ? null : mendPageCallOf(asDto(last))).toEqual({
          attachmentId: null,
          failure: { code: "invalid_request", message: REFUSAL.message },
        });
        expect(last !== undefined && isShownAsPage(asDto(last))).toBe(false);
      }),
    ),
  );

  it.effect("Codex: the mcpToolCall keeps its identity, and its page from the result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport((message, push) => {
          const id = message["id"];
          if (typeof id !== "number") return;
          if (message["method"] === "initialize") push({ id, result: {} });
          if (message["method"] === "thread/start") push({ id, result: { thread: { id: "t" } } });
          if (message["method"] === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
        });
        const seen = recorded();
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("chart it");
        const call = {
          type: "mcpToolCall",
          id: "call_page",
          server: "mend",
          tool: "html_render",
          arguments: { html: HTML, title: "Latency", height: 420 },
          error: null,
          durationMs: null,
        };
        fake.push({
          method: "item/started",
          params: { turnId: "turn-1", item: { ...call, status: "inProgress", result: null } },
        });
        fake.push({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              ...call,
              status: "completed",
              durationMs: 31,
              result: {
                content: [{ type: "text", text: JSON.stringify(RESULT) }],
                structuredContent: RESULT,
              },
            },
          },
        });
        yield* fake.drain;
        const updates = seen.items.filter((item) => item.providerItemId === "call_page");
        expect(updates).toHaveLength(2);
        for (const update of updates) {
          expect(JSON.stringify(update)).not.toContain("p99");
          expect(JSON.stringify(update)).not.toContain('"message"');
        }
        expect(updates.map((update) => isShownAsPage(asDto(update)))).toEqual([false, true]);
        expect(updates[1]).toMatchObject({
          kind: "tool-call",
          status: "completed",
          data: {
            type: "mcpToolCall",
            server: "mend",
            tool: "html_render",
            status: "completed",
            durationMs: 31,
            arguments: { title: "Latency", height: 420 },
            mendPageCall: { attachmentId: PAGE_ID, failure: null },
          },
        });
      }),
    ),
  );

  it.effect(
    "Claude, asking: the approval shows no HTML, and the answer sends the whole input",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sent: Array<JsonObject> = [];
          const fake = yield* fakeTransport((message) => sent.push(message));
          const opened: Array<AgentEvent> = [];
          const session = yield* ClaudeAdapter.start(fake.transport, {
            cwd: "/workspace/repo",
            permissionMode: "ask",
            onEvent: (event) =>
              Effect.sync(() => {
                if (event._tag === "request.opened") opened.push(event);
              }),
          });
          yield* session.sendTurn("chart it");
          const input = { tool_use_id: "toolu_page", html: HTML, title: "Latency", height: 420 };
          fake.push({
            type: "control_request",
            request_id: "permission-page",
            request: { subtype: "can_use_tool", tool_name: "mcp__mend__html_render", input },
          });
          yield* fake.drain;
          expect(JSON.stringify(opened)).not.toContain("p99");
          expect(opened).toMatchObject([
            {
              request: {
                providerItemId: "toolu_page",
                title: "mcp__mend__html_render",
                detail: {
                  toolName: "mcp__mend__html_render",
                  input: { tool_use_id: "toolu_page", title: "Latency", height: 420 },
                },
              },
            },
          ]);
          yield* session.respond("permission-page", "accept");
          expect(sent.at(-1)).toEqual({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: "permission-page",
              response: { behavior: "allow", updatedInput: input },
            },
          });
        }),
      ),
  );

  it.effect("Codex: a call the server refused is failed, as the app-server reports it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport((message, push) => {
          const id = message["id"];
          if (typeof id !== "number") return;
          if (message["method"] === "initialize") push({ id, result: {} });
          if (message["method"] === "thread/start") push({ id, result: { thread: { id: "t" } } });
          if (message["method"] === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
        });
        const seen = recorded();
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("chart it");
        const call = {
          type: "mcpToolCall",
          server: "mend",
          tool: "html_render",
          arguments: { html: HTML, title: "Tall", height: 420 },
          durationMs: 12,
        };
        // codex-rs `notify_mcp_tool_call_completed`: a result with `isError` is `failed`, with the
        // result and no error, and the app-server's result does not keep `isError`.
        fake.push({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              ...call,
              id: "call_refused",
              status: "failed",
              error: null,
              result: {
                content: [{ type: "text", text: JSON.stringify(REFUSAL) }],
                structuredContent: null,
                _meta: null,
              },
            },
          },
        });
        fake.push({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              ...call,
              id: "call_unreached",
              status: "failed",
              error: { message: "tool call timed out after 60s" },
              result: null,
            },
          },
        });
        yield* fake.drain;
        const refused = seen.items.find((item) => item.providerItemId === "call_refused");
        const unreached = seen.items.find((item) => item.providerItemId === "call_unreached");
        expect(JSON.stringify(seen.items)).not.toContain("p99");
        expect(refused?.status).toBe("failed");
        expect(refused === undefined ? null : mendPageCallOf(asDto(refused))).toEqual({
          attachmentId: null,
          failure: { code: "invalid_request", message: REFUSAL.message },
        });
        expect(unreached?.status).toBe("failed");
        expect(unreached === undefined ? null : mendPageCallOf(asDto(unreached))).toEqual({
          attachmentId: null,
          failure: { code: null, message: "tool call timed out after 60s" },
        });
        for (const item of [refused, unreached]) {
          expect(item !== undefined && isShownAsPage(asDto(item))).toBe(false);
        }
      }),
    ),
  );

  it("knows a call after Mend's own conversion to the other harness, and strips its HTML", () => {
    const args = JSON.stringify({ html: HTML, title: "Latency", height: 420 });
    const converted: ReadonlyArray<AgentEventItem> = [
      {
        providerItemId: "call_mend000001",
        providerTurnId: "turn",
        kind: "tool-call",
        status: "completed",
        title: "imported_mcp__mend__html_render",
        text: null,
        data: {
          type: "function_call",
          name: "imported_mcp__mend__html_render",
          arguments: args,
          call_id: "call_mend000001",
        },
      },
      {
        providerItemId: "toolu_mend_2",
        providerTurnId: "turn",
        kind: "tool-call",
        status: "completed",
        title: "mcp__mend__html_render",
        text: null,
        data: {
          type: "tool_use",
          id: "toolu_mend_2",
          name: "mcp__mend__html_render",
          input: { "$mend.toolInput": { format: "json", value: ` ${args}` } },
        },
      },
    ];
    for (const item of converted) {
      const compact = compactMendPageCall(item);
      expect(JSON.stringify(compact)).not.toContain("p99");
      expect(JSON.stringify(compact)).toContain("Latency");
      expect(mendPageCallOf(asDto(compact))).toEqual({ attachmentId: null, failure: null });
    }
    expect(
      [
        { name: "mcp__mend__html_render", namespace: null },
        { name: "html_render", namespace: "mcp__mend__" },
        { name: "html_render", namespace: "mend" },
        { name: "imported_mcp__mend__html_render", namespace: null },
      ].map(isMendPageTool),
    ).toEqual([true, true, true, true]);
    expect(
      [
        { name: "html_render", namespace: null },
        { name: "imported_html_render", namespace: null },
        { name: "html_render", namespace: "mcp__figma__" },
        { name: "mcp__t3-code__html_render", namespace: null },
        { name: "imported_mcp__figma__html_render", namespace: null },
        { name: "html_render_v2", namespace: null },
      ].map(isMendPageTool),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("leaves every other tool call as the harness wrote it", () => {
    const others: ReadonlyArray<AgentEventItem> = [
      {
        providerItemId: "toolu_other",
        providerTurnId: "turn",
        kind: "tool-call",
        status: "completed",
        title: "mcp__t3-code__html_render",
        text: null,
        data: { type: "tool_use", name: "mcp__t3-code__html_render", input: { html: HTML } },
      },
      {
        providerItemId: "call_other",
        providerTurnId: "turn",
        kind: "tool-call",
        status: "completed",
        title: null,
        text: null,
        data: {
          type: "mcpToolCall",
          server: "figma",
          tool: "html_render",
          arguments: { html: HTML },
        },
      },
      {
        providerItemId: "msg",
        providerTurnId: "turn",
        kind: "assistant-message",
        status: "completed",
        title: null,
        text: "mcp__mend__html_render",
        data: { type: "text", name: "mcp__mend__html_render" },
      },
    ];
    for (const item of others) {
      expect(compactMendPageCall(item)).toBe(item);
      expect(mendPageCallOf(asDto(item))).toBeNull();
    }
  });

  it("reads the page id from every shape a result takes, and nothing from a failure", () => {
    const text = JSON.stringify(RESULT);
    expect(mendPageReferenceIn(text)).toBe(PAGE_ID);
    expect(mendPageReferenceIn([{ type: "text", text }])).toBe(PAGE_ID);
    expect(mendPageReferenceIn({ content: [{ type: "text", text }] })).toBe(PAGE_ID);
    expect(mendPageReferenceIn({ structuredContent: RESULT })).toBe(PAGE_ID);
    const timing = "Wall time: 0.0213 seconds\nOutput:";
    expect(mendPageReferenceIn(`${timing}\n${text}`)).toBe(PAGE_ID);
    expect(
      mendPageReferenceIn(
        JSON.stringify([
          { type: "input_text", text: timing },
          { type: "input_text", text },
        ]),
      ),
    ).toBe(PAGE_ID);
    expect(mendPageReferenceIn(JSON.stringify({ content: [{ type: "text", text }] }))).toBe(
      PAGE_ID,
    );
    expect(mendPageReferenceIn(JSON.stringify({ structuredContent: RESULT }))).toBe(PAGE_ID);
    expect(mendPageReferenceIn(`${timing}\n${JSON.stringify({ content: [{ text }] })}`)).toBe(
      PAGE_ID,
    );
    expect(mendPageReferenceIn(timing)).toBeNull();
    expect(mendPageReferenceIn('{"_tag":"MendMcpFailure"}')).toBeNull();
    expect(mendPageReferenceIn("not json")).toBeNull();
  });
});
