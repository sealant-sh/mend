import { Schema } from "effect";

import { AgentTurnId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** Stable identity of one person's selected fork context. */
export const MergeBackId = Schema.String.pipe(Schema.brand("MergeBackId"));
export type MergeBackId = typeof MergeBackId.Type;

/** Immutable context assigned to one parent turn; never an author, payer or file operation. */
export const MergeBackContext = Schema.Struct({
  id: MergeBackId,
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
  sourceTurnId: AgentTurnId,
  sourceOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sourceRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summary: Schema.String.check(Schema.isMaxLength(32_000)),
  createdAt: Timestamp,
});
export type MergeBackContext = typeof MergeBackContext.Type;

/** Add context only at native dispatch, keeping the person's displayed message unchanged. */
export function messageWithMergeBack(
  input: string,
  contexts: ReadonlyArray<MergeBackContext>,
): string {
  if (contexts.length === 0) return input;
  return [
    ...contexts.flatMap((context) => [
      "Context handoff (merge_back / fork_delta_summary):",
      `From fork ${context.sourceSessionId}, through turn ${context.sourceTurnId}.`,
      "Use this recorded fork context with the user's message. No files were merged or copied.",
      context.summary,
      "",
    ]),
    "User message:",
    input,
  ].join("\n");
}
