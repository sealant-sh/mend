import { Issue, Run, Timestamp } from "@mend/domain";
import { EndpointUrl } from "@mend/domain/endpoint-url";
import { AgentLogins, LoginClass, MessageSettings, SettleSettings } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

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
  /** Whether this is the person's chosen default for its provider, the one sessions use. */
  isDefault: Schema.Boolean,
  /**
   * Claude and Codex: a subscription, or an API key with its last four characters. Absent for
   * GitHub, and from a platform that predates login classes.
   */
  login: Schema.optional(LoginClass),
}) {}

/** The login class a connect's secret must be; sealant refuses a secret of the other class. */
export const ConnectLogin = Schema.Literals(["subscription", "api-key"]);
export type ConnectLogin = typeof ConnectLogin.Type;

export class ConnectAccountInput extends Schema.Class<ConnectAccountInput>("ConnectAccountInput")(
  Schema.Struct({
    provider: ConnectedAccountProvider,
    /**
     * Provider-shaped plaintext, forwarded verbatim: a Claude setup token or the
     * contents of `~/.claude/.credentials.json`; the contents of
     * `~/.codex/auth.json`; an Anthropic or OpenAI API key; a GitHub token (`gh auth token`).
     */
    secret: Schema.String.check(Schema.isNonEmpty()),
    /** Claude and Codex: what `secret` is. Without it the platform reads the class off the secret. */
    login: Schema.optional(ConnectLogin),
    /** Make this login the person's default for its provider, the one their sessions spend. */
    makeDefault: Schema.optional(Schema.Boolean),
    /** The account to write, by name; without it or `accountId`, the person's chosen login. */
    name: Schema.optional(Schema.String),
    accountId: Schema.optional(Schema.String),
    /**
     * Claude and Codex API keys: the base URL of a compatible endpoint this login's requests go
     * to, such as a company gateway (ADR 0018, decision 11). Read as the platform reads it.
     * Reconnecting without it removes the endpoint.
     */
    endpoint: Schema.optional(EndpointUrl),
  }).check(
    Schema.makeFilter((input) => {
      if (input.endpoint !== undefined && input.login !== "api-key")
        return { path: ["endpoint"], issue: "Only an API key sends its requests to an endpoint." };
      if (input.login !== "api-key") return undefined;
      if (input.provider === "github")
        return { path: ["login"], issue: "GitHub takes a token, not an API key." };
      return /\s/.test(input.secret)
        ? { path: ["secret"], issue: "An API key has no spaces or line breaks." }
        : undefined;
    }),
  ),
) {}

/** What the settings page shows about the signed-in user's platform identity. */
export class SealantIdentity extends Schema.Class<SealantIdentity>("SealantIdentity")({
  sealantUserId: Schema.String,
  accounts: Schema.Array(ConnectedAccount),
  /** Whether the platform runs sessions on a Claude or Codex API key (ADR 0018). */
  apiKeys: Schema.Boolean,
}) {}

export class InvalidMessageSettings extends Schema.TaggedError<InvalidMessageSettings>()(
  "InvalidMessageSettings",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class InvalidSettleSettings extends Schema.TaggedError<InvalidSettleSettings>()(
  "InvalidSettleSettings",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

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
  .add(HttpApiEndpoint.get("messageSettings", "/me/message-settings", { success: MessageSettings }))
  .add(
    HttpApiEndpoint.put("setMessageSettings", "/me/message-settings", {
      payload: MessageSettings,
      success: MessageSettings,
      error: [InvalidMessageSettings],
    }),
  )
  // What settling a session's thread in T3 Code does beside settling it (SettleSettings).
  .add(HttpApiEndpoint.get("settleSettings", "/me/settle-settings", { success: SettleSettings }))
  .add(
    HttpApiEndpoint.put("setSettleSettings", "/me/settle-settings", {
      payload: SettleSettings,
      success: SettleSettings,
      error: [InvalidSettleSettings],
    }),
  )
  .middleware(AuthMiddleware);

export class NotFound extends Schema.TaggedError<NotFound>()(
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
