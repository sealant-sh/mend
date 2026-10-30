import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, AgentEventItem } from "@mend/domain/workbench";
import { Effect, Queue, Stream } from "effect";

import {
  type AgentTransport,
  ClaudeAdapter,
  CodexAdapter,
  compactMendScreenCall,
  MEND_SCREEN_CALL_FIELD,
} from "../src/index.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TYPED = "correct horse battery staple";
const PNG_BASE64 = `iVBORw0KGgo${"QUJD".repeat(64)}`;
const RECEIPT = { screenId: "screen-1", seq: 4, callKey: "key-4" };
const ANSWERED = {
  screen: { display: ":12", size: "1280x800", input: "agent" },
  receipt: RECEIPT,
  frameId: "frame-4",
  outcome: "applied",
  actions: [
    { action: "click 10,20 left", result: "done" },
    { action: `type ${TYPED.length} characters`, result: "done" },
  ],
  sinceLastLook: [],
  message: "The image is the screen once it went quiet.",
};
const HELD = {
  screen: { display: ":12", size: "1280x800", input: { person: "Bea", since: null } },
  receipt: null,
  frameId: null,
  outcome: "refused",
  refusal: "held",
  message: "Bea holds the screen's input. Mend sent no input; look again once they hand it back.",
};
const ACTIONS = [
  { kind: "click", at: { x: 10, y: 20 } },
  { kind: "type", text: TYPED },
];
const STORED_ACTIONS = [
  { kind: "click", at: { x: 10, y: 20 } },
  { kind: "type", length: TYPED.length },
];

/** Neither the frame nor the typed text, anywhere in what the adapter published. */
const expectNoPayload = (published: unknown) => {
  const text = JSON.stringify(published);
  expect(text).not.toContain(TYPED);
  expect(text).not.toContain(PNG_BASE64.slice(0, 24));
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
  const events: Array<AgentEvent> = [];
  const onEvent = (event: AgentEvent) => Effect.sync(() => void events.push(event));
  const items = () =>
    events.flatMap((event) => (event._tag === "item.updated" ? [event.item] : []));
  return { events, items, onEvent };
};

const codexServer = (message: JsonObject, push: (value: unknown) => void) => {
  const id = message["id"];
  if (typeof id !== "number") return;
  if (message["method"] === "initialize") push({ id, result: {} });
  if (message["method"] === "thread/start") push({ id, result: { thread: { id: "t" } } });
  if (message["method"] === "turn/start") push({ id, result: { turn: { id: "turn-1" } } });
};

const claudeResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }],
  },
});

/** A call after Mend's own conversion, its arguments inside Mend's tool input envelope. */
const enveloped = (value: string): AgentEventItem => ({
  providerItemId: "toolu_converted",
  providerTurnId: "turn",
  kind: "tool-call",
  status: "completed",
  title: "imported_mcp__mend__screen_act",
  text: null,
  data: {
    type: "tool_use",
    name: "imported_mcp__mend__screen_act",
    input: { "$mend.toolInput": { format: "json", value } },
  },
});

describe("a call to Mend's screen tools as the harness records it", () => {
  it.effect("Claude: the tool_use keeps typed text by its length, and its receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(() => undefined);
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        const act = {
          type: "tool_use",
          id: "toolu_act",
          name: "mcp__mend__screen_act",
          input: { actions: ACTIONS },
        };
        const held = { ...act, id: "toolu_held" };
        fake.push({
          type: "stream_event",
          event: { type: "message_start", message: { id: "m1" } },
        });
        fake.push({
          type: "stream_event",
          event: { type: "content_block_start", index: 0, content_block: { ...act, input: {} } },
        });
        fake.push({ type: "assistant", message: { id: "m1", content: [act] } });
        fake.push(
          claudeResult("toolu_act", [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
            },
            { type: "text", text: JSON.stringify(ANSWERED) },
          ]),
        );
        fake.push({ type: "assistant", message: { id: "m2", content: [held] } });
        fake.push(claudeResult("toolu_held", [{ type: "text", text: JSON.stringify(HELD) }], true));
        yield* fake.drain;
        expectNoPayload(seen.events);
        const last = (id: string) => seen.items().findLast((item) => item.providerItemId === id);
        expect(last("toolu_act")).toMatchObject({
          kind: "tool-call",
          status: "completed",
          text: null,
          data: {
            name: "mcp__mend__screen_act",
            input: { actions: STORED_ACTIONS },
            [MEND_SCREEN_CALL_FIELD]: { receipt: RECEIPT, outcome: "applied", refusal: null },
          },
        });
        expect(last("toolu_held")).toMatchObject({
          status: "failed",
          data: {
            [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "refused", refusal: "held" },
          },
        });
      }),
    ),
  );

  it.effect("Codex: the mcpToolCall keeps no result, no error and no typed text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(codexServer);
        const seen = recorded();
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        const call = {
          type: "mcpToolCall",
          server: "mend",
          tool: "screen_act",
          arguments: { actions: ACTIONS },
          durationMs: null,
        };
        fake.push({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { ...call, id: "call_act", status: "inProgress", result: null, error: null },
          },
        });
        fake.push({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              ...call,
              id: "call_act",
              status: "completed",
              durationMs: 900,
              error: null,
              result: {
                content: [
                  { type: "image", data: PNG_BASE64, mimeType: "image/png" },
                  { type: "text", text: JSON.stringify(ANSWERED) },
                ],
                structuredContent: null,
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
              id: "call_held",
              status: "failed",
              error: null,
              result: {
                content: [{ type: "text", text: JSON.stringify(HELD) }],
                structuredContent: HELD,
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
              error: { message: `MCP error -32602: got {"kind":"typ","text":"${TYPED}"}` },
              result: null,
            },
          },
        });
        yield* fake.drain;
        expectNoPayload(seen.events);
        const updates = (id: string) => seen.items().filter((item) => item.providerItemId === id);
        expect(updates("call_act").map((item) => item.data)).toEqual([
          {
            type: "mcpToolCall",
            id: "call_act",
            server: "mend",
            tool: "screen_act",
            status: "inProgress",
            arguments: { actions: STORED_ACTIONS },
            durationMs: null,
          },
          {
            type: "mcpToolCall",
            id: "call_act",
            server: "mend",
            tool: "screen_act",
            status: "completed",
            arguments: { actions: STORED_ACTIONS },
            durationMs: 900,
            [MEND_SCREEN_CALL_FIELD]: { receipt: RECEIPT, outcome: "applied", refusal: null },
          },
        ]);
        expect(updates("call_held").at(-1)?.data).toMatchObject({
          [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "refused", refusal: "held" },
        });
        expect(updates("call_unreached").at(-1)).toMatchObject({
          status: "failed",
          data: {
            [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "outcome_unknown", refusal: null },
          },
        });
      }),
    ),
  );

  it.effect("Claude, asking: the approval shows no typed text, and the answer sends it all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: Array<JsonObject> = [];
        const fake = yield* fakeTransport((message) => sent.push(message));
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        const input = { tool_use_id: "toolu_act", actions: ACTIONS };
        fake.push({
          type: "control_request",
          request_id: "permission-act",
          request: { subtype: "can_use_tool", tool_name: "mcp__mend__screen_act", input },
        });
        yield* fake.drain;
        expectNoPayload(seen.events);
        expect(seen.events.filter((event) => event._tag === "request.opened")).toMatchObject([
          {
            request: {
              title: "mcp__mend__screen_act",
              detail: { input: { tool_use_id: "toolu_act", actions: STORED_ACTIONS } },
            },
          },
        ]);
        yield* session.respond("permission-act", "accept");
        expect(sent.at(-1)).toMatchObject({
          response: { response: { behavior: "allow", updatedInput: input } },
        });
      }),
    ),
  );

  it("leaves every other tool's call as it was", () => {
    const item: AgentEventItem = {
      providerItemId: "toolu_other",
      providerTurnId: "turn",
      kind: "tool-call",
      status: "completed",
      title: "mcp__other__screen_act",
      text: null,
      data: {
        type: "tool_use",
        name: "mcp__other__screen_act",
        input: { actions: ACTIONS },
        result: { content: [{ type: "image", data: PNG_BASE64 }] },
      },
    };
    expect(compactMendScreenCall(item)).toBe(item);
  });

  it("strips typed text inside Mend's tool input envelope, and drops one it cannot read", () => {
    const read = compactMendScreenCall(enveloped(JSON.stringify({ actions: ACTIONS })));
    expect(read.data).toEqual({
      type: "tool_use",
      name: "imported_mcp__mend__screen_act",
      input: {
        "$mend.toolInput": { format: "json", value: JSON.stringify({ actions: STORED_ACTIONS }) },
      },
    });
    const cut = compactMendScreenCall(enveloped(`{"actions":[{"kind":"type","text":"${TYPED}`));
    expect(cut.data).toMatchObject({ input: { "$mend.toolInput": { value: "{}" } } });
    expectNoPayload([read, cut]);
  });
});

const TYPED_NUMBER = 271828182845;

/** The shapes an agent can give `screen_act`, valid or not; none may keep its typed text. */
const ARGUMENT_SHAPES: ReadonlyArray<readonly [string, unknown]> = [
  ["a valid batch", { actions: [{ kind: "type", text: TYPED }] }],
  [
    "a batch over the limits",
    {
      actions: Array.from({ length: 21 }, () => ({
        kind: "type",
        text: `${TYPED}${"x".repeat(2001)}`,
      })),
    },
  ],
  ["an unknown kind", { actions: [{ kind: "typo", text: TYPED }] }],
  ["an action in an array", { actions: [[{ kind: "type", text: TYPED }]] }],
  ["arrays of arrays", { actions: [[[[{ kind: "type", text: TYPED }]], [{ text: TYPED }]]] }],
  ["text in a nested object", { actions: [{ kind: "type", payload: { text: TYPED } }] }],
  ["text at odd depths", { text: TYPED, a: [{ b: { text: TYPED, c: [[{ text: TYPED }]] } }] }],
  ["a root array", [{ kind: "type", text: TYPED }]],
  ["a number as text", { actions: [{ kind: "type", text: TYPED_NUMBER }] }],
  ["an object as text", { actions: [{ kind: "type", text: { value: TYPED } }] }],
  ["an array as text", { actions: [{ kind: "type", text: [TYPED] }] }],
  ["actions encoded as a string", { actions: JSON.stringify([{ kind: "type", text: TYPED }]) }],
  ["arguments as a JSON string", JSON.stringify({ actions: [[{ kind: "type", text: TYPED }]] })],
  ["an unparseable string", `{"actions":[{"kind":"type","text":"${TYPED}`],
  ["a JSON string of text", JSON.stringify(TYPED)],
  [
    "Mend's envelope around a nested batch",
    {
      "$mend.toolInput": {
        format: "json",
        value: JSON.stringify({ actions: [[{ kind: "type", text: TYPED }]] }),
      },
    },
  ],
  [
    "Mend's envelope around an object",
    { "$mend.toolInput": { format: "json", value: { actions: [{ kind: "type", text: TYPED }] } } },
  ],
  ["Mend's envelope of plain text", { "$mend.toolInput": { format: "text", value: TYPED } }],
  [
    "Mend's envelope beside more text",
    { "$mend.toolInput": { format: "json", value: "{}" }, more: { text: TYPED } },
  ],
  [
    "Mend's envelope inside the arguments",
    { actions: [{ "$mend.toolInput": { format: "text", value: TYPED } }] },
  ],
];

const expectNoTyped = (published: unknown) => {
  const text = JSON.stringify(published);
  expect(text).not.toContain(TYPED);
  expect(text).not.toContain(String(TYPED_NUMBER));
};

describe("typed text in any shape of a screen_act's arguments", () => {
  it.effect("Claude: neither the live items nor the approvals keep it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(() => undefined);
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        ARGUMENT_SHAPES.forEach(([, args], index) => {
          const id = `toolu_shape_${index}`;
          fake.push({
            type: "assistant",
            message: {
              id: `m${index}`,
              content: [{ type: "tool_use", id, name: "mcp__mend__screen_act", input: args }],
            },
          });
          fake.push(claudeResult(id, [{ type: "text", text: JSON.stringify(HELD) }], true));
          fake.push({
            type: "control_request",
            request_id: `permission-${index}`,
            request: { subtype: "can_use_tool", tool_name: "mcp__mend__screen_act", input: args },
          });
        });
        yield* fake.drain;
        const opened = seen.events.filter((event) => event._tag === "request.opened");
        expect(opened).toHaveLength(ARGUMENT_SHAPES.length);
        expectNoTyped(seen.events);
        expect(
          seen.items().findLast((item) => item.providerItemId === "toolu_shape_3")?.data,
        ).toMatchObject({
          input: { actions: [[{ kind: "type", length: TYPED.length }]] },
        });
      }),
    ),
  );

  it.effect("Codex: the live items keep none of it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(codexServer);
        const seen = recorded();
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        ARGUMENT_SHAPES.forEach(([, args], index) => {
          fake.push({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: {
                type: "mcpToolCall",
                id: `call_shape_${index}`,
                server: "mend",
                tool: "screen_act",
                arguments: args,
                status: "failed",
                durationMs: 3,
                error: { message: "MCP error -32602: invalid params" },
                result: null,
              },
            },
          });
        });
        yield* fake.drain;
        expect(seen.items()).toHaveLength(ARGUMENT_SHAPES.length);
        expectNoTyped(seen.events);
        for (const item of seen.items()) {
          expect(item.data).toMatchObject({
            [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "outcome_unknown" },
          });
        }
      }),
    ),
  );
});

describe("a call to another server's screen_act or html_render", () => {
  const OTHER_TOOLS = [
    "mcp__other__screen_act",
    "mcp__t3-code__html_render",
    "screen_act",
    "html_render",
  ];
  const PAGE_HTML = "<p>a chart from another server</p>";

  it.effect("Claude: the live items and the approval keep what the harness wrote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(() => undefined);
        const seen = recorded();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "ask",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        const input = { actions: ACTIONS, html: PAGE_HTML };
        OTHER_TOOLS.forEach((name, index) => {
          const id = `toolu_other_${index}`;
          fake.push({
            type: "assistant",
            message: { id: `m${index}`, content: [{ type: "tool_use", id, name, input }] },
          });
          fake.push(claudeResult(id, [{ type: "text", text: JSON.stringify(ANSWERED) }]));
          fake.push({
            type: "control_request",
            request_id: `permission-${index}`,
            request: { subtype: "can_use_tool", tool_name: name, input },
          });
        });
        yield* fake.drain;
        OTHER_TOOLS.forEach((name, index) => {
          const item = seen
            .items()
            .findLast((each) => each.providerItemId === `toolu_other_${index}`);
          expect(item?.data).toEqual({ type: "tool_use", id: `toolu_other_${index}`, name, input });
        });
        expect(
          seen.events.flatMap((event) =>
            event._tag === "request.opened" ? [event.request.detail] : [],
          ),
        ).toEqual(OTHER_TOOLS.map((toolName) => ({ toolName, input, suggestions: [] })));
      }),
    ),
  );

  it.effect("Codex: the live items keep their arguments and their result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeTransport(codexServer);
        const seen = recorded();
        const session = yield* CodexAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("open the page");
        const calls = [
          ["other", "screen_act"],
          ["t3-code", "html_render"],
        ].map(([server, tool], index) => ({
          type: "mcpToolCall",
          id: `call_other_${index}`,
          server,
          tool,
          arguments: { actions: ACTIONS, html: PAGE_HTML },
          status: "completed",
          durationMs: 3,
          error: null,
          result: {
            content: [{ type: "text", text: JSON.stringify(ANSWERED) }],
            structuredContent: null,
          },
        }));
        for (const item of calls) {
          fake.push({ method: "item/completed", params: { turnId: "turn-1", item } });
        }
        yield* fake.drain;
        expect(seen.items().map((item) => item.data)).toEqual(calls);
      }),
    ),
  );
});
