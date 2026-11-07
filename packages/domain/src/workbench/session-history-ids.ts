import { Schema } from "effect";

/** Identity of an immutable pairing of native history and a worktree checkpoint. */
export const TurnBoundaryId = Schema.String.pipe(Schema.brand("TurnBoundaryId"));
export type TurnBoundaryId = typeof TurnBoundaryId.Type;
/** Identity of a person's durable keyed history command. */
export const HistoryOperationId = Schema.String.pipe(Schema.brand("HistoryOperationId"));
export type HistoryOperationId = typeof HistoryOperationId.Type;
