import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import { type Duplex, pipeline } from "node:stream";

import type { ForwardAgent, ForwardSocket } from "@mend/sessions";
import { Effect } from "effect";

import type { PreviewBodyCap } from "./preview-gateway-settings.ts";
import {
  type ForwardRequest,
  forwardRequestHead,
  forwardResponseHead,
  gatewayPage,
  notDelivered,
  stated,
} from "./preview-headers.ts";
import {
  type HeaderPair,
  membersOf,
  type PreviewAnswer,
  type PreviewRequestHead,
} from "./preview-requests.ts";

const UNREAD_LINGER_MS = 2_000;

export type Downstream =
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

export interface Exchange {
  readonly head: PreviewRequestHead;
  readonly downstream: Downstream;
  committed: boolean;
}

const pairsOf = (raw: ReadonlyArray<string>): Array<HeaderPair> => {
  const pairs: Array<HeaderPair> = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index] ?? "", raw[index + 1] ?? ""]);
  }
  return pairs;
};

const flatten = (pairs: ReadonlyArray<HeaderPair>): Array<string> =>
  pairs.flatMap(([name, value]) => [name, value]);

export const exchangeOf = (downstream: Downstream): Exchange => ({
  head: {
    method: downstream.request.method ?? "GET",
    target: downstream.request.url ?? "/",
    headers: pairsOf(downstream.request.rawHeaders),
  },
  downstream,
  committed: false,
});

export const declaredLength = (head: PreviewRequestHead): number | null => {
  const [length] = membersOf(head.headers, "content-length");
  return length === undefined ? null : Number(length);
};

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

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

export const destroyDownstream = (downstream: Downstream): void => {
  if (downstream.kind === "http") downstream.response.destroy();
  else downstream.socket.destroy();
};

/**
 * A request whose body may still be arriving gets the answer written straight to its socket:
 * Node's `res.end` would read and discard the rest of the body, with keep-alive all of it.
 */
export const respond = (exchange: Exchange, reply: PreviewAnswer): void => {
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
  const socket = downstream.kind === "http" ? downstream.request.socket : downstream.socket;
  if (!socket.destroyed) lingerThenDestroy(socket, answerBytes(reply));
};

export interface ForwardLease {
  readonly agent: ForwardAgent;
  readonly dialOwn: () => ForwardSocket;
  readonly closed: () => boolean;
  readonly track: (request: ClientRequest) => () => void;
  readonly holdUpgraded: (socket: Duplex) => () => void;
  readonly refusal: (error: Error) => PreviewAnswer;
}

export interface RelaySettings {
  readonly bodyCap: PreviewBodyCap;
  readonly queueWaitMs: number;
}

export interface RelayTarget {
  readonly serviceName: string;
  readonly forward: ForwardRequest;
  readonly lease: ForwardLease;
  readonly holdsForward: () => () => void;
}

type End = (page?: PreviewAnswer) => void;

interface Handlers {
  readonly retryable: boolean;
  readonly deliver: (upstream: ClientRequest, end: End) => void;
  readonly answered: (upstream: ClientRequest, end: End) => void;
  readonly cleanup?: () => void;
}

/**
 * A `retryable` request whose reused forward closed before any answer is sent once more, on a
 * forward of its own: the app may have closed that keep-alive socket as the request went out.
 */
const sendUpstream = (
  exchange: Exchange,
  target: RelayTarget,
  settings: RelaySettings,
  handlers: Handlers,
) =>
  Effect.callback<undefined>((resume) => {
    const { lease, serviceName, forward } = target;
    let ended = false;
    let upstream: ClientRequest | null = null;
    let untrack: (() => void) | null = null;
    let vacate: (() => void) | null = null;
    let waiting: NodeJS.Timeout | null = null;
    const settle = () => {
      if (waiting !== null) clearTimeout(waiting);
      waiting = null;
      untrack?.();
      untrack = null;
      vacate?.();
      vacate = null;
    };
    const end: End = (page) => {
      if (ended) return;
      ended = true;
      settle();
      if (page !== undefined) respond(exchange, page);
      resume(Effect.succeed(undefined));
    };
    const send = (fresh: boolean) => {
      let delivered = false;
      let responded = false;
      const sent = httpRequest({
        method: exchange.head.method,
        path: exchange.head.target,
        headers: flatten(forwardRequestHead(exchange.head.headers, forward)),
        setHost: false,
        ...(fresh ? { createConnection: lease.dialOwn } : { agent: lease.agent }),
      });
      upstream = sent;
      untrack?.();
      untrack = lease.track(sent);
      if (!fresh && waiting === null) {
        waiting = setTimeout(() => {
          sent.destroy();
          end(gatewayPage(503, notDelivered(serviceName, "every forward to it stayed busy")));
        }, settings.queueWaitMs);
      }
      const deliver = () => {
        if (ended) return;
        if (lease.closed()) {
          sent.destroy();
          return end(gatewayPage(503, notDelivered(serviceName, "the preview restarted")));
        }
        delivered = true;
        handlers.deliver(sent, end);
      };
      sent.once("socket", (socket) => {
        if (waiting !== null) clearTimeout(waiting);
        waiting = null;
        vacate ??= target.holdsForward();
        if (socket.connecting) socket.once("connect", deliver);
        else deliver();
      });
      sent.once("response", () => {
        responded = true;
      });
      handlers.answered(sent, end);
      sent.on("error", (error) => {
        if (ended) return;
        if (handlers.retryable && !fresh && delivered && !responded && sent.reusedSocket) {
          return send(true);
        }
        end(
          delivered
            ? gatewayPage(502, stated(serviceName, "the app did not answer"))
            : lease.refusal(error),
        );
      });
    };
    send(false);
    return Effect.sync(() => {
      ended = true;
      upstream?.destroy();
      handlers.cleanup?.();
      settle();
    });
  });

const streamBody = (
  request: IncomingMessage,
  upstream: ClientRequest,
  serviceName: string,
  cap: PreviewBodyCap,
  end: End,
) => {
  if (cap._tag === "Capped") {
    let seen = 0;
    request.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen <= cap.bytes) return;
      request.unpipe(upstream);
      request.pause();
      end(gatewayPage(413, stated(serviceName, `the request body passed ${cap.bytes} bytes`)));
      upstream.destroy();
    });
  }
  request.pipe(upstream);
};

const relayHttp = (
  exchange: Exchange,
  downstream: Extract<Downstream, { kind: "http" }>,
  target: RelayTarget,
  settings: RelaySettings,
) => {
  const { request, response } = downstream;
  return sendUpstream(exchange, target, settings, {
    retryable: IDEMPOTENT.has(exchange.head.method) && !mayCarryBody(exchange.head),
    deliver: (upstream, end) => {
      if (downstream.expectsContinue) response.writeContinue();
      if (mayCarryBody(exchange.head)) {
        streamBody(request, upstream, target.serviceName, settings.bodyCap, end);
      } else upstream.end();
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
          target.forward.cookies,
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
  target: RelayTarget,
  settings: RelaySettings,
) => {
  const browser = downstream.socket;
  const pair: Array<Duplex> = [];
  return sendUpstream(exchange, target, settings, {
    retryable: false,
    deliver: (upstream) => upstream.end(),
    answered: (upstream, end) => {
      upstream.once("upgrade", (answered, app, appHead) => {
        app.on("error", () => browser.destroy());
        if (target.lease.closed() || browser.destroyed) {
          app.destroy();
          browser.destroy();
          return end();
        }
        pair.push(browser, app);
        exchange.committed = true;
        const head = forwardResponseHead(
          { status: 101, headers: pairsOf(answered.rawHeaders) },
          target.forward.cookies,
        );
        browser.write(headText(101, head));
        if (appHead.length > 0) browser.write(appHead);
        if (downstream.head.length > 0) app.write(downstream.head);
        browser.pipe(app);
        app.pipe(browser);
        let open = 2;
        const closesWith = (socket: Duplex, other: Duplex) => {
          const release = target.lease.holdUpgraded(socket);
          socket.once("close", () => {
            other.destroy();
            release();
            open -= 1;
            if (open === 0) end();
          });
        };
        closesWith(browser, app);
        closesWith(app, browser);
      });
      upstream.once("response", (answered) => {
        exchange.committed = true;
        const status = answered.statusCode ?? 502;
        const head = forwardResponseHead(
          { status, headers: pairsOf(answered.rawHeaders) },
          target.forward.cookies,
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

export const relay = (
  exchange: Exchange,
  target: RelayTarget,
  settings: RelaySettings,
): Effect.Effect<undefined> => {
  const { downstream } = exchange;
  return downstream.kind === "http"
    ? relayHttp(exchange, downstream, target, settings)
    : relayUpgrade(exchange, downstream, target, settings);
};
