import { Issue, Run, Timestamp } from "@mend/domain";
import { AgentLogins } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";
import { AccountRejected, SealantUnavailable } from "./system.ts";

// ─── Connected-account wire shapes (served by the API, spoken by @mend/sealant) ──

/** The providers Sealant can hold credentials for. GitHub is a credential, not a model provider. */
export const ConnectedAccountProvider = Schema.Literals(["claude", "codex", "github"]);
export type ConnectedAccountProvider = typeof ConnectedAccountProvider.Type;

export const ConnectedAccountStatus = Schema.Literals(["active", "invalid", "archived"]);
export type ConnectedAccountStatus = typeof ConnectedAccountStatus.Type;

/**
 * A connected account as every Mend surface sees it — Sealant never returns
 * secret material, and Mend never stores any: the credential goes straight
 * through to the platform under the user's own Sealant identity.
 */
export class ConnectedAccount extends Schema.Class<ConnectedAccount>("ConnectedAccount")({
  id: Schema.String,
  provider: ConnectedAccountProvider,
  name: Schema.String,
  /** Provider-shaped payload kind: oauth-token | credentials-json | auth-json | gh-cli-token. */
  kind: Schema.String,
  status: ConnectedAccountStatus,
  /** Non-secret display data: token suffix, codex account email, github login + scopes. */
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  connectedAt: Timestamp,
  updatedAt: Timestamp,
  lastUsedAt: Schema.NullOr(Timestamp),
}) {}

export class ConnectAccountInput extends Schema.Class<ConnectAccountInput>("ConnectAccountInput")({
  provider: ConnectedAccountProvider,
  /**
   * Provider-shaped plaintext, forwarded verbatim: a Claude setup token or the
   * contents of `~/.claude/.credentials.json`; the contents of
   * `~/.codex/auth.json`; a GitHub token (`gh auth token`).
   */
  secret: Schema.String.check(Schema.isNonEmpty()),
  /** Account name under the provider; `default` is the one sessions attach. */
  name: Schema.optional(Schema.String),
}) {}

/** What the settings page shows about the signed-in user's platform identity. */
export class SealantIdentity extends Schema.Class<SealantIdentity>("SealantIdentity")({
  sealantUserId: Schema.String,
  accounts: Schema.Array(ConnectedAccount),
}) {}

export const accountsGroup = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("identity", "/me/sealant", {
      success: SealantIdentity,
      error: [SealantUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("connect", "/me/sealant/accounts", {
      payload: ConnectAccountInput,
      success: ConnectedAccount,
      error: [AccountRejected, SealantUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.delete("disconnect", "/me/sealant/accounts/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: ConnectedAccount,
      error: [AccountRejected, SealantUnavailable],
    }),
  )
  // Which of the caller's own logins their Claude and Codex sessions receive (docs/adr/0016,
  // decision 5): every connected one by default, or the session's own agent's only. PUT saves it.
  .add(HttpApiEndpoint.get("agentLogins", "/me/agent-logins", { success: AgentLogins }))
  .add(
    HttpApiEndpoint.put("setAgentLogins", "/me/agent-logins", {
      payload: AgentLogins,
      success: AgentLogins,
    }),
  )
  .middleware(AuthMiddleware);

export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class IssueDetail extends Schema.Class<IssueDetail>("IssueDetail")({
  issue: Issue,
  runs: Schema.Array(Run),
}) {}

/** One terminal command the run executed, from the SDK's read surface. */
export class RunCommandView extends Schema.Class<RunCommandView>("RunCommandView")({
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Number),
}) {}

/** A telemetry gap, straight from the record's loss report — never fabricated. */
export class LossSpanView extends Schema.Class<LossSpanView>("LossSpanView")({
  fromSequence: Schema.NullOr(Schema.String),
  toSequence: Schema.NullOr(Schema.String),
}) {}

/** Provenance-honest: `complete` or the exact spans that were dropped. */
export class LossReportView extends Schema.Class<LossReportView>("LossReportView")({
  complete: Schema.Boolean,
  spans: Schema.Array(LossSpanView),
}) {}

/**
 * The run detail: the indexed row plus what the record can already show
 * (commands · transcript · loss). `recordError` carries the observed failure
 * when the recording could not be read — a gap is content, not an omission.
 */
export class RunDetail extends Schema.Class<RunDetail>("RunDetail")({
  run: Run,
  commands: Schema.Array(RunCommandView),
  transcript: Schema.NullOr(Schema.String),
  loss: Schema.NullOr(LossReportView),
  recordError: Schema.NullOr(Schema.String),
}) {}

/** One timeline entry of the full trace, summary-first (typed data stays platform-side). */
export class TraceEntryView extends Schema.Class<TraceEntryView>("TraceEntryView")({
  sequence: Schema.String,
  occurredAt: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  processId: Schema.NullOr(Schema.String),
}) {}

/** A page of the full trace; `nextFrom` resumes where this page ended. */
export class TracePage extends Schema.Class<TracePage>("TracePage")({
  entries: Schema.Array(TraceEntryView),
  nextFrom: Schema.NullOr(Schema.String),
}) {}

/** One network source the run touched, aggregated from the record's source events. */
export class RunSourceView extends Schema.Class<RunSourceView>("RunSourceView")({
  host: Schema.String,
  method: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Int),
  count: Schema.Int,
  firstSequence: Schema.String,
}) {}

/** The queue: list, manual entry into triage, the Gate 1 drag, the detail views. */
