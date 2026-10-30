import {
  addressSubject,
  clientAddressOf,
  cookieValues,
  routedPath,
  type SessionCookieName,
  type WindowLimiter,
} from "@mend/network";
import { ByteSize, Cause, Clock, Effect, Option, type Layer } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";

import { budgetMessage, credentialSubject, type BudgetName, type Budgets } from "./budgets.ts";

const isLoopbackSocket = (address: string): boolean => {
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || bare.startsWith("127.");
};

/**
 * Seconds to wait before `limiter` admits another request from this client, or null now (ADR 0004,
 * "Budgets"). The client is its address as the one resolver sees it, IPv6 by its /64; a loopback
 * socket with no `X-Forwarded-For` is this machine's own and is never counted.
 */
export const addressWindowWait = (
  limiter: WindowLimiter,
  limit: number,
  request: {
    readonly socket: string | undefined;
    readonly forwardedFor: string | undefined;
    readonly trustedProxies: ReadonlyArray<string>;
  },
  at: number,
): number | null => {
  const internal =
    request.socket !== undefined &&
    isLoopbackSocket(request.socket) &&
    (request.forwardedFor ?? "").trim() === "";
  if (internal) return null;
  const address = addressSubject(
    clientAddressOf(request.socket, request.forwardedFor, request.trustedProxies),
  );
  return limiter.take(address, limit, at);
};

export type BodyBudget = Extract<BudgetName, "bodyBytes" | "uploadBodyBytes" | "bundleBytes">;

const BODY_ROUTES: ReadonlyArray<readonly [method: string, path: RegExp, budget: BodyBudget]> = [
  ["POST", /^\/api\/sessions\/[^/]+\/images$/, "uploadBodyBytes"],
  ["POST", /^\/api\/skills\/sync$/, "uploadBodyBytes"],
  ["PUT", /^\/api\/me\/pi-profile$/, "uploadBodyBytes"],
  ["POST", /^\/api\/projects\/[^/]+\/memory\/import$/, "uploadBodyBytes"],
  ["POST", /^\/api\/organization\/folders\/[^/]+\/files$/, "uploadBodyBytes"],
  ["POST", /^\/api\/dotfiles\/snapshot$/, "uploadBodyBytes"],
  ["PUT", /^\/api\/projects\/[^/]+\/workspace-image$/, "uploadBodyBytes"],
  ["POST", /^\/api\/projects\/[^/]+\/handoffs$/, "bundleBytes"],
];

export const bodyBudgetFor = (method: string, pathname: string): BodyBudget => {
  const routed = routedPath(pathname);
  const row = BODY_ROUTES.find(([verb, path]) => verb === method && path.test(routed));
  return row === undefined ? "bodyBytes" : row[2];
};

/**
 * Attempts at proving who you are. They get their own, tighter window, so guessing a password or
 * an invitation does not come out of the same allowance as loading a page.
 */
const SIGN_IN_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/auth\/sign-in(\/|$)/,
  /^\/api\/auth\/sign-up(\/|$)/,
  /^\/api\/auth\/(request-password-reset|reset-password|forget-password)(\/|$)/,
  /^\/api\/invitations\/[^/]+(\/|$)/,
];

export const isSignInAttempt = (method: string, pathname: string): boolean =>
  method === "POST" && SIGN_IN_PATHS.some((path) => path.test(routedPath(pathname)));

/**
 * The credentials a request presents, whatever they turn out to be worth: the bearer, and the
 * value of each cookie named exactly as Mend's session cookie. Only those: the rest of a `Cookie`
 * header is the client's to write, and counting it would let one appended pair start a fresh
 * window on every request. A look-alike name is not counted either: a sibling page on Mend's site
 * can plant one for the parent domain, and it would pool every visitor into one window. A request
 * presenting both is counted under both, whichever one authentication goes on to read.
 */
export const presentedCredentials = (
  headers: Readonly<Record<string, string | undefined>>,
  sessionCookie: SessionCookieName,
): ReadonlyArray<string> => {
  const authorization = headers["authorization"]?.trim() ?? "";
  return [
    ...(authorization === "" ? [] : [authorization]),
    ...cookieValues(headers["cookie"], sessionCookie),
  ];
};

export const budgetRefusal = (
  status: 413 | 429,
  name: BudgetName,
  limit: number,
  retryAfterSeconds: number | null,
) =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: "BudgetExceeded",
      budget: name,
      limit,
      retryAfterSeconds,
      message: budgetMessage(name, limit),
    },
    {
      status,
      ...(retryAfterSeconds === null
        ? {}
        : { headers: { "retry-after": String(retryAfterSeconds) } }),
    },
  );

/**
 * The budgets every request meets before routing, authentication or a byte of its body (docs/adr/
 * 0004, "Budgets"; MEND-05):
 *
 * 1. requests per minute from one client address, as the one resolver sees it, IPv6 by its /64.
 *    When every hop of a request is trusted the resolver answers the socket's own address, and
 *    that is counted like any other: a proxy that hides its clients shares one window, which
 *    shows up as refusals, where an exemption would show up as nothing at all. The one request
 *    not counted is a loopback socket with no `X-Forwarded-For`: a process on this machine;
 * 2. a tighter window for sign-in attempts from that address, with no exemption;
 * 3. requests per minute presenting one credential. It is counted by a digest of what was
 *    presented, valid or not, so this costs no lookup; rotating made-up credentials falls back on
 *    the address window;
 * 4. the body: a declared `Content-Length` over the route's limit is refused with 413 unread, and
 *    the same limit is set as `MaxBodySize`, which cuts a chunked body when it passes it.
 *
 * Installed on the router like the public network policy, so it also guards upgrades.
 */
export const requestBudgets = (input: {
  readonly budgets: Budgets["Service"];
  readonly trustedProxies: ReadonlyArray<string>;
  readonly sessionCookie: SessionCookieName;
  readonly now?: () => number;
}): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const { budgets, trustedProxies, sessionCookie, now } = input;
  return HttpRouter.middleware(
    (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { limits } = budgets;
        const pathname = new URL(request.url, "http://mend.local").pathname;
        const client = {
          socket: Option.getOrUndefined(request.remoteAddress),
          forwardedFor: request.headers["x-forwarded-for"],
          trustedProxies,
        };
        const address = addressSubject(
          clientAddressOf(client.socket, client.forwardedFor, trustedProxies),
        );

        const at = now?.() ?? (yield* Clock.currentTimeMillis);
        if (isSignInAttempt(request.method, pathname)) {
          const wait = budgets.signIns.take(address, limits.signInAttemptsPerMinute, at);
          if (wait !== null) {
            return budgetRefusal(
              429,
              "signInAttemptsPerMinute",
              limits.signInAttemptsPerMinute,
              wait,
            );
          }
        }
        const addressWait = addressWindowWait(
          budgets.addresses,
          limits.addressRequestsPerMinute,
          client,
          at,
        );
        if (addressWait !== null) {
          return budgetRefusal(
            429,
            "addressRequestsPerMinute",
            limits.addressRequestsPerMinute,
            addressWait,
          );
        }
        for (const credential of presentedCredentials(request.headers, sessionCookie)) {
          const wait = budgets.credentials.take(
            credentialSubject(credential),
            limits.credentialRequestsPerMinute,
            at,
          );
          if (wait !== null) {
            return budgetRefusal(
              429,
              "credentialRequestsPerMinute",
              limits.credentialRequestsPerMinute,
              wait,
            );
          }
        }

        const bodyBudget = bodyBudgetFor(request.method, pathname);
        const bodyLimit = limits[bodyBudget];
        if (bodyLimit <= 0) return yield* handler;
        const declared = Number(request.headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > bodyLimit) {
          return budgetRefusal(413, bodyBudget, bodyLimit, null);
        }
        return yield* handler.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(bodyLimit)),
          Effect.catchCause((cause) => {
            // The pinned Node adapter has no tagged size-limit cause: it wraps this exact Error
            // in RequestParseError. HttpApi payload decoding promotes that typed error to a defect.
            // Translate only this request's sole limit error; retain interruption and other failures.
            // Over a socket the adapter has already destroyed the request at the limit, so the
            // client sees the connection end, not this 413; the handler still never reads past it.
            const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
            const error =
              reason === undefined
                ? undefined
                : Cause.isFailReason(reason)
                  ? reason.error
                  : Cause.isDieReason(reason)
                    ? reason.defect
                    : undefined;
            if (
              HttpServerError.isHttpServerError(error) &&
              error.reason._tag === "RequestParseError" &&
              error.reason.request.source === request.source &&
              error.reason.cause instanceof Error &&
              error.reason.cause.message === "maxBytes exceeded"
            ) {
              return Effect.succeed(budgetRefusal(413, bodyBudget, bodyLimit, null));
            }
            return Effect.failCause(cause);
          }),
        );
      }),
    { global: true },
  );
};

/**
 * A web `Request` for a handler that wants one (better-auth), with the body read under this
 * request's `MaxBodySize`. `HttpServerRequest.toWeb` hands over the raw stream, which no limit
 * applies to, so an undeclared body would be buffered whole by whoever reads it.
 */
export const boundedWebRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
    if (url === undefined) return yield* Effect.die(new Error("request URL does not parse"));
    const init = { method: request.method, headers: request.headers };
    if (request.method === "GET" || request.method === "HEAD") return new Request(url, init);
    const body = yield* request.arrayBuffer.pipe(Effect.option);
    return Option.isNone(body) ? null : new Request(url, { ...init, body: body.value });
  });
