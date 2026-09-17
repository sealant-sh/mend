import { addressSubject, clientAddressOf } from "@mend/network";
import { Effect, FileSystem, Option, type Layer } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { budgetMessage, credentialSubject, type BudgetName, type Budgets } from "./budgets.ts";

const isLoopbackSocket = (address: string): boolean => {
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || bare.startsWith("127.");
};

/** Routes that take a file in their body, by method and path (docs/adr/0004, "Budgets"). */
const UPLOAD_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/sessions\/[^/]+\/images$/],
  ["POST", /^\/api\/skills\/sync$/],
  ["POST", /^\/api\/organization\/folders\/[^/]+\/files$/],
  ["POST", /^\/api\/dotfiles\/snapshot$/],
  ["PUT", /^\/api\/projects\/[^/]+\/workspace-image$/],
];

/**
 * The path as the router will match it. The router ignores case and duplicate slashes and decodes
 * percent-escapes, so a spelling that still reaches a route must not slip past the rules here.
 */
export const routedPath = (pathname: string): string => {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Not valid escapes: the router will not match it either.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
};

export const isUploadRoute = (method: string, pathname: string): boolean =>
  UPLOAD_ROUTES.some(([verb, path]) => verb === method && path.test(routedPath(pathname)));

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
 * value of each session cookie. Only those: the rest of a `Cookie` header is the client's to
 * write, and counting it would let one appended pair start a fresh window on every request. A
 * request presenting both is counted under both, whichever one authentication goes on to read.
 */
export const presentedCredentials = (
  headers: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const authorization = headers["authorization"]?.trim() ?? "";
  if (authorization !== "") found.push(authorization);
  for (const pair of (headers["cookie"] ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name.endsWith("session_token") && value !== "") found.push(value);
  }
  return found;
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
export const requestBudgets = (
  budgets: Budgets["Service"],
  trustedProxies: ReadonlyArray<string>,
  now: () => number = Date.now,
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.middleware(
    (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { limits } = budgets;
        const pathname = new URL(request.url, "http://mend.local").pathname;
        const socket = Option.getOrUndefined(request.remoteAddress);
        const forwardedFor = request.headers["x-forwarded-for"];
        const address = addressSubject(clientAddressOf(socket, forwardedFor, trustedProxies));

        // Never inferred from a trusted chain: a load balancer or a pod inside a trusted CIDR
        // would then carry the whole Internet past the windows. Only a bare loopback socket is
        // this machine's own (a probe, the CLI beside the server); the web tier always forwards.
        const internal =
          socket !== undefined && isLoopbackSocket(socket) && (forwardedFor ?? "").trim() === "";

        const at = now();
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
        const addressWait = internal
          ? null
          : budgets.addresses.take(address, limits.addressRequestsPerMinute, at);
        if (addressWait !== null) {
          return budgetRefusal(
            429,
            "addressRequestsPerMinute",
            limits.addressRequestsPerMinute,
            addressWait,
          );
        }
        for (const credential of presentedCredentials(request.headers)) {
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

        const upload = isUploadRoute(request.method, pathname);
        const bodyBudget: BudgetName = upload ? "uploadBodyBytes" : "bodyBytes";
        const bodyLimit = limits[bodyBudget];
        if (bodyLimit <= 0) return yield* handler;
        const declared = Number(request.headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > bodyLimit) {
          return budgetRefusal(413, bodyBudget, bodyLimit, null);
        }
        return yield* handler.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(bodyLimit)),
        );
      }),
    { global: true },
  );

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
