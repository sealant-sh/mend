import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, AgentEventItem } from "@mend/domain/workbench";
import { Effect, Queue, Stream } from "effect";

import {
  type AgentTransport,
  ClaudeAdapter,
  CodexAdapter,
  compactMendScreenCall,
  MEND_SCREEN_ARGUMENTS_DROPPED,
  MEND_SCREEN_CALL_FIELD,
} from "../src/index.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A marker JSON never escapes, so it shows in any encoding of the text that kept it.
const TYPED = "typed-marker-Vq7Zs correct horse battery staple";
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
              detail: { input: { actions: STORED_ACTIONS } },
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

  it("reads the arguments out of Mend's tool input envelope, and drops ones it cannot read", () => {
    const read = compactMendScreenCall(enveloped(JSON.stringify({ actions: ACTIONS })));
    expect(read.data).toEqual({
      type: "tool_use",
      name: "imported_mcp__mend__screen_act",
      input: { actions: STORED_ACTIONS },
    });
    const cut = compactMendScreenCall(enveloped(`{"actions":[{"kind":"type","text":"${TYPED}`));
    expect(cut.data).toEqual({
      type: "tool_use",
      name: "imported_mcp__mend__screen_act",
      input: null,
      [MEND_SCREEN_ARGUMENTS_DROPPED]: true,
    });
    expectNoPayload([read, cut]);
  });

  it("keeps a screen_look's empty arguments, and drops any others", () => {
    const look = (input: unknown): AgentEventItem => ({
      ...enveloped("{}"),
      title: "mcp__mend__screen_look",
      data: { type: "tool_use", name: "mcp__mend__screen_look", input },
    });
    expect(compactMendScreenCall(look({})).data).toMatchObject({ input: {} });
    expect(compactMendScreenCall(look({})).data).not.toHaveProperty(MEND_SCREEN_ARGUMENTS_DROPPED);
    const typed = compactMendScreenCall(look({ text: TYPED }));
    expect(typed.data).toMatchObject({ input: null, [MEND_SCREEN_ARGUMENTS_DROPPED]: true });
    expectNoPayload(typed);
  });
});

const TYPED_NUMBER = 271828182845;

const encoded = (value: unknown, times: number): unknown =>
  times === 0 ? value : encoded(JSON.stringify(value), times - 1);
const TYPE_ACTION = { kind: "type", text: TYPED };
const TYPE_STORED = { kind: "type", length: TYPED.length };
const CLICK = { kind: "click", at: { x: 10, y: 20 } };

/**
 * The shapes an agent can give `screen_act` and what Mend stores of each: the batch its schema
 * rebuilds, or nothing.
 */
const STORED_SHAPES: ReadonlyArray<readonly [string, unknown, unknown]> = [
  ["a valid batch", { actions: ACTIONS }, { actions: STORED_ACTIONS }],
  [
    "every kind of action",
    {
      actions: [
        { kind: "click", at: { x: 1, y: 2 }, button: "right", count: 2 },
        { kind: "move", to: { x: 3, y: 4 } },
        { kind: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
        { kind: "scroll", at: { x: 9, y: 10 }, dx: 0, dy: -3 },
        TYPE_ACTION,
        { kind: "key", combo: "ctrl+shift+t" },
        { kind: "wait", ms: 250 },
      ],
    },
    {
      actions: [
        { kind: "click", at: { x: 1, y: 2 }, button: "right", count: 2 },
        { kind: "move", to: { x: 3, y: 4 } },
        { kind: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
        { kind: "scroll", at: { x: 9, y: 10 }, dx: 0, dy: -3 },
        TYPE_STORED,
        { kind: "key", combo: "ctrl+shift+t" },
        { kind: "wait", ms: 250 },
      ],
    },
  ],
  [
    "a valid batch with text under other keys",
    {
      actions: [
        { ...CLICK, at: { x: 10, y: 20, label: TYPED }, note: TYPED, text: TYPED },
        { ...TYPE_ACTION, value: TYPED, payload: { text: TYPED } },
      ],
      comment: TYPED,
      text: TYPED,
    },
    { actions: [CLICK, TYPE_STORED] },
  ],
  [
    "a valid batch whose typed text is JSON",
    { actions: [{ kind: "type", text: JSON.stringify({ actions: [TYPE_ACTION] }) }] },
    { actions: [{ kind: "type", length: JSON.stringify({ actions: [TYPE_ACTION] }).length }] },
  ],
  [
    "a valid batch whose typed text is encoded JSON",
    { actions: [{ kind: "type", text: encoded({ text: TYPED }, 2) }] },
    { actions: [{ kind: "type", length: String(encoded({ text: TYPED }, 2)).length }] },
  ],
  ["a batch as a JSON string", encoded({ actions: ACTIONS }, 1), { actions: STORED_ACTIONS }],
  ["a batch encoded three times", encoded({ actions: ACTIONS }, 3), { actions: STORED_ACTIONS }],
  ["a batch encoded eight times", encoded({ actions: ACTIONS }, 8), { actions: STORED_ACTIONS }],
  ["a batch encoded nine times", encoded({ actions: ACTIONS }, 9), null],
  [
    "Mend's envelope around an encoded batch",
    { "$mend.toolInput": { format: "json", value: encoded({ actions: ACTIONS }, 2) } },
    { actions: STORED_ACTIONS },
  ],
  ["actions encoded twice", { actions: encoded([TYPE_ACTION], 2) }, null],
  ["actions encoded three times", { actions: encoded([TYPE_ACTION], 3) }, null],
  ["an action encoded inside the array", { actions: [encoded(TYPE_ACTION, 1)] }, null],
  ["an action encoded twice inside the array", { actions: [CLICK, encoded(TYPE_ACTION, 2)] }, null],
  [
    "a point encoded inside an action",
    { actions: [{ kind: "click", at: encoded({ x: 1, y: 2, text: TYPED }, 2) }] },
    null,
  ],
  ["text encoded under another key", { actions: [{ payload: encoded({ text: TYPED }, 2) }] }, null],
  [
    "an unknown kind beside valid ones",
    { actions: [CLICK, { kind: "paste", text: TYPED }, TYPE_ACTION] },
    null,
  ],
  ["a batch over 20 actions", { actions: Array.from({ length: 21 }, () => TYPE_ACTION) }, null],
  [
    "text over 2,000 characters",
    { actions: [CLICK, { kind: "type", text: `${TYPED}${"x".repeat(2001)}` }] },
    null,
  ],
  ["an empty batch", { actions: [] }, null],
  ["no arguments", {}, null],
  ["an unknown kind", { actions: [{ kind: "typo", text: TYPED }] }, null],
  ["an action in an array", { actions: [[TYPE_ACTION]] }, null],
  ["arrays of arrays", { actions: [[[[TYPE_ACTION]], [{ text: TYPED }]]] }, null],
  ["text in a nested object", { actions: [{ kind: "type", payload: { text: TYPED } }] }, null],
  [
    "text at odd depths",
    { text: TYPED, a: [{ b: { text: TYPED, c: [[{ text: TYPED }]] } }] },
    null,
  ],
  ["a root array", [TYPE_ACTION], null],
  ["a number as text", { actions: [{ kind: "type", text: TYPED_NUMBER }] }, null],
  ["an object as text", { actions: [{ kind: "type", text: { value: TYPED } }] }, null],
  ["an array as text", { actions: [{ kind: "type", text: [TYPED] }] }, null],
  ["actions encoded as a string", { actions: encoded([TYPE_ACTION], 1) }, null],
  ["arguments as a JSON string", encoded({ actions: [[TYPE_ACTION]] }, 1), null],
  ["an unparseable string", `{"actions":[{"kind":"type","text":"${TYPED}`, null],
  ["a JSON string of text", encoded(TYPED, 1), null],
  ["typed text alone", TYPED, null],
  [
    "Mend's envelope around a nested batch",
    { "$mend.toolInput": { format: "json", value: encoded({ actions: [[TYPE_ACTION]] }, 1) } },
    null,
  ],
  [
    "Mend's envelope around an object",
    { "$mend.toolInput": { format: "json", value: { actions: [TYPE_ACTION] } } },
    null,
  ],
  ["Mend's envelope of plain text", { "$mend.toolInput": { format: "text", value: TYPED } }, null],
  [
    "Mend's envelope beside more text",
    { "$mend.toolInput": { format: "json", value: "{}" }, more: { text: TYPED } },
    null,
  ],
  [
    "Mend's envelope inside the arguments",
    { actions: [{ "$mend.toolInput": { format: "text", value: TYPED } }] },
    null,
  ],
];

/** What a stored call keeps beside arguments it stored as null. */
const droppedFlag = (stored: unknown) =>
  stored === null ? { [MEND_SCREEN_ARGUMENTS_DROPPED]: true } : {};

const claudeCall = (input: unknown): AgentEventItem => ({
  providerItemId: "toolu_shape",
  providerTurnId: "turn",
  kind: "tool-call",
  status: "completed",
  title: "mcp__mend__screen_act",
  text: null,
  data: { type: "tool_use", name: "mcp__mend__screen_act", input },
});
const codexCall = (args: unknown): AgentEventItem => ({
  ...claudeCall(null),
  title: "screen_act",
  data: { type: "mcpToolCall", server: "mend", tool: "screen_act", arguments: args },
});

describe("what Mend stores of a screen_act's arguments", () => {
  it.each(STORED_SHAPES)("%s", (_name, args, stored) => {
    const dropped = droppedFlag(stored);
    const claude = compactMendScreenCall(claudeCall(args));
    const codex = compactMendScreenCall(codexCall(args));
    expect(JSON.stringify([claude, codex])).not.toContain(TYPED);
    expect(claude.data).toEqual({
      type: "tool_use",
      name: "mcp__mend__screen_act",
      input: stored,
      ...dropped,
    });
    expect(codex.data).toEqual({
      type: "mcpToolCall",
      server: "mend",
      tool: "screen_act",
      arguments: stored,
      ...dropped,
    });
    expect(compactMendScreenCall(claude)).toEqual(claude);
    expect(compactMendScreenCall(codex)).toEqual(codex);
  });
});

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
        STORED_SHAPES.forEach(([, args], index) => {
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
        expect(opened).toHaveLength(STORED_SHAPES.length);
        expectNoTyped(seen.events);
        STORED_SHAPES.forEach(([, , input], index) => {
          const item = seen
            .items()
            .findLast((each) => each.providerItemId === `toolu_shape_${index}`);
          expect(item?.data).toEqual({
            type: "tool_use",
            id: `toolu_shape_${index}`,
            name: "mcp__mend__screen_act",
            input,
            ...droppedFlag(input),
            [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "refused", refusal: "held" },
          });
        });
        expect(
          opened.map((event) => (event._tag === "request.opened" ? event.request.detail : null)),
        ).toEqual(
          // Claude reads a request's input as an object, and anything else as no input.
          STORED_SHAPES.map(([, args, stored]) => {
            const input = isObject(args) ? stored : null;
            return {
              toolName: "mcp__mend__screen_act",
              input,
              ...droppedFlag(input),
              suggestions: [],
            };
          }),
        );
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
        STORED_SHAPES.forEach(([, args], index) => {
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
        expect(seen.items()).toHaveLength(STORED_SHAPES.length);
        expectNoTyped(seen.events);
        STORED_SHAPES.forEach(([, , stored], index) => {
          expect(seen.items()[index]?.data).toEqual({
            type: "mcpToolCall",
            id: `call_shape_${index}`,
            server: "mend",
            tool: "screen_act",
            arguments: stored,
            ...droppedFlag(stored),
            status: "failed",
            durationMs: 3,
            [MEND_SCREEN_CALL_FIELD]: { receipt: null, outcome: "outcome_unknown", refusal: null },
          });
        });
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
