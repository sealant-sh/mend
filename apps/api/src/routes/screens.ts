import { randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";

import {
  CurrentUser,
  MendApi,
  SCREEN_SOCKET_CLOSE,
  type ScreenControlResult,
  type ScreenHolder,
  type ScreenRead,
  type ScreenSocketHello,
} from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { OrganizationsRepo, ScreensRepo, UpgradeTicketsRepo } from "@mend/db";
import { SessionId, ViewerConnectionId } from "@mend/domain";
import { SCREEN_LIMITS, type ScreenInput, type ScreenLogBody } from "@mend/domain/workbench";
import { type ScreenControlAnswer, Screens, type ViewerBytes, type WatchEnd } from "@mend/sessions";
import { type Cause, Duration, Effect, Queue, Semaphore } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Socket } from "effect/socket";

import { ProjectAccess } from "../access.ts";
import { Budgets } from "../budgets.ts";
import { ConnectionRegistry } from "../connections.ts";
import { ScreenWatch } from "../screen-watch.ts";
import { makeFrameGuard, reserveScreenViewer } from "../socket-budgets.ts";
import { isUpgradeCaller, resolveUpgradeCaller, UrlBearers } from "./upgrade-tickets.ts";

/** Who holds a screen's input, as watchers see it (ADR 0020, "How people watch and take over"). */
const holderOf = (input: ScreenInput): ScreenHolder => {
  switch (input._tag) {
    case "Agent":
      return { _tag: "Agent", awaiting: false };
    case "AwaitingAgent":
      return { _tag: "Agent", awaiting: true };
    case "Person":
      return { _tag: "Person", userId: input.userId, taking: false };
    case "Fencing":
      return input.to._tag === "Person"
        ? { _tag: "Person", userId: input.by, taking: true }
        : { _tag: "Agent", awaiting: true };
    case "Paused":
      return { _tag: "Paused", reason: input.reason };
  }
};

const resultOf = (answer: ScreenControlAnswer): ScreenControlResult =>
  answer._tag === "Changed" ? { _tag: "Changed", holder: holderOf(answer.next) } : answer;

const OWNER_ONLY: ScreenControlResult = { _tag: "Refused", why: "owner-only" };
const NOT_WATCHING: ScreenControlResult = { _tag: "NotWatching" };
const NO_SCREEN: ScreenRead = { _tag: "NoScreen" };

/** The log entries that give the input to its holder. */
const GIVES_INPUT: ReadonlyArray<ScreenLogBody["_tag"]> = [
  "Started",
  "Restarted",
  "Taken",
  "HandedBack",
  "Paused",
];

export const ScreensGroupLive = HttpApiBuilder.group(MendApi, "screens", (handlers) =>
  handlers
    .handle("read", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* (yield* ProjectAccess).session(params.id);
        const repo = yield* ScreensRepo;
        const screen = yield* repo.ofSession(session.id);
        if (screen === null) return NO_SCREEN;
        const given = yield* repo.lastLoggedAt(screen.id, GIVES_INPUT);
        const read: ScreenRead = {
          _tag: "Screen",
          display: screen.display,
          width: SCREEN_LIMITS.width,
          height: SCREEN_LIMITS.height,
          life: screen.life,
          holder: holderOf(screen.input),
          since: screen.input._tag === "Paused" ? screen.input.since : given,
          ownerUserId: session.ownerUserId,
        };
        return read;
      }),
    )
    .handle("take", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = (yield* CurrentUser).user.id;
        const session = yield* (yield* ProjectAccess).session(params.id);
        if (session.ownerUserId !== caller) return OWNER_ONLY;
        // `Screens.take` trusts the connection it is given: it must be this owner's own open viewer.
        if (!(yield* (yield* ScreenWatch).isOpen(payload.connection, caller, session.id))) {
          return NOT_WATCHING;
        }
        return resultOf(yield* (yield* Screens).take(session.id, caller, payload.connection));
      }),
    )
    .handle("handBack", ({ params }) =>
      Effect.gen(function* () {
        const caller = (yield* CurrentUser).user.id;
        const session = yield* (yield* ProjectAccess).session(params.id);
        if (session.ownerUserId !== caller) return OWNER_ONLY;
        return resultOf(yield* (yield* Screens).handBack(session.id, caller));
      }),
    ),
);

export interface ScreenSocketTiming {
  /** How often the server pings; a client silent for two pings in a row has stopped answering. */
  readonly pingEvery: Duration.Input;
}

/**
 * Two pings span the 10 s heartbeat lease, and the route renews it at each ping until the client
 * has missed two, so a silent holder lapses as `disconnected` a ping before its lease would end.
 */
export const SCREEN_SOCKET_TIMING: ScreenSocketTiming = { pingEvery: "5 seconds" };

const MISSED_PINGS = 2;
const UPLOAD_HOLD_BYTES = 1024 * 1024;
/** RFC 6455 §5.5.2: an unmasked ping with no payload, as a server sends one. */
const PING = Uint8Array.of(0x89, 0x00);

const close = (code: number, reason: string) => new Socket.CloseEvent(code, reason);

const closeOf = (end: WatchEnd): Socket.CloseEvent | null => {
  switch (end._tag) {
    case "ViewerLeft":
      return null;
    case "ScreenEnded":
      return end.how === "closed"
        ? close(SCREEN_SOCKET_CLOSE.screenEnded, "screen ended")
        : close(SCREEN_SOCKET_CLOSE.screenReset, "screen connection reset");
    case "NoScreen":
      return close(SCREEN_SOCKET_CLOSE.noScreen, "no live screen");
    case "Unreachable":
      return close(SCREEN_SOCKET_CLOSE.unreachable, end.reason);
    case "ViewerRefused":
      return close(SCREEN_SOCKET_CLOSE.viewerRefused, end.reason);
    case "FellBehind":
      return close(SCREEN_SOCKET_CLOSE.fellBehind, "viewer fell behind");
  }
};

/**
 * The upgraded TCP socket under the WebSocket. Effect's socket hides `ws`'s ping and its send
 * buffer; both are this socket's: a ping is two bytes written between `ws`'s whole frames, any
 * byte from the client (its pong included) is an answer, and its unwritten bytes are what the
 * viewer has not taken yet.
 */
const upgradedSocketOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof IncomingMessage ? request.source.socket : null;

export const makeScreenSocketRoutes = (timing: ScreenSocketTiming) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const auth = yield* Auth;
      const connections = yield* ConnectionRegistry;
      const tickets = yield* UpgradeTicketsRepo;
      const organizations = yield* OrganizationsRepo;
      const urlBearers = yield* UrlBearers;
      const budgets = yield* Budgets;
      const watch = yield* ScreenWatch;
      const screens = yield* Screens;

      yield* router.add("GET", "/api/screen-socket", (request) =>
        Effect.gen(function* () {
          const url = new URL(request.url, "http://mend.local");
          const headers = new Headers(
            Object.entries(request.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(",") : v,
            ]),
          );
          const caller = yield* resolveUpgradeCaller({
            auth,
            tickets,
            organizations,
            urlBearers,
            headers,
            url,
            target: "screen",
          });
          if (!isUpgradeCaller(caller)) return caller;
          const param = url.searchParams.get("session");
          if (param === null || param === "") {
            return HttpServerResponse.text("missing ?session", { status: 400 });
          }
          const sessionId = SessionId.make(param);
          const subject = { userId: caller.userId, credential: caller.credential };
          const viewer = yield* watch.admit(subject, sessionId).pipe(Effect.option);
          // A session the caller cannot see answers exactly like a missing one, before any budget
          // is counted, so a full screen says nothing of a session the caller cannot see.
          if (viewer._tag === "None") {
            return HttpServerResponse.text("unknown session", { status: 404 });
          }
          const tcp = upgradedSocketOf(request);
          if (tcp === null) {
            return HttpServerResponse.text("the screen socket needs Node's HTTP server", {
              status: 501,
            });
          }
          const mayTakeInput = viewer.value.ownerUserId === caller.userId;

          return yield* Effect.scoped(
            Effect.gen(function* () {
              // Before anything is dialled or upgraded (docs/adr/0004, "Budgets"), and held from
              // the moment it is counted until the socket closes.
              const held = yield* reserveScreenViewer(
                budgets,
                connections,
                caller.userId,
                sessionId,
              );
              if (held._tag === "Refused") return held.response;
              const socket = yield* request.upgrade;
              const { write } = yield* socket.writer;
              // Reading opens the socket for writing too, so the reader comes before any frame.
              const { pull } = yield* socket.reader;
              let closing = false;
              const closeWith = (event: Socket.CloseEvent) =>
                Effect.suspend(() => {
                  closing = true;
                  return write(event).pipe(Effect.ignore);
                });
              // Leaving the organization closes it; shared control going off does not (D2).
              yield* held.opened(closeWith, caller.stillAdmitted);
              const guard = held;
              const frames = makeFrameGuard(budgets.limits.frameBytes, closeWith);
              const connection = ViewerConnectionId.make(
                `vc_${randomBytes(16).toString("base64url")}`,
              );

              const inbound = yield* Queue.unbounded<Uint8Array, Cause.Done>();
              const room = yield* Semaphore.make(UPLOAD_HOLD_BYTES);
              yield* Effect.forkScoped(
                Effect.gen(function* () {
                  for (;;) {
                    for (const data of yield* pull) {
                      if (guard.revoked()) continue;
                      const overFrame = frames.refuse(data);
                      if (overFrame !== null) return yield* overFrame;
                      if (typeof data === "string") {
                        return yield* closeWith(
                          close(SCREEN_SOCKET_CLOSE.viewerRefused, "binary RFB only"),
                        );
                      }
                      yield* room.take(Math.min(UPLOAD_HOLD_BYTES, data.byteLength));
                      yield* Queue.offer(inbound, data);
                    }
                  }
                }).pipe(Effect.ignore, Effect.ensuring(Queue.end(inbound))),
              );
              const bytes: ViewerBytes = {
                read: Queue.take(inbound).pipe(
                  Effect.tap((data) => room.release(Math.min(UPLOAD_HOLD_BYTES, data.byteLength))),
                  Effect.orElseSucceed(() => null),
                ),
                write: (data) => (closing ? Effect.void : write(data).pipe(Effect.ignore)),
                unsent: Effect.sync(() => tcp.writableLength),
              };

              let heard = true;
              const onData = () => {
                heard = true;
              };
              tcp.on("data", onData);
              yield* Effect.addFinalizer(() => Effect.sync(() => void tcp.off("data", onData)));
              // The lease is renewed at every ping while the client still counts as answering,
              // so it runs a ping past this loop: a silent holder lapses here, as disconnected,
              // before its lease could lapse it.
              const stoppedAnswering = Effect.gen(function* () {
                for (let missed = 0; missed < MISSED_PINGS; ) {
                  yield* Effect.sleep(timing.pingEvery);
                  if (heard) {
                    heard = false;
                    missed = 0;
                  } else {
                    missed += 1;
                  }
                  if (mayTakeInput && missed < MISSED_PINGS) {
                    yield* screens.heartbeat(sessionId, connection);
                  }
                  if (!closing && tcp.writable) tcp.write(PING);
                }
              });

              // The hello goes out once the connection is open, so a Take over that names it finds it.
              const hello: ScreenSocketHello = { type: "connection", connection };
              const watched = watch.hold(subject, sessionId, () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* watch.open(connection, caller.userId, sessionId);
                    yield* write(JSON.stringify(hello)).pipe(Effect.ignore);
                    return yield* screens.watch({ sessionId, connection, mayTakeInput }, bytes);
                  }),
                ),
              );
              const ended = yield* Effect.raceFirst(
                Effect.map(watched, closeOf),
                Effect.as(
                  stoppedAnswering,
                  close(SCREEN_SOCKET_CLOSE.stoppedAnswering, "stopped answering"),
                ),
              ).pipe(
                Effect.catchTags({
                  NotFound: () =>
                    Effect.succeed(close(SCREEN_SOCKET_CLOSE.accessEnded, "access revoked")),
                  ScreenAccessEnded: (stop) =>
                    Effect.succeed(
                      stop.reason === "access-ended"
                        ? close(SCREEN_SOCKET_CLOSE.accessEnded, "access revoked")
                        : close(SCREEN_SOCKET_CLOSE.recheckUnavailable, "access not checked"),
                    ),
                }),
              );
              if (mayTakeInput) {
                const revoked = guard.revoked() || ended?.code === SCREEN_SOCKET_CLOSE.accessEnded;
                yield* screens.lapse(sessionId, connection, revoked ? "revoked" : "disconnected");
              }
              if (ended !== null) yield* closeWith(ended);
              return HttpServerResponse.empty();
            }),
          );
        }),
      );
    }),
  );

/** `/api/screen-socket`: one viewer of a session's screen per socket. */
export const ScreenSocketRoutes = makeScreenSocketRoutes(SCREEN_SOCKET_TIMING);
