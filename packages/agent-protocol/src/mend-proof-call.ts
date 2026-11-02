import type { AgentEventItem } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

import { CODEX_TIMING, toolIdentityOf } from "./mend-page-call.ts";
import { mendProofToolOf, ProofToolText } from "./mend-proof-tools.ts";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decodeText = Schema.decodeUnknownOption(ProofToolText);
export const proofToolTextIn = (value: unknown, depth = 0): ProofToolText | null => {
  if (depth >= 12) return null;
  if (typeof value === "string") {
    try {
      return proofToolTextIn(JSON.parse(value.replace(CODEX_TIMING, "")), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = proofToolTextIn(part, depth + 1);
      if (text !== null) return text;
    }
    return null;
  }
  const text = decodeText(value);
  if (Option.isSome(text)) return text.value;
  return isObject(value)
    ? proofToolTextIn(value["structuredContent"] ?? value["content"] ?? value["text"], depth + 1)
    : null;
};

export const MEND_PROOF_CALL_FIELD = "mendProofCall";

const compacted = (item: AgentEventItem, output?: unknown): AgentEventItem | null => {
  const data = item.data;
  if (item.kind !== "tool-call" || !isObject(data)) return null;
  const identity = toolIdentityOf(data);
  if (identity === null || mendProofToolOf(identity) === null) return null;
  const {
    result,
    error: _error,
    output: _output,
    content: _content,
    [MEND_PROOF_CALL_FIELD]: kept,
    ...rest
  } = data;
  const marker = proofToolTextIn(output ?? result ?? kept);
  return {
    ...item,
    text: null,
    data: { ...rest, ...(marker === null ? {} : { [MEND_PROOF_CALL_FIELD]: marker }) },
  };
};

/** Proof tool transcripts keep the artifact reference and discard image blocks. */
export const compactMendProofCall = (item: AgentEventItem): AgentEventItem =>
  compacted(item) ?? item;
export const withMendProofResult = (item: AgentEventItem, output: unknown): AgentEventItem | null =>
  compacted(item, output);
