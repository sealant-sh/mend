import { describe, expect, it } from "vitest";

import { backfillFromNative } from "../src/native-backfill.ts";
import { convertNativeSession, ingestNativeSession } from "../src/native-convert.ts";
import { withPages } from "../src/transcript-pages.ts";

const TYPED = "correct horse battery staple";
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
