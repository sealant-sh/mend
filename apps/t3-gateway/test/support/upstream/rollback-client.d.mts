import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2ThreadProjection,
} from "@mend/t3-contracts";
import type * as Option from "effect/Option";

export interface UndoEntry {
  readonly kind: "message";
  readonly projectedItem?: { readonly visibility: "local" | "inherited" | "synthetic" };
  readonly message: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly runId: string | null;
    readonly inputIntent?: string | null;
  };
}
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<UndoEntry>;
  readonly checkpoints: ReadonlyArray<{
    readonly status: string;
    readonly runId: string | null;
    readonly checkpointTurnCount: number;
  }>;
  readonly threadStartCheckpointReady: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number>;
  readonly unsettledRunId?: string | null;
}): Map<string, number>;
export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  count: number,
): OrchestrationV2Checkpoint | undefined;
export function rollbackWaiter(owners: {
  readonly environmentThreadDetails: { readonly stateAtom: (ref: unknown) => unknown };
  readonly appAtomRegistry: {
    readonly get: (atom: unknown) => {
      readonly data: Option.Option<OrchestrationV2ThreadProjection>;
    };
    readonly subscribe: (atom: unknown, inspect: () => void) => () => void;
  };
  readonly Option: { readonly getOrNull: typeof Option.getOrNull };
}): (
  ref: unknown,
  count: number,
  requestId: string,
  revert: () => Promise<void>,
  timeoutMs?: number,
) => Promise<void>;
