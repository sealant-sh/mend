import type { AgentEventItem } from "@mend/domain/workbench";
import { Schema } from "effect";

import { CODEX_TIMING, TOOL_INPUT_ENVELOPE, toolIdentityOf } from "./mend-page-call.ts";
import {
  isMendScreenTool,
  MEND_SCREEN_CALL_FIELD,
  MendScreenCall,
  ScreenToolText,
} from "./mend-screen-tools.ts";

// A stored screen call keeps no frame and no typed text (ADR 0020, "Compaction and typed text"):
// its arguments keep each text's length, and its answer only the `mendScreenCall` marker.

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * `value` with every `text` string, at any depth, as its length; undefined when a `text` holds
 * anything else, a string holds encoded JSON, or a tool input envelope sits inside, since Mend
 * cannot tell what typed text those carry.
 */
const withTextLengths = (value: unknown): unknown => {
  if (typeof value === "string") {
    const decoded = parsed(value);
    return typeof decoded === "object" && decoded !== null ? undefined : value;
  }
  if (Array.isArray(value)) {
    const kept = value.map(withTextLengths);
    return kept.includes(undefined) ? undefined : kept;
  }
  if (!isObject(value)) return value;
  const kept: Array<readonly [string, unknown]> = [];
  for (const [key, field] of Object.entries(value)) {
    if (key === TOOL_INPUT_ENVELOPE) return undefined;
    if (key === "text") {
      if (typeof field !== "string") return undefined;
      kept.push(["length", field.length]);
      continue;
    }
    const keptField = withTextLengths(field);
    if (keptField === undefined) return undefined;
    kept.push([key, keptField]);
  }
  return Object.fromEntries(kept);
};

/** The JSON Mend's own envelope carries, when `args` is that envelope and nothing else. */
const envelopedJson = (args: JsonObject): string | null => {
  const envelope = args[TOOL_INPUT_ENVELOPE];
  return Object.keys(args).length === 1 &&
    isObject(envelope) &&
    envelope["format"] === "json" &&
    typeof envelope["value"] === "string"
    ? envelope["value"]
    : null;
};

/**
 * A screen call's arguments without typed text, in each form a harness writes them: an object, a
 * JSON string of one, or Mend's own envelope around one. Arguments in any other shape are dropped.
 */
export const screenArgumentsWithoutText = (args: unknown): unknown => {
  if (typeof args === "string") {
    const value = parsed(args);
    const kept = isObject(value) ? screenArgumentsWithoutText(value) : null;
    return kept === null ? null : JSON.stringify(kept);
  }
  if (!isObject(args)) return null;
  if (TOOL_INPUT_ENVELOPE in args) {
    const value = envelopedJson(args);
    return value === null
      ? null
      : {
          [TOOL_INPUT_ENVELOPE]: {
            format: "json",
            value: screenArgumentsWithoutText(value) ?? "{}",
          },
        };
  }
  return withTextLengths(args) ?? null;
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

/** The data of a call to one of Mend's screen tools; null for any other item. */
const screenCallData = (item: AgentEventItem): JsonObject | null => {
  const data = item.data;
  if (item.kind !== "tool-call" || !isObject(data)) return null;
  const identity = toolIdentityOf(data);
  return identity !== null && isMendScreenTool(identity) ? data : null;
};

// Codex keeps the answer on the item as `result`, or `error` when the call never reached Mend; an
// error can quote the arguments, so neither is kept.
const compacted = (item: AgentEventItem, data: JsonObject, answered: unknown): AgentEventItem => {
  const { result, error, input, arguments: args, [MEND_SCREEN_CALL_FIELD]: kept, ...rest } = data;
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
      ...(input === undefined ? {} : { input: screenArgumentsWithoutText(input) }),
      ...(args === undefined ? {} : { arguments: screenArgumentsWithoutText(args) }),
      ...(marker === null ? {} : { [MEND_SCREEN_CALL_FIELD]: marker }),
    },
  };
};

export const compactMendScreenCall = (item: AgentEventItem): AgentEventItem => {
  const data = screenCallData(item);
  return data === null ? item : compacted(item, data, undefined);
};

/** The call `item` once its answer `output` came, as Claude and the native transcripts keep it. */
export const withMendScreenResult = (
  item: AgentEventItem,
  output: unknown,
): AgentEventItem | null => {
  const data = screenCallData(item);
  return data === null ? null : compacted(item, data, output);
};

export const requestInputWithoutTypedText = (toolName: string, input: unknown): unknown =>
  isMendScreenTool({ name: toolName, namespace: null }) ? screenArgumentsWithoutText(input) : input;
