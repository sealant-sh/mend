import { requestPathOf } from "@mend/network";
import { Effect, type Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

import { routedPath } from "./request-budgets.ts";

/**
 * Every spelling the router sends to the raw route: it drops an absolute URL's origin, ends the
 * path at `?`, `;` or `#`, and ignores case, escapes, repeated and trailing slashes. Any id
 * counts, so a spelling the router would not match is only ever kept out of logs as well.
 */
export const rawFileRequest = (request: HttpServerRequest.HttpServerRequest) => {
  const path = routedPath(requestPathOf(request.url)).replace(/\/+$/, "");
  return /^\/api\/worktrees\/.+\/raw$/.test(path);
};

/** Suppress raw request logging before authentication and query decoding can fail. */
export const rawFilePrivacy: Layer.Layer<never, never, HttpRouter.HttpRouter> =
  HttpRouter.middleware(
    (handler) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        rawFileRequest(request) ? HttpMiddleware.withLoggerDisabled(handler) : handler,
      ),
    { global: true },
  );
