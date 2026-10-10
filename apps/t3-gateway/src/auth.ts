import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AuthAccessTokenType,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  authScopeResponse,
  AuthSessionId,
  AuthStandardClientScopes,
  DpopFailureReason,
  type AuthAccessTokenResult,
  type AuthClientMetadataDeviceType,
  type AuthSessionState,
} from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GatewayEnvironment } from "./environment.ts";
import { Projections } from "./hub.ts";
import { MendClient, type MendDevicePlatform, type MendUnavailable } from "./mend-client.ts";
import { GatewayState, type BearerSession, type GatewayStateError } from "./state.ts";

/**
 * Pairing and bearer sessions (ADR 0012, "Access"). A t3code client pairs with a Mend pairing
 * code: the gateway claims it through Mend's `POST /api/pair`, keeps the device token Mend hands
 * back, and gives the client a bearer of its own. Every later call to Mend is the person's own,
 * made with that device token, so Mend's access rules apply unchanged.
 */

/** How long a request waits on Mend's answer about the bearer's device. */
export const DEVICE_CHECK_DEADLINE = "2 seconds";

/**
 * How long Mend's answer that a device is still paired is taken as current: a connect's ticket and
 * its snapshot reads share one call to Mend, never one each.
 */
export const DEVICE_CONFIRMED_FOR_MS = 5_000;

/** What Mend answered about a device token, or that it did not answer. */
type DeviceVerdict = "accepted" | "refused" | "unanswered";

/** As long as t3code's own bearer sessions (`DEFAULT_SESSION_TTL`, 30 days). */
export const BEARER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a paired client may do. t3code's standard client scopes; never the access-admin ones. */
export const GRANTED_SCOPES: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes;

const isEnvironmentScope = Schema.is(AuthEnvironmentScope);

/**
 * What a grant made before t3code's granular permissions (v0.0.46-nightly.20261010.2922) stands
 * for now. Those grants were t3code's standard client scopes of the time, marked by `review:write`,
 * which grants no RPC of its own; each old scope is read as the scopes t3code split it into (its
 * `legacyParents`), so a client paired before the split keeps what it could do. Any other grant is
 * read as stored.
 */
const LEGACY_CHILDREN: ReadonlyMap<
  AuthEnvironmentScope,
  ReadonlyArray<AuthEnvironmentScope>
> = new Map([
  [AuthOrchestrationReadScope, [AuthFilesystemReadScope, AuthDiagnosticsReadScope]],
  [
    AuthOrchestrationOperateScope,
    [
      AuthSettingsWriteScope,
      AuthProvidersManageScope,
      AuthEnvironmentMaintainScope,
      AuthPreviewOperateScope,
      AuthSourceControlWriteScope,
      AuthFilesystemWriteScope,
    ],
  ],
  [AuthTerminalOperateScope, [AuthTerminalReadScope]],
]);
const LEGACY_GRANT_MARK: AuthEnvironmentScope = "review:write";

export const grantedScopesOf = (
  stored: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> =>
  stored.some((scope) => scope === LEGACY_GRANT_MARK)
    ? [...new Set(stored.flatMap((scope) => [scope, ...(LEGACY_CHILDREN.get(scope) ?? [])]))]
    : stored;

/**
 * RFC 6749 scope tokens (%x21 / %x23-5B / %x5D-7E), as t3code reads them
 * (`t3:packages/shared/src/oauthScope.ts`).
 */
const OAUTH_SCOPE_TOKEN = /^[!#-[\]-~]+$/u;

/**
 * The requested scopes t3code knows, or null when the value is malformed or names none. A name
 * t3code lacks is dropped, as t3code's own server drops it.
 */
export const parseRequestedScopes = (value: string): ReadonlyArray<AuthEnvironmentScope> | null => {
  if (value.length === 0) return null;
  const tokens = value.split(" ");
  if (tokens.some((token) => !OAUTH_SCOPE_TOKEN.test(token))) return null;
  const scopes = [...new Set(tokens)].filter(isEnvironmentScope);
  return scopes.length === 0 ? null : scopes;
};

/**
 * What a token request is granted: the scopes it asked for that the gateway grants, as t3code's
 * server grants the overlap. `review:write` is kept: a client from before granular permissions asks
 * with it for the standard grant of its time, which `grantedScopesOf` reads as today's. A client
 * naming it now gets only what the old scopes it also names covered, which it could ask for itself.
 * The token's `scope` stays what was granted, not its reading: a client from before permissions
 * reads that string with its own, older list of scopes.
 */
export const grantFor = (
  requested: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> =>
  requested.filter((scope) => GRANTED_SCOPES.includes(scope) || scope === LEGACY_GRANT_MARK);

const hashBearer = (token: string): string => createHash("sha256").update(token).digest("hex");

const BEARER_PREFIX = "Bearer ";
const DPOP_PREFIX = "DPoP ";

// ─── Failures ────────────────────────────────────────────────────────────────

/** No credential on the request. */
export class GatewayCredentialMissing extends Schema.TaggedError<GatewayCredentialMissing>()(
  "GatewayCredentialMissing",
  {},
) {}

/** A credential the gateway does not accept: unknown, expired, revoked, or a refused code. */
export class GatewayCredentialInvalid extends Schema.TaggedError<GatewayCredentialInvalid>()(
  "GatewayCredentialInvalid",
  {
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
  },
) {}

/** The token request asked for scopes that are malformed or that pairing does not grant. */
export class GatewayRequestInvalid extends Schema.TaggedError<GatewayRequestInvalid>()(
  "GatewayRequestInvalid",
  { reason: Schema.Literals(["invalid_scope", "scope_not_granted"]) },
) {}

/**
 * Mend did not say, within `DEVICE_CHECK_DEADLINE`, whether the bearer's device is still paired.
 * Nothing is served on the gateway's word alone: the client is told to retry (503).
 */
export class GatewayDeviceUnconfirmed extends Schema.TaggedError<GatewayDeviceUnconfirmed>()(
  "GatewayDeviceUnconfirmed",
  {},
) {
  override get message(): string {
    return "Mend did not answer whether this device is still paired. Try again shortly.";
  }
}

/** A bearer that authenticated, with the Mend identity behind it. */
export interface AuthenticatedBearer {
  readonly session: BearerSession;
  readonly expiresAt: DateTime.Utc;
}

/**
 * Mend is refusing pairing claims from this client's address for now: too many failed codes. The
 * code may be right and is not spent; the client is told it is rate limited, and may retry.
 */
export class GatewayPairingRateLimited extends Schema.TaggedError<GatewayPairingRateLimited>()(
  "GatewayPairingRateLimited",
  {
    retryAfterSeconds: Schema.NullOr(Schema.Int),
  },
) {
  override get message(): string {
    return "Mend is refusing pairing claims from this client's address for now (too many failed codes).";
  }
}

export interface TokenExchangeInput {
  readonly credential: string;
  readonly scope: string | undefined;
  /**
   * The `x-forwarded-for` to send Mend with the claim: the request's own header, if any, then the
   * address the gateway saw. Mend believes entries only through hops it trusts (loopback, or
   * `MEND_TRUSTED_PROXIES`), the same rule as for any other proxy in front of it.
   */
  readonly forwardedFor: string | undefined;
  /** Whether the request carried a DPoP proof. The gateway issues bearer tokens only. */
  readonly dpop: boolean;
  readonly client: {
    readonly label: string | undefined;
    readonly deviceType: AuthClientMetadataDeviceType | undefined;
    readonly os: string | undefined;
  };
}

export class GatewayAuth extends Context.Service<
  GatewayAuth,
  {
    /** `POST /oauth/token`: a Mend pairing code for a gateway bearer. */
    readonly exchange: (
      input: TokenExchangeInput,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      | GatewayCredentialInvalid
      | GatewayPairingRateLimited
      | GatewayRequestInvalid
      | GatewayStateError
      | MendUnavailable
    >;
    /** The bearer behind an `authorization` header, from the gateway's own state. */
    readonly authenticate: (
      authorization: string | undefined,
    ) => Effect.Effect<
      AuthenticatedBearer,
      GatewayCredentialMissing | GatewayCredentialInvalid | GatewayStateError
    >;
    /**
     * The bearer session a spent WebSocket ticket names, if it is still live: a session revoked
     * or expired between the ticket and the upgrade does not open a socket.
     */
    readonly authenticateSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<AuthenticatedBearer, GatewayCredentialInvalid | GatewayStateError>;
    /**
     * Every route that serves the person's data, after the bearer authenticated (the ticket, the
     * HTTP snapshots): Mend still accepts its device token. A device revoked in Mend ends the
     * bearer, so the client is told its credential is invalid (t3code's terminal answer). Mend not
     * answering within `DEVICE_CHECK_DEADLINE` is `GatewayDeviceUnconfirmed`: nothing is served
     * from the hub's memory to a device nobody could confirm. One answer serves every request of
     * the device for `DEVICE_CONFIRMED_FOR_MS`.
     */
    readonly confirmDevice: (
      bearer: AuthenticatedBearer,
    ) => Effect.Effect<void, GatewayCredentialInvalid | GatewayDeviceUnconfirmed>;
    /**
     * `GET /api/auth/session`: authenticated only while the bearer is live here and Mend still
     * accepts its device token. A device revoked in Mend ends the bearer too.
     */
    readonly sessionState: (
      authorization: string | undefined,
    ) => Effect.Effect<AuthSessionState, GatewayStateError | MendUnavailable>;
  }
>()("@mend/t3-gateway/GatewayAuth") {}

/** Mend's device platform for a t3code client, from what it says about itself. */
export const mendPlatformFor = (client: TokenExchangeInput["client"]): MendDevicePlatform => {
  const os = client.os?.toLowerCase() ?? "";
  if (os.includes("android")) return "android";
  if (os.includes("ios") || os.includes("ipados")) return "ios";
  if (client.deviceType === "desktop") return "desktop";
  return "other";
};

/** What Mend lists the device as: t3code, and the client's own label when it sends one. */
export const mendDeviceNameFor = (client: TokenExchangeInput["client"]): string =>
  client.label === undefined ? "t3code" : `t3code · ${client.label}`;

export const GatewayAuthLive: Layer.Layer<
  GatewayAuth,
  never,
  GatewayState | MendClient | GatewayEnvironment | Projections
> = Layer.effect(
  GatewayAuth,
  Effect.gen(function* () {
    const state = yield* GatewayState;
    const mend = yield* MendClient;
    const environment = yield* GatewayEnvironment;
    const projections = yield* Projections;

    const exchange = Effect.fn("GatewayAuth.exchange")(function* (input: TokenExchangeInput) {
      const requested =
        input.scope === undefined ? GRANTED_SCOPES : parseRequestedScopes(input.scope);
      if (requested === null) return yield* new GatewayRequestInvalid({ reason: "invalid_scope" });
      // Checked before the code is claimed, so a client asking for nothing it can have keeps its code.
      const granted = grantFor(requested);
      // Nothing, or only the mark, which grants nothing by itself: t3code answers the same.
      if (granted.every((scope) => scope === LEGACY_GRANT_MARK)) {
        return yield* new GatewayRequestInvalid({ reason: "scope_not_granted" });
      }
      if (input.dpop) {
        return yield* new GatewayCredentialInvalid({ dpopFailureReason: "invalid_proof" });
      }

      const claim = yield* mend
        .claimPairing({
          code: input.credential,
          name: mendDeviceNameFor(input.client),
          platform: mendPlatformFor(input.client),
          forwardedFor: input.forwardedFor,
        })
        .pipe(
          // Unknown or spent: to t3code, the pairing credential is not accepted. Rate limited says
          // nothing about the code, so it is not reported as a wrong one.
          Effect.catchTags({
            MendPairingRefused: () => Effect.fail(new GatewayCredentialInvalid({})),
            MendPairingRateLimited: ({ retryAfterSeconds }) =>
              Effect.fail(new GatewayPairingRateLimited({ retryAfterSeconds })),
          }),
        );

      const now = yield* Clock.currentTimeMillis;
      const token = randomBytes(32).toString("base64url");
      const session: BearerSession = {
        sessionId: AuthSessionId.make(randomUUID()),
        tokenHash: hashBearer(token),
        deviceToken: claim.token,
        mendUser: claim.user,
        mendDeviceId: claim.device.id,
        scopes: granted,
        client: {
          label: input.client.label ?? null,
          deviceType: input.client.deviceType ?? "unknown",
          os: input.client.os ?? null,
        },
        issuedAt: now,
        expiresAt: now + BEARER_TTL_MS,
        revokedAt: null,
      };
      yield* state.insertSession(session);
      return {
        access_token: token,
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer" as const,
        expires_in: Math.floor(BEARER_TTL_MS / 1000),
        scope: granted.join(" "),
      };
    });

    /**
     * A stored session that is neither revoked nor expired, for a device Mend has not refused. A
     * refusal whose revocation the state file could not write still ends the bearer; the write is
     * tried again here.
     */
    const live = (found: Option.Option<BearerSession>) =>
      Effect.gen(function* () {
        if (Option.isNone(found)) return yield* new GatewayCredentialInvalid({});
        const session = found.value;
        const now = yield* Clock.currentTimeMillis;
        if (session.revokedAt !== null || session.expiresAt <= now) {
          return yield* new GatewayCredentialInvalid({});
        }
        if (projections.isDeviceRefused(session.deviceToken)) {
          yield* state.revokeSessionsForDevice(session.deviceToken, now).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not revoke a refused device's bearers", {
                cause: error.message,
              }),
            ),
          );
          return yield* new GatewayCredentialInvalid({});
        }
        const bearer: AuthenticatedBearer = {
          session: { ...session, scopes: grantedScopesOf(session.scopes) },
          expiresAt: DateTime.makeUnsafe(session.expiresAt),
        };
        return bearer;
      });

    const authenticate = Effect.fn("GatewayAuth.authenticate")(function* (
      authorization: string | undefined,
    ) {
      if (authorization === undefined) return yield* new GatewayCredentialMissing({});
      if (authorization.startsWith(DPOP_PREFIX)) {
        // No gateway token is proof-bound, which is how t3code answers DPoP for a bearer token.
        return yield* new GatewayCredentialInvalid({ dpopFailureReason: "invalid_proof" });
      }
      if (!authorization.startsWith(BEARER_PREFIX)) return yield* new GatewayCredentialMissing({});
      const token = authorization.slice(BEARER_PREFIX.length).trim();
      if (token.length === 0) return yield* new GatewayCredentialMissing({});

      return yield* live(yield* state.findSession(hashBearer(token)));
    });

    const authenticateSession = Effect.fn("GatewayAuth.authenticateSession")(function* (
      sessionId: AuthSessionId,
    ) {
      return yield* live(yield* state.findSessionById(sessionId));
    });

    /** Device token → when Mend last said it is paired. */
    const confirmedAt = new Map<string, number>();
    /** Device token → the answer a request is already waiting for: concurrent ones share it. */
    const asking = new Map<string, Deferred.Deferred<DeviceVerdict>>();

    const askMend = (deviceToken: string): Effect.Effect<DeviceVerdict> =>
      Effect.suspend(() => {
        const pending = asking.get(deviceToken);
        if (pending !== undefined) return Deferred.await(pending);
        const answer = Deferred.makeUnsafe<DeviceVerdict>();
        asking.set(deviceToken, answer);
        return mend.checkDevice(deviceToken).pipe(
          Effect.timeoutOption(DEVICE_CHECK_DEADLINE),
          Effect.map((verdict): DeviceVerdict => Option.getOrElse(verdict, () => "unanswered")),
          Effect.catchTag("MendUnavailable", () => Effect.succeed<DeviceVerdict>("unanswered")),
          Effect.tap((verdict) => Deferred.succeed(answer, verdict)),
          // An interrupted ask leaves no one waiting on it.
          Effect.ensuring(
            Effect.sync(() => asking.delete(deviceToken)).pipe(
              Effect.andThen(Deferred.succeed(answer, "unanswered")),
            ),
          ),
        );
      });

    const confirmDevice = Effect.fn("GatewayAuth.confirmDevice")(function* (
      bearer: AuthenticatedBearer,
    ) {
      const { session } = bearer;
      const now = yield* Clock.currentTimeMillis;
      const last = confirmedAt.get(session.deviceToken);
      if (last !== undefined && now - last < DEVICE_CONFIRMED_FOR_MS) return;
      const verdict = yield* askMend(session.deviceToken);
      if (verdict === "accepted") {
        confirmedAt.set(session.deviceToken, yield* Clock.currentTimeMillis);
        return;
      }
      confirmedAt.delete(session.deviceToken);
      if (verdict === "unanswered") return yield* new GatewayDeviceUnconfirmed({});
      // As the device gate refuses a token: its bearers are revoked and its sockets close.
      yield* projections.refuseDevice(session.mendUser.id, session.deviceToken);
      return yield* new GatewayCredentialInvalid({});
    });

    const sessionState = Effect.fn("GatewayAuth.sessionState")(function* (
      authorization: string | undefined,
    ) {
      const unauthenticated: AuthSessionState = { authenticated: false, auth: environment.auth };
      const bearer = yield* authenticate(authorization).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          GatewayCredentialMissing: () => Effect.succeed(Option.none<AuthenticatedBearer>()),
          GatewayCredentialInvalid: () => Effect.succeed(Option.none<AuthenticatedBearer>()),
        }),
      );
      if (Option.isNone(bearer)) return unauthenticated;
      const { session, expiresAt } = bearer.value;

      const verdict = yield* mend.checkDevice(session.deviceToken);
      if (verdict === "refused") {
        // As the device gate refuses a token: its bearers are revoked and its sockets close.
        yield* projections.refuseDevice(session.mendUser.id, session.deviceToken);
        return unauthenticated;
      }
      const authenticated: AuthSessionState = {
        authenticated: true,
        auth: environment.auth,
        ...authScopeResponse(session.scopes),
        sessionMethod: "bearer-access-token",
        expiresAt,
      };
      return authenticated;
    });

    return { exchange, authenticate, authenticateSession, confirmDevice, sessionState };
  }),
);
