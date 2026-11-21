import { compactMendProofCall, withMendProofResult } from "@mend/agent-protocol";
import {
  compactMendPageCall,
  compactMendScreenCall,
  contentBlockKind,
  claudeBlockData,
  claudeProposedPlan,
  isClaudeSubAgent,
  withClaudeSubAgentResult,
  withClaudeCommandResult,
  withClaudeTaskToolResult,
  withMendPageResult,
  withMendScreenResult,
} from "@mend/agent-protocol";
import type { BackfillTurnInput } from "@mend/db";
import {
  type AgentEventItem,
  isHarnessSetupMessage,
  type NativeIngestCursor,
} from "@mend/domain/workbench";

/**
 * Mode switch, the history half: turn the harness's OWN transcript into
 * durable conversation turns so a PTY-born session picked up in protocol mode
 * shows its past natively — the real content blocks with their real ids, not
 * an inferred rendering. The mapping vocabulary is shared with the live
 * adapters (`contentBlockKind`), so a backfilled turn can never render
 * differently from the same turn streamed live.
 *
 * The cursor is what keeps a second pickup honest: protocol-era turns are in
 * the native transcript too (the harness writes one record whatever the
 * frontend), and they already exist durably under their own provider turn
 * ids — only entries past the cursor may backfill. Claude entries carry
 * stable uuids and fork-on-resume preserves the copied prefix; codex rollouts
 * have no per-entry ids, so the ingested line count stands in. A cursor whose
 * boundary cannot be found in the file backfills nothing — missing history is
 * recoverable (the transcript view still has it); duplicated turns are not.
 *
 * Tool outputs are projected for commands, Mend tools and synchronous sub-agents, as in the live adapter.
 */

export interface NativeBackfillResult {
  readonly turns: ReadonlyArray<BackfillTurnInput>;
  readonly cursor: NativeIngestCursor;
}

/**
 * `finishedOnly`: a live terminal agent's transcript, read while it runs (SLNT-1235). Only turns
 * the harness finished land, and the cursor stops after the last of them, so a turn read while it
 * is still being written lands whole on a later read, never cut short for good. A mode switch
 * reads an agent that has ended, so every turn it holds lands.
 */
export interface NativeBackfillOptions {
  readonly finishedOnly?: boolean;
}

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown, key: string): string | null => {
  if (!isObject(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const type = stringField(part, "type");
      const text = stringField(part, "text");
      return text !== null && (type === "text" || type === "input_text" || type === "output_text")
        ? [text]
        : [];
    })
    .join("\n");
};

/** A call to one of Mend's own tools, kept as the live adapters keep it. */
const compactMend = (item: AgentEventItem): AgentEventItem =>
  compactMendProofCall(compactMendScreenCall(compactMendPageCall(item)));

interface OpenTurn {
  readonly providerTurnId: string;
  readonly input: string;
  readonly items: AgentEventItem[];
}

const noteMendResult = (
  open: OpenTurn | null,
  callId: string | null,
  output: unknown,
  failed: boolean,
  structured?: unknown,
): void => {
  if (open === null || callId === null) return;
  const at = open.items.findIndex((item) => item.providerItemId === callId);
  const call = open.items[at];
  const answered =
    call === undefined
      ? null
      : (withClaudeTaskToolResult(call, output, failed, structured) ??
        withClaudeCommandResult(call, output, failed, structured) ??
        withMendPageResult(call, output, failed) ??
        withMendScreenResult(call, output) ??
        withMendProofResult(call, output) ??
        withClaudeSubAgentResult(call, output, failed));
  if (answered !== null) open.items[at] = answered;
};

/** Claude's line for a turn the person stopped: it ends that turn and opens none. */
const CLAUDE_INTERRUPTED = "[Request interrupted by user";

const backfillClaude = (
  providerSessionId: string,
  jsonl: string,
  cursor: NativeIngestCursor | null,
  options: NativeBackfillOptions,
): NativeBackfillResult => {
  const boundary = cursor?.lastEntryUuid ?? null;
  const entries: Array<JsonObject> = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObject(entry)) entries.push(entry);
    } catch {
      continue;
    }
  }
  const lastUuid = entries.reduce<string | null>(
    (last, entry) => stringField(entry, "uuid") ?? last,
    null,
  );
  const nextCursor: NativeIngestCursor = {
    providerSessionId,
    lastEntryUuid: lastUuid,
    lineCount: entries.length,
  };
  let past = boundary === null;
  if (boundary !== null && !entries.some((entry) => stringField(entry, "uuid") === boundary)) {
    // The recorded boundary is not in this file — a fork that did not copy the
    // prefix. Backfilling would risk duplicating protocol-era turns; skip.
    return { turns: [], cursor: nextCursor };
  }

  const turns: BackfillTurnInput[] = [];
  let open: OpenTurn | null = null;
  // The last entry of the newest turn known finished, and how many turns had landed then.
  let finishedUuid: string | null = boundary;
  let finishedTurns = 0;
  let openFinished = false;
  let latestUuid: string | null = boundary;
  const close = () => {
    if (open !== null && (open.input !== "" || open.items.length > 0)) turns.push(open);
    open = null;
  };
  // A turn is finished once a later one starts, once the person stopped it, or once its newest
  // reply stops for any reason but a tool call. `through` is its last entry.
  const markFinished = (through: string | null) => {
    finishedUuid = through;
    finishedTurns = turns.length + (open === null ? 0 : 1);
  };
  // The live adapter's identity scheme: block ids come from the wire when the
  // block carries one; text/thinking blocks fall back to the message id plus
  // the per-message block cursor.
  const assistantBlockCursors = new Map<string, number>();
  let ordinal = 0;

  for (const entry of entries) {
    const uuid = stringField(entry, "uuid");
    if (!past) {
      if (uuid === boundary) past = true;
      continue;
    }
    if (entry["isMeta"] === true || entry["isSidechain"] === true) continue;
    const type = stringField(entry, "type");
    const message = entry["message"];
    const before = latestUuid;
    if (uuid !== null) latestUuid = uuid;
    if (type === "user") {
      const content = isObject(message) ? message["content"] : null;
      if (Array.isArray(content)) {
        const structured =
          content.filter((part) => stringField(part, "type") === "tool_result").length === 1
            ? (entry["toolUseResult"] ?? entry["tool_use_result"])
            : undefined;
        for (const part of content) {
          if (stringField(part, "type") !== "tool_result" || !isObject(part)) continue;
          noteMendResult(
            open,
            stringField(part, "tool_use_id"),
            part["content"],
            part["is_error"] === true,
            structured,
          );
        }
      }
      const text = textOf(content).trim();
      if (text.startsWith(CLAUDE_INTERRUPTED)) {
        if (open !== null) markFinished(latestUuid);
        openFinished = false;
        continue;
      }
      if (text === "" || text.startsWith("<command-")) continue;
      if (open !== null) markFinished(before);
      openFinished = false;
      close();
      ordinal += 1;
      open = {
        providerTurnId: `native:${uuid ?? `user-${ordinal}`}`,
        input: text,
        items: [],
      };
      continue;
    }
    if (type !== "assistant" || !isObject(message)) continue;
    if (open === null) continue; // history that precedes any user turn — nothing to attach to
    const stopReason = stringField(message, "stop_reason");
    openFinished = stopReason !== null && stopReason !== "tool_use";
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    const messageId = stringField(message, "id");
    for (const block of content) {
      if (!isObject(block)) continue;
      const blockType = stringField(block, "type");
      const streamIndex = (() => {
        if (messageId === null) return open.items.length;
        const next = assistantBlockCursors.get(messageId) ?? 0;
        assistantBlockCursors.set(messageId, next + 1);
        return next;
      })();
      const providerItemId =
        stringField(block, "id") ??
        (messageId === null
          ? `${open.providerTurnId}:block:${streamIndex}`
          : `${messageId}:block:${streamIndex}`);
      const proposal =
        stringField(block, "name") === "ExitPlanMode"
          ? claudeProposedPlan(
              open.providerTurnId,
              providerItemId,
              block["input"],
              entry["parent_tool_use_id"],
            )
          : null;
      if (proposal !== null) open.items.push(proposal);
      open.items.push(
        compactMend({
          providerItemId,
          providerTurnId: open.providerTurnId,
          kind: contentBlockKind(blockType, stringField(block, "name")),
          status: isClaudeSubAgent(stringField(block, "name")) ? "in-progress" : "completed",
          title: blockType === "tool_use" ? stringField(block, "name") : null,
          text: stringField(block, "text") ?? stringField(block, "thinking") ?? null,
          data: claudeBlockData(block, entry),
        }),
      );
    }
  }
  if (open !== null && openFinished) markFinished(latestUuid);
  close();
  if (options.finishedOnly !== true) return { turns, cursor: nextCursor };
  return {
    turns: turns.slice(0, finishedTurns),
    cursor: { providerSessionId, lastEntryUuid: finishedUuid, lineCount: entries.length },
  };
};

/**
 * The text a Codex user item says, without the parts Codex adds itself: its environment block
 * and any other `<…>` wrapper, and its AGENTS.md envelope. Codex 0.160 sends the envelope and the
 * environment block as two parts of one item, which read as one message when joined.
 */
const codexPersonText = (content: unknown): string => {
  if (!Array.isArray(content)) return textOf(content).trim();
  return content
    .flatMap((part) => {
      const type = stringField(part, "type");
      const text = stringField(part, "text")?.trim() ?? "";
      if (text === "" || (type !== "text" && type !== "input_text" && type !== "output_text"))
        return [];
      return text.startsWith("<") || isHarnessSetupMessage(text) ? [] : [text];
    })
    .join("\n")
    .trim();
};

const backfillCodex = (
  providerSessionId: string,
  jsonl: string,
  cursor: NativeIngestCursor | null,
  options: NativeBackfillOptions,
): NativeBackfillResult => {
  const lines = jsonl.split("\n").filter((line) => line.trim() !== "");
  const skip = cursor?.lineCount ?? 0;
  const nextCursor: NativeIngestCursor = {
    providerSessionId,
    lastEntryUuid: null,
    lineCount: lines.length,
  };
  if (skip > lines.length) {
    // The recorded boundary is past this file's end — a fork that did not
    // copy the prefix. Skip rather than risk duplicating protocol-era turns.
    return { turns: [], cursor: nextCursor };
  }

  const turns: BackfillTurnInput[] = [];
  let open: OpenTurn | null = null;
  const close = () => {
    if (open !== null && (open.input !== "" || open.items.length > 0)) turns.push(open);
    open = null;
  };
  let userOrdinal = 0;
  // The line after the newest finished turn, and how many turns had landed then.
  let finishedLines = skip;
  let finishedTurns = 0;
  for (const [index, line] of lines.entries()) {
    let entry: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }
    // Codex ends every turn, done or stopped, with one of these.
    if (entry["type"] === "event_msg" && isObject(entry["payload"]) && index >= skip) {
      const event = stringField(entry["payload"], "type");
      if (event === "task_complete" || event === "turn_aborted") {
        finishedLines = index + 1;
        finishedTurns = turns.length + (open === null ? 0 : 1);
      }
      continue;
    }
    if (entry["type"] !== "response_item" || !isObject(entry["payload"])) continue;
    const payload = entry["payload"];
    const payloadType = stringField(payload, "type");
    if (payloadType === "message" && stringField(payload, "role") === "user") {
      userOrdinal += 1; // count from file start — the id must be stable across pickups
      if (index < skip) continue;
      // Codex writes its environment and instruction blocks as user items, its AGENTS.md one
      // as a whole "# AGENTS.md instructions …" envelope: keep real turns only.
      const text = codexPersonText(payload["content"]);
      if (text === "") continue;
      close();
      open = { providerTurnId: `native:user:${userOrdinal}`, input: text, items: [] };
      continue;
    }
    if (index < skip || open === null) continue;
    if (payloadType === "message" && stringField(payload, "role") === "assistant") {
      const text = textOf(payload["content"]).trim();
      if (text === "") continue;
      open.items.push({
        providerItemId: `rollout:${index}`,
        providerTurnId: open.providerTurnId,
        kind: "assistant-message",
        status: "completed",
        title: null,
        text,
        data: payload,
      });
      continue;
    }
    if (payloadType === "reasoning") {
      const summary = payload["summary"];
      const text = Array.isArray(summary)
        ? summary
            .flatMap((part) => {
              const partText = stringField(part, "text");
              return stringField(part, "type") === "summary_text" && partText !== null
                ? [partText]
                : [];
            })
            .join("\n")
            .trim()
        : "";
      if (text === "") continue;
      open.items.push({
        providerItemId: `rollout:${index}`,
        providerTurnId: open.providerTurnId,
        kind: "reasoning",
        status: "completed",
        title: null,
        text,
        data: payload,
      });
      continue;
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const name = stringField(payload, "name") ?? "tool";
      const shell = name === "exec_command" || name === "shell";
      open.items.push(
        compactMend({
          providerItemId: stringField(payload, "call_id") ?? `rollout:${index}`,
          providerTurnId: open.providerTurnId,
          kind: shell ? "command-execution" : "tool-call",
          status: "completed",
          title: name,
          text: null,
          data: payload,
        }),
      );
      continue;
    }
    if (payloadType === "function_call_output") {
      noteMendResult(open, stringField(payload, "call_id"), payload["output"], false);
    }
  }
  close();
  if (options.finishedOnly !== true) return { turns, cursor: nextCursor };
  return {
    turns: turns.slice(0, finishedTurns),
    cursor: { providerSessionId, lastEntryUuid: null, lineCount: finishedLines },
  };
};

/**
 * Parse the harness's native transcript into backfill turns past the cursor.
 * Null for a harness without cross-mode support.
 */
export const backfillFromNative = (
  harness: string,
  providerSessionId: string,
  nativeJsonl: string,
  cursor: NativeIngestCursor | null,
  options: NativeBackfillOptions = {},
): NativeBackfillResult | null =>
  harness === "claude"
    ? backfillClaude(providerSessionId, nativeJsonl, cursor, options)
    : harness === "codex"
      ? backfillCodex(providerSessionId, nativeJsonl, cursor, options)
      : null;

/**
 * A cursor that marks the WHOLE transcript as already durably projected —
 * stamped at protocol-process harvest, when every entry the file holds went
 * through the live adapter. Only genuinely PTY-era turns ever backfill.
 */
export const cursorAtEndOf = (
  harness: string,
  providerSessionId: string,
  nativeJsonl: string,
): NativeIngestCursor | null => {
  const parsed = backfillFromNative(harness, providerSessionId, nativeJsonl, null);
  return parsed === null ? null : parsed.cursor;
};
