import {
  SCREEN_SIZE,
  ScreenActParams,
  ScreenLookParams,
  type ScreenToolInput,
  type ScreenToolRefusal,
  type ScreenToolText,
} from "@mend/agent-protocol";
import { UsersRepo } from "@mend/db";
import {
  SCREEN_ACT_TOOL,
  SCREEN_LIMITS,
  SCREEN_LOOK_TOOL,
  type ScreenActionNote,
  type ScreenDegraded,
  type ScreenEndReason,
  type ScreenLapse,
  type ScreenLogEntry,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import * as Context from "effect/Context";

import type { ScreenStartError } from "../screen/screen-host.ts";
import { type ScreenCallAnswer, Screens, type ScreenState } from "../screen/screens.ts";
import { asCaller, type Caller } from "./caller.ts";

/** What a screen tool answers: the service's answer, or why it could not ask the service. */
type ToolAnswer =
  | ScreenCallAnswer
  | { readonly _tag: "StartFailed"; readonly message: string }
  | { readonly _tag: "NotServedHere" };

type NameOf = (userId: string) => string;

const NO_SCREEN =
  "This session's workspace has no screen. The project's owner turns it on in the project's Environment.";

const PAUSED_MINUTES = SCREEN_LIMITS.pausedTimeoutMs / 60_000;

const LAPSE: Record<ScreenLapse, string> = {
  "lease-lapsed": "the person's viewer stopped answering",
  disconnected: "the person's connection dropped",
  revoked: "the person's access was revoked",
  restart: "Mend restarted",
};
const DEGRADED: Record<ScreenDegraded, string> = {
  "client-failed": "an app on it failed to start",
  "decoder-refused": "Mend could not read its stream",
};
const ENDED: Record<ScreenEndReason, string> = {
  idle: `no one used it for ${SCREEN_LIMITS.idleStopMs / 60_000} minutes`,
  "session-stopped": "the session stopped",
  "process-exited": "its process exited",
  "workspace-ended": "the workspace ended",
};

const REFUSED: Record<
  Exclude<ScreenToolRefusal, "no_screen" | "held" | "unsupported_key" | "start_failed">,
  string
> = {
  busy: "Another call on this screen is still running. Mend sent no input; wait for its answer, then call again.",
  look_first:
    "The screen was handed back to you. Call screen_look before screen_act; Mend sent no input.",
  call_reused:
    "This call's key already ran with other arguments on this screen. Mend sent no input; call the tool again.",
  observation_unavailable:
    "This call already ran, and Mend no longer has its frame. Call screen_look to see the screen now.",
  unattributed_caller:
    "This call did not come from the session's current agent process, so Mend sent no input.",
  owner_only:
    "Only turns the session's owner sends drive its screen, and someone else sent this one. Mend sent no input.",
  not_served_here:
    "This session's tools reached a Mend worker process, and only Mend's API process drives screens. Mend sent no input.",
};

const clock = (at: Date) => `${at.toISOString().slice(11, 19)} UTC`;

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One entry of the screen log as the agent reads it; the agent's own entries say nothing. */
const sentenceOf = (entry: ScreenLogEntry, nameOf: NameOf): ReadonlyArray<string> => {
  const who = entry.actor._tag === "Person" ? nameOf(entry.actor.userId) : "Mend";
  const at = clock(entry.at);
  const body = entry.body;
  switch (body._tag) {
    case "Looked":
    case "Acted":
      return [];
    case "Started":
      return [`The screen started at ${at}.`];
    case "Taken":
      return [`${who} took the screen at ${at}.`];
    case "HandedBack":
      return entry.actor._tag === "Person"
        ? [`${who} handed the screen back at ${at}.`]
        : [
            `Mend handed the screen back at ${at}, after its input was paused ${PAUSED_MINUTES} minutes.`,
          ];
    case "PersonInput":
      return [
        `${who} put input on the screen by ${at}: ${counted(body.clicks, "click")}, ${counted(body.keys, "key")}, ${counted(body.pastes, "paste")}.`,
      ];
    case "Paused":
      return [`The screen's input paused at ${at}: ${LAPSE[body.reason]}.`];
    case "FramesNotKept":
      return [
        `Mend stopped keeping this screen's frames at ${at}: the ${body.budget}'s frame budget is reached.`,
      ];
    case "Degraded":
      return [`The screen degraded at ${at}: ${DEGRADED[body.reason]}.`];
    case "Ended":
      return [`The screen ended at ${at}: ${ENDED[body.reason]}.`];
    case "Restarted":
      return [
        `Mend started the screen over at ${at}, its apps with it: it could not sign in to it again after Mend restarted.`,
      ];
  }
};

const inputOf = ({ screen, takenAt }: ScreenState, nameOf: NameOf): ScreenToolInput => {
  const input = screen.input;
  switch (input._tag) {
    case "Agent":
    case "AwaitingAgent":
      return "agent";
    case "Fencing":
      return { person: nameOf(input.by), since: null };
    case "Person":
      return { person: nameOf(input.userId), since: takenAt?.toISOString() ?? null };
    case "Paused":
      return { paused: LAPSE[input.reason], since: input.since.toISOString() };
  }
};

const point = (at: { readonly x: number; readonly y: number }) => `${at.x},${at.y}`;

const actionOf = ({ action }: ScreenActionNote): string => {
  switch (action.kind) {
    case "click":
      return `click ${point(action.at)} ${action.button ?? "left"}${(action.count ?? 1) > 1 ? ` x${action.count}` : ""}`;
    case "move":
      return `move ${point(action.to)}`;
    case "drag":
      return `drag ${point(action.from)} to ${point(action.to)}`;
    case "scroll":
      return `scroll ${point(action.at)} dx ${action.dx} dy ${action.dy}`;
    case "type":
      return `type ${counted(action.length, "character")}`;
    case "key":
      return `key ${action.combo}`;
    case "wait":
      return `wait ${action.ms} ms`;
  }
};

const heldMessage = (input: ScreenToolInput | undefined): string => {
  if (input === undefined || input === "agent") {
    return "A person is taking the screen's input. Mend sent no input; look again in a moment.";
  }
  if ("person" in input) {
    return `${input.person} holds the screen's input. Mend sent no input; look again once they hand it back.`;
  }
  return `The screen's input is paused: ${input.paused}. Mend sent no input. The screen returns to you ${PAUSED_MINUTES} minutes after it paused, unless the session's owner takes over first.`;
};

const answeredMessage = (answer: Extract<ToolAnswer, { readonly _tag: "Answered" }>): string => {
  const skipped = answer.actions.filter((note) => note.result !== "done").length;
  const frame =
    answer.outcome === "applied"
      ? "The image is the screen once it went quiet."
      : `${counted(skipped, "action")} did not run. The image is the screen once the batch stopped.`;
  return answer.frameId === null
    ? `${frame} Mend kept no frame of it: the screen's frame budget is reached.`
    : frame;
};

/** The tool's text: what happened, the screen as it is now, and what people did since. */
const screenToolText = (
  answer: ToolAnswer,
  state: ScreenState | null,
  nameOf: NameOf,
): ScreenToolText => {
  const screen =
    state === null
      ? null
      : { display: `:${state.screen.display}`, size: SCREEN_SIZE, input: inputOf(state, nameOf) };
  const refused = (refusal: ScreenToolRefusal, message: string): ScreenToolText => ({
    screen,
    receipt: null,
    frameId: null,
    outcome: "refused",
    refusal,
    message,
  });
  switch (answer._tag) {
    case "Answered":
      return {
        screen,
        receipt: answer.receipt,
        frameId: answer.frameId,
        outcome: answer.outcome,
        actions: answer.actions.map((note) => ({ action: actionOf(note), result: note.result })),
        sinceLastLook: answer.sinceLastLook.flatMap((entry) => sentenceOf(entry, nameOf)),
        message: answeredMessage(answer),
      };
    case "NoEntry":
      return {
        screen,
        receipt: null,
        frameId: null,
        outcome: answer.outcome,
        message:
          answer.outcome === "refused"
            ? "Mend refused this call before it sent any input."
            : "The screen stopped during this call, so part of its input may have landed. Call screen_look to see the screen now.",
      };
    case "UnsupportedKey":
      return refused(
        "unsupported_key",
        `No X keysym is named "${answer.key}". Mend sent no input. Name keys as X does, such as Return, Tab, Escape, BackSpace, Left, F5 or ctrl+shift+t.`,
      );
    case "StartFailed":
      return refused("start_failed", `The screen did not start: ${answer.message}.`);
    case "NotServedHere":
      return refused("not_served_here", REFUSED.not_served_here);
    case "Refused": {
      const { refusal } = answer;
      if (refusal === "no_screen") return refused(refusal, NO_SCREEN);
      if (refusal === "held") return refused(refusal, heldMessage(screen?.input));
      return refused(refusal, REFUSED[refusal]);
    }
  }
};

/**
 * A frame goes as an image block beside the text. Codex hands a model only the
 * `structuredContent` of a result that has one (codex-rs `protocol/src/models.rs`,
 * `as_function_call_output_payload`), so a result with a frame carries none.
 */
const resultOf = (answer: ToolAnswer, text: ScreenToolText): McpSchema.CallToolResult => {
  const said: McpSchema.ContentBlock = { type: "text", text: JSON.stringify(text) };
  return answer._tag === "Answered"
    ? new McpSchema.CallToolResult({
        content: [{ type: "image", data: answer.png, mimeType: "image/png" }, said],
      })
    : new McpSchema.CallToolResult({ content: [said], structuredContent: text, isError: true });
};

const toolJson = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return Schema.decodeUnknownSync(McpSchema.ToolJson)(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
};

const LOOK_DESCRIPTION = `See this session's screen: an X display, ${SCREEN_SIZE}, in the workspace. An app you start on its display (the answer names it; \`chromium <url>\` from your shell opens there) shows on it. Answers a PNG of the screen once it goes quiet, who holds its input, and what people did on it since your last look. Look before screen_act, and again after a person hands the screen back.`;

const ACT_DESCRIPTION = `Act on this session's screen, ${SCREEN_SIZE} with 0,0 at the top left, in one batch of at most ${SCREEN_LIMITS.batchActions} actions run in order: click, move, drag, scroll (wheel steps), type (at most ${SCREEN_LIMITS.typeChars} characters), key (an X key combo such as ctrl+l or Return) and wait (at most ${SCREEN_LIMITS.waitMs} ms). A batch runs at most ${SCREEN_LIMITS.batchMs / 1000} s, and actions past it are skipped. Answers a PNG of the screen once it goes quiet and each action's result. A person watching may take over at any moment: the rest of the batch is skipped, and calls answer held until they hand the screen back. Call screen_look first.`;

type Call =
  | { readonly tool: typeof SCREEN_LOOK_TOOL }
  | { readonly tool: typeof SCREEN_ACT_TOOL; readonly params: ScreenActParams };

const decodeAct = Schema.decodeUnknownEffect(ScreenActParams);

/** Both tools on Mend's MCP server, each call answered by `answer`. */
const screenToolsLayer = <R>(
  answer: (caller: Caller, call: Call) => Effect.Effect<McpSchema.CallToolResult, never, R>,
): Layer.Layer<never, never, R> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const context = yield* Effect.context<R>();
      const run = (call: Call) =>
        asCaller((_: unknown, caller: Caller) =>
          answer(caller, call).pipe(Effect.provideContext(context)),
        );
      // D9 (a1): both read-only, as html_render is, so Codex runs them without asking; a person
      // watching can take over at any moment instead.
      const annotations = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      };
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: SCREEN_LOOK_TOOL,
          title: "Look at the screen",
          description: LOOK_DESCRIPTION,
          inputSchema: toolJson(ScreenLookParams),
          annotations,
        }),
        annotations: Context.empty(),
        handle: run({ tool: SCREEN_LOOK_TOOL }),
      });
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: SCREEN_ACT_TOOL,
          title: "Act on the screen",
          description: ACT_DESCRIPTION,
          inputSchema: toolJson(ScreenActParams),
          annotations,
        }),
        annotations: Context.empty(),
        handle: (payload: unknown) =>
          decodeAct(payload).pipe(
            Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
            Effect.flatMap((params) => run({ tool: SCREEN_ACT_TOOL, params })(payload)),
          ),
      });
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));

/** Where `Screens` runs: the process that serves HTTP and holds every hand. */
export const ScreenToolsLive: Layer.Layer<never, never, Screens | UsersRepo> = screenToolsLayer(
  (caller, call) =>
    Effect.gen(function* () {
      const screens = yield* Screens;
      const users = yield* UsersRepo;
      const answer: ToolAnswer = yield* (
        call.tool === SCREEN_LOOK_TOOL ? screens.look(caller) : screens.act(caller, call.params)
      ).pipe(
        Effect.catchTag("ScreenStartError", (error: ScreenStartError) =>
          Effect.succeed<ToolAnswer>({ _tag: "StartFailed", message: error.message }),
        ),
      );
      const state = yield* screens.state(caller.sessionId);
      const people = new Set<string>();
      const input = state?.screen.input;
      if (input?._tag === "Person") people.add(input.userId);
      if (input?._tag === "Fencing") people.add(input.by);
      if (answer._tag === "Answered") {
        for (const { actor } of answer.sinceLastLook) {
          if (actor._tag === "Person") people.add(actor.userId);
        }
      }
      const named = new Map<string, string>(
        (yield* users.byIds([...people])).map((user) => [user.id, user.name]),
      );
      const nameOf: NameOf = (userId) => named.get(userId) || "someone";
      return resultOf(answer, screenToolText(answer, state, nameOf));
    }),
);

/**
 * A worker-only process (MEND_MODE=worker) builds no `Screens`, yet serves the channel of every
 * session it launched or resumed: its tools say where screens are driven.
 */
export const ScreenToolsElsewhereLive: Layer.Layer<never> = screenToolsLayer(() => {
  const answer: ToolAnswer = { _tag: "NotServedHere" };
  return Effect.succeed(
    resultOf(
      answer,
      screenToolText(answer, null, () => "someone"),
    ),
  );
});
