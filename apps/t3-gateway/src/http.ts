import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  ORCHESTRATION_PROTOCOL_HEADER,
  type AuthEnvironmentScope,
  type DpopFailureReason,
  type EnvironmentAuthInvalidReason,
  type EnvironmentInternalErrorReason,
  type EnvironmentRequestInvalidReason,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { GatewayAuth, type GatewayCredentialInvalid } from "./auth.ts";
import { GatewayEnvironment } from "./environment.ts";
import { WebSocketTickets } from "./tickets.ts";

/**
 * The HTTP half of a t3code environment, on t3code's own contract (`EnvironmentHttpApi` in the
 * vendored `environmentHttp.ts`), so paths, payloads, status codes and error bodies are t3code's.
 *
 * Phase 0 serves the `metadata` and `auth` groups (ADR 0012, "The surface"). `orchestration`,
 * `projects` and `pullRequests` arrive with phase 1, and `connect` (T3 Connect's relay, which the
 * gateway never offers) with them, as refusals.
 */
export const GatewayHttpApi = HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth);

// ─── t3code's error bodies ────────────────────────────────────────────────────

/** t3code stamps every refusal with the request's trace id (`t3:apps/server/src/auth/http.ts`). */
const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const authInvalid = (reason: EnvironmentAuthInvalidReason, dpopFailureReason?: DpopFailureReason) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason,
        ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
        traceId,
      }),
    ),
  );

const requestInvalid = (reason: EnvironmentRequestInvalidReason) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
  );

const scopeRequired = (requiredScope: AuthEnvironmentScope) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(
      new EnvironmentScopeRequiredError({ code: "insufficient_scope", requiredScope, traceId }),
    ),
  );

const internal = (reason: EnvironmentInternalErrorReason, cause: unknown) =>
  Effect.gen(function* () {
    const traceId = yield* currentTraceId;
    yield* Effect.logError("t3 gateway request failed", { reason, traceId, cause });
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });

/** t3code challenges a refused DPoP request with `www-authenticate: DPoP`. */
const dpopChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const invalidCredential = (error: GatewayCredentialInvalid) =>
  Effect.andThen(
    error.dpopFailureReason === undefined ? Effect.void : dpopChallenge,
    authInvalid("invalid_credential", error.dpopFailureReason),
  );

/** Credentials never sit in a cache (t3code's `CREDENTIAL_RESPONSE_HEADERS`). */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

// ─── Authentication middleware ───────────────────────────────────────────────

export const EnvironmentAuthenticatedAuthLive: Layer.Layer<
  EnvironmentAuthenticatedAuth,
  never,
  GatewayAuth
> = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bearer = yield* auth.authenticate(request.headers["authorization"]).pipe(
          Effect.catchTags({
            GatewayCredentialMissing: () => authInvalid("missing_credential"),
            GatewayCredentialInvalid: invalidCredential,
            GatewayStateError: (error) => internal("internal_error", error),
          }),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            sessionId: bearer.session.sessionId,
            subject: bearer.session.mendUser.id,
            method: "bearer-access-token",
            scopes: new Set(bearer.session.scopes),
            expiresAt: bearer.expiresAt,
          }),
        );
      });
  }),
);

// ─── Groups ──────────────────────────────────────────────────────────────────

export const MetadataGroupLive = HttpApiBuilder.group(GatewayHttpApi, "metadata", (handlers) =>
  Effect.gen(function* () {
    const environment = yield* GatewayEnvironment;
    return handlers.handle("descriptor", () => Effect.succeed(environment.descriptor));
  }),
);

export const AuthGroupLive = HttpApiBuilder.group(GatewayHttpApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    const tickets = yield* WebSocketTickets;

    return (
      handlers
        .handle("session", (args) =>
          auth.sessionState(args.headers.authorization).pipe(
            Effect.catchTags({
              GatewayStateError: (error) => internal("internal_error", error),
              MendUnavailable: (error) => internal("internal_error", error),
            }),
          ),
        )
        // Cookie sessions are the primary environment's web app; the gateway offers bearer tokens
        // only (`sessionMethods`), so no credential is good for one.
        .handle("browserSession", () => authInvalid("invalid_credential"))
        .handle("token", (args) =>
          Effect.gen(function* () {
            yield* noStore;
            return yield* auth.exchange({
              credential: args.payload.subject_token,
              scope: args.payload.scope,
              dpop: args.headers.dpop !== undefined,
              client: {
                label: args.payload.client_label,
                deviceType: args.payload.client_device_type,
                os: args.payload.client_os,
              },
            });
          }).pipe(
            Effect.catchTags({
              GatewayRequestInvalid: (error) => requestInvalid(error.reason),
              GatewayCredentialInvalid: invalidCredential,
              GatewayStateError: (error) => internal("access_token_issuance_failed", error),
              MendUnavailable: (error) => internal("access_token_issuance_failed", error),
            }),
          ),
        )
        .handle("webSocketTicket", () =>
          Effect.gen(function* () {
            const principal = yield* EnvironmentAuthenticatedPrincipal;
            yield* noStore;
            return yield* tickets.issue(principal.sessionId);
          }),
        )
        // Pairing links and client sessions are administered in Mend (its devices), never here. A
        // paired client never holds the access scopes, so these answer as t3code answers a client
        // with the standard scopes.
        .handle("pairingCredential", () => scopeRequired(AuthAccessWriteScope))
        .handle("pairingLinks", () => scopeRequired(AuthAccessReadScope))
        .handle("revokePairingLink", () => scopeRequired(AuthAccessWriteScope))
        .handle("clients", () => scopeRequired(AuthAccessReadScope))
        .handle("revokeClient", () => scopeRequired(AuthAccessWriteScope))
        .handle("revokeOtherClients", () => scopeRequired(AuthAccessWriteScope))
    );
  }),
);

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * t3code's browser CORS (`t3:apps/server/src/http.ts`, `browserApiCorsLayer`, packaged mode):
 * any origin, no credentials, its methods and headers. The desktop renderer and the hosted app
 * call the environment cross-origin.
 */
export const GatewayCorsLive: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.cors({
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "authorization",
    "b3",
    "traceparent",
    "content-type",
    "dpop",
    ORCHESTRATION_PROTOCOL_HEADER,
  ],
  maxAge: 600,
});

/** Every gateway route, ready for `HttpRouter.serve` or `HttpRouter.toWebHandler`. */
export const GatewayRoutesLive = Layer.mergeAll(
  HttpApiBuilder.layer(GatewayHttpApi).pipe(
    Layer.provide(MetadataGroupLive),
    Layer.provide(AuthGroupLive),
    Layer.provide(EnvironmentAuthenticatedAuthLive),
  ),
  GatewayCorsLive,
);
