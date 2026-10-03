import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
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
import { authInvalid, internal, notFound, requestInvalid, scopeRequired } from "./http-errors.ts";
import { EMPTY_SHELL_SNAPSHOT } from "./shell.ts";
import { WebSocketTickets } from "./tickets.ts";
import { WebSocketRouteLive } from "./ws.ts";

/**
 * The HTTP half of a t3code environment, on t3code's own contract (`EnvironmentHttpApi` in the
 * vendored `environmentHttp.ts`), so paths, payloads, status codes and error bodies are t3code's.
 *
 * Phase 0 serves the `metadata` and `auth` groups and the empty orchestration shell (ADR 0012,
 * "The surface"). `projects` and `pullRequests` arrive with phase 1, and `connect` (T3 Connect's
 * relay, which the gateway never offers) with them, as refusals. The `/ws` RPC socket is beside
 * these routes, in `ws.ts`.
 */
export const GatewayHttpApi = HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.orchestration);

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

/**
 * The shell over HTTP, as a client loads it before it subscribes. Empty until phase 1 projects
 * Mend's projects and sessions into it; so every thread a client names is not here.
 */
export const OrchestrationGroupLive = HttpApiBuilder.group(
  GatewayHttpApi,
  "orchestration",
  (handlers) =>
    Effect.succeed(
      handlers
        .handle("shellSnapshot", () =>
          Effect.gen(function* () {
            const principal = yield* EnvironmentAuthenticatedPrincipal;
            if (!principal.scopes.has(AuthOrchestrationReadScope)) {
              return yield* scopeRequired(AuthOrchestrationReadScope);
            }
            return EMPTY_SHELL_SNAPSHOT;
          }),
        )
        .handle("threadSnapshot", () => notFound("thread_not_found"))
        .handle("threadBoundedSnapshot", () => notFound("thread_not_found"))
        .handle("threadHistoryPage", () => notFound("thread_not_found")),
    ),
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
    Layer.provide(OrchestrationGroupLive),
    Layer.provide(EnvironmentAuthenticatedAuthLive),
  ),
  WebSocketRouteLive,
  GatewayCorsLive,
);
