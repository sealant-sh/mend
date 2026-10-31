import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import type { PreviewId, SealantWorkspaceId } from "@mend/domain";
import { asSealantUser } from "@mend/sealant";
import { type ForwardAdapter, WorkspaceCaller } from "@mend/sessions";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";

import { budgetMessage, Budgets, ceilingMessage, overCeiling } from "./budgets.ts";
import { ConnectionRegistry } from "./connections.ts";
import { EventBus } from "./events-bus.ts";
import type { PreviewGatewayLimits, PreviewGatewaySettings } from "./preview-gateway-settings.ts";
import {
  budgetPage,
  CEILING_RETRY_SECONDS,
  type ForwardRequest,
  notDelivered,
} from "./preview-headers.ts";
import { servePreviewRequest } from "./preview-host.ts";
import {
  type PreviewAccessEnded,
  PreviewConfig,
  PreviewIdentity,
  PreviewNoIdentity,
  PreviewNotFound,
  PreviewUnavailable,
  type PreviewViewer,
} from "./preview-identity.ts";
import { generationOf, makePreviewPools, type PreviewEntry } from "./preview-pools.ts";
import {
  declaredLength,
  destroyDownstream,
  type Downstream,
  type Exchange,
  exchangeOf,
  relay,
  respond,
} from "./preview-relay.ts";
import { answer, gatewayPage, type PreviewAnswer, refusalAnswer } from "./preview-requests.ts";
import { cookiePolicyOf, type PreviewRouting } from "./preview-routing.ts";
import { makeStartWaves, routeOf, type WaveOutcome } from "./preview-start-wave.ts";
import { PreviewTargets } from "./preview-targets.ts";
import { addressWindowWait } from "./request-budgets.ts";

export class PreviewListenFailed extends Schema.TaggedError<PreviewListenFailed>()(
  "PreviewListenFailed",
  { address: Schema.String, message: Schema.String },
) {}

const REFRESH_EVERY = "1 second";
const LENDING_SWEEP_EVERY = "50 seconds";

const LIMIT_WORDS = {
  perPreview: "open requests for one preview",
  gateway: "open requests across previews",
  forwards: "open forwards across previews",
  admitting: "requests being admitted across previews",
  waiting: "requests waiting for a forward across previews",
} as const satisfies Record<keyof PreviewGatewayLimits, string>;

const NOT_FOUND = refusalAnswer(new PreviewNotFound());
const UNAVAILABLE = refusalAnswer(new PreviewUnavailable({ operation: "admit" }));
const ACCESS_ENDED = refusalAnswer(
  new PreviewNoIdentity({ reason: "membership-ended", previewId: null }),
);
const FAILED = answer(500, "The preview gateway could not answer this request.");
const PIPELINED = answer(400, "Bad request.", { connection: "close" });

const ceilingPage = (limits: PreviewGatewayLimits, name: keyof PreviewGatewayLimits) =>
  budgetPage(ceilingMessage(limits[name], LIMIT_WORDS[name]), CEILING_RETRY_SECONDS);

const logged = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }));

const ignoreNotRunning = () => undefined;

const once = (release: () => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
};

export interface ListeningServer {
  readonly listen: (port: number, host: string, listening: () => void) => unknown;
  readonly close: (closed?: (error?: Error) => void) => unknown;
  readonly once: (event: "error", failed: (error: Error) => void) => unknown;
  readonly removeListener: (event: "error", failed: (error: Error) => void) => unknown;
}

export const listening = (
  server: ListeningServer,
  address: { readonly bind: string; readonly port: number },
): Effect.Effect<void, PreviewListenFailed, Scope.Scope> =>
  Effect.andThen(
    Effect.addFinalizer(() => Effect.sync(() => server.close(ignoreNotRunning))),
    Effect.callback<void, PreviewListenFailed>((resume) => {
      const failed = (error: Error) =>
        resume(
          Effect.fail(
            new PreviewListenFailed({
              address: `${address.bind}:${address.port}`,
              message: error.message,
            }),
          ),
        );
      server.once("error", failed);
      server.listen(address.port, address.bind, () => {
        server.removeListener("error", failed);
        resume(Effect.void);
      });
      return Effect.sync(() => {
        server.removeListener("error", failed);
        server.close(ignoreNotRunning);
      });
    }),
  );

const bump = <K>(counts: Map<K, number>, key: K, by: number) => {
  const next = (counts.get(key) ?? 0) + by;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
};

const reply = (exchange: Exchange, page: PreviewAnswer): Effect.Effect<undefined> =>
  Effect.sync(() => {
    respond(exchange, page);
    return undefined;
  });

const makeOccupancy = () => {
  const byPreview = new Map<PreviewId, number>();
  const byViewer = new Map<string, number>();
  let total = 0;
  return {
    occupy: (previewId: PreviewId, viewerId: string) => {
      bump(byPreview, previewId, 1);
      bump(byViewer, viewerId, 1);
      total += 1;
      return once(() => {
        bump(byPreview, previewId, -1);
        bump(byViewer, viewerId, -1);
        total -= 1;
      });
    },
    total: () => total,
    ofPreview: (previewId: PreviewId) => byPreview.get(previewId) ?? 0,
    ofViewer: (viewerId: string) => byViewer.get(viewerId) ?? 0,
  };
};

export const makePreviewGatewayLayer = (
  settings: PreviewGatewaySettings,
): Layer.Layer<
  never,
  PreviewListenFailed,
  | PreviewIdentity
  | PreviewConfig
  | PreviewTargets
  | WorkspaceCaller
  | ForwardAdapter
  | EventBus
  | Budgets
  | ConnectionRegistry
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const targets = yield* PreviewTargets;
      const caller = yield* WorkspaceCaller;
      const budgets = yield* Budgets;
      const connections = yield* ConnectionRegistry;
      const bus = yield* EventBus;
      const clock = yield* Clock.Clock;
      const run = Effect.runCallbackWith(yield* Effect.context<PreviewIdentity | PreviewConfig>());
      const { appUrl } = yield* PreviewConfig;
      const backOf = (preview: PreviewViewer["preview"]) =>
        `${appUrl}/projects/${encodeURIComponent(preview.projectId)}`;
      const pools = yield* makePreviewPools(settings.limits.forwards);
      const waves = yield* makeStartWaves(settings.startHoldMs);
      const { limits } = settings;
      const occupancy = makeOccupancy();

      /** Sockets Node stops tracking once it hands them over: upgrades and CONNECTs. */
      const rawSockets = new Set<Duplex>();
      const busy = new WeakSet<object>();
      let admitting = 0;
      let admitted = 0;
      let closing = false;

      const ceilingFor = (previewId: PreviewId, viewerId: string): PreviewAnswer | null => {
        const account = budgets.limits.accountPreviewConnections;
        if (overCeiling(occupancy.ofViewer(viewerId), account)) {
          return budgetPage(
            budgetMessage("accountPreviewConnections", account),
            CEILING_RETRY_SECONDS,
          );
        }
        if (overCeiling(occupancy.ofPreview(previewId), limits.perPreview)) {
          return ceilingPage(limits, "perPreview");
        }
        if (overCeiling(occupancy.total(), limits.gateway)) return ceilingPage(limits, "gateway");
        if (overCeiling(admitted - occupancy.total(), limits.waiting)) {
          return ceilingPage(limits, "waiting");
        }
        return null;
      };

      const lent = (viewerId: string, workspaceId: SealantWorkspaceId) =>
        Effect.exit(asSealantUser(viewerId)(caller.mayAct(workspaceId)));

      const readResolution = (id: PreviewId) =>
        targets.snapshot(id).pipe(
          Effect.map(Option.some),
          Effect.catchDefect((defect) =>
            logged("preview gateway: a binding could not be read", Cause.die(defect)).pipe(
              Effect.as(Option.none()),
            ),
          ),
        );

      const boundOrStarted = (
        entry: PreviewEntry,
        preview: PreviewViewer["preview"],
        viewerId: string,
      ): Effect.Effect<WaveOutcome> =>
        Effect.gen(function* () {
          const cached = entry.resolution();
          if (cached?._tag === "Bound") return { _tag: "Bound", resolution: cached };
          const read = yield* readResolution(preview.id);
          if (Option.isNone(read)) return { _tag: "Refused", answer: UNAVAILABLE };
          entry.remember(read.value);
          const route = routeOf(preview.serviceName, read.value, backOf(preview));
          if (route._tag !== "Start") return route;
          if (
            route.workspaceId !== null &&
            Exit.isFailure(yield* lent(viewerId, route.workspaceId))
          ) {
            return { _tag: "Refused", answer: NOT_FOUND };
          }
          const release = occupancy.occupy(preview.id, viewerId);
          const outcome = yield* waves
            .join(
              { id: preview.id, serviceName: preview.serviceName, back: backOf(preview) },
              route.from,
              viewerId,
            )
            .pipe(Effect.ensuring(Effect.sync(release)));
          if (outcome._tag === "Bound") entry.remember(outcome.resolution);
          return outcome;
        });

      const serveAdmitted = (
        exchange: Exchange,
        admittedViewer: PreviewViewer,
        routing: PreviewRouting,
        endAdmission: () => void,
      ): Effect.Effect<undefined, never, Scope.Scope> =>
        Effect.gen(function* () {
          endAdmission();
          const { viewer, preview, origin } = admittedViewer;
          const viewerId = viewer.userId;
          const cap = settings.bodyCap;
          const declared = declaredLength(exchange.head);
          if (cap._tag === "Capped" && declared !== null && declared > cap.bytes) {
            const fact = `the request body is over ${cap.bytes} bytes`;
            return yield* reply(
              exchange,
              gatewayPage(413, notDelivered(preview.serviceName, fact)),
            );
          }
          const ceiling = ceilingFor(preview.id, viewerId);
          if (ceiling !== null) return yield* reply(exchange, ceiling);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              admitted += 1;
            }),
            () =>
              Effect.sync(() => {
                admitted -= 1;
              }),
          );
          yield* connections.register(
            viewerId,
            Effect.sync(() => destroyDownstream(exchange.downstream)),
            undefined,
            "preview",
          );
          const entry = yield* pools.enter(preview);
          const outcome = yield* boundOrStarted(entry, preview, viewerId);
          if (outcome._tag === "Refused") return yield* reply(exchange, outcome.answer);
          const generation = generationOf(outcome.resolution);
          if (Exit.isFailure(yield* lent(viewerId, generation.attempt.workspaceId))) {
            entry.closeViewerPool(generation, viewerId);
            return yield* reply(exchange, NOT_FOUND);
          }
          const lease = yield* entry.lease(generation, viewerId);
          const forward: ForwardRequest = {
            origin,
            port: generation.attempt.port,
            host: generation.attempt.host,
            cookies: cookiePolicyOf(routing, preview),
            upgrade: exchange.downstream.kind === "raw",
          };
          return yield* relay(
            exchange,
            {
              serviceName: preview.serviceName,
              forward,
              lease,
              holdsForward: () => occupancy.occupy(preview.id, viewerId),
            },
            settings,
          );
        });

      const settle = (
        exchange: Exchange,
        exit: Exit.Exit<PreviewAnswer | null, PreviewAccessEnded>,
      ): void => {
        if (Exit.isSuccess(exit)) {
          if (exit.value !== null) respond(exchange, exit.value);
          else if (!exchange.committed) destroyDownstream(exchange.downstream);
          return;
        }
        if (exchange.committed || Cause.hasInterruptsOnly(exit.cause)) {
          return destroyDownstream(exchange.downstream);
        }
        const ended = Exit.findErrorOption(exit);
        if (Option.isNone(ended)) return respond(exchange, FAILED);
        respond(exchange, ended.value.reason === "access-ended" ? ACCESS_ENDED : UNAVAILABLE);
      };

      const refusedAtTheDoor = (downstream: Downstream): PreviewAnswer | null => {
        const forwarded = downstream.request.headers["x-forwarded-for"];
        const wait = addressWindowWait(
          budgets.previewAddresses,
          budgets.limits.addressPreviewRequestsPerMinute,
          {
            socket: downstream.request.socket.remoteAddress,
            forwardedFor: Array.isArray(forwarded) ? forwarded.join(", ") : forwarded,
            trustedProxies: settings.trustedProxies,
          },
          clock.currentTimeMillisUnsafe(),
        );
        if (wait !== null) {
          const limit = budgets.limits.addressPreviewRequestsPerMinute;
          return budgetPage(budgetMessage("addressPreviewRequestsPerMinute", limit), wait);
        }
        return overCeiling(admitting, limits.admitting) ? ceilingPage(limits, "admitting") : null;
      };

      const accept = (downstream: Downstream): void => {
        if (closing) return destroyDownstream(downstream);
        if (downstream.kind === "http") {
          const socket = downstream.request.socket;
          if (busy.has(socket)) {
            downstream.response.writeHead(PIPELINED.status, PIPELINED.headers);
            downstream.response.end(PIPELINED.body);
            return;
          }
          busy.add(socket);
          downstream.response.once("close", () => busy.delete(socket));
        } else {
          rawSockets.add(downstream.socket);
          downstream.socket.on("error", () => downstream.socket.destroy());
          downstream.socket.once("close", () => rawSockets.delete(downstream.socket));
        }
        const exchange = exchangeOf(downstream);
        const refused = refusedAtTheDoor(downstream);
        if (refused !== null) return respond(exchange, refused);
        admitting += 1;
        const endAdmission = once(() => {
          admitting -= 1;
        });
        let settled = false;
        const interrupt = run(
          servePreviewRequest(exchange.head, (viewer, routing) =>
            serveAdmitted(exchange, viewer, routing, endAdmission),
          ).pipe(
            Effect.tapCause((cause) =>
              Cause.hasDies(cause)
                ? logged("preview gateway: a request failed", cause)
                : Effect.void,
            ),
          ),
          {
            onExit: (exit) => {
              settled = true;
              endAdmission();
              settle(exchange, exit);
            },
          },
        );
        const closed = downstream.kind === "http" ? downstream.response : downstream.socket;
        closed.once("close", () => {
          if (!settled) interrupt();
        });
      };

      const supervised = (what: string, effect: Effect.Effect<void>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : logged(what, cause),
          ),
        );

      const server = createServer({
        // A held upload, then its delivery, outlives Node's default of 300 s.
        requestTimeout: 0,
        headersTimeout: 10_000,
        keepAliveTimeout: 5_000,
        maxHeaderSize: 16 * 1024,
        highWaterMark: 64 * 1024,
      });
      server.timeout = 0;
      server.maxHeadersCount = 64;
      server.on("request", (request, response) =>
        accept({ kind: "http", request, response, expectsContinue: false }),
      );
      server.on("checkContinue", (request, response) =>
        accept({ kind: "http", request, response, expectsContinue: true }),
      );
      server.on("upgrade", (request, socket, head) =>
        accept({ kind: "raw", request, socket, head }),
      );
      // Node emits CONNECT apart from `request`.
      server.on("connect", (request, socket, head) =>
        accept({ kind: "raw", request, socket, head }),
      );
      server.on("clientError", (_error, socket) => {
        if (socket.writable && !busy.has(socket)) {
          socket.write(
            "HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
          );
        }
        socket.destroy();
      });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closing = true;
          server.closeAllConnections();
          pools.closeAll();
          for (const socket of rawSockets) socket.destroy();
        }),
      );
      yield* listening(server, settings);
      server.on("error", (error) =>
        run(
          Effect.logError("preview gateway: the listener failed").pipe(
            Effect.annotateLogs({ error: error.message }),
          ),
        ),
      );

      const subscription = yield* bus.subscribe;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((signal) =>
          supervised("preview gateway: a refresh failed", pools.onSignal(signal)),
        ),
        Effect.forkScoped,
      );
      yield* supervised("preview gateway: a refresh failed", pools.refreshAll).pipe(
        Effect.repeat(Schedule.spaced(REFRESH_EVERY)),
        Effect.forkScoped,
      );
      yield* supervised("preview gateway: a lending sweep failed", pools.recheckAllLending).pipe(
        Effect.repeat(Schedule.spaced(LENDING_SWEEP_EVERY)),
        Effect.forkScoped,
      );
      yield* Effect.logInfo("preview gateway listening").pipe(
        Effect.annotateLogs({ bind: settings.bind, port: settings.port }),
      );
    }),
  );
