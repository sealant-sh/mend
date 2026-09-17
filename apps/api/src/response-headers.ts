import { Cause, Effect, type Layer } from "effect";
import { HttpRouter, HttpServerError, HttpServerResponse } from "effect/unstable/http";

/**
 * Headers the API sets on its own answers (docs/adr/0004, "Errors and browser headers"; MEND-11).
 * The web front sets the full browser policy on everything it relays; these hold when something
 * reaches the API without it (a native client, a probe, a misrouted browser). An API answer is
 * data: it is never a document to sniff, frame or send a referrer from.
 */
export const API_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export const apiResponseHeaders: Layer.Layer<never, never, HttpRouter.HttpRouter> =
  HttpRouter.middleware(
    (handler) =>
      handler.pipe(
        // A typed failure (a route that does not exist, a request that does not parse) is turned
        // into its response by the server, outside every middleware, where no header can be set.
        // It is answered here instead, with the same response the server would have built. An
        // interruption is the client going away and passes through.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
        ),
        Effect.map((response) => HttpServerResponse.setHeaders(response, API_RESPONSE_HEADERS)),
      ),
    { global: true },
  );
