import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

const rawRequest = (request: HttpServerRequest.HttpServerRequest) =>
  /^\/api\/worktrees\/[^/?]+\/raw(?:\?|$)/.test(request.url);

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
