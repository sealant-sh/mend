import { PageId, SessionId } from "@mend/domain";
import { PageRef } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { backfillFromNative } from "../src/native-backfill.ts";
import { convertNativeSession, ingestNativeSession } from "../src/native-convert.ts";
import { withPages } from "../src/transcript-pages.ts";

// A marker JSON never escapes, so it shows in any encoding of the text that kept it.
const TYPED = "typed-marker-Vq7Zs correct horse battery staple";
const PNG_BASE64 = `iVBORw0KGgo${"QUJD".repeat(64)}`;
const RECEIPT = { screenId: "screen-1", seq: 4, callKey: "key-4" };
const ANSWERED = JSON.stringify({
  screen: { display: ":12", size: "1280x800", input: "agent" },
  receipt: RECEIPT,
  frameId: "frame-4",
  outcome: "applied",
  actions: [{ action: `type ${TYPED.length} characters`, result: "done" }],
  sinceLastLook: [],
  message: "The image is the screen once it went quiet.",
});
const ACTIONS = [{ kind: "type", text: TYPED }];
const MARKER = { receipt: RECEIPT, outcome: "applied", refusal: null };

const jsonl = (entries: ReadonlyArray<unknown>): string =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const claudeTranscript = jsonl([
  { type: "user", uuid: "u1", message: { role: "user", content: "open the app" } },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_act",
          name: "mcp__mend__screen_act",
          input: { actions: ACTIONS },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_act",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
            },
            { type: "text", text: ANSWERED },
          ],
        },
      ],
    },
  },
]);

const codexTranscript = jsonl([
  { type: "session_meta", payload: { id: "codex-session" } },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "open the app" }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      namespace: "mcp__mend__",
      name: "screen_act",
      arguments: JSON.stringify({ actions: ACTIONS }),
      call_id: "call_act",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_act",
      output: [
        { type: "input_text", text: "Wall time: 0.9 seconds\nOutput:" },
        { type: "input_text", text: ANSWERED },
        { type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` },
      ],
    },
  },
]);

const expectNoPayload = (stored: unknown) => {
  const text = JSON.stringify(stored);
  expect(text).not.toContain(TYPED);
  expect(text).not.toContain(PNG_BASE64.slice(0, 24));
};

describe("a call to Mend's screen tools in a native transcript", () => {
  it.each([
    ["claude", claudeTranscript, "toolu_act"],
    ["codex", codexTranscript, "call_act"],
  ])(
    "%s: backfills the call with its receipt, never its frame or typed text",
    (harness, native, id) => {
      expect(native).toContain(TYPED);
      const items = backfillFromNative(harness, "sess-screens", native, null)?.turns.flatMap(
        (turn) => turn.items,
      );
      expectNoPayload(items);
      const call = items?.find((item) => item.providerItemId === id);
      expect(call).toMatchObject({ kind: "tool-call", status: "completed", text: null });
      expect(call?.data).toMatchObject({ mendScreenCall: MARKER });
      const args = harness === "claude" ? call?.data : null;
      if (args !== null) expect(args).toMatchObject({ input: { actions: [{ kind: "type" }] } });
    },
  );

  it.each([
    ["claude", "codex", claudeTranscript],
    ["codex", "claude", codexTranscript],
  ])(
    "%s converted to %s: backfills the call with its receipt and no payload",
    (source, target, native) => {
      const converted = convertNativeSession(source, target, native, {
        cwd: "/workspace/repo",
        now: "2026-10-30T10:00:00.000Z",
      });
      const file = converted?.files.find((entry) => entry.path.endsWith(".jsonl"));
      expect(file?.content).toContain(TYPED);
      const items =
        backfillFromNative(
          target,
          converted?.providerSessionId ?? "",
          file?.content ?? "",
          null,
        )?.turns.flatMap((turn) => turn.items) ?? [];
      expectNoPayload(items);
      const calls = items.filter((item) => JSON.stringify(item.data).includes('"mendScreenCall"'));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.data).toMatchObject({ mendScreenCall: MARKER });
      expect(JSON.stringify(calls[0]?.data).replaceAll('\\"', '"')).toContain(
        `"length":${TYPED.length}`,
      );
    },
  );

  it.each([
    ["claude", claudeTranscript],
    ["codex", codexTranscript],
  ])(
    "%s: the transcript view shows the tool's text, never its frame or typed text",
    (harness, native) => {
      const events = ingestNativeSession(harness, native, "/workspace/repo")?.events ?? [];
      const entries = withPages(events, []);
      expectNoPayload(entries);
      const call = entries.find((entry) => entry.kind === "tool");
      expect(call).toMatchObject({ kind: "tool" });
      if (call?.kind !== "tool") return;
      expect(JSON.parse(call.args)).toEqual({ actions: [{ kind: "type", length: TYPED.length }] });
      expect(JSON.parse(call.output)).toMatchObject({ receipt: RECEIPT, outcome: "applied" });
    },
  );
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
  ["a valid batch", { actions: [CLICK, TYPE_ACTION] }, { actions: [CLICK, TYPE_STORED] }],
  [
    "a valid batch with text under other keys",
    {
      actions: [
        { ...CLICK, at: { x: 10, y: 20, label: TYPED }, note: TYPED, text: TYPED },
        { ...TYPE_ACTION, value: TYPED, payload: { text: TYPED } },
      ],
      comment: TYPED,
    },
    { actions: [CLICK, TYPE_STORED] },
  ],
  [
    "a valid batch whose typed text is encoded JSON",
    { actions: [{ kind: "type", text: encoded({ text: TYPED }, 2) }] },
    { actions: [{ kind: "type", length: String(encoded({ text: TYPED }, 2)).length }] },
  ],
  [
    "a batch encoded three times",
    encoded({ actions: [TYPE_ACTION] }, 3),
    { actions: [TYPE_STORED] },
  ],
  ["a batch encoded nine times", encoded({ actions: [TYPE_ACTION] }, 9), null],
  [
    "Mend's envelope around an encoded batch",
    { "$mend.toolInput": { format: "json", value: encoded({ actions: [TYPE_ACTION] }, 2) } },
    { actions: [TYPE_STORED] },
  ],
  ["actions encoded twice", { actions: encoded([TYPE_ACTION], 2) }, null],
  ["actions encoded three times", { actions: encoded([TYPE_ACTION], 3) }, null],
  ["an action encoded twice inside the array", { actions: [CLICK, encoded(TYPE_ACTION, 2)] }, null],
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
  ["actions encoded as a string", { actions: encoded([TYPE_ACTION], 1) }, null],
  ["an unparseable string", `{"actions":[{"kind":"type","text":"${TYPED}`, null],
  ["a JSON string of text", encoded(TYPED, 1), null],
  [
    "Mend's envelope around a nested batch",
    { "$mend.toolInput": { format: "json", value: encoded({ actions: [[TYPE_ACTION]] }, 1) } },
    null,
  ],
  [
    "Mend's envelope inside the arguments",
    { actions: [{ "$mend.toolInput": { format: "text", value: TYPED } }] },
    null,
  ],
];

interface NativeCall {
  readonly namespace: string | null;
  readonly name: string;
  readonly args: unknown;
}

/** An answer that quotes the call's arguments, as a schema refusal does. */
const refusalOf = (call: NativeCall): string => `invalid params: ${JSON.stringify(call.args)}`;

const claudeCallsOf = (calls: ReadonlyArray<NativeCall>, output = refusalOf) =>
  jsonl([
    { type: "user", uuid: "u1", message: { role: "user", content: "open the app" } },
    ...calls.flatMap((call, index) => [
      {
        type: "assistant",
        uuid: `a${index}`,
        message: {
          id: `msg_${index}`,
          content: [{ type: "tool_use", id: `toolu_${index}`, name: call.name, input: call.args }],
        },
      },
      {
        type: "user",
        uuid: `r${index}`,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `toolu_${index}`,
              is_error: output === refusalOf,
              content: [{ type: "text", text: output(call) }],
            },
          ],
        },
      },
    ]),
  ]);

const codexCallsOf = (calls: ReadonlyArray<NativeCall>, output = refusalOf) =>
  jsonl([
    { type: "session_meta", payload: { id: "codex-session" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "open the app" }],
      },
    },
    ...calls.flatMap((call, index) => [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          namespace: call.namespace,
          name: call.name,
          arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
          call_id: `call_${index}`,
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: `call_${index}`, output: output(call) },
      },
    ]),
  ]);

const expectNoTyped = (stored: unknown) => {
  const text = JSON.stringify(stored);
  expect(text).not.toContain(TYPED);
  expect(text).not.toContain(String(TYPED_NUMBER));
};

describe("typed text in any shape of a screen_act's arguments", () => {
  const shapes = STORED_SHAPES.map(([, args]) => args);
  const transcripts = [
    [
      "claude",
      claudeCallsOf(
        shapes.map((args) => ({ namespace: null, name: "mcp__mend__screen_act", args })),
      ),
      "input",
    ],
    [
      "codex",
      codexCallsOf(shapes.map((args) => ({ namespace: "mcp__mend__", name: "screen_act", args }))),
      "arguments",
    ],
  ] as const;

  it.each(transcripts)(
    "%s: the backfilled items keep only what the schema rebuilds",
    (harness, native, field) => {
      expect(native).toContain(TYPED);
      const items = backfillFromNative(harness, "sess-shapes", native, null)?.turns.flatMap(
        (turn) => turn.items,
      );
      const calls = items?.filter((item) => item.kind === "tool-call") ?? [];
      expect(calls).toHaveLength(shapes.length);
      expectNoTyped(items);
      STORED_SHAPES.forEach(([, , stored], index) => {
        expect(calls[index]?.data).toMatchObject({
          [field]: stored,
          mendScreenCall: { receipt: null, outcome: "outcome_unknown", refusal: null },
        });
        if (stored === null) {
          expect(calls[index]?.data).toMatchObject({ mendScreenArgumentsDropped: true });
        } else {
          expect(calls[index]?.data).not.toHaveProperty("mendScreenArgumentsDropped");
        }
      });
    },
  );

  it.each(transcripts)("%s: the transcript view shows none of it", (harness, native) => {
    const events = ingestNativeSession(harness, native, "/workspace/repo")?.events ?? [];
    const entries = withPages(events, []);
    const calls = entries.filter((entry) => entry.kind === "tool");
    expect(calls).toHaveLength(shapes.length);
    expectNoTyped(entries);
    expect(calls.map((call) => (call.kind === "tool" ? call.args : null))).toEqual(
      STORED_SHAPES.map(([, , stored]) => (stored === null ? "" : JSON.stringify(stored))),
    );
  });
});

describe("a call to another server's screen_act or html_render", () => {
  const PAGE = PageId.make("5f2c9a7e-1d3b-4e8a-9c0f-7b6a5d4c3e2f");
  const page = new PageRef({
    id: PAGE,
    sessionId: SessionId.make("sess-other"),
    title: "Latency",
    height: 420,
    publishedAt: new Date(),
  });
  const args = { actions: ACTIONS, html: "<p>another server's chart</p>" };
  // The answer names one of this session's pages, so only the caller's identity tells them apart.
  const answer = () =>
    JSON.stringify({ ...JSON.parse(ANSWERED), htmlRender: { attachmentId: PAGE } });

  it.each([
    [
      "claude",
      claudeCallsOf(
        ["mcp__other__screen_act", "mcp__t3-code__html_render", "screen_act", "html_render"].map(
          (name) => ({ namespace: null, name, args }),
        ),
        answer,
      ),
    ],
    [
      "codex",
      codexCallsOf(
        [
          { namespace: "mcp__other__", name: "screen_act", args },
          { namespace: "mcp__t3-code__", name: "html_render", args },
        ],
        answer,
      ),
    ],
  ])("%s: backfill and the transcript view keep what the harness wrote", (harness, native) => {
    const items =
      backfillFromNative(harness, "sess-other", native, null)?.turns.flatMap(
        (turn) => turn.items,
      ) ?? [];
    const calls = items.filter((item) => item.kind === "tool-call");
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(JSON.stringify(call.data)).toContain(TYPED);
      expect(call.data).not.toHaveProperty("mendScreenCall");
      expect(call.data).not.toHaveProperty("mendPageCall");
    }
    const events = ingestNativeSession(harness, native, "/workspace/repo")?.events ?? [];
    expect(events.filter((event) => event.kind === "tool").length).toBe(calls.length);
    expect(withPages(events, [page])).toEqual([...events, { kind: "page", page }]);
  });
});
