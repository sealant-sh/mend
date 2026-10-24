import { Data } from "effect";

import {
  AgentSteerDeliveryError,
  AgentSteerRefusedError,
  type AgentProtocolError,
  type AgentSteerInput,
} from "./types.ts";

export class CodexRpcRejected extends Data.TaggedError("CodexRpcRejected")<{
  readonly code: number | null;
  readonly message: string;
  readonly error: Readonly<Record<string, unknown>>;
}> {}

export class CodexRpcNotSent extends Data.TaggedError("CodexRpcNotSent")<{
  readonly error: AgentProtocolError;
}> {}

export class CodexRpcUnanswered extends Data.TaggedError("CodexRpcUnanswered")<{
  readonly error: AgentProtocolError;
}> {}

export type CodexRpcFailure = CodexRpcRejected | CodexRpcNotSent | CodexRpcUnanswered;

type SteerRefusalReason = AgentSteerRefusedError["reason"];

/**
 * `turn/steer` refusals by their exact app-server words (code -32600), from codex-rs
 * `app-server/src/request_processors/turn_processor.rs` (`turn_steer_inner`) and
 * `error_code.rs` (`server_draining_error`) at rust-v0.160.0.
 */
const STEER_REFUSALS: ReadonlyMap<string, SteerRefusalReason> = new Map([
  ["no active turn to steer", "no-active-turn"],
  ["cannot steer a review turn", "review-turn"],
  ["cannot steer a compact turn", "compact-turn"],
  ["active turn uses a different output schema", "output-schema"],
  ["input must not be empty", "invalid-input"],
  ["expectedTurnId must not be empty", "invalid-input"],
  ["Server is draining; retry after reconnecting", "server-draining"],
]);
const STEER_TARGET_CHANGED = /^expected active turn id `(.+)` but found `(.+)`$/;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

const steerRefusal = (
  rejected: CodexRpcRejected,
  expectedTurnId: string,
): { readonly reason: SteerRefusalReason; readonly actualTurnId: string | null } | null => {
  if (rejected.code === METHOD_NOT_FOUND) return { reason: "unsupported", actualTurnId: null };
  if (rejected.code !== INVALID_REQUEST) return null;
  const known = STEER_REFUSALS.get(rejected.message);
  if (known !== undefined) return { reason: known, actualTurnId: null };
  const changed = STEER_TARGET_CHANGED.exec(rejected.message);
  if (changed === null || changed[1] !== expectedTurnId) return null;
  return { reason: "target-changed", actualTurnId: changed[2] ?? null };
};

export const refused = (
  input: AgentSteerInput,
  reason: SteerRefusalReason,
  actualTurnId: string | null,
  message: string,
) =>
  new AgentSteerRefusedError({
    adapter: "codex",
    reason,
    expectedTurnId: input.expectedTurnId,
    actualTurnId,
    message,
  });

export const undelivered = (
  certainty: AgentSteerDeliveryError["certainty"],
  message: string,
  cause: unknown,
) => new AgentSteerDeliveryError({ adapter: "codex", certainty, message, cause });

export const steerFailure = (
  input: AgentSteerInput,
  failure: CodexRpcFailure,
): AgentSteerRefusedError | AgentSteerDeliveryError => {
  switch (failure._tag) {
    case "CodexRpcNotSent":
      return undelivered("not-written", failure.error.message, failure.error);
    case "CodexRpcUnanswered":
      return undelivered("uncertain", failure.error.message, failure.error);
    case "CodexRpcRejected": {
      const refusal = steerRefusal(failure, input.expectedTurnId);
      return refusal === null
        ? undelivered("uncertain", failure.message, failure.error)
        : refused(input, refusal.reason, refusal.actualTurnId, failure.message);
    }
  }
};
