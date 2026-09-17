import { SealantRunId, SessionProcessId } from "@mend/domain";
import { TenancyMode } from "@mend/domain/workbench";
import { Schema } from "effect";
import * as Context from "effect/Context";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

/**
 * The Mend API contract — one Effect HttpApi served from the product process,
 * consumed by the web app (SSR loaders and client) and later the mobile app.
 * Contract first: this module is pure data; the server implementation lives in
 * ./server.ts, and clients derive themselves from what is declared here.
 */

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * The signed-in identity as endpoints see it. The shape @mend/auth's session
 * resolves to — declared here (not imported) so the contract package carries
 * no auth implementation; the server's auth layer satisfies it structurally.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}
export interface AuthenticatedSession {
  readonly user: AuthenticatedUser;
  readonly expiresAt: Date;
}

/** Who is signed in, provided to protected endpoints by the auth middleware. */
export class CurrentUser extends Context.Service<CurrentUser, AuthenticatedSession>()(
  "@mend/api/CurrentUser",
) {}

/** Cookie session (web) or bearer token (mobile) — both resolve through better-auth. */
export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: CurrentUser }
>()("@mend/api/AuthMiddleware", {
  error: Unauthorized,
}) {}

export class HealthStatus extends Schema.Class<HealthStatus>("HealthStatus")({
  status: Schema.Literals(["ok"]),
  version: Schema.String,
  /** `local` (host + Docker) or `kubernetes` (RWX store claim, network session channel). */
  deploymentMode: Schema.Literals(["local", "kubernetes"]),
  /** The central store root this instance serves; on Kubernetes the claim's mount path. */
  storeRoot: Schema.String,
  /** How workspaces reach their session: the per-session socket, or the network endpoint. */
  sessionChannel: Schema.Struct({
    mode: Schema.Literals(["unix-socket", "network"]),
    endpoint: Schema.NullOr(Schema.String),
  }),
  /** `MEND_TENANCY` (docs/adr/0003-organizations-and-tenancy.md). */
  tenancy: TenancyMode,
  /**
   * The multi mode gate as evaluated at start: whether it passes, and the ids of the items that do
   * not. Details stay with the operator (`GET /operator/gate`).
   */
  tenancyGate: Schema.Struct({
    passed: Schema.Boolean,
    failing: Schema.Array(Schema.String),
  }),
}) {}

export class ProcessLogChunk extends Schema.Class<ProcessLogChunk>("ProcessLogChunk")({
  sequence: Schema.String,
  dataBase64: Schema.String,
}) {}

export class ProcessLogPage extends Schema.Class<ProcessLogPage>("ProcessLogPage")({
  processId: SessionProcessId,
  sealantSessionId: Schema.String,
  sealantRunId: Schema.NullOr(SealantRunId),
  requestedFrom: Schema.String,
  firstSequence: Schema.NullOr(Schema.String),
  lastSequence: Schema.NullOr(Schema.String),
  nextFrom: Schema.String,
  status: Schema.Literals(["exited", "failed", "running", "starting"]),
  chunks: Schema.Array(ProcessLogChunk),
  telemetryLoss: Schema.Literal("unknown"),
  telemetryNote: Schema.String,
}) {}
