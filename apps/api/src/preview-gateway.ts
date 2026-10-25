import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { type Duplex, pipeline } from "node:stream";

import type { PreviewId } from "@mend/domain";
import {
  type PreviewBoundAttempt,
  type PreviewGatewayRefusal,
  type PreviewGatewayResolution,
  type PreviewStartReason,
  previewStartReasonOf,
} from "@mend/domain/workbench";
import { asSealantUser, type ForwardIssueReason, ForwardSessionOwner } from "@mend/sealant";
import {
  ForwardAdapter,
  ForwardAgent,
  ForwardRefusedError,
  ForwardSocket,
  type ForwardSocketConnect,
  type ForwardTarget,
  forwardSockets,
  WorkspaceCaller,
} from "@mend/sessions";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
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
import { type BusSignal, EventBus } from "./events-bus.ts";
import {
  type ForwardRequest,
  forwardRequestHead,
  forwardResponseHead,
  gatewayPage,
  undeliveredAnswer,
} from "./preview-headers.ts";
import { servePreviewRequest } from "./preview-host.ts";
import {
  type PreviewAccessEnded,
  PreviewConfig,
  PreviewIdentity,
  type PreviewViewer,
} from "./preview-identity.ts";
import {
  answer,
  type HeaderPair,
  membersOf,
  type PreviewAnswer,
  type PreviewRequestHead,
} from "./preview-requests.ts";
import { cookiePolicyOf } from "./preview-routing.ts";
import { PreviewTargets } from "./preview-targets.ts";

/**
 * The preview gateway (ADR 0017, delivery 7): a raw `node:http` listener that admits each request
 * through step 6's `servePreviewRequest` and relays it, as a stream, to the preview's dev server
 * over a forward lent for that viewer. A stopped preview is started once for every request that
 * reaches it, and each request is held, its body unread, until the start ends.
 */

/** The gateway's own ceilings. They are not ADR 0004 budgets, whose `0` opens the exposure gate. */
export interface PreviewGatewayLimits {
  /** Requests and upgrades one preview holds open, a held one included. */
  readonly perPreview: number;
  /** The same across every preview. */
  readonly gateway: number;
  /** Forwards open across every preview: dials, pooled sockets and upgraded sockets. */
  readonly forwards: number;
}

export type PreviewBodyCap =
  | { readonly _tag: "Unlimited" }
  | { readonly _tag: "Capped"; readonly bytes: number };

export interface PreviewGatewaySettings {
  readonly bind: string;
  readonly port: number;
  /** How long a held request waits for a stopped preview to start. */
  readonly startHoldMs: number;
  /** A streaming cap on one request body. */
  readonly bodyCap: PreviewBodyCap;
  readonly limits: PreviewGatewayLimits;
}

export const PREVIEW_GATEWAY_DEFAULTS = {
  startHoldMs: 180_000,
  bodyCap: { _tag: "Unlimited" },
  limits: { perPreview: 64, gateway: 256, forwards: 128 },
} as const satisfies Omit<PreviewGatewaySettings, "bind" | "port">;

const LIMIT_WORDS = {
  perPreview: "open requests for one preview",
  gateway: "open requests across previews",
  forwards: "open forwards across previews",
} as const satisfies Record<keyof PreviewGatewayLimits, string>;

export class PreviewListenFailed extends Schema.TaggedError<PreviewListenFailed>()(
  "PreviewListenFailed",
  { address: Schema.String, message: Schema.String },
) {}

/** One viewer's pool: dev servers close idle keep-alive connections after about 5 s. */
const POOL = { maxSockets: 6, maxFreeSockets: 2, freeSocketMs: 4_000, idleMs: 10_000 } as const;
/** How long an answered socket that may still be uploading stays open before it is destroyed. */
const UNREAD_LINGER_MS = 2_000;
const REFRESH_EVERY = "1 second";
const LENDING_SWEEP_EVERY = "50 seconds";

type Downstream =
  | {
      readonly kind: "http";
      readonly request: IncomingMessage;
      readonly response: ServerResponse;
      readonly expectsContinue: boolean;
    }
  | {
      readonly kind: "raw";
      readonly request: IncomingMessage;
      readonly socket: Duplex;
      readonly head: Buffer;
    };

interface Exchange {
  readonly head: PreviewRequestHead;
  readonly downstream: Downstream;
  /** Something of an answer reached the browser: a response head, a 101, or a whole answer. */
  committed: boolean;
}

/** An immutable attempt under one control revision: what a pool and its sockets belong to. */
interface Generation {
  readonly key: string;
  readonly attempt: PreviewBoundAttempt;
}

interface Pool {
  readonly key: string;
  readonly viewerId: string;
  readonly generation: Generation;
  readonly agent: ForwardAgent;
  readonly requests: Set<ClientRequest>;
  /** Both sockets of each upgraded pair. An Agent forgets a socket once it is upgraded. */
  readonly upgraded: Set<Duplex>;
  closed: boolean;
  idle: NodeJS.Timeout | null;
}

type Outcome =
  | { readonly _tag: "Ready"; readonly generation: Generation }
  | { readonly _tag: "Refused"; readonly answer: PreviewAnswer };

interface StartFrom {
  readonly revision: number;
  readonly sourceAttemptId: PreviewBoundAttempt["attemptId"];
}

/** One start for every request that reaches a stopped preview, published before it runs. */
interface Wave {
  readonly deadline: number;
  readonly done: Deferred.Deferred<Outcome>;
}

interface Cell {
  readonly previewId: PreviewId;
  readonly projectId: string;
  readonly serviceName: string;
  readonly pools: Map<string, Pool>;
  wave: Wave | null;
  exchanges: number;
}

const DONE: Effect.Effect<undefined> = Effect.succeed(undefined);

/** Ends one exchange once, with a page when nothing of the app's answer went out yet. */
type End = (page?: PreviewAnswer) => void;

const pairsOf = (raw: ReadonlyArray<string>): Array<HeaderPair> => {
  const pairs: Array<HeaderPair> = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index] ?? "", raw[index + 1] ?? ""]);
  }
  return pairs;
};

const flatten = (pairs: ReadonlyArray<HeaderPair>): Array<string> =>
  pairs.flatMap(([name, value]) => [name, value]);

const headOf = (request: IncomingMessage): PreviewRequestHead => ({
  method: request.method ?? "GET",
  target: request.url ?? "/",
  headers: pairsOf(request.rawHeaders),
});

const declaredLength = (head: PreviewRequestHead): number | null => {
  const [length] = membersOf(head.headers, "content-length");
  return length === undefined ? null : Number(length);
};

const mayCarryBody = (head: PreviewRequestHead): boolean =>
  membersOf(head.headers, "transfer-encoding").length > 0 || (declaredLength(head) ?? 0) > 0;

const headText = (status: number, fields: ReadonlyArray<HeaderPair>): string =>
  `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n${fields
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("")}\r\n`;

const answerBytes = (reply: PreviewAnswer): Buffer => {
  const body = Buffer.from(reply.body, "utf8");
  const fields: Array<HeaderPair> = [
    ...Object.entries(reply.headers),
    ["content-length", String(body.length)],
    ["connection", "close"],
  ];
  return Buffer.concat([Buffer.from(headText(reply.status, fields), "latin1"), body]);
};

/** Ends `socket` once written, then destroys it: the peer may still be sending, unread. */
const lingerThenDestroy = (socket: Duplex, last: Buffer | null) => {
  let timer = setTimeout(() => socket.destroy(), UNREAD_LINGER_MS * 5);
  socket.once("close", () => clearTimeout(timer));
  const linger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => socket.destroy(), UNREAD_LINGER_MS);
  };
  if (last === null) socket.end(linger);
  else socket.end(last, linger);
};

const logged = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }));

const destroyDownstream = (downstream: Downstream) => {
  if (downstream.kind === "http") downstream.response.destroy();
  else downstream.socket.destroy();
};

const refusedSocket = (error: Error): ForwardSocket => {
  const socket = new ForwardSocket();
  setImmediate(() => socket.destroy(error));
  return socket;
};

const poolKey = (generation: Generation, viewerId: string) => `${generation.key}\u0000${viewerId}`;

const useRequest = (pool: Pool, request: ClientRequest) => {
  pool.requests.add(request);
  if (pool.idle !== null) clearTimeout(pool.idle);
  pool.idle = null;
};

const NOT_FOUND = answer(404, "No such preview.");
const UNAVAILABLE = answer(503, "Previews are unavailable right now.");
const ACCESS_ENDED = answer(401, "Not signed in to this preview.");
const FAILED = answer(500, "The preview gateway could not answer this request.");
const PIPELINED = answer(400, "Bad request.", { connection: "close" });

const stated = (service: string, fact: string) => `preview · ${service} · ${fact}`;
const notDelivered = (service: string, fact: string) =>
  `${stated(service, fact)} · your request was not delivered`;

const REFUSED = {
  "service-missing": { status: 503, fact: "no Service of this name in its worktree" },
  "not-browser-service": { status: 503, fact: "the Service serves no browser page" },
  "no-recorded-command": { status: 503, fact: "no recorded command starts it" },
  // 501: the gateway does not implement TLS to the dev server yet; nothing upstream failed.
  "https-unsupported": { status: 501, fact: "it speaks https, which previews do not relay yet" },
  "process-binding-unavailable": { status: 503, fact: "process binding is unavailable" },
} as const satisfies Record<PreviewGatewayRefusal, { status: number; fact: string }>;

type DialDisposition =
  | { readonly _tag: "NotLent" }
  | { readonly _tag: "Undelivered"; readonly status: 502 | 503 | 504; readonly fact: string };

const undelivered = (status: 502 | 503 | 504, fact: string): DialDisposition => ({
  _tag: "Undelivered",
  status,
  fact,
});
const NOT_LENT: DialDisposition = { _tag: "NotLent" };

/** What a refused dial answers. A dial refusal always comes before any byte reached the app. */
const DIAL_DISPOSITION = {
  "connection-refused": undelivered(502, "nothing listens"),
  "name-unresolved": undelivered(502, "nothing listens"),
  "network-unreachable": undelivered(502, "the forward failed"),
  "dial-failed": undelivered(502, "the forward failed"),
  "transport-unavailable": undelivered(503, "the forward failed"),
  internal: undelivered(502, "the forward failed"),
  "platform-failed": undelivered(502, "the forward failed"),
  "unrecognized-refusal": undelivered(502, "the forward failed"),
  "protocol-unsupported": undelivered(502, "the forward failed"),
  "invalid-target": undelivered(502, "the forward failed"),
  "workspace-not-ready": undelivered(503, "workspace is not live"),
  "runtime-unreachable": undelivered(503, "workspace is not live"),
  "runtime-untargetable": undelivered(503, "workspace is not live"),
  "not-found": undelivered(503, "workspace is not live"),
  "dial-timeout": undelivered(504, "the forward timed out"),
  "deadline-exceeded": undelivered(504, "the forward timed out"),
  "budget-exceeded": undelivered(503, "the platform's forward budget is reached"),
  unauthorized: undelivered(503, "the platform refused the forward"),
  NO_PRINCIPAL: undelivered(503, "the platform refused the forward"),
  UNKNOWN_USER: undelivered(503, "the platform refused the forward"),
  forbidden: NOT_LENT,
  no_standing: NOT_LENT,
  creator_no_access: NOT_LENT,
  "owner-exited": undelivered(502, "process exited"),
  "owner-required": undelivered(502, "process binding is unavailable"),
  "peer-mismatch": undelivered(502, "process binding is unavailable"),
  "binding-unverifiable": undelivered(502, "process binding is unavailable"),
  "binding-unsupported": undelivered(502, "process binding is unavailable"),
  cancelled: undelivered(503, "the forward was given up"),
} as const satisfies Record<ForwardIssueReason, DialDisposition>;

/** A dial the gateway refused itself, at its forward ceiling. */
class ForwardCeilingReached extends Error {}

const generationOf = (bound: Extract<PreviewGatewayResolution, { _tag: "Bound" }>): Generation => ({
  key: `${bound.revision}:${bound.attempt.attemptId}`,
  attempt: bound.attempt,
});

const refusedWith = (reply: PreviewAnswer): Outcome => ({ _tag: "Refused", answer: reply });

type Route = Outcome | { readonly _tag: "Start"; readonly from: StartFrom };

/** What one resolution means for a request: deliver, refuse, or start the preview first. */
const routeOf = (serviceName: string, resolution: PreviewGatewayResolution | null): Route => {
  if (resolution === null) return refusedWith(NOT_FOUND);
  switch (resolution._tag) {
    case "OwnerStopped":
      return refusedWith(undeliveredAnswer({ _tag: "StoppedByOwner", serviceName }));
    case "Refused": {
      const refused = REFUSED[resolution.reason];
      return refusedWith(gatewayPage(refused.status, notDelivered(serviceName, refused.fact)));
    }
    case "Bound":
      return { _tag: "Ready", generation: generationOf(resolution) };
    case "Starting":
      return {
        _tag: "Start",
        from: { revision: resolution.revision, sourceAttemptId: resolution.attemptId },
      };
    case "Dormant":
      return {
        _tag: "Start",
        from: { revision: resolution.revision, sourceAttemptId: resolution.source.sourceAttemptId },
      };
  }
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
      const config = yield* PreviewConfig;
      const targets = yield* PreviewTargets;
      const caller = yield* WorkspaceCaller;
      const budgets = yield* Budgets;
      const connections = yield* ConnectionRegistry;
      const bus = yield* EventBus;
      const clock = yield* Clock.Clock;
      const scope = yield* Effect.scope;
      const run = Effect.runCallbackWith(yield* Effect.context<PreviewIdentity | PreviewConfig>());
      const forwarding = yield* Effect.context<ForwardAdapter>();

      /** Only occupied previews: a cell goes once nothing of it is open. */
      const cells = new Map<PreviewId, Cell>();
      /** The latest admitted delivery per preview, in ms on the gateway's Clock, for step 12. */
      const latestActivity = new Map<PreviewId, number>();
      /** Sockets Node stops tracking once it hands them over: upgrades and CONNECTs. */
      const rawSockets = new Set<Duplex>();
      /** Sockets with an exchange outstanding: a pipelined request beyond it is refused. */
      const busy = new WeakSet<object>();
      let openExchanges = 0;
      let openForwards = 0;
      let closing = false;

      const retain = (cell: Cell) => {
        const occupied = cell.exchanges > 0 || cell.pools.size > 0 || cell.wave !== null;
        if (!occupied && cells.get(cell.previewId) === cell) cells.delete(cell.previewId);
      };

      const cellOf = (preview: PreviewViewer["preview"]): Cell => {
        const known = cells.get(preview.id);
        if (known !== undefined) return known;
        const cell: Cell = {
          previewId: preview.id,
          projectId: preview.projectId,
          serviceName: preview.serviceName,
          pools: new Map(),
          wave: null,
          exchanges: 0,
        };
        cells.set(preview.id, cell);
        return cell;
      };

      /** Pre-delivery answers never call `ServerResponse.end` on a body that may still arrive. */
      const respond = (exchange: Exchange, reply: PreviewAnswer): void => {
        const { downstream } = exchange;
        if (exchange.committed) return destroyDownstream(downstream);
        exchange.committed = true;
        if (
          downstream.kind === "http" &&
          !(mayCarryBody(exchange.head) && !downstream.request.complete)
        ) {
          downstream.response.writeHead(reply.status, reply.headers);
          downstream.response.end(reply.body);
          return;
        }
        // Node's `res.end` would read and discard the rest of the body: with keep-alive, all of it.
        const socket = downstream.kind === "http" ? downstream.request.socket : downstream.socket;
        if (!socket.destroyed) lingerThenDestroy(socket, answerBytes(reply));
      };

      const reply = (exchange: Exchange, page: PreviewAnswer): Effect.Effect<undefined> =>
        Effect.sync(() => {
          respond(exchange, page);
          return undefined;
        });

      const settlePool = (cell: Cell, pool: Pool) => {
        if (pool.closed || pool.idle !== null) return;
        if (pool.requests.size > 0 || pool.upgraded.size > 0) return;
        pool.idle = setTimeout(() => closePool(cell, pool), POOL.idleMs);
        pool.idle.unref();
      };

      const closePool = (cell: Cell, pool: Pool) => {
        if (pool.closed) return;
        pool.closed = true;
        if (pool.idle !== null) clearTimeout(pool.idle);
        if (cell.pools.get(pool.key) === pool) cell.pools.delete(pool.key);
        for (const request of pool.requests) request.destroy();
        for (const socket of pool.upgraded) socket.destroy();
        pool.agent.destroy();
        retain(cell);
      };

      const dial = (pool: Pool, connect: ForwardSocketConnect, target: ForwardTarget) => {
        if (pool.closed) return refusedSocket(new Error("the preview's attempt changed"));
        if (overCeiling(openForwards, settings.limits.forwards)) {
          return refusedSocket(new ForwardCeilingReached());
        }
        openForwards += 1;
        const socket = connect(target, { purpose: "preview" });
        socket.once("close", () => {
          openForwards -= 1;
        });
        // Registered before the Agent's own listener: a late dial from a closed generation never
        // carries a request.
        socket.once("connect", () => {
          if (pool.closed) socket.destroy();
        });
        return socket;
      };

      const poolFor = (cell: Cell, generation: Generation, viewerId: string): Pool => {
        const key = poolKey(generation, viewerId);
        const known = cell.pools.get(key);
        if (known !== undefined && !known.closed) return known;
        const { attempt } = generation;
        const target: ForwardTarget = {
          workspaceId: attempt.workspaceId,
          port: attempt.port,
          binding: {
            kind: "session",
            session: ForwardSessionOwner.make(attempt.platformSessionId),
          },
        };
        // The viewer is the asker: the adapter lends each dial as the workspace's creator only
        // while this person may act there.
        const connect = Effect.runSyncWith(forwarding)(asSealantUser(viewerId)(forwardSockets));
        const pool: Pool = {
          key,
          viewerId,
          generation,
          // The Agent's timeout destroys a socket only while it is free: an active SSE stream
          // in a long gap keeps its forward.
          agent: new ForwardAgent(() => dial(pool, connect, target), {
            maxSockets: POOL.maxSockets,
            maxFreeSockets: POOL.maxFreeSockets,
            timeout: POOL.freeSocketMs,
          }),
          requests: new Set(),
          upgraded: new Set(),
          closed: false,
          idle: null,
        };
        cell.pools.set(key, pool);
        return pool;
      };

      const releaseRequest = (cell: Cell, pool: Pool, request: ClientRequest) => {
        pool.requests.delete(request);
        settlePool(cell, pool);
      };

      const dialAnswer = (cell: Cell, pool: Pool, error: Error): PreviewAnswer => {
        if (error instanceof ForwardCeilingReached) {
          return gatewayPage(503, ceilingMessage(settings.limits.forwards, LIMIT_WORDS.forwards));
        }
        if (pool.closed) {
          return gatewayPage(503, notDelivered(cell.serviceName, "the preview restarted"));
        }
        if (!(error instanceof ForwardRefusedError)) {
          return gatewayPage(502, notDelivered(cell.serviceName, "the forward failed"));
        }
        const disposition = DIAL_DISPOSITION[error.record.issue.reason];
        if (disposition._tag === "NotLent") {
          closePool(cell, pool);
          return NOT_FOUND;
        }
        return gatewayPage(disposition.status, notDelivered(cell.serviceName, disposition.fact));
      };

      /**
       * One upstream request through the pool. Nothing reaches the app until its forward is open and
       * the generation is still current; only then does Continue go out and the body start to flow.
       */
      const sendUpstream = (
        exchange: Exchange,
        cell: Cell,
        pool: Pool,
        forward: ForwardRequest,
        handlers: {
          readonly deliver: (upstream: ClientRequest, end: End) => void;
          readonly answered: (upstream: ClientRequest, end: End) => void;
          readonly cleanup?: () => void;
        },
      ) =>
        Effect.callback<undefined>((resume) => {
          let delivered = false;
          let ended = false;
          const upstream = httpRequest({
            agent: pool.agent,
            method: exchange.head.method,
            path: exchange.head.target,
            headers: flatten(forwardRequestHead(exchange.head.headers, forward)),
            setHost: false,
          });
          useRequest(pool, upstream);
          const end: End = (page) => {
            if (ended) return;
            ended = true;
            releaseRequest(cell, pool, upstream);
            if (page !== undefined) respond(exchange, page);
            resume(DONE);
          };
          const deliver = () => {
            if (ended) return;
            if (pool.closed) {
              upstream.destroy();
              return end(gatewayPage(503, notDelivered(cell.serviceName, "the preview restarted")));
            }
            delivered = true;
            latestActivity.set(cell.previewId, clock.currentTimeMillisUnsafe());
            handlers.deliver(upstream, end);
          };
          upstream.once("socket", (socket) => {
            if (socket.connecting) socket.once("connect", deliver);
            else deliver();
          });
          handlers.answered(upstream, end);
          // After the app's head went out a page may not say "not delivered", and after the
          // browser's head went out `respond` destroys instead.
          upstream.on("error", (error) =>
            end(
              delivered
                ? gatewayPage(502, stated(cell.serviceName, "the app did not answer"))
                : dialAnswer(cell, pool, error),
            ),
          );
          // Interrupted: the listener answers, so the destroyed request's own error must not.
          return Effect.sync(() => {
            ended = true;
            upstream.destroy();
            handlers.cleanup?.();
            releaseRequest(cell, pool, upstream);
          });
        });

      const streamBody = (
        request: IncomingMessage,
        upstream: ClientRequest,
        cell: Cell,
        end: End,
      ) => {
        const cap = settings.bodyCap;
        if (cap._tag === "Capped") {
          let seen = 0;
          request.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen <= cap.bytes) return;
            request.unpipe(upstream);
            request.pause();
            end(
              gatewayPage(
                413,
                stated(cell.serviceName, `the request body passed ${cap.bytes} bytes`),
              ),
            );
            upstream.destroy();
          });
        }
        request.pipe(upstream);
      };

      const relayHttp = (
        exchange: Exchange,
        downstream: Extract<Downstream, { kind: "http" }>,
        cell: Cell,
        pool: Pool,
        forward: ForwardRequest,
      ) => {
        const { request, response } = downstream;
        return sendUpstream(exchange, cell, pool, forward, {
          deliver: (upstream, end) => {
            if (downstream.expectsContinue) response.writeContinue();
            if (mayCarryBody(exchange.head)) streamBody(request, upstream, cell, end);
            else upstream.end();
          },
          answered: (upstream, end) =>
            upstream.once("response", (answered) => {
              if (exchange.committed) {
                answered.destroy();
                return end();
              }
              exchange.committed = true;
              const status = answered.statusCode ?? 502;
              const head = forwardResponseHead(
                { status, headers: pairsOf(answered.rawHeaders) },
                forward.cookies,
              );
              response.writeHead(status, flatten(head));
              response.flushHeaders();
              pipeline(answered, response, () => end());
            }),
        });
      };

      const relayUpgrade = (
        exchange: Exchange,
        downstream: Extract<Downstream, { kind: "raw" }>,
        cell: Cell,
        pool: Pool,
        forward: ForwardRequest,
      ) => {
        const browser = downstream.socket;
        const pair: Array<Duplex> = [];
        return sendUpstream(exchange, cell, pool, forward, {
          deliver: (upstream) => upstream.end(),
          answered: (upstream, end) => {
            upstream.once("upgrade", (answered, app, appHead) => {
              // The browser's socket destroys itself on error (`accept`); its close ends the app's.
              app.on("error", () => browser.destroy());
              if (pool.closed || browser.destroyed) {
                app.destroy();
                browser.destroy();
                return end();
              }
              pair.push(browser, app);
              for (const socket of pair) pool.upgraded.add(socket);
              exchange.committed = true;
              const head = forwardResponseHead(
                { status: 101, headers: pairsOf(answered.rawHeaders) },
                forward.cookies,
              );
              browser.write(headText(101, head));
              if (appHead.length > 0) browser.write(appHead);
              if (downstream.head.length > 0) app.write(downstream.head);
              browser.pipe(app);
              app.pipe(browser);
              let open = 2;
              for (const [socket, other] of [
                [browser, app],
                [app, browser],
              ] as const) {
                socket.once("close", () => {
                  other.destroy();
                  pool.upgraded.delete(socket);
                  open -= 1;
                  if (open === 0) {
                    settlePool(cell, pool);
                    end();
                  }
                });
              }
            });
            upstream.once("response", (answered) => {
              exchange.committed = true;
              const status = answered.statusCode ?? 502;
              const head = forwardResponseHead(
                { status, headers: pairsOf(answered.rawHeaders) },
                forward.cookies,
              );
              browser.write(headText(status, [...head, ["connection", "close"]]));
              answered.pipe(browser, { end: false });
              answered.once("error", () => browser.destroy());
              answered.once("end", () => {
                lingerThenDestroy(browser, null);
                end();
              });
            });
          },
          cleanup: () => {
            for (const socket of pair) socket.destroy();
          },
        });
      };

      const startedOutcome = (cell: Cell, resolution: PreviewGatewayResolution | null): Outcome => {
        if (resolution?._tag === "Bound") {
          return { _tag: "Ready", generation: generationOf(resolution) };
        }
        const route = routeOf(cell.serviceName, resolution);
        return route._tag === "Start" ? didNotStart(cell, "process exited") : route;
      };

      const didNotStart = (cell: Cell, reason: PreviewStartReason): Outcome =>
        refusedWith(
          undeliveredAnswer({
            _tag: "DidNotStart",
            serviceName: cell.serviceName,
            holdMs: settings.startHoldMs,
            reason,
          }),
        );

      const runWave = (cell: Cell, wave: Wave, from: StartFrom, viewerId: string) => {
        const started = Effect.gen(function* () {
          yield* targets.ensureRunning({
            previewId: cell.previewId,
            revision: from.revision,
            sourceAttemptId: from.sourceAttemptId,
            deadline: wave.deadline,
          });
          return startedOutcome(cell, yield* targets.snapshot(cell.previewId));
        }).pipe(
          Effect.catchTag("PreviewStartFailed", (failed) =>
            Effect.succeed(
              failed.reason === "owner-stopped"
                ? refusedWith(
                    undeliveredAnswer({ _tag: "StoppedByOwner", serviceName: cell.serviceName }),
                  )
                : didNotStart(cell, previewStartReasonOf(failed.reason)),
            ),
          ),
        );
        const bounded = Effect.suspend(() =>
          started.pipe(
            Effect.timeoutOption(
              Duration.millis(Math.max(0, wave.deadline - clock.currentTimeMillisUnsafe())),
            ),
            Effect.map(Option.getOrElse(() => didNotStart(cell, "start timed out"))),
          ),
        );
        return budgets.withPreviewStartSlot(viewerId, bounded).pipe(
          Effect.map(
            (outcome) =>
              outcome ??
              refusedWith(
                gatewayPage(
                  429,
                  budgetMessage(
                    "accountPreviewStartsInFlight",
                    budgets.limits.accountPreviewStartsInFlight,
                  ),
                ),
              ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : logged("preview gateway: a start failed", cause).pipe(
                  Effect.as(didNotStart(cell, "preview is unavailable")),
                ),
          ),
          Effect.flatMap((outcome) => Deferred.succeed(wave.done, outcome)),
          Effect.ensuring(
            Effect.suspend(() => {
              if (cell.wave === wave) cell.wave = null;
              retain(cell);
              return Deferred.succeed(wave.done, didNotStart(cell, "preview is unavailable"));
            }),
          ),
        );
      };

      /** The first waiter publishes the wave and pays for it; a waiter leaving leaves it running. */
      const joinWave = (cell: Cell, from: StartFrom, viewerId: string): Effect.Effect<Outcome> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let wave = cell.wave;
            if (wave === null) {
              wave = {
                deadline: clock.currentTimeMillisUnsafe() + settings.startHoldMs,
                done: Deferred.makeUnsafe<Outcome>(),
              };
              cell.wave = wave;
              yield* Effect.forkIn(runWave(cell, wave, from, viewerId), scope);
            }
            return yield* restore(Deferred.await(wave.done));
          }),
        );

      const resolve = (cell: Cell, viewerId: string): Effect.Effect<Outcome> =>
        Effect.gen(function* () {
          const read = yield* targets.snapshot(cell.previewId).pipe(
            Effect.map(Option.some),
            Effect.catchDefect((defect) =>
              logged("preview gateway: a binding could not be read", Cause.die(defect)).pipe(
                Effect.as(Option.none()),
              ),
            ),
          );
          if (Option.isNone(read)) return refusedWith(UNAVAILABLE);
          const route = routeOf(cell.serviceName, read.value);
          return route._tag === "Start" ? yield* joinWave(cell, route.from, viewerId) : route;
        });

      const admit = (
        exchange: Exchange,
        cell: Cell,
        viewerId: string,
      ): Effect.Effect<PreviewAnswer | null, never, Scope.Scope> =>
        Effect.gen(function* () {
          const held = yield* connections.countFor(viewerId, "preview");
          const accountLimit = budgets.limits.accountPreviewConnections;
          if (overCeiling(held, accountLimit)) {
            return gatewayPage(429, budgetMessage("accountPreviewConnections", accountLimit));
          }
          const refused = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const open = { perPreview: cell.exchanges, gateway: openExchanges };
              const over = (["perPreview", "gateway"] as const).find((name) =>
                overCeiling(open[name], settings.limits[name]),
              );
              if (over !== undefined) {
                return gatewayPage(503, ceilingMessage(settings.limits[over], LIMIT_WORDS[over]));
              }
              cell.exchanges += 1;
              openExchanges += 1;
              return null;
            }),
            (refusal) =>
              Effect.sync(() => {
                if (refusal !== null) return;
                cell.exchanges -= 1;
                openExchanges -= 1;
                retain(cell);
              }),
          );
          if (refused !== null) return refused;
          yield* connections.register(
            viewerId,
            Effect.sync(() => destroyDownstream(exchange.downstream)),
            undefined,
            "preview",
          );
          return null;
        });

      const serveAdmitted = (
        exchange: Exchange,
        admitted: PreviewViewer,
      ): Effect.Effect<undefined, never, Scope.Scope> =>
        Effect.gen(function* () {
          const routing = config.routing;
          if (routing === null) return yield* reply(exchange, UNAVAILABLE);
          const { viewer, preview } = admitted;
          const cell = cellOf(preview);
          const cap = settings.bodyCap;
          const declared = declaredLength(exchange.head);
          if (cap._tag === "Capped" && declared !== null && declared > cap.bytes) {
            const fact = `the request body is over ${cap.bytes} bytes`;
            return yield* reply(exchange, gatewayPage(413, notDelivered(cell.serviceName, fact)));
          }
          const refused = yield* admit(exchange, cell, viewer.userId);
          if (refused !== null) return yield* reply(exchange, refused);
          const outcome = yield* resolve(cell, viewer.userId);
          if (outcome._tag === "Refused") return yield* reply(exchange, outcome.answer);
          const { generation } = outcome;
          const lent = yield* Effect.exit(
            asSealantUser(viewer.userId)(caller.mayAct(generation.attempt.workspaceId)),
          );
          if (Exit.isFailure(lent)) {
            const pooled = cell.pools.get(poolKey(generation, viewer.userId));
            if (pooled !== undefined) closePool(cell, pooled);
            return yield* reply(exchange, NOT_FOUND);
          }
          const pool = poolFor(cell, generation, viewer.userId);
          const { downstream } = exchange;
          const forward: ForwardRequest = {
            origin: admitted.origin,
            port: generation.attempt.port,
            cookies: cookiePolicyOf(routing, preview),
            upgrade: downstream.kind === "raw",
          };
          return yield* downstream.kind === "http"
            ? relayHttp(exchange, downstream, cell, pool, forward)
            : relayUpgrade(exchange, downstream, cell, pool, forward);
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
        const exchange: Exchange = {
          head: headOf(downstream.request),
          downstream,
          committed: false,
        };
        let settled = false;
        const interrupt = run(
          servePreviewRequest(exchange.head, (admitted) => serveAdmitted(exchange, admitted)).pipe(
            Effect.tapCause((cause) =>
              Cause.hasDies(cause)
                ? logged("preview gateway: a request failed", cause)
                : Effect.void,
            ),
          ),
          {
            onExit: (exit) => {
              settled = true;
              settle(exchange, exit);
            },
          },
        );
        const closed = downstream.kind === "http" ? downstream.response : downstream.socket;
        closed.once("close", () => {
          if (!settled) interrupt();
        });
      };

      const refreshCells = (selected: ReadonlyArray<Cell>): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (selected.length === 0) return;
          const read = yield* targets.snapshots(selected.map((cell) => cell.previewId)).pipe(
            Effect.map(Option.some),
            Effect.catchDefect((defect) =>
              logged("preview gateway: bindings could not be read", Cause.die(defect)).pipe(
                Effect.as(Option.none()),
              ),
            ),
          );
          for (const cell of selected) {
            const resolution = Option.isSome(read)
              ? (read.value.get(cell.previewId) ?? null)
              : null;
            const current = resolution?._tag === "Bound" ? generationOf(resolution).key : null;
            for (const pool of cell.pools.values()) {
              if (pool.generation.key !== current) closePool(cell, pool);
            }
            retain(cell);
          }
        });

      /** Closes each selected pool whose viewer the workspace no longer lends to. */
      const recheckLending = (selected: (pool: Pool) => boolean): Effect.Effect<void> =>
        Effect.suspend(() =>
          Effect.forEach(
            [...cells.values()].flatMap((cell) =>
              [...cell.pools.values()].filter(selected).map((pool) => ({ cell, pool })),
            ),
            ({ cell, pool }) =>
              asSealantUser(pool.viewerId)(
                caller.mayAct(pool.generation.attempt.workspaceId),
              ).pipe(Effect.catch(() => Effect.sync(() => closePool(cell, pool)))),
            { concurrency: 4, discard: true },
          ),
        );

      const onSignal = (signal: BusSignal): Effect.Effect<void> => {
        if (signal.kind === "resync") return refreshCells([...cells.values()]);
        const { event } = signal;
        switch (event.type) {
          case "worktree":
          case "project": {
            const { projectId } = event;
            return refreshCells(
              [...cells.values()].filter((cell) => cell.projectId === projectId),
            );
          }
          case "user": {
            const { userId } = event;
            return recheckLending((pool) => pool.viewerId === userId);
          }
          case "organization":
            return recheckLending(() => true);
          default:
            return Effect.void;
        }
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
      // Node emits CONNECT apart from `request`; admission answers it 405.
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

      yield* Effect.callback<void, PreviewListenFailed>((resume) => {
        const failed = (error: Error) =>
          resume(
            Effect.fail(
              new PreviewListenFailed({
                address: `${settings.bind}:${settings.port}`,
                message: error.message,
              }),
            ),
          );
        server.once("error", failed);
        server.listen(settings.port, settings.bind, () => {
          server.removeListener("error", failed);
          server.on("error", (error) =>
            run(
              Effect.logError("preview gateway: the listener failed").pipe(
                Effect.annotateLogs({ error: error.message }),
              ),
            ),
          );
          resume(Effect.void);
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closing = true;
          server.close();
          server.closeAllConnections();
          for (const cell of cells.values()) {
            for (const pool of cell.pools.values()) closePool(cell, pool);
          }
          for (const socket of rawSockets) socket.destroy();
        }),
      );

      const subscription = yield* bus.subscribe;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((signal) =>
          supervised("preview gateway: a refresh failed", onSignal(signal)),
        ),
        Effect.forkScoped,
      );
      yield* supervised(
        "preview gateway: a refresh failed",
        Effect.suspend(() => refreshCells([...cells.values()])),
      ).pipe(Effect.repeat(Schedule.spaced(REFRESH_EVERY)), Effect.forkScoped);
      yield* supervised(
        "preview gateway: a lending sweep failed",
        recheckLending(() => true),
      ).pipe(
        Effect.repeat(Schedule.spaced(LENDING_SWEEP_EVERY)),
        Effect.forkScoped,
      );
      yield* Effect.logInfo("preview gateway listening").pipe(
        Effect.annotateLogs({ bind: settings.bind, port: settings.port }),
      );
    }),
  );
