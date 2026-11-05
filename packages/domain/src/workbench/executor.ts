import { Schema } from "effect";

import { SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

export const ExecutorMode = Schema.Literals(["own", "mend-run"]);
export type ExecutorMode = typeof ExecutorMode.Type;
export const ExecutorLinkState = Schema.Literals(["unlinked", "active", "refused"]);
export const ExecutorLinkStatus = Schema.Struct({
  state: ExecutorLinkState,
  observedAt: Schema.NullOr(Timestamp),
});
export type ExecutorLinkStatus = typeof ExecutorLinkStatus.Type;
export const ExecutorConfigurationInput = Schema.Struct({ mode: ExecutorMode, url: Schema.String });
/** Only observations and release configuration; private endpoints and credentials stay server-side. */
export const ExecutorManagedStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  state: Schema.String,
  observedAt: Schema.NullOr(Timestamp),
  image: Schema.NullOr(Schema.String),
  releaseImage: Schema.String,
  memoryBytes: Schema.Number,
  backupAt: Schema.NullOr(Timestamp),
  retained: Schema.optionalKey(Schema.Boolean),
});
/** Owner lifecycle choices never accept arbitrary image pins or runtime endpoints. */
export const ExecutorManagedAction = Schema.Literals(["start", "stop", "upgrade", "remove"]);
export const ExecutorConfiguration = Schema.Struct({
  mode: Schema.NullOr(ExecutorMode),
  url: Schema.NullOr(Schema.String),
  mendRunAvailable: Schema.Boolean,
  member: ExecutorLinkStatus,
  managed: Schema.optionalKey(ExecutorManagedStatus),
});
export const ExecutorPersonalStatus = Schema.Struct({
  configured: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  link: ExecutorLinkStatus,
});
export const ExecutorLinkStart = Schema.Struct({ url: Schema.String });
export const ExecutorLinkTarget = Schema.Literals(["person", "member"]);
export type ExecutorLinkTarget = typeof ExecutorLinkTarget.Type;
export const ExecutorCallOutcome = Schema.Literals([
  "requested",
  "held",
  "answering",
  "completed",
  "refused",
  "denied",
  "expired",
  "unavailable",
]);
export type ExecutorCallOutcome = typeof ExecutorCallOutcome.Type;
export const ExecutorToolObservation = Schema.Struct({
  service: Schema.String,
  tool: Schema.String,
  outcome: Schema.String,
});
export type ExecutorToolObservation = typeof ExecutorToolObservation.Type;
export const ExecutorCall = Schema.Struct({
  id: Schema.String,
  sessionId: SessionId,
  service: Schema.String,
  tool: Schema.String,
  asUserId: Schema.NullOr(Schema.String),
  asMember: Schema.Boolean,
  approverId: Schema.NullOr(Schema.String),
  outcome: ExecutorCallOutcome,
  message: Schema.String,
  observations: Schema.Array(ExecutorToolObservation),
  createdAt: Timestamp,
  observedAt: Timestamp,
  expiresAt: Schema.NullOr(Timestamp),
});
export type ExecutorCall = typeof ExecutorCall.Type;
export const ExecutorCalls = Schema.Struct({
  calls: Schema.Array(ExecutorCall),
  olderCursor: Schema.NullOr(Schema.String),
});
export const ExecutorApprovalInput = Schema.Struct({
  action: Schema.Literals(["accept", "decline"]),
  content: Schema.Record(Schema.String, Schema.Unknown),
});
export type ExecutorApprovalInput = typeof ExecutorApprovalInput.Type;
export const ExecutorService = Schema.Struct({ id: Schema.String, name: Schema.String });
export const ExecutorServices = Schema.Struct({
  services: Schema.Array(ExecutorService),
  observedAt: Timestamp,
  nextOffset: Schema.NullOr(Schema.Number),
});
export const EXECUTOR_APPROVAL_MS = 15 * 60_000;

/** An owner chooses an origin, never credentials, an endpoint path or a redirect destination. */
export const executorOrigin = (input: string): string | null => {
  try {
    const url = new URL(input.trim());
    const loopback =
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

/** Service management never exposes Executor's private origin or credentials. */
export const ExecutorServiceTarget = ExecutorLinkTarget;
export type ExecutorServiceTarget = typeof ExecutorServiceTarget.Type;
export const ExecutorServiceField = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  secret: Schema.Boolean,
  required: Schema.Boolean,
});
export const ExecutorServiceMethod = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "fields", "unsupported"]),
  fields: Schema.Array(ExecutorServiceField),
});
export const ExecutorServiceAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  linked: Schema.Boolean,
  canDisconnect: Schema.Boolean,
});
export const ExecutorServiceRequirement = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literals(["app", "user"]),
  methods: Schema.Array(ExecutorServiceMethod),
  accounts: Schema.Array(ExecutorServiceAccount),
});
export const ExecutorServiceDirectory = Schema.Struct({
  services: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      shared: Schema.Boolean,
      requirements: Schema.Array(ExecutorServiceRequirement),
    }),
  ),
  observedAt: Timestamp,
});
export const ExecutorAddService = Schema.Struct({
  target: ExecutorServiceTarget,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  url: Schema.String.check(Schema.isMaxLength(4096)),
});
export const ExecutorConnectService = Schema.Struct({
  target: ExecutorServiceTarget,
  service: Schema.String.check(Schema.isMaxLength(256)),
  requirement: Schema.String.check(Schema.isMaxLength(256)),
  method: Schema.String.check(Schema.isMaxLength(256)),
});
export const ExecutorServiceConnection = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  fields: Schema.Array(ExecutorServiceField),
  completed: Schema.Boolean,
});
export const ExecutorServiceSubmit = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(256)),
  fields: Schema.RedactedFromValue(Schema.Record(Schema.String, Schema.String)),
});
export const ExecutorServiceFinish = Schema.Struct({
  callbackUrl: Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(16384))),
});
export const ExecutorServiceAccountAction = Schema.Struct({
  target: ExecutorServiceTarget,
  service: Schema.String.check(Schema.isMaxLength(256)),
  requirement: Schema.String.check(Schema.isMaxLength(256)),
  account: Schema.String.check(Schema.isMaxLength(256)),
});
