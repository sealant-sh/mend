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
 * A budget refused new work (docs/adr/0004-access-without-a-private-network.md, "Budgets").
 * Nothing running was stopped. `budget` names which one, `retryAfterSeconds` when a window frees
 * (null for a ceiling, which frees when the account's own work settles). The global request
 * budgets answer the same shape from the router, before any endpoint is reached.
 */
export class BudgetExceeded extends Schema.TaggedErrorClass<BudgetExceeded>()(
  "BudgetExceeded",
  {
    budget: Schema.String,
    limit: Schema.Int,
    retryAfterSeconds: Schema.NullOr(Schema.Int),
    message: Schema.String,
  },
  { httpApiStatus: 429 },
) {}

/**
 * What a failure nobody declared answers (docs/adr/0004, "Errors and browser headers"). The
 * detail stays in the server's log under `reference`; a client shows the reference and nothing
 * else. Answered by the API's error boundary, outside every endpoint, so no endpoint declares it.
 */
export class InternalError extends Schema.TaggedErrorClass<InternalError>()(
  "InternalError",
  {
    reference: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 500 },
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
  /** The sign-in (`session:<id>`) or paired device (`device:<id>`) that proved this caller. */
  readonly credential?: `session:${string}` | `device:${string}`;
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
  /**
   * True on a server that mints upgrade tickets (docs/adr/0004). A client whose mint answers 404
   * reads this before it lets its bearer ride a URL: absent means a server older than tickets,
   * true means something between the client and Mend refused the mint, and the bearer stays put.
   */
  upgradeTickets: Schema.optional(Schema.Boolean),
  /**
   * `MEND_EXPOSURE` as declared, and the public exposure gate as evaluated at start
   * (docs/adr/0004-access-without-a-private-network.md), as two counts: the items still open,
   * and those of them that are open because no build can observe them. `/health` needs no
   * sign-in, so it says how many and never which: on an instance the Internet can reach, the ids
   * would be a list of what to try. They stay with the operator (`GET /operator/exposure`).
   * Optional on the wire so a client reads an older server.
   */
  exposure: Schema.optional(
    Schema.Struct({
      declared: Schema.Literals(["loopback", "private", "public"]),
      open: Schema.Int,
      unobservable: Schema.Int,
    }),
  ),
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
