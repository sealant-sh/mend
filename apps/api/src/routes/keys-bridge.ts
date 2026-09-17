import { Auth } from "@mend/auth";
import { AgentBridge } from "@mend/store";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { ConnectionRegistry } from "../connections.ts";

/**
 * The ssh-agent bridge's transport (docs/GIT-ACCESS.md decision 2): one
 * standing WebSocket from `mend keys share`, JSON text frames carrying
 * base64 agent-protocol messages verbatim. This route only authenticates,
 * upgrades, and shuttles frames — the bridge semantics (unix agent socket,
 * request queue, attribution) live in @mend/store's AgentBridge, which
 * deliberately knows nothing about WebSockets.
 *
 * Auth mirrors /api/tty: session cookie or `?token=` folded into the bearer
 * header (a WebSocket client cannot set headers).
 */
export const KeysBridgeRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const bridge = yield* AgentBridge;
    const connections = yield* ConnectionRegistry;

    yield* router.add("GET", "/api/keys/bridge/ws", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://mend.local");
        const headers = new Headers(
          Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
        );
        const token = url.searchParams.get("token");
        if (!headers.has("authorization") && token !== null) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const authed = yield* auth.getSession(headers);
        if (Option.isNone(authed)) return HttpServerResponse.empty({ status: 401 });

        const clientName = url.searchParams.get("host") ?? "unknown machine";

        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Removing the account closes this socket (docs/adr/0003).
            yield* connections.register(
              authed.value.user.id,
              write(new Socket.CloseEvent(1008, "access revoked")).pipe(Effect.ignore),
            );

            // The bridge speaks through a plain callback; each frame rides
            // its own forked fiber (writes are tiny and ordered enough — the
            // agent protocol above serializes at one in-flight request).
            // The share serves this account's own bridge; it never signs for anyone else.
            const handle = yield* bridge.attach(authed.value.user.id, {
              name: clientName,
              send: (frame) => {
                Effect.runFork(write(frame).pipe(Effect.ignore));
              },
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => handle.detach()));

            yield* socket
              .runRaw((data) => {
                if (typeof data === "string") handle.feed(data);
                else handle.feed(Buffer.from(data).toString("utf8"));
                return Effect.void;
              })
              .pipe(Effect.ignore);
          }),
        );

        return HttpServerResponse.empty();
      }),
    );
  }),
);
