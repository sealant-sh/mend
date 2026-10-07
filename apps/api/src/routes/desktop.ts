import { Auth } from "@mend/auth";
import { HarnessLayoutsRepo, ServicesRepo, SessionsRepo } from "@mend/db";
import { DesktopPilotRequest, SessionId } from "@mend/domain";
import { MEND_GROUP } from "@mend/domain/workbench";
import { asSealantUser, PersonLayoutPlatform, SealantClient } from "@mend/sealant";
import { Effect, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { Budgets } from "../budgets.ts";
import { ConnectionRegistry, guardSocket } from "../connections.ts";
import { SessionSteering } from "../session-steering.ts";
import { connectionRefusal, makeFrameGuard } from "../socket-budgets.ts";
import { capturedDesktop } from "./desktop-capture.ts";
import { desktopHttp, desktopPathAllowed } from "./desktop-http.ts";

/** Authenticated session desktop: HTTP observations and a binary VNC connection over the SDK. */
export const DesktopRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const sessions = yield* SessionsRepo;
    const services = yield* ServicesRepo;
    const steering = yield* SessionSteering;
    const sealant = yield* SealantClient;
    const budgets = yield* Budgets;
    const connections = yield* ConnectionRegistry;
    const layouts = yield* HarnessLayoutsRepo;
    const platform = yield* PersonLayoutPlatform;

    yield* router.add("*", "/api/sessions/:sessionId/desktop/*", (request) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const id = params.sessionId;
        const path = `/${params["*"] ?? ""}`;
        const vnc = path === "/vnc" && request.method === "GET";
        if (!id || (!vnc && !desktopPathAllowed(request.method, path)))
          return HttpServerResponse.empty({ status: 404 });
        if (vnc && request.headers.upgrade?.toLowerCase() !== "websocket")
          return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
        const headers = new Headers(
          Object.entries(request.headers).map(([key, value]) => [key, value]),
        );
        const caller = yield* auth.getSession(headers);
        if (Option.isNone(caller)) return HttpServerResponse.empty({ status: 401 });
        const userId = caller.value.user.id;
        const session = yield* sessions.byId(SessionId.make(id)).pipe(Effect.option);
        if (Option.isNone(session)) return HttpServerResponse.empty({ status: 404 });
        const authorization = yield* steering
          .authorizeUser(session.value, userId)
          .pipe(Effect.result);
        if (authorization._tag === "Failure")
          return HttpServerResponse.empty({
            status: authorization.failure._tag === "NotFound" ? 404 : 403,
          });
        // Running another harness or typing into the workspace spends its owner's credentials,
        // exactly like the existing command and terminal controls (ADR 0013).
        if (session.value.ownerUserId !== userId) return HttpServerResponse.empty({ status: 403 });
        const service = yield* services.byName(session.value.id, "desktop");
        const workspaceId = session.value.sealantWorkspaceId;
        if (!service || service.workspacePort !== 6090 || service.transport !== "tcp")
          return HttpServerResponse.text("Start this session's desktop first", { status: 409 });
        if (!workspaceId) {
          if (request.method === "GET" && !vnc) {
            const captured = yield* capturedDesktop(
              session.value,
              path,
              request.headers.range,
            ).pipe(Effect.option);
            if (Option.isSome(captured) && captured.value !== null) return captured.value;
          }
          return HttpServerResponse.text("The session desktop is stopped", { status: 409 });
        }
        if (vnc) {
          const refusal = yield* connectionRefusal(budgets, connections, userId, "tunnel");
          if (refusal !== null) return refusal;
        }
        const body =
          request.method === "POST" ? new Uint8Array(yield* request.arrayBuffer) : new Uint8Array();
        if (body.byteLength > 32000) {
          return HttpServerResponse.empty({ status: 413 });
        }
        if (request.method === "POST" && path === "/pilot") {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(DesktopPilotRequest),
          )(Buffer.from(body).toString("utf8")).pipe(Effect.option);
          if (Option.isNone(input))
            return HttpServerResponse.text("Invalid pilot request", { status: 400 });
          // A coding workspace may initially have only its primary harness's login. Put the
          // chosen owner's connected login through Core's public credentials API, never argv.
          const connected = yield* Effect.gen(function* () {
            const workspace = yield* sealant.getWorkspace(workspaceId);
            const layout = yield* layouts.worktreeLayout(session.value.worktreeId);
            const person =
              layout.layout === "person"
                ? (yield* layouts.identitiesOf([userId])).find(
                    (entry) => entry.accountId === userId,
                  )
                : undefined;
            if (layout.layout === "person" && !person) return false;
            yield* platform.postCredentials(workspace, {
              onBehalfOf: userId,
              home: `/home/mend-desktop-${session.value.id}`,
              owner: person ? { uid: person.uid, gid: MEND_GROUP.gid } : { uid: 1000, gid: 1000 },
              logins: input.value.harness === "claude" ? { claude: true } : { codex: true },
            });
            return true;
          }).pipe(
            asSealantUser(userId),
            Effect.orElseSucceed(() => false),
          );
          if (!connected)
            return HttpServerResponse.text(
              `Could not load your connected ${input.value.harness} account into this desktop. Check accounts and try again.`,
              { status: 409 },
            );
        }
        const dialed = yield* Effect.gen(function* () {
          const workspace = yield* sealant.getWorkspace(workspaceId);
          return yield* sealant.forward(workspace, vnc ? 5901 : 6090, "127.0.0.1");
        }).pipe(asSealantUser(session.value.ownerUserId), Effect.result);
        if (dialed._tag === "Failure") {
          if (request.method === "GET" && !vnc) {
            const captured = yield* capturedDesktop(
              session.value,
              path,
              request.headers.range,
            ).pipe(Effect.option);
            if (Option.isSome(captured) && captured.value !== null) return captured.value;
          }
          return HttpServerResponse.text("The session desktop is not reachable", { status: 502 });
        }
        const pipe = dialed.success;
        if (vnc) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => pipe.close()));
              const socket = yield* request.upgrade;
              const write = yield* socket.writer;
              const guard = yield* guardSocket(
                connections,
                userId,
                write,
                auth.getSession(headers).pipe(Effect.map(Option.isSome)),
                session.value.id,
                "tunnel",
              );
              const frames = makeFrameGuard(budgets.limits.frameBytes, write);
              yield* Effect.forkScoped(
                Stream.fromAsyncIterable(pipe.output, () => new Error("Desktop disconnected")).pipe(
                  Stream.runForEach((bytes) => write(bytes)),
                  Effect.andThen(write(new Socket.CloseEvent(1000, "desktop disconnected"))),
                  Effect.ignore,
                ),
              );
              yield* socket
                .runRaw((data) => {
                  if (guard.revoked()) return Effect.void;
                  const over = frames.refuse(data);
                  if (over !== null) return over;
                  if (typeof data !== "string") pipe.send(data);
                  return Effect.void;
                })
                .pipe(Effect.ignore);
            }),
          );
          return HttpServerResponse.empty();
        }
        const exchange = yield* Effect.tryPromise({
          try: () =>
            desktopHttp(pipe, {
              method: request.method,
              path,
              body,
              ...(request.headers.range ? { range: request.headers.range } : {}),
            }),
          catch: () => new Error("Desktop request failed"),
        }).pipe(Effect.result);
        if (exchange._tag === "Failure") {
          if (request.method === "GET") {
            const captured = yield* capturedDesktop(
              session.value,
              path,
              request.headers.range,
            ).pipe(Effect.option);
            if (Option.isSome(captured) && captured.value !== null) return captured.value;
          }
          return HttpServerResponse.text("The session desktop did not answer", { status: 502 });
        }
        const { response, close } = exchange.success;
        const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
        for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const value = response.headers[key];
          if (typeof value === "string") responseHeaders[key] = value;
        }
        return HttpServerResponse.stream(
          Stream.fromAsyncIterable(response, () => new Error("Desktop response ended")).pipe(
            Stream.ensuring(Effect.sync(close)),
          ),
          { status: response.statusCode ?? 502, headers: responseHeaders },
        );
      }),
    );
  }),
);
