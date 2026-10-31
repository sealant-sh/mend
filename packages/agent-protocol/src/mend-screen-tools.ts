import {
  SCREEN_ACT_TOOL,
  SCREEN_LIMITS,
  SCREEN_LOOK_TOOL,
  ScreenActionResult,
  ScreenActParams,
  ScreenCallOutcome,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { Tool } from "effect/ai";

import { isMendTool, type ToolIdentity } from "./mend-page-call.ts";

// The screen tools' catalog (ADR 0020): Mend's MCP server and the compactors read it alike.

export { ScreenActParams };
export const ScreenLookParams = Tool.EmptyParams;

export const isMendScreenTool = (identity: ToolIdentity): boolean =>
  isMendTool(SCREEN_LOOK_TOOL, identity) || isMendTool(SCREEN_ACT_TOOL, identity);

export const ScreenToolRefusal = Schema.Literals([
  "no_screen",
  "held",
  "busy",
  "look_first",
  "call_reused",
  "observation_unavailable",
  "unattributed_caller",
  "owner_only",
  "unsupported_key",
  "start_failed",
  "not_served_here",
]);
export type ScreenToolRefusal = typeof ScreenToolRefusal.Type;

/** What links a call's screen log entry to the tool call that holds it. */
export const ScreenToolReceipt = Schema.Struct({
  screenId: Schema.String,
  seq: Schema.Int,
  callKey: Schema.String,
});
export type ScreenToolReceipt = typeof ScreenToolReceipt.Type;

export const SCREEN_SIZE = `${SCREEN_LIMITS.width}x${SCREEN_LIMITS.height}` as const;

/** `since` is an ISO time; a person's is null while their take over still fences the agent. */
export const ScreenToolInput = Schema.Union([
  Schema.Literal("agent"),
  Schema.Struct({ person: Schema.String, since: Schema.NullOr(Schema.String) }),
  Schema.Struct({ paused: Schema.String, since: Schema.String }),
]);
export type ScreenToolInput = typeof ScreenToolInput.Type;

/** The text block beside the PNG; a result without one carries it as `structuredContent` too. */
export const ScreenToolText = Schema.Struct({
  /** Null when the session has no screen, or this process cannot read it. */
  screen: Schema.NullOr(
    Schema.Struct({
      display: Schema.String,
      size: Schema.Literal(SCREEN_SIZE),
      input: ScreenToolInput,
    }),
  ),
  /** Null when the call left no entry in the screen log. */
  receipt: Schema.NullOr(ScreenToolReceipt),
  /** Null when Mend kept no frame for the call. */
  frameId: Schema.NullOr(Schema.String),
  outcome: ScreenCallOutcome,
  refusal: Schema.optionalKey(ScreenToolRefusal),
  actions: Schema.optionalKey(
    Schema.Array(Schema.Struct({ action: Schema.String, result: ScreenActionResult })),
  ),
  /** People's and Mend's entries since the agent's previous look, one sentence each. */
  sinceLastLook: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.String,
});
export type ScreenToolText = typeof ScreenToolText.Type;
