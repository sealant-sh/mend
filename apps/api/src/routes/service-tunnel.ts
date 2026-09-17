import { CurrentUser } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { ServiceForwardsRepo, ServicesRepo, SessionsRepo } from "@mend/db";
import { ServiceId } from "@mend/domain";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { ProjectAccess } from "../access.ts";

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
    const services = yield* ServicesRepo;
    const forwards = yield* ServiceForwardsRepo;
    const sessions = yield* SessionsRepo;
    const sealant = yield* SealantClient;
    const access = yield* ProjectAccess;

    yield* router.add("GET", "/api/service-tunnel", (request) =>
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

        const serviceParam = url.searchParams.get("service");
        if (serviceParam === null) {
          return HttpServerResponse.text("missing ?service", { status: 400 });
        }
        const service = yield* services.byId(ServiceId.make(serviceParam));
        if (service === null) {
          return HttpServerResponse.text("unknown service", { status: 404 });
        }
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
        const owner = yield* sessions.byId(service.sessionId).pipe(Effect.option);
        const ownerUserId = Option.isSome(owner) ? owner.value.ownerUserId : null;
        // Authenticated is not authorized. The raw listener cannot gate per
        // user — network reach is its only gate — but this path can, so it
        // does: whoever can see the project tunnels its Services (docs/adr/0002),
        // the same rule `/api/tty` applies. The dial itself runs as the owner.
        const visible = Option.isNone(owner)
          ? Option.none()
          : yield* access
              .project(owner.value.projectId)
              .pipe(Effect.option, Effect.provideService(CurrentUser, authed.value));
        if (Option.isNone(visible)) {
          return HttpServerResponse.text("unknown service", { status: 404 });
        }
        const workspaceId =
          forward !== null && (forward.state === "binding" || forward.state === "bound")
            ? forward.sealantWorkspaceId
            : Option.isSome(owner)
              ? owner.value.sealantWorkspaceId
              : null;
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
