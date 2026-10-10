import {
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { GatewayAuth, type AuthenticatedBearer } from "./auth.ts";
import { GatewayEnvironment } from "./environment.ts";
import { authInvalid, internal } from "./http-errors.ts";
import { Projections } from "./hub.ts";
import { gatewayRpcHandlersLayer } from "./rpc.ts";
import { WebSocketTickets } from "./tickets.ts";

/**
 * `GET /ws`: t3code's RPC socket (ADR 0012, handshake step 3). The client spends a WebSocket
 * ticket from `POST /api/auth/websocket-ticket` in `?wsTicket=` and names the orchestration
 * protocol it speaks; then every frame is Effect RPC in JSON against t3code's `WsRpcGroup`.
 */

/** The query parameter t3code's client puts the ticket in (`t3:apps/server/src/auth/EnvironmentAuth.ts`). */
export const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

/**
 * How long, at most, a socket whose device was revoked stays open for the calls in flight to be
 * answered: their typed refusals reach the client before the socket closes. A subscription that is
 * not refused stays open until then.
 */
const REFUSED_SOCKET_GRACE = "2 seconds";
/** How often a refused socket looks whether its calls in flight were answered. */
const REFUSED_SOCKET_POLL = "10 millis";

/** One call of one client of the socket. */
const keyOf = (clientId: number, requestId: string | number) => `${clientId}:${requestId}`;

/**
 * The socket's protocol, counting the calls in flight: a request is in flight from the moment it
 * arrives until its exit was written to the socket.
 */
const trackInFlight = (protocol: RpcServer.Protocol["Service"]) => {
  const inFlight = new Set<string>();
  const tracked: RpcServer.Protocol["Service"] = {
    ...protocol,
    run: (f) =>
      protocol.run((clientId, data) => {
        if (data._tag === "Request") inFlight.add(keyOf(clientId, data.id));
        return f(clientId, data);
      }),
    send: (clientId, response, transferables) =>
      protocol.send(clientId, response, transferables).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (response._tag === "Exit") inFlight.delete(keyOf(clientId, response.requestId));
          }),
        ),
      ),
  };
  /** Waits until every call in flight now has been answered. */
  const answered = Effect.suspend(() => {
    const pending = Array.from(inFlight);
    const done = () => pending.every((key) => !inFlight.has(key));
    return Effect.void.pipe(
      Effect.repeat({ until: done, schedule: Schedule.spaced(REFUSED_SOCKET_POLL) }),
    );
  });
  return { tracked, answered };
};

/** t3code's own check (`hasCompatibleOrchestrationProtocol` in t3:apps/server/src/ws.ts). */
export const hasCompatibleOrchestrationProtocol = (url: URL): boolean =>
  url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
  String(ORCHESTRATION_PROTOCOL_VERSION);

/** t3code's answer to a client without the protocol parameter: 426 and what it needs. */
const protocolIncompatible = () =>
  HttpServerResponse.jsonUnsafe(
    {
      code: "orchestration_protocol_incompatible",
      message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    },
    { status: 426 },
  );

export const WebSocketRouteLive: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | GatewayAuth | WebSocketTickets | GatewayEnvironment | Projections
> = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    const tickets = yield* WebSocketTickets;
    const environment = yield* GatewayEnvironment;
    const projections = yield* Projections;

    /**
     * As t3code reads an upgrade: a ticket when the URL carries one, else the request's own
     * bearer. Either way the session must still be live.
     */
    const authenticateUpgrade = (
      request: HttpServerRequest.HttpServerRequest,
      url: URL,
    ): Effect.Effect<AuthenticatedBearer, EnvironmentAuthInvalidError | EnvironmentInternalError> =>
      Effect.gen(function* () {
        const ticket = url.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM)?.trim() ?? "";
        if (ticket.length === 0) {
          return yield* auth.authenticate(request.headers["authorization"]);
        }
        const sessionId = yield* tickets.consume(ticket);
        if (Option.isNone(sessionId)) return yield* authInvalid("invalid_credential");
        return yield* auth.authenticateSession(sessionId.value);
      }).pipe(
        Effect.catchTags({
          GatewayCredentialMissing: () => authInvalid("missing_credential"),
          GatewayCredentialInvalid: (error) =>
            authInvalid("invalid_credential", error.dpopFailureReason),
          GatewayStateError: (error) => internal("internal_error", error),
        }),
      );

    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value)) {
          return protocolIncompatible();
        }
        const bearer = yield* authenticateUpgrade(request, url.value);

        // One RPC server per socket, holding this person's handlers, as t3code builds one per
        // connection. It lives in the request's scope, which lasts as long as the socket.
        // The person's hub, held while the socket is open (ADR 0012, "Projection").
        const hub = yield* projections.hub(bearer.session);
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        const { tracked, answered } = trackInFlight(protocol);
        yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(
          Effect.provideService(RpcServer.Protocol, tracked),
          Effect.provide(gatewayRpcHandlersLayer(bearer.session, hub)),
          Effect.provideService(GatewayEnvironment, environment),
          Effect.forkScoped,
        );
        // Mend refusing the socket's device token (revoked) closes the socket, whichever token
        // the person's hub reads with.
        return yield* Effect.raceFirst(
          httpEffect,
          hub.refusal(bearer.session.deviceToken).pipe(
            // The call that found the refusal, and any other in flight, is answered first: its
            // typed refusal is written before the socket closes, never lost to the close.
            Effect.andThen(answered.pipe(Effect.timeoutOption(REFUSED_SOCKET_GRACE))),
            Effect.as(HttpServerResponse.empty({ status: 401 })),
          ),
        );
      }).pipe(
        Effect.provide(RpcSerialization.layerJson),
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
