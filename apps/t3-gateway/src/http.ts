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
import * as Option from "effect/Option";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { AssetRouteLive } from "./assets.ts";
import {
  GatewayAuth,
  type GatewayCredentialInvalid,
  type GatewayPairingRateLimited,
} from "./auth.ts";
import { GatewayEnvironment } from "./environment.ts";
import { authInvalid, internal, notFound, requestInvalid, scopeRequired } from "./http-errors.ts";
import { Projections } from "./hub.ts";
import { latestLocalTurnOrdinalOf } from "./thread-projection.ts";
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

/**
 * A claim Mend refused for its rate limit. t3code's token contract declares no rate-limit error, so
 * this is a plain `429 Too Many Requests` with `retry-after` and an RFC 6749-shaped body. t3code's
 * clients report an undeclared status as transient ("returned undeclared status 429"), never as a
 * wrong code to discard, and the code is not spent.
 */
export const pairingRateLimited = (error: GatewayPairingRateLimited) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        error: "rate_limited",
        error_description:
          error.retryAfterSeconds === null
            ? "Too many failed pairing codes from this client's address. The code was not spent; try again shortly."
            : `Too many failed pairing codes from this client's address. The code was not spent; try again in ${error.retryAfterSeconds} s.`,
      },
      {
        status: 429,
        headers:
          error.retryAfterSeconds === null
            ? {}
            : { "retry-after": String(error.retryAfterSeconds) },
      },
    ),
  );

/**
 * The `x-forwarded-for` a pairing claim carries to Mend: the client's own chain, then the address
 * the gateway saw, the way every proxy in front of Mend appends its hop. Without the second there
 * is nothing to append to, so the client's chain is not passed on alone: Mend would believe it.
 */
export const forwardedChain = (
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
): string | undefined => {
  if (remoteAddress === undefined || remoteAddress === "") return undefined;
  const chain = forwardedFor?.trim() ?? "";
  return chain === "" ? remoteAddress : `${chain}, ${remoteAddress}`;
};

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
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* auth.exchange({
              credential: args.payload.subject_token,
              scope: args.payload.scope,
              forwardedFor: forwardedChain(
                request.headers["x-forwarded-for"],
                Option.getOrUndefined(request.remoteAddress),
              ),
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
              GatewayPairingRateLimited: pairingRateLimited,
              GatewayStateError: (error) => internal("access_token_issuance_failed", error),
              MendUnavailable: (error) => internal("access_token_issuance_failed", error),
            }),
          ),
        )
        .handle("webSocketTicket", () =>
          Effect.gen(function* () {
            const principal = yield* EnvironmentAuthenticatedPrincipal;
            yield* noStore;
            // A ticket per connect: the moment to ask Mend whether the device is still paired.
            const bearer = yield* auth.authenticateSession(principal.sessionId);
            yield* auth.confirmDevice(bearer);
            return yield* tickets.issue(principal.sessionId);
          }).pipe(
            Effect.catchTags({
              GatewayCredentialInvalid: invalidCredential,
              GatewayStateError: (error) => internal("internal_error", error),
            }),
          ),
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
 * The shell over HTTP, as a client loads it before it subscribes: the person's projection hub,
 * the same one their sockets read (ADR 0012, "Projection").
 */
export const OrchestrationGroupLive = HttpApiBuilder.group(
  GatewayHttpApi,
  "orchestration",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* GatewayAuth;
      const projections = yield* Projections;

      /**
       * The caller's hub, held for the request's scope, once they may read orchestration. The
       * middleware authenticated the bearer; its session is read again for the device token.
       */
      const callerHub = Effect.gen(function* () {
        const principal = yield* EnvironmentAuthenticatedPrincipal;
        if (!principal.scopes.has(AuthOrchestrationReadScope)) {
          return yield* scopeRequired(AuthOrchestrationReadScope);
        }
        const bearer = yield* auth
          .authenticateSession(principal.sessionId)
          .pipe(Effect.catch((error) => internal("internal_error", error)));
        return yield* projections.hub(bearer.session);
      });

      return (
        handlers
          .handle("shellSnapshot", () =>
            Effect.scoped(
              Effect.gen(function* () {
                const hub = yield* callerHub;
                // Mend unreachable, or every device of the person refused: t3code retries either.
                return yield* hub.shellSnapshot.pipe(
                  Effect.catch((error) => internal("orchestration_snapshot_failed", error)),
                );
              }),
            ),
          )
          .handle("threadSnapshot", ({ params }) =>
            Effect.scoped(
              Effect.gen(function* () {
                const hub = yield* callerHub;
                const snapshot = yield* hub
                  .threadSnapshot(params.threadId)
                  .pipe(
                    Effect.catch((error) =>
                      internal("orchestration_thread_snapshot_failed", error),
                    ),
                  );
                if (snapshot === null) return yield* notFound("thread_not_found");
                return snapshot;
              }),
            ),
          )
          // The whole thread, as one window with nothing older: Mend's threads are read in full.
          .handle("threadBoundedSnapshot", ({ params }) =>
            Effect.scoped(
              Effect.gen(function* () {
                const hub = yield* callerHub;
                const snapshot = yield* hub
                  .threadSnapshot(params.threadId)
                  .pipe(
                    Effect.catch((error) =>
                      internal("orchestration_thread_bounded_snapshot_failed", error),
                    ),
                  );
                if (snapshot === null) return yield* notFound("thread_not_found");
                return {
                  ...snapshot,
                  historyCursor: null,
                  hasMoreHistory: false,
                  latestLocalTurnOrdinal: latestLocalTurnOrdinalOf(snapshot.projection),
                };
              }),
            ),
          )
          // No cursor is ever handed out, so there is never an older page.
          .handle("threadHistoryPage", ({ params }) =>
            Effect.scoped(
              Effect.gen(function* () {
                const hub = yield* callerHub;
                const snapshot = yield* hub
                  .threadSnapshot(params.threadId)
                  .pipe(
                    Effect.catch((error) => internal("orchestration_thread_history_failed", error)),
                  );
                if (snapshot === null) return yield* notFound("thread_not_found");
                return {
                  snapshotSequence: snapshot.snapshotSequence,
                  items: [],
                  nextCursor: null,
                  hasMoreHistory: false,
                };
              }),
            ),
          )
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
    Layer.provide(OrchestrationGroupLive),
    Layer.provide(EnvironmentAuthenticatedAuthLive),
  ),
  WebSocketRouteLive,
  AssetRouteLive,
  GatewayCorsLive,
);
