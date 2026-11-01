import { UserFacts, UsersRepo } from "@mend/db";
import {
  ScreenFrameId,
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "@mend/domain";
import {
  DisplayNumber,
  type ScreenActParams,
  type ScreenInput,
  type ScreenLogEntry,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { describe, expect, it } from "vitest";

import { ScreenStartError } from "../screen/screen-host.ts";
import { type ScreenCallAnswer, Screens, type ScreenState } from "../screen/screens.ts";
import { SessionChannelRegistryLive } from "../session-channel.ts";
import { MEND_MCP_CALL_KEY_HEADER, MEND_MCP_PATH } from "./caller.ts";
import { ProofCaptures } from "./proof-captures.ts";
import { MendMcp, MendMcpLive, MendMcpWithoutScreensLive } from "./server.ts";
import { SessionPages } from "./session-pages.ts";

const SESSION = SessionId.make("s-screen-tools");
const SCREEN = ScreenId.make("screen-1");
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const TYPED = "hunter2-secret";

const caller = {
  sessionId: SESSION,
  accountId: "alice",
  agentProcess: { _tag: "Current", id: SessionProcessId.make(crypto.randomUUID()) },
} as const;

const stateOf = (input: ScreenInput, takenAt: Date | null = null): ScreenState => ({
  screen: {
    id: SCREEN,
    sessionId: SESSION,
    workspaceId: SealantWorkspaceId.make("ws-1"),
    display: DisplayNumber.make(12),
    processId: null,
    life: { _tag: "Live", degraded: null, browserSandboxOff: false },
    input,
  },
  takenAt,
});

const entry = (seq: number, at: string, body: ScreenLogEntry["body"]): ScreenLogEntry => ({
  screenId: SCREEN,
  seq,
  at: new Date(at),
  actor: body._tag === "Paused" ? { _tag: "Mend" } : { _tag: "Person", userId: "bea" },
  body,
  frame: null,
  checkpoint: null,
});

const answered = (overrides: Partial<Extract<ScreenCallAnswer, { _tag: "Answered" }>> = {}) =>
  ({
    _tag: "Answered",
    outcome: "applied",
    receipt: { screenId: SCREEN, seq: 7, callKey: "call-1" },
    png: PNG,
    observedAt: new Date("2026-11-01T14:02:00Z"),
    frameId: ScreenFrameId.make("frame-7"),
    actions: [],
    sinceLastLook: [],
    ...overrides,
  }) satisfies ScreenCallAnswer;

interface Stub {
  readonly answer: Effect.Effect<ScreenCallAnswer, ScreenStartError>;
  readonly proof?: ProofCaptures["Service"];
  readonly state?: ScreenState | null;
}

const post = (message: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://mend.session${MEND_MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });

const Reply = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optionalKey(Schema.String),
            data: Schema.optionalKey(Schema.String),
            mimeType: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      structuredContent: Schema.optionalKey(Schema.Unknown),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeReply = Schema.decodeUnknownSync(Reply);

/** One MCP session against Mend's server: `tools/list`, then each call in turn. */
const serve = (
  stub: Stub,
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
  server: "screens" | "worker" = "screens",
) => {
  const acted: Array<ScreenActParams> = [];
  const screens = Layer.mock(Screens)({
    look: () => stub.answer,
    act: (_, params) => {
      acted.push(params);
      return stub.answer;
    },
    state: () => Effect.succeed(stub.state ?? null),
  });
  const users = Layer.mock(UsersRepo)({
    byIds: (ids) =>
      Effect.succeed(
        ids.flatMap((id) =>
          id === "bea" ? [new UserFacts({ id, name: "Bea", email: "bea@example.invalid" })] : [],
        ),
      ),
  });
  const layer = (server === "screens" ? MendMcpLive : MendMcpWithoutScreensLive).pipe(
    Layer.provide(
      stub.proof === undefined
        ? Layer.mock(ProofCaptures)({})
        : Layer.succeed(ProofCaptures, stub.proof),
    ),
    Layer.provide(SessionChannelRegistryLive),
    Layer.provide(screens),
    Layer.provide(users),
    Layer.provide(Layer.succeed(SessionPages, { publish: () => Effect.die("not in this test") })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const mcp = yield* MendMcp;
      const opened = yield* mcp.handle(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
        caller,
      );
      const session = {
        "mcp-session-id": opened.headers.get("mcp-session-id") ?? "",
        "mcp-protocol-version": "2025-06-18",
      };
      const replies = [];
      const listed = yield* mcp.handle(
        post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session),
        caller,
      );
      replies.push(decodeReply(yield* Effect.promise(() => listed.json())));
      for (const [at, call] of calls.entries()) {
        const answer = yield* mcp.handle(
          post(
            { jsonrpc: "2.0", id: 3 + at, method: "tools/call", params: call },
            { ...session, [MEND_MCP_CALL_KEY_HEADER]: `call-${at}` },
          ),
          caller,
        );
        replies.push(decodeReply(yield* Effect.promise(() => answer.json())));
      }
      return { listed: replies[0]?.result?.tools ?? [], replies: replies.slice(1), acted };
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
};

const look = { name: "screen_look", arguments: {} };
const act = (actions: ReadonlyArray<unknown>) => ({ name: "screen_act", arguments: { actions } });

const textOf = (reply: ReturnType<typeof decodeReply> | undefined): unknown =>
  JSON.parse(reply?.result?.content?.find((block) => block.type === "text")?.text ?? "null");

describe("the screen tools on Mend's MCP server", () => {
  it("lists both tools as read-only, with the action schema as screen_act's input", async () => {
    const { listed } = await serve({ answer: Effect.succeed(answered()) }, []);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "screen_look",
          inputSchema: expect.objectContaining({ type: "object" }),
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
        }),
        expect.objectContaining({
          name: "screen_act",
          annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["actions"],
            properties: {
              actions: expect.objectContaining({ type: "array", minItems: 1, maxItems: 20 }),
            },
          }),
        }),
      ]),
    );
    const actTool = listed.find((tool) => JSON.stringify(tool).includes('"screen_act"'));
    for (const kind of ["click", "move", "drag", "scroll", "type", "key", "wait"]) {
      expect(JSON.stringify(actTool)).toContain(`"${kind}"`);
    }
    expect(JSON.stringify(actTool)).toContain("2000");
  });

  it("answers a look with the frame as an image block, and its text beside it", async () => {
    const since = [
      entry(3, "2026-10-30T14:02:10Z", { _tag: "Taken", epoch: 2 }),
      entry(4, "2026-10-30T14:02:40Z", { _tag: "PersonInput", clicks: 2, keys: 1, pastes: 0 }),
      entry(5, "2026-10-30T14:03:00Z", { _tag: "HandedBack", epoch: 3 }),
      entry(6, "2026-10-30T14:03:05Z", { _tag: "Paused", reason: "disconnected" }),
    ];
    const { replies } = await serve(
      {
        answer: Effect.succeed(answered({ sinceLastLook: since })),
        state: stateOf({ _tag: "Agent", epoch: 4 }),
      },
      [look],
    );
    const result = replies[0]?.result;
    expect(result?.isError ?? false).toBe(false);
    expect(result?.content?.[0]).toEqual({
      type: "image",
      data: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    });
    expect(textOf(replies[0])).toEqual({
      screen: { display: ":12", size: "1280x800", input: "agent" },
      receipt: { screenId: SCREEN, seq: 7, callKey: "call-1" },
      frameId: "frame-7",
      outcome: "applied",
      actions: [],
      sinceLastLook: [
        "Bea took the screen at 14:02:10 UTC.",
        "Bea put input on the screen by 14:02:40 UTC: 2 clicks, 1 key, 0 pastes.",
        "Bea handed the screen back at 14:03:00 UTC.",
        "The screen's input paused at 14:03:05 UTC: the person's connection dropped.",
      ],
      message: "The image is the screen once it went quiet.",
    });
    // Codex hands a model a result's structuredContent in place of its image.
    expect(result?.structuredContent).toBeUndefined();
  });

  it("answers an act with each action's result, a typed text by its length only", async () => {
    const { replies, acted } = await serve(
      {
        answer: Effect.succeed(
          answered({
            outcome: "interrupted",
            frameId: null,
            actions: [
              { action: { kind: "click", at: { x: 10, y: 20 }, count: 2 }, result: "done" },
              { action: { kind: "type", length: TYPED.length }, result: "skipped: taken over" },
            ],
          }),
        ),
        state: stateOf(
          { _tag: "Person", epoch: 5, userId: "bea", connection: ViewerConnectionId.make("v") },
          new Date("2026-10-30T14:05:00Z"),
        ),
      },
      [
        act([
          { kind: "click", at: { x: 10, y: 20 }, count: 2 },
          { kind: "type", text: TYPED },
        ]),
      ],
    );
    expect(acted).toEqual([
      {
        actions: [
          { kind: "click", at: { x: 10, y: 20 }, count: 2 },
          { kind: "type", text: TYPED },
        ],
      },
    ]);
    expect(textOf(replies[0])).toMatchObject({
      screen: { input: { person: "Bea", since: "2026-10-30T14:05:00.000Z" } },
      outcome: "interrupted",
      frameId: null,
      actions: [
        { action: "click 10,20 left x2", result: "done" },
        { action: "type 14 characters", result: "skipped: taken over" },
      ],
      message:
        "1 action did not run. The image is the screen once the batch stopped. Mend kept no frame of it: the screen's frame budget is reached.",
    });
    expect(JSON.stringify(replies)).not.toContain(TYPED);
  });

  it("answers every refusal as text with isError, and the same object as structuredContent", async () => {
    const held = stateOf({
      _tag: "Person",
      epoch: 2,
      userId: "bea",
      connection: ViewerConnectionId.make("v"),
    });
    const paused = stateOf({
      _tag: "Paused",
      epoch: 3,
      reason: "lease-lapsed",
      since: new Date("2026-10-30T14:00:00Z"),
    });
    const cases: ReadonlyArray<{
      readonly stub: Stub;
      readonly refusal: string;
      readonly outcome?: string;
      readonly message: string | RegExp;
    }> = [
      {
        stub: { answer: Effect.succeed({ _tag: "Refused", refusal: "no_screen" }), state: null },
        refusal: "no_screen",
        message:
          "This session's workspace has no screen. The project's owner turns it on in the project's Environment.",
      },
      {
        stub: { answer: Effect.succeed({ _tag: "Refused", refusal: "held" }), state: held },
        refusal: "held",
        message:
          "Bea holds the screen's input. Mend sent no input; look again once they hand it back.",
      },
      {
        stub: { answer: Effect.succeed({ _tag: "Refused", refusal: "held" }), state: paused },
        refusal: "held",
        message: /^The screen's input is paused: the person's viewer stopped answering\./,
      },
      ...(
        [
          "busy",
          "look_first",
          "call_reused",
          "observation_unavailable",
          "unattributed_caller",
          "owner_only",
        ] as const
      ).map((refusal) => ({
        stub: { answer: Effect.succeed<ScreenCallAnswer>({ _tag: "Refused", refusal }) },
        refusal,
        message: /\S/,
      })),
      {
        stub: { answer: Effect.succeed({ _tag: "UnsupportedKey", key: "hyper+q" }) },
        refusal: "unsupported_key",
        message: /^No X keysym is named "hyper\+q"\. Mend sent no input\./,
      },
      {
        stub: {
          answer: Effect.fail(new ScreenStartError({ message: "the screen did not start" })),
        },
        refusal: "start_failed",
        message: "The screen did not start: the screen did not start.",
      },
    ];
    for (const { stub, refusal, message } of cases) {
      const { replies } = await serve(stub, [look]);
      const result = replies[0]?.result;
      const text = textOf(replies[0]);
      expect(result?.isError).toBe(true);
      expect(result?.content).toHaveLength(1);
      expect(result?.structuredContent).toEqual(text);
      expect(text).toMatchObject({ outcome: "refused", refusal, receipt: null, frameId: null });
      expect(text).toHaveProperty("message", expect.stringMatching(message));
    }
  });

  it("says when a call left no entry, and whether its input may have landed", async () => {
    for (const outcome of ["refused", "outcome_unknown"] as const) {
      const { replies } = await serve(
        {
          answer: Effect.succeed({ _tag: "NoEntry", outcome }),
          state: stateOf({ _tag: "Agent", epoch: 1 }),
        },
        [look],
      );
      expect(replies[0]?.result?.isError).toBe(true);
      expect(textOf(replies[0])).toMatchObject({ outcome, receipt: null });
      expect(textOf(replies[0])).not.toHaveProperty("refusal");
    }
  });

  it("refuses actions outside the schema as invalid params, and sends the screen nothing", async () => {
    const { replies, acted } = await serve({ answer: Effect.succeed(answered()) }, [
      act([]),
      act([{ kind: "type", text: "x".repeat(2_001) }]),
      act([{ kind: "click", at: { x: 1280, y: 0 } }]),
      act(Array.from({ length: 21 }, () => ({ kind: "wait", ms: 1 }))),
    ]);
    expect(acted).toEqual([]);
    for (const reply of replies) expect(reply.error?.code).toBe(-32602);
    expect(replies[1]?.error?.message).toContain(
      'Expected a value with a length between 1 and 2000\n  at ["actions"][0]["text"]',
    );
  });

  it("answers in a process without Screens that the API process drives screens", async () => {
    const { listed, replies } = await serve(
      { answer: Effect.die("no Screens here") },
      [look, act([{ kind: "wait", ms: 1 }])],
      "worker",
    );
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "screen_look" }),
        expect.objectContaining({ name: "screen_act" }),
      ]),
    );
    for (const reply of replies) {
      expect(reply.result?.isError).toBe(true);
      expect(textOf(reply)).toMatchObject({
        screen: null,
        outcome: "refused",
        refusal: "not_served_here",
      });
    }
  });
});

describe("proof tools on the screen-enabled MCP server", () => {
  it("returns an image beside the reference, with the authenticated caller and call key", async () => {
    const seen: Array<unknown> = [];
    const reference = {
      artifactId: "proof-1",
      label: "Board · checkpoint #2 · observed 14:02 UTC",
      message: "Recorded the screen as observed.",
    };
    const proof: ProofCaptures["Service"] = {
      videoStart: (who, params) =>
        Effect.sync(() => {
          seen.push({ who, params });
          return new McpSchema.CallToolResult({
            content: [{ type: "text", text: JSON.stringify(reference) }],
          });
        }),
      videoStop: (who) =>
        Effect.sync(() => {
          seen.push({ who });
          return new McpSchema.CallToolResult({
            content: [{ type: "text", text: JSON.stringify(reference) }],
          });
        }),
      screenshot: (who, params) =>
        Effect.sync(() => {
          seen.push({ who, params });
          return new McpSchema.CallToolResult({
            content: [
              { type: "image", data: PNG, mimeType: "image/png" },
              { type: "text", text: JSON.stringify(reference) },
            ],
          });
        }),
      missing: () =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            content: [{ type: "text", text: JSON.stringify(reference) }],
          }),
        ),
    };
    const params = { title: "Board", caption: "Empty board" };
    const { listed, replies } = await serve({ answer: Effect.succeed(answered()), proof }, [
      { name: "proof_screenshot", arguments: params },
      { name: "proof_video_start", arguments: { title: "Board", caption: "Completed task" } },
      { name: "proof_video_stop", arguments: {} },
      {
        name: "proof_missing",
        arguments: { title: "Board", kind: "screenshot", reason: "No account" },
      },
    ]);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "proof_screenshot" }),
        expect.objectContaining({ name: "proof_video_start" }),
        expect.objectContaining({ name: "proof_video_stop" }),
        expect.objectContaining({ name: "proof_missing" }),
      ]),
    );
    expect(replies[0]?.result?.structuredContent).toBeUndefined();
    expect(replies[0]?.result?.content?.[0]).toMatchObject({
      type: "image",
      data: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    });
    expect(textOf(replies[0])).toEqual(reference);
    expect(textOf(replies[1])).toEqual(reference);
    expect(seen).toEqual([
      { who: { ...caller, callKey: "call-0" }, params },
      {
        who: { ...caller, callKey: "call-1" },
        params: { title: "Board", caption: "Completed task" },
      },
      { who: { ...caller, callKey: "call-2" } },
    ]);
    expect(textOf(replies[2])).toEqual(reference);
    expect(textOf(replies[3])).toEqual(reference);
    const worker = await serve({ answer: Effect.succeed(answered()) }, [], "worker");
    expect(worker.listed.some((tool) => JSON.stringify(tool).includes('"proof_screenshot"'))).toBe(
      false,
    );
    expect(worker.listed.some((tool) => JSON.stringify(tool).includes('"proof_missing"'))).toBe(
      false,
    );
    expect(worker.listed.some((tool) => JSON.stringify(tool).includes('"proof_video_start"'))).toBe(
      false,
    );
    expect(worker.listed.some((tool) => JSON.stringify(tool).includes('"proof_video_stop"'))).toBe(
      false,
    );
  });
});
