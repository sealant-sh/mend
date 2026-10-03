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
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { GatewayAuth, type AuthenticatedBearer } from "./auth.ts";
import { GatewayEnvironment } from "./environment.ts";
import { authInvalid, internal } from "./http-errors.ts";
import { MendClient } from "./mend-client.ts";
import { gatewayRpcHandlersLayer } from "./rpc.ts";
import { WebSocketTickets } from "./tickets.ts";

/**
 * `GET /ws`: t3code's RPC socket (ADR 0012, handshake step 3). The client spends a WebSocket
 * ticket from `POST /api/auth/websocket-ticket` in `?wsTicket=` and names the orchestration
 * protocol it speaks; then every frame is Effect RPC in JSON against t3code's `WsRpcGroup`.
 */

/** The query parameter t3code's client puts the ticket in (`t3:apps/server/src/auth/EnvironmentAuth.ts`). */
export const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

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
  HttpRouter.HttpRouter | GatewayAuth | WebSocketTickets | GatewayEnvironment | MendClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* GatewayAuth;
    const tickets = yield* WebSocketTickets;
    const environment = yield* GatewayEnvironment;
    const mend = yield* MendClient;

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
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.provide(gatewayRpcHandlersLayer(bearer.session)),
          Effect.provideService(GatewayEnvironment, environment),
          Effect.provideService(MendClient, mend),
          Effect.forkScoped,
        );
        return yield* httpEffect;
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
