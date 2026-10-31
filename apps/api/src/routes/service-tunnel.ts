import { Auth } from "@mend/auth";
import {
  OrganizationsRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionsRepo,
  UpgradeTicketsRepo,
} from "@mend/db";
import { ServiceId } from "@mend/domain";
import { asSealantUser, type ForwardIssueReason } from "@mend/sealant";
import { ForwardAdapter, portTarget, ServiceHost } from "@mend/sessions";
import { type Cause, Effect, Option, Queue, Semaphore } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

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
 * here, which dials through the same forward adapter as the listener.
 * Rides the ONE endpoint every deployment already exposes (the Mend API),
 * and unlike the raw listener every connection is authenticated as a Mend
 * user.
 *
 * Wire protocol, mirroring `/api/tty`'s one-socket-per-attachment shape:
 *   client → server   binary = bytes toward the workspace port
 *   client → server   text   = `{"t":"eof"}` half-close (no more outbound bytes)
 *   server → client   binary = bytes from the workspace port
 *   server → client   close 1000 = the workspace side ended, after every byte it sent
 *   server → client   close 1011 = the forward was reset: what arrived is all there is
 *   server → client   close 4410 = the Service is stopping or restarting; the reason says which
 *   server → client   close 4xxx = the dial was refused; the reason names why (below)
 *
 * Auth: session cookie (browser) or `?token=` (CLI; WebSocket cannot set
 * headers). Addressing: `?service=<id>`. TCP only — UDP has no connection to
 * pump; its relay stays a server-listener concern.
 */

const UPLOAD_HOLD_BYTES = 1024 * 1024;

const SERVICE_GONE_CLOSE = 4410;

const frameSize = (frame: string | Uint8Array): number =>
  typeof frame === "string" ? frame.length : frame.byteLength;

/**
 * The close code a refused dial ends the tunnel with: 4000 plus the HTTP status the refusal would
 * have had. The reason text is the refusal's name, never Core's message.
 */
const TUNNEL_REFUSAL_CLOSE = {
  "connection-refused": 4502,
  "name-unresolved": 4502,
  "network-unreachable": 4502,
  "dial-failed": 4502,
  "transport-unavailable": 4502,
  internal: 4502,
  "platform-failed": 4502,
  "unrecognized-refusal": 4502,
  "workspace-not-ready": 4503,
  "runtime-unreachable": 4503,
  "runtime-untargetable": 4503,
  "protocol-unsupported": 4503,
  "dial-timeout": 4504,
  "deadline-exceeded": 4504,
  "budget-exceeded": 4429,
  unauthorized: 4401,
  NO_PRINCIPAL: 4401,
  UNKNOWN_USER: 4401,
  forbidden: 4403,
  no_standing: 4403,
  creator_no_access: 4403,
  "not-a-person": 4403,
  "not-found": 4404,
  "owner-exited": 4409,
  "peer-mismatch": 4409,
  "binding-unverifiable": 4409,
  "binding-unsupported": 4409,
  "invalid-target": 4409,
  "owner-required": 4409,
  cancelled: 4499,
} as const satisfies Record<ForwardIssueReason, number>;

const isEof = (data: string): boolean => {
  try {
    const frame: unknown = JSON.parse(data);
    return typeof frame === "object" && frame !== null && "t" in frame && frame.t === "eof";
  } catch {
    return false;
  }
};

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
    const forwardAdapter = yield* ForwardAdapter;
    const serviceHost = yield* ServiceHost;

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

        const target = portTarget(workspaceId, service.workspacePort);

        // The dial runs after the upgrade: a WebSocket client cannot read an HTTP refusal, but it
        // can read a close code.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* request.upgrade;
            const { write } = yield* socket.writer;
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
            const inbound = yield* Queue.unbounded<
              { readonly pulled: ReadonlyArray<string | Uint8Array>; readonly held: number },
              Cause.Done
            >();
            const room = yield* Semaphore.make(UPLOAD_HOLD_BYTES);
            // The client leaving ends the reader: that gives the dial up, or resets the forward.
            const lifetime = new AbortController();
            yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()));
            yield* serviceHost.hold(service.id, (reason) =>
              write(new Socket.CloseEvent(SERVICE_GONE_CLOSE, reason)).pipe(
                Effect.ignore,
                Effect.andThen(Effect.sync(() => lifetime.abort())),
              ),
            );
            const { pull } = yield* socket.reader;
            yield* Effect.forkScoped(
              pull.pipe(
                Effect.flatMap((pulled) => {
                  const held = Math.min(
                    UPLOAD_HOLD_BYTES,
                    pulled.reduce((sum, frame) => sum + frameSize(frame), 0),
                  );
                  return room
                    .take(held)
                    .pipe(Effect.andThen(Queue.offer(inbound, { pulled, held })));
                }),
                Effect.forever,
                Effect.ensuring(
                  Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(Queue.end(inbound))),
                ),
                Effect.ignore,
              ),
            );

            const opened = yield* forwardAdapter
              .open(target, { purpose: "tunnel", signal: lifetime.signal })
              .pipe(
                // As the session's owner, after the caller was authorized above; the client asks
                // about a joined session's executor as its creator (`WorkspaceCaller`).
                asSealantUser(ownerUserId),
                Effect.map((connection) => ({ ok: true as const, connection })),
                Effect.catchTag("ForwardDialFailure", (failure) =>
                  Effect.succeed({ ok: false as const, issue: failure.record.issue }),
                ),
              );
            if (!opened.ok) {
              if (opened.issue.reason !== "cancelled") {
                yield* write(
                  new Socket.CloseEvent(
                    TUNNEL_REFUSAL_CLOSE[opened.issue.reason],
                    opened.issue.reason,
                  ),
                ).pipe(Effect.ignore);
              }
              return;
            }
            const { bytes } = opened.connection;

            // Workspace to client: its FIN is a normal close, after every byte; a reset is not.
            yield* Effect.forkScoped(
              Effect.gen(function* () {
                for (;;) {
                  const next = yield* bytes.read();
                  if (next.kind === "eof") break;
                  yield* write(next.bytes);
                }
                yield* write(new Socket.CloseEvent(1000, "workspace side ended"));
              }).pipe(
                Effect.catchTag("ForwardIoFailure", (failure) =>
                  write(new Socket.CloseEvent(1011, `reset: ${failure.reason}`)),
                ),
                Effect.ignore,
              ),
            );

            // Client to workspace, one frame at a time: each write waits for the workspace's room.
            yield* Effect.gen(function* () {
              for (;;) {
                const batch = yield* Queue.take(inbound);
                for (const data of batch.pulled) {
                  if (guard.revoked()) continue;
                  const overFrame = frames.refuse(data);
                  if (overFrame !== null) {
                    yield* overFrame;
                    continue;
                  }
                  if (typeof data !== "string") yield* bytes.write(data);
                  else if (isEof(data)) yield* bytes.finish();
                }
                yield* room.release(batch.held);
              }
            }).pipe(
              Effect.catchTag("ForwardIoFailure", (failure) =>
                write(new Socket.CloseEvent(1011, `reset: ${failure.reason}`)),
              ),
              Effect.ignore,
            );
          }),
        );

        return HttpServerResponse.empty();
      }),
    );
  }),
);
