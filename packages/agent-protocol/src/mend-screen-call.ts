import {
  type AgentEventItem,
  SCREEN_LIMITS,
  SCREEN_LOOK_TOOL,
  ScreenActionNote,
  withoutTypedText,
} from "@mend/domain/workbench";
import { Option, Schema } from "effect";

import { CODEX_TIMING, TOOL_INPUT_ENVELOPE, toolIdentityOf } from "./mend-page-call.ts";
import {
  MEND_SCREEN_CALL_FIELD,
  MendScreenCall,
  type MendScreenTool,
  mendScreenToolOf,
  ScreenActParams,
  ScreenLookParams,
  ScreenToolText,
} from "./mend-screen-tools.ts";

// A stored screen call keeps no frame and no typed text (ADR 0020, "Compaction and typed text"):
// its arguments only as its tool's schema rebuilds them, and its answer only the `mendScreenCall`
// marker. Arguments the schema does not decode are dropped whole, never salvaged.

type JsonObject = Readonly<Record<string, unknown>>;

/** Set beside arguments stored as null because they did not decode against their tool's schema. */
export const MEND_SCREEN_ARGUMENTS_DROPPED = "mendScreenArgumentsDropped";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const MAX_ENCODINGS = 8;

/** `args` read out of the JSON strings and Mend's envelopes around it, up to `MAX_ENCODINGS`. */
const unwrapped = (args: unknown, depth = 0): unknown => {
  if (depth === MAX_ENCODINGS) return args;
  if (typeof args === "string") return unwrapped(parsed(args), depth + 1);
  const envelope =
    isObject(args) && Object.keys(args).length === 1 ? args[TOOL_INPUT_ENVELOPE] : undefined;
  return isObject(envelope) && typeof envelope["value"] === "string"
    ? unwrapped(envelope["value"], depth + 1)
    : args;
};

/** A batch as Mend stores it, so a stored call compacts again to itself. */
const StoredScreenActParams = Schema.Struct({
  actions: Schema.Array(ScreenActionNote.fields.action).check(
    Schema.isBetweenLength(1, SCREEN_LIMITS.batchActions),
  ),
});
export type StoredScreenActParams = typeof StoredScreenActParams.Type;

// Decoding keeps only the fields each schema names.
const decodeAct = Schema.decodeUnknownOption(ScreenActParams);
const decodeStoredAct = Schema.decodeUnknownOption(StoredScreenActParams);
const decodeLook = Schema.decodeUnknownOption(ScreenLookParams);

/**
 * A screen_act's arguments as Mend stores them: the batch `ScreenActParams` decodes, with each
 * typed text as its length; null when they do not decode.
 */
export const screenArgumentsWithoutText = (args: unknown): StoredScreenActParams | null => {
  const value = unwrapped(args);
  const act = decodeAct(value);
  return Option.isSome(act)
    ? { actions: act.value.actions.map(withoutTypedText) }
    : Option.getOrNull(decodeStoredAct(value));
};

/** A call's arguments as Mend stores them for `tool`; null when its schema does not decode them. */
export const storedScreenArguments = (tool: MendScreenTool, args: unknown): unknown =>
  tool === SCREEN_LOOK_TOOL
    ? Option.getOrNull(decodeLook(unwrapped(args)))
    : screenArgumentsWithoutText(args);

const argumentFields = (tool: MendScreenTool, field: string, args: unknown): JsonObject => {
  const stored = storedScreenArguments(tool, args);
  return stored === null
    ? { [field]: null, [MEND_SCREEN_ARGUMENTS_DROPPED]: true }
    : { [field]: stored };
};

const isScreenText = Schema.is(ScreenToolText);

/** The tool's text in a result as a harness keeps it: its blocks, its JSON, or Codex's rollout. */
export const screenToolTextIn = (output: unknown): ScreenToolText | null => {
  if (typeof output === "string") return screenToolTextIn(parsed(output.replace(CODEX_TIMING, "")));
  if (Array.isArray(output)) {
    for (const part of output) {
      const found = screenToolTextIn(part);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(output)) return null;
  if (isScreenText(output)) return output;
  return (
    screenToolTextIn(output["structuredContent"]) ??
    screenToolTextIn(output["content"]) ??
    screenToolTextIn(output["text"])
  );
};

/** With no text, as when the call never reached Mend, whether its input landed is unknown. */
const markerOf = (output: unknown): MendScreenCall => {
  const text = screenToolTextIn(output);
  return text === null
    ? { receipt: null, outcome: "outcome_unknown", refusal: null }
    : { receipt: text.receipt, outcome: text.outcome, refusal: text.refusal ?? null };
};

const isMarker = Schema.is(MendScreenCall);

/** The data of a call to one of Mend's screen tools, and which; null for any other item. */
const screenCallOf = (
  item: AgentEventItem,
): { readonly data: JsonObject; readonly tool: MendScreenTool } | null => {
  const data = item.data;
  if (item.kind !== "tool-call" || !isObject(data)) return null;
  const identity = toolIdentityOf(data);
  const tool = identity === null ? null : mendScreenToolOf(identity);
  return tool === null ? null : { data, tool };
};

// Codex keeps the answer on the item as `result`, or `error` when the call never reached Mend; an
// error can quote the arguments, so neither is kept.
const compacted = (
  item: AgentEventItem,
  { data, tool }: { readonly data: JsonObject; readonly tool: MendScreenTool },
  answered: unknown,
): AgentEventItem => {
  const {
    result,
    error,
    input,
    arguments: args,
    [MEND_SCREEN_CALL_FIELD]: kept,
    [MEND_SCREEN_ARGUMENTS_DROPPED]: _dropped,
    ...rest
  } = data;
  const marker =
    answered !== undefined || isObject(result) || isObject(error)
      ? markerOf(answered ?? result)
      : isMarker(kept)
        ? kept
        : null;
  return {
    ...item,
    // A call Mend refused, or that never reached it, failed as each harness reports it.
    status: marker === null || marker.receipt !== null ? item.status : "failed",
    text: null,
    data: {
      ...rest,
      ...(input === undefined ? {} : argumentFields(tool, "input", input)),
      ...(args === undefined ? {} : argumentFields(tool, "arguments", args)),
      ...(marker === null ? {} : { [MEND_SCREEN_CALL_FIELD]: marker }),
    },
  };
};

export const compactMendScreenCall = (item: AgentEventItem): AgentEventItem => {
  const call = screenCallOf(item);
  return call === null ? item : compacted(item, call, undefined);
};

/** The call `item` once its answer `output` came, as Claude and the native transcripts keep it. */
export const withMendScreenResult = (
  item: AgentEventItem,
  output: unknown,
): AgentEventItem | null => {
  const call = screenCallOf(item);
  return call === null ? null : compacted(item, call, output);
};

/** A request detail's input, a screen tool's kept as a stored call keeps its arguments. */
export const requestInputWithoutTypedText = (toolName: string, input: unknown): JsonObject => {
  const tool = mendScreenToolOf({ name: toolName, namespace: null });
  return tool === null ? { input } : argumentFields(tool, "input", input);
};
