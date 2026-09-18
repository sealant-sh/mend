import { Auth } from "@mend/auth";
import {
  OrganizationsRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionsRepo,
  UpgradeTicketsRepo,
} from "@mend/db";
import { ServiceId } from "@mend/domain";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { Budgets } from "../budgets.ts";
import { ConnectionRegistry, guardSocket } from "../connections.ts";
import { SessionSteering } from "../session-steering.ts";
import { connectionRefusal, makeFrameGuard } from "../socket-budgets.ts";
import { isUpgradeCaller, resolveUpgradeCaller, UrlBearers } from "./upgrade-tickets.ts";

/**
 * The Service tunnel (docs/SESSION-SERVICES.md): the client-side data plane
 * for supervised Services. The server-side listener (`MEND_SERVICE_HOSTS`)
 * binds the SERVER's interfaces — the right thing when the server is your
 * machine, useless when it is a Pod or a VPS. This route is the
 * location-independent path: `mend service connect` binds the port on the
 * CLIENT's loopback and pumps each accepted connection over one WebSocket
 * here, which dials the same `workspace.forward` pipe the listener uses.
 * Rides the ONE endpoint every deployment already exposes (the Mend API),
 * and unlike the raw listener every connection is authenticated as a Mend
 * user.
 *
 * Wire protocol, mirroring `/api/tty`'s one-socket-per-attachment shape:
 *   client → server   binary = bytes toward the workspace port
 *   client → server   text   = `{"t":"eof"}` half-close (no more outbound bytes)
 *   server → client   binary = bytes from the workspace port
 *   server → client   close  = the workspace side ended
 *
 * Auth: session cookie (browser) or `?token=` (CLI; WebSocket cannot set
 * headers). Addressing: `?service=<id>`. TCP only — UDP has no connection to
 * pump; its relay stays a server-listener concern.
 */
export const ServiceTunnelRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const connections = yield* ConnectionRegistry;
    const tickets = yield* UpgradeTicketsRepo;
    const organizations = yield* OrganizationsRepo;
    const urlBearers = yield* UrlBearers;
    const budgets = yield* Budgets;
    const services = yield* ServicesRepo;
    const forwards = yield* ServiceForwardsRepo;
    const sessions = yield* SessionsRepo;
    const steering = yield* SessionSteering;
    const sealant = yield* SealantClient;

    yield* router.add("GET", "/api/service-tunnel", (request) =>
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
          target: "service-tunnel",
        });
        if (!isUpgradeCaller(caller)) return caller;

        // Before anything is resolved, dialled or upgraded (docs/adr/0004, "Budgets").
        const overBudget = yield* connectionRefusal(budgets, connections, caller.userId, "tunnel");
        if (overBudget !== null) return overBudget;

        const serviceParam = url.searchParams.get("service");
        if (serviceParam === null) {
          return HttpServerResponse.text("missing ?service", { status: 400 });
        }
        const service = yield* services.byId(ServiceId.make(serviceParam));
        if (service === null) {
          return HttpServerResponse.text("unknown service", { status: 404 });
        }
        const owner = yield* sessions.byId(service.sessionId).pipe(Effect.option);
        if (Option.isNone(owner)) {
          return HttpServerResponse.text("unknown service", { status: 404 });
        }
        // Visibility first: a session the caller cannot see answers exactly like a missing one.
        const refusal = yield* steering.authorizeUser(owner.value, caller.userId).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error._tag)),
        );
        if (refusal === "NotFound")
          return HttpServerResponse.text("unknown service", { status: 404 });
        if (refusal !== null) return HttpServerResponse.text("forbidden", { status: 403 });
        if (service.transport === "udp") {
          return HttpServerResponse.text("UDP Services have no connection to tunnel", {
            status: 409,
          });
        }
        // The tunnel needs the WORKSPACE, not a healthy server-side listener: a live
        // forward names it, else the session row does (the listener can be legitimately
        // unbindable — e.g. a stale Pod-IP policy — while the Service process runs on).
        const forward =
          service.currentForwardId === null ? null : yield* forwards.byId(service.currentForwardId);
        const ownerUserId = owner.value.ownerUserId;
        // Authenticated is not authorized. Both raw steering routes apply the same owner rule;
        // the unauthenticated raw listener can only rely on network reach.
        const workspaceId =
          forward !== null && (forward.state === "binding" || forward.state === "bound")
            ? forward.sealantWorkspaceId
            : owner.value.sealantWorkspaceId;
        if (workspaceId === null) {
          return HttpServerResponse.text("the Service has no live workspace", { status: 409 });
        }

        // The same two-element dial chain as the server-side listener: the
        // container loopback first, then the workspace-scoped dind sidecar.
        const dialed = yield* Effect.gen(function* () {
          const workspace = yield* sealant.getWorkspace(workspaceId);
          const pipe = yield* sealant
            .forward(workspace, service.workspacePort, "127.0.0.1")
            .pipe(Effect.catch(() => sealant.forward(workspace, service.workspacePort, "docker")));
          return { ok: true as const, pipe };
        }).pipe(
          asSealantUser(ownerUserId),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, message: String(error.message) }),
          ),
        );
        if (!dialed.ok) return HttpServerResponse.text(dialed.message, { status: 502 });
        const pipe = dialed.pipe;

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => pipe.close()));
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Removing the account closes this socket, and drops its input from then on (docs/adr/0003).
            const guard = yield* guardSocket(
              connections,
              caller.userId,
              write,
              caller.stillAdmitted,
              owner.value.id,
              "tunnel",
            );
            const frames = makeFrameGuard(budgets.limits.frameBytes, write);

            const iterator = pipe.output[Symbol.asyncIterator]();
            const pumpOutput = Effect.gen(function* () {
              for (;;) {
                const next = yield* Effect.promise(() => iterator.next());
                if (next.done === true) break;
                yield* write(next.value);
              }
              yield* write(new Socket.CloseEvent(1000, "workspace side ended"));
            }).pipe(Effect.ignore);
            yield* Effect.forkScoped(pumpOutput);

            yield* socket
              .runRaw((data) => {
                if (guard.revoked()) return Effect.void;
                const overFrame = frames.refuse(data);
                if (overFrame !== null) return overFrame;
                if (typeof data !== "string") {
                  pipe.send(data);
                  return Effect.void;
                }
                try {
                  const frame = JSON.parse(data) as { readonly t?: string };
                  if (frame.t === "eof") pipe.eof();
                } catch {
                  // Unknown text frame — ignore.
                }
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
