import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@mend/t3-contracts";

/**
 * The check a t3code client runs on a descriptor before it pairs, from
 * `t3:packages/client-runtime/src/connection/compatibility.ts` at the pinned tag (MIT, T3 Tools
 * Inc.), reduced to its verdict: `null` when the client connects, else why it refuses.
 * `@t3tools/client-runtime` is not vendored; the CI step that drives the gateway with it replaces
 * this copy (ADR 0012, "Protocol churn").
 */
export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): "client-too-old" | "server-too-old" | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? "client-too-old"
    : "server-too-old";
}
