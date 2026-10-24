import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

import { routedPath } from "./request-budgets.ts";

/**
 * Every spelling the router sends to the raw route: it drops an absolute URL's origin, ends the
 * path at `?`, `;` or `#`, and ignores case, escapes, repeated and trailing slashes. Any id
 * counts, so a spelling the router would not match is only ever kept out of logs as well.
 */
const rawRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const target = request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const path = routedPath(target.split(/[?;#]/, 1)[0] ?? "").replace(/\/+$/, "");
  return /^\/api\/worktrees\/.+\/raw$/.test(path);
};

/** Suppress raw request logging before authentication and query decoding can fail. */
export const rawFilePrivacy: Layer.Layer<never, never, HttpRouter.HttpRouter> =
  HttpRouter.middleware(
    (handler) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        rawRequest(request) ? HttpMiddleware.withLoggerDisabled(handler) : handler,
      ),
    { global: true },
  );

/** The raw query carries a private filename, which server spans otherwise record. */
export const RawFileTracingDisabledLive: Layer.Layer<never> = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
)(rawRequest);
