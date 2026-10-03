import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { WEBSOCKET_TICKET_QUERY_PARAM } from "../../src/ws.ts";

/**
 * The gateway's `/ws` URL as t3code's client builds it: the WebSocket origin of the HTTP base,
 * the ticket, and the orchestration protocol it speaks
 * (`t3:packages/client-runtime/src/authorization/remote.ts`).
 */
export const socketUrl = (
  ticket: string | null,
  protocol: string | null = String(ORCHESTRATION_PROTOCOL_VERSION),
) =>
  HttpServer.addressFormattedWith((base) =>
    Effect.sync(() => {
      const url = new URL("/ws", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (ticket !== null) url.searchParams.set(WEBSOCKET_TICKET_QUERY_PARAM, ticket);
      if (protocol !== null) url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, protocol);
      return url.toString();
    }),
  );

/**
 * An Effect RPC client of t3code's `WsRpcGroup`, built the way t3code's own session builds one
 * (`t3:packages/client-runtime/src/rpc/session.ts` and `rpc/protocol.ts` at the pin): a socket
 * protocol over the global WebSocket, JSON serialization, no retries.
 */
export const connectWsRpc = (url: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, { openTimeout: "5 seconds" }),
            RpcSerialization.layerJson,
          ),
        ),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  });
