import { Auth } from "@mend/auth";
import { SessionProcessesRepo, SessionsRepo } from "@mend/db";
import { SessionId, SessionProcessId, type SealantWorkspaceId } from "@mend/domain";
import { currentAgentProcess } from "@mend/domain/workbench";
import { asSealantUser, SealantClient } from "@mend/sealant";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { ConnectionRegistry } from "../connections.ts";
import { SessionSteering } from "../session-steering.ts";

/**
 * The terminal proxy (plan §8.1.F) as a DATA PLANE: one WebSocket per attach.
 * The CLI (and later the phone/web pane) reaches a session's platform PTY
 * through Mend, never the control plane directly — Mend's token is the only
 * credential a client holds. Auth happens ONCE at the upgrade, the platform
 * attachment (`session.attach`, itself one held WebSocket to the control
 * plane's held daemon connection) is opened ONCE, and after that a keystroke
 * is a binary frame on open sockets — no per-event auth, DB, HTTP, or
 * process spawns anywhere on the path.
 *
 * Wire protocol (mirrors the platform's `sealant.attach.v1`):
 *   server → client   binary = PTY output bytes (replay from `?from=`, then live)
 *   server → client   text   = `{"t":"end"}` then close (session settled)
 *   client → server   binary = PTY input bytes
 *   client → server   text   = `{"t":"resize","cols":n,"rows":n}`
 *
 * Auth: session cookie (browser) or `?token=` (CLI; WebSocket cannot set
 * headers). Addressing stays query-param: `?process=<id>` reaches any
 * workspace process by its plural record (docs/SESSION-SERVICES.md);
 * `?session=<id>` (legacy) resolves to the session's CURRENT agent process
 * — the newest live one, else the newest ever — falling back to the row's
 * mirrored pointer for sessions that predate process rows. `&from=<seq>`
 * replays either.
 */
export const TtyRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const steering = yield* SessionSteering;
    const sealant = yield* SealantClient;
    const connections = yield* ConnectionRegistry;

    yield* router.add("GET", "/api/tty", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://mend.local");

        // Authenticate once, before upgrading. Browser clients carry the
        // cookie; the CLI passes its bearer as ?token= and it is folded into
        // the header shape better-auth expects.
        const headers = new Headers(
          Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
        );
        const token = url.searchParams.get("token");
        if (!headers.has("authorization") && token !== null) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const authed = yield* auth.getSession(headers);
        if (Option.isNone(authed)) return HttpServerResponse.empty({ status: 401 });

        // Two address forms resolve to one (workspace, PTY) pair.
        const processParam = url.searchParams.get("process");
        const sessionParam = url.searchParams.get("session");
        let target: {
          readonly sealantWorkspaceId: SealantWorkspaceId;
          readonly sealantSessionId: string;
          /** The session owner: the PTY belongs to THEIR Sealant user, whoever attaches. */
          readonly ownerUserId: string | null;
        };
        if (processParam !== null) {
          const process = yield* processes.byId(SessionProcessId.make(processParam));
          if (process === null) {
            return HttpServerResponse.text("unknown process", { status: 404 });
          }
          const owner = yield* sessions.byId(process.sessionId).pipe(Effect.option);
          if (Option.isNone(owner)) {
            return HttpServerResponse.text("unknown process", { status: 404 });
          }
          // Visibility first: a session the caller cannot see answers exactly like a missing one.
          const refusal = yield* steering.authorizeUser(owner.value, authed.value.user.id).pipe(
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          if (refusal === "NotFound")
            return HttpServerResponse.text("unknown process", { status: 404 });
          if (refusal !== null) return HttpServerResponse.text("forbidden", { status: 403 });
          if (process.kind === "agent-protocol") {
            return HttpServerResponse.text("protocol agents use the structured conversation API", {
              status: 409,
            });
          }
          const processPtyId = process.sealantSessionId;
          if (processPtyId === null) {
            // Adopted Services forward a port; there is no PTY to attach.
            return HttpServerResponse.text("process has no platform PTY", { status: 409 });
          }
          target = {
            sealantWorkspaceId: process.sealantWorkspaceId,
            sealantSessionId: processPtyId,
            ownerUserId: owner.value.ownerUserId,
          };
        } else if (sessionParam !== null) {
          const session = yield* sessions.byId(SessionId.make(sessionParam)).pipe(Effect.option);
          if (Option.isNone(session)) {
            return HttpServerResponse.text("unknown session", { status: 404 });
          }
          // Visibility first: a session the caller cannot see answers exactly like a missing one.
          const refusal = yield* steering.authorizeUser(session.value, authed.value.user.id).pipe(
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          if (refusal === "NotFound")
            return HttpServerResponse.text("unknown session", { status: 404 });
          if (refusal !== null) return HttpServerResponse.text("forbidden", { status: 403 });
          const agent = currentAgentProcess(yield* processes.listForSession(session.value.id));
          if (agent?.kind === "agent-protocol") {
            return HttpServerResponse.text("protocol agents use the structured conversation API", {
              status: 409,
            });
          }
          const ownerUserId = session.value.ownerUserId;
          const resolved =
            agent !== null && agent.sealantSessionId !== null
              ? {
                  sealantWorkspaceId: agent.sealantWorkspaceId,
                  sealantSessionId: agent.sealantSessionId,
                  ownerUserId,
                }
              : session.value.sealantWorkspaceId !== null && session.value.sealantSessionId !== null
                ? {
                    sealantWorkspaceId: session.value.sealantWorkspaceId,
                    sealantSessionId: session.value.sealantSessionId,
                    ownerUserId,
                  }
                : null;
          if (resolved === null) {
            return HttpServerResponse.text("session has no platform PTY", { status: 409 });
          }
          target = resolved;
        } else {
          return HttpServerResponse.text("missing ?process or ?session", { status: 400 });
        }
        const { sealantWorkspaceId, sealantSessionId, ownerUserId } = target;
        const from = BigInt(url.searchParams.get("from") ?? "0");

        const resolved = yield* Effect.gen(function* () {
          const workspace = yield* sealant.getWorkspace(sealantWorkspaceId);
          const pty = yield* sealant.getSession(workspace, sealantSessionId);
          // A settled session has no PTY to attach — that is a state, not a crash.
          const attachment = yield* Effect.tryPromise({
            try: () => pty.attach({ from }),
            catch: () => new Error(`the session has no live PTY (it may have settled)`),
          });
          return { ok: true as const, attachment };
        }).pipe(
          asSealantUser(ownerUserId),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, message: String(error.message) }),
          ),
        );
        if (!resolved.ok) return HttpServerResponse.text(resolved.message, { status: 502 });
        const attachment = resolved.attachment;

        // The pump, scope-bound to this handler fiber: the client closing the
        // socket interrupts it, and the finalizer drops the platform
        // attachment (the session itself keeps running).
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => attachment.close()));
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Removing the account closes this socket (docs/adr/0003).
            yield* connections.register(
              authed.value.user.id,
              write(new Socket.CloseEvent(1008, "access revoked")).pipe(Effect.ignore),
            );

            const iterator = attachment.output[Symbol.asyncIterator]();
            const pumpOutput = Effect.gen(function* () {
              for (;;) {
                const next = yield* Effect.promise(() => iterator.next());
                if (next.done === true) break;
                yield* write(next.value);
              }
              yield* write(JSON.stringify({ t: "end" }));
              yield* write(new Socket.CloseEvent(1000, "session settled"));
            }).pipe(Effect.ignore);
            yield* Effect.forkScoped(pumpOutput);

            yield* socket
              .runRaw((data) => {
                if (typeof data !== "string") {
                  attachment.send(data);
                  return Effect.void;
                }
                try {
                  const frame = JSON.parse(data) as {
                    readonly t?: string;
                    readonly cols?: number;
                    readonly rows?: number;
                    readonly data?: string;
                  };
                  if (
                    frame.t === "resize" &&
                    typeof frame.cols === "number" &&
                    typeof frame.rows === "number"
                  ) {
                    attachment.resize(frame.cols, frame.rows);
                  }
                  // Text-frame input: native clients (Hermes) send this —
                  // binary encoding is unreliable there, and the SDK encodes.
                  if (frame.t === "input" && typeof frame.data === "string") {
                    attachment.send(frame.data);
                  }
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
