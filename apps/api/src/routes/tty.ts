import { Auth } from "@mend/auth";
import {
  OrganizationsRepo,
  SessionControlEventsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  UpgradeTicketsRepo,
} from "@mend/db";
import { SessionId, SessionProcessId, type SealantWorkspaceId } from "@mend/domain";
import { currentAgentProcess } from "@mend/domain/workbench";
import { asSealantUser, SealantClient, SealantPlatformError } from "@mend/sealant";
import { WorkspaceCaller } from "@mend/sessions";
import { Duration, Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { Budgets } from "../budgets.ts";
import { ConnectionRegistry, guardSocket } from "../connections.ts";
import { SessionSteering } from "../session-steering.ts";
import { connectionRefusal, makeFrameGuard } from "../socket-budgets.ts";
import { isUpgradeCaller, resolveUpgradeCaller, UrlBearers } from "./upgrade-tickets.ts";

/** How long the platform may take to hand over a terminal before the upgrade is answered without one. */
export const TTY_ATTACH_BOUND = Duration.seconds(20);

/** What one client frame asks of the PTY. */
export type TtyInput =
  | { readonly kind: "input"; readonly data: string | Uint8Array }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number };

/**
 * Read one client frame. Only the session's owner types in its terminal, even while control is
 * shared (docs/adr/0013-whoever-sends-a-turn-pays.md, "Terminal sessions: only the owner types"):
 * for anyone else every frame is null, keys and resizes alike, and the output keeps streaming.
 * An unknown or malformed text frame is null too.
 */
export const ttyInputOf = (data: string | Uint8Array, typing: boolean): TtyInput | null => {
  if (!typing) return null;
  if (typeof data !== "string") return { kind: "input", data };
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null || !("t" in frame)) return null;
  if (
    frame.t === "resize" &&
    "cols" in frame &&
    "rows" in frame &&
    typeof frame.cols === "number" &&
    typeof frame.rows === "number"
  ) {
    return { kind: "resize", cols: frame.cols, rows: frame.rows };
  }
  // Text-frame input: native clients (Hermes) send this — binary encoding is unreliable there,
  // and the SDK encodes.
  if (frame.t === "input" && "data" in frame && typeof frame.data === "string") {
    return { kind: "input", data: frame.data };
  }
  return null;
};

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
 * Any steerer may attach; only the session's owner types (`ttyInputOf`, docs/adr/0013).
 *
 * Auth: the session cookie (browser), an `Authorization` header, or `?ticket=`: an upgrade
 * ticket, single use, thirty seconds, minted for exactly this terminal (docs/adr/0004, "Upgrade
 * tickets"), because a WebSocket opened by a browser or the CLI cannot set a header. A bearer as
 * `?token=` is read only while `MEND_URL_BEARERS=accept`. Addressing stays query-param: `?process=<id>` reaches any
 * workspace process by its plural record (docs/SESSION-SERVICES.md);
 * `?session=<id>` (legacy) resolves to the session's CURRENT agent process
 * — the newest live one, else the newest ever — falling back to the row's
 * mirrored pointer for sessions that predate process rows. `&from=<seq>`
 * replays either.
 */
export const TtyRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const connections = yield* ConnectionRegistry;
    const tickets = yield* UpgradeTicketsRepo;
    const organizations = yield* OrganizationsRepo;
    const urlBearers = yield* UrlBearers;
    const budgets = yield* Budgets;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const steering = yield* SessionSteering;
    const sealant = yield* SealantClient;
    const workspaces = yield* WorkspaceCaller;
    const controlEvents = yield* SessionControlEventsRepo;

    yield* router.add("GET", "/api/tty", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://mend.local");

        // Authenticate once, before upgrading.
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
          target: "tty",
        });
        if (!isUpgradeCaller(caller)) return caller;

        // Before anything is resolved, dialled or upgraded (docs/adr/0004, "Budgets").
        const overBudget = yield* connectionRefusal(
          budgets,
          connections,
          caller.userId,
          "terminal",
        );
        if (overBudget !== null) return overBudget;

        // Two address forms resolve to one (workspace, PTY) pair.
        const processParam = url.searchParams.get("process");
        const sessionParam = url.searchParams.get("session");
        let target: {
          readonly sealantWorkspaceId: SealantWorkspaceId;
          readonly sealantSessionId: string;
          /** The session owner: the PTY belongs to THEIR Sealant user, whoever attaches. */
          readonly ownerUserId: string | null;
          /** The session the PTY belongs to, and the process when one was named. */
          readonly sessionId: SessionId;
          readonly processId: string | null;
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
          const refusal = yield* steering.authorizeUser(owner.value, caller.userId).pipe(
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
            sessionId: owner.value.id,
            processId: process.id,
          };
        } else if (sessionParam !== null) {
          const session = yield* sessions.byId(SessionId.make(sessionParam)).pipe(Effect.option);
          if (Option.isNone(session)) {
            return HttpServerResponse.text("unknown session", { status: 404 });
          }
          // Visibility first: a session the caller cannot see answers exactly like a missing one.
          const refusal = yield* steering.authorizeUser(session.value, caller.userId).pipe(
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
                  sessionId: session.value.id,
                  processId: agent.id,
                }
              : session.value.sealantWorkspaceId !== null && session.value.sealantSessionId !== null
                ? {
                    sealantWorkspaceId: session.value.sealantWorkspaceId,
                    sealantSessionId: session.value.sealantSessionId,
                    ownerUserId,
                    sessionId: session.value.id,
                    processId: null,
                  }
                : null;
          if (resolved === null) {
            return HttpServerResponse.text("session has no platform PTY", { status: 409 });
          }
          target = resolved;
        } else {
          return HttpServerResponse.text("missing ?process or ?session", { status: 400 });
        }
        const { sealantWorkspaceId, sealantSessionId, ownerUserId, sessionId } = target;
        const from = BigInt(url.searchParams.get("from") ?? "0");

        // An attachment the platform hands over after the bound below has nobody to pump it.
        let closeLate: (() => void) | null = null;
        const resolved = yield* Effect.gen(function* () {
          // Typing into an existing terminal is acting in its workspace: refused, before anything
          // attaches, for an owner who may no longer work there (review 2 of mend#558, P2-1).
          // Watching only reads its output.
          if (caller.userId === ownerUserId) yield* workspaces.mayAct(sealantWorkspaceId);
          const workspace = yield* sealant.getWorkspace(sealantWorkspaceId);
          const pty = yield* sealant.getSession(workspace, sealantSessionId);
          const attaching = pty.attach({ from });
          closeLate = () =>
            void attaching.then(
              (late) => late.close(),
              () => undefined,
            );
          // A settled session has no PTY to attach — that is a state, not a crash.
          const attachment = yield* Effect.tryPromise({
            try: () => attaching,
            catch: () => new Error(`the session has no live PTY (it may have settled)`),
          });
          return { ok: true as const, status: 200, attachment };
        }).pipe(
          // As the session's owner, after the caller was authorized above. A joined session's PTY
          // runs in another person's executor: the client asks about it as that executor's
          // creator, for an owner who may work there (`WorkspaceCaller`, alpha 2026-10-06).
          asSealantUser(ownerUserId),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              status: error instanceof SealantPlatformError && error.status === 403 ? 403 : 502,
              message: String(error.message),
            }),
          ),
          // Bounded, so the upgrade is answered before a client gives up on it (the CLI waits
          // 30 s): a platform slow to attach reads as that, and the session keeps running.
          Effect.timeoutOrElse({
            duration: TTY_ATTACH_BOUND,
            orElse: () =>
              Effect.sync(() => {
                closeLate?.();
                return {
                  ok: false as const,
                  status: 504,
                  message: `the platform did not attach the terminal within ${Duration.toSeconds(TTY_ATTACH_BOUND)} s · the session keeps running · attach again`,
                };
              }),
          }),
        );
        if (!resolved.ok) {
          return HttpServerResponse.text(resolved.message, { status: resolved.status });
        }
        const attachment = resolved.attachment;

        // The pump, scope-bound to this handler fiber: the client closing the
        // socket interrupts it, and the finalizer drops the platform
        // attachment (the session itself keeps running).
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => attachment.close()));
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Anyone but the owner watches: output streams, their keys and resizes are dropped.
            const typing = caller.userId === ownerUserId;
            yield* controlEvents.record({
              sessionId,
              actorUserId: caller.userId,
              kind: typing ? "terminal-attach" : "terminal-watch",
              refId: target.processId,
            });
            // Removing the account closes this socket, and drops its input from then on (docs/adr/0003).
            const guard = yield* guardSocket(
              connections,
              caller.userId,
              write,
              caller.stillAdmitted,
              sessionId,
              "terminal",
            );
            const frames = makeFrameGuard(budgets.limits.frameBytes, write);

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
                if (guard.revoked()) return Effect.void;
                const overFrame = frames.refuse(data);
                if (overFrame !== null) return overFrame;
                const input = ttyInputOf(data, typing);
                if (input?.kind === "input") attachment.send(input.data);
                if (input?.kind === "resize") attachment.resize(input.cols, input.rows);
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
