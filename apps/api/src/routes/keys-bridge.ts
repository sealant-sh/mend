import { Auth } from "@mend/auth";
import { OrganizationsRepo, UpgradeTicketsRepo } from "@mend/db";
import { AgentBridge } from "@mend/store";
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { Budgets } from "../budgets.ts";
import { ConnectionRegistry, guardSocket } from "../connections.ts";
import { connectionRefusal, makeFrameGuard } from "../socket-budgets.ts";
import { isUpgradeCaller, resolveUpgradeCaller, UrlBearers } from "./upgrade-tickets.ts";

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
    const connections = yield* ConnectionRegistry;
    const tickets = yield* UpgradeTicketsRepo;
    const organizations = yield* OrganizationsRepo;
    const urlBearers = yield* UrlBearers;
    const budgets = yield* Budgets;
    const bridge = yield* AgentBridge;

    yield* router.add("GET", "/api/keys/bridge/ws", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://mend.local");
        const headers = new Headers(
          Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
        );
        // A ticket, a header or the cookie; a bearer in the URL only while MEND_URL_BEARERS allows it
        // (docs/adr/0004, "Upgrade tickets").
        const caller = yield* resolveUpgradeCaller({
          auth,
          tickets,
          organizations,
          urlBearers,
          headers,
          url,
          target: "keys-bridge",
        });
        if (!isUpgradeCaller(caller)) return caller;

        // Before anything is resolved, dialled or upgraded (docs/adr/0004, "Budgets").
        const overBudget = yield* connectionRefusal(
          budgets,
          connections,
          caller.userId,
          "key-bridge",
        );
        if (overBudget !== null) return overBudget;

        const clientName = url.searchParams.get("host") ?? "unknown machine";

        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Removing the account closes this socket, and drops its input from then on (docs/adr/0003).
            const guard = yield* guardSocket(
              connections,
              caller.userId,
              write,
              caller.stillAdmitted,
              undefined,
              "key-bridge",
            );
            const frames = makeFrameGuard(budgets.limits.frameBytes, write);

            // The bridge speaks through a plain callback; each frame rides
            // its own forked fiber (writes are tiny and ordered enough — the
            // agent protocol above serializes at one in-flight request).
            // The share serves this account's own bridge; it never signs for anyone else.
            const handle = yield* bridge.attach(caller.userId, {
              name: clientName,
              send: (frame) => {
                Effect.runFork(write(frame).pipe(Effect.ignore));
              },
            });
            yield* Effect.addFinalizer(() => Effect.sync(() => handle.detach()));

            yield* socket
              .runRaw((data) => {
                if (guard.revoked()) return Effect.void;
                const overFrame = frames.refuse(data);
                if (overFrame !== null) return overFrame;
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
