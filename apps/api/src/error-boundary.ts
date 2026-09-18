import { randomBytes } from "node:crypto";

import { redactDetail } from "@mend/network";
import { Cause, Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

/**
 * The one place error text leaves the API (docs/adr/0004, "Errors and browser headers"; MEND-11).
 *
 * - A declared contract error crosses with its tag and its message, and the message is scrubbed of
 *   what arrived from below: server paths, internal hosts, URL credentials and queries, tokens
 *   (`redactDetail`). Mend's own words pass through unchanged, so the person still reads why.
 * - A plain-text error body (the socket routes' 502s) is scrubbed the same way.
 * - A defect, or any 5xx nobody declared, crosses as `InternalError` and a reference. The detail
 *   goes to the log under that reference, which is what an operator searches for.
 *
 * `MEND_ERROR_DETAIL=verbose` turns the scrubbing off for an operator debugging a private
 * instance. It is an open item of the public exposure gate.
 */
export class ErrorDetail extends Context.Service<
  ErrorDetail,
  { readonly mode: "redacted" | "verbose" }
>()("@mend/api/ErrorDetail") {}

export const ErrorDetailLive: Layer.Layer<ErrorDetail, Config.ConfigError> = Layer.effect(
  ErrorDetail,
  Effect.gen(function* () {
    const mode = yield* Config.schema(
      Schema.Literals(["redacted", "verbose"]),
      "MEND_ERROR_DETAIL",
    ).pipe(Config.withDefault("redacted" as const));
    if (mode === "verbose") {
      yield* Effect.logWarning(
        "MEND_ERROR_DETAIL=verbose: error responses carry upstream detail (paths, hosts, platform text)",
      );
    }
    return { mode };
  }),
);

/** Eight bytes, hex: short enough to read out, long enough to find one line in a day of logs. */
export const makeReference = (): string => randomBytes(8).toString("hex");

const DETAIL_FIELDS: ReadonlySet<string> = new Set([
  "message",
  "stderr",
  "stdout",
  "output",
  "detail",
  "reason",
  "recordError",
  "error",
  "cause",
  "stack",
  "path",
  "url",
]);

/** Scrub every detail-bearing string in an error body, at any depth. Other values are untouched. */
export const redactErrorBody = (body: unknown): unknown => {
  if (Array.isArray(body)) return body.map(redactErrorBody);
  if (typeof body !== "object" || body === null) return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      typeof value === "string" && DETAIL_FIELDS.has(key)
        ? redactDetail(value)
        : redactErrorBody(value),
    ]),
  );
};

const internalError = (reference: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: "InternalError",
      reference,
      message: `internal error · reference ${reference}`,
    },
    { status: 500 },
  );

const decoder = new TextDecoder();

/** Everything about a response but its body: a rewritten error still clears a cookie it meant to. */
const kept = (response: HttpServerResponse.HttpServerResponse) => ({
  status: response.status,
  ...(response.statusText === undefined ? {} : { statusText: response.statusText }),
  headers: response.headers,
  cookies: response.cookies,
});

/** The scrubbed response, or the same one when there is nothing to scrub. */
export const redactErrorResponse = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    if (response.status < 400 || response.body._tag !== "Uint8Array") return response;
    const contentType = response.body.contentType.toLowerCase();
    const text = decoder.decode(response.body.body);
    if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return response;
      }
      const tagged = typeof parsed === "object" && parsed !== null && "_tag" in parsed;
      if (response.status >= 500 && !tagged) {
        // An undeclared 5xx: whatever produced it, its body was not written for a client.
        const reference = makeReference();
        yield* Effect.logError("an undeclared error response was replaced").pipe(
          Effect.annotateLogs({ reference, status: response.status, body: text.slice(0, 2000) }),
        );
        return internalError(reference);
      }
      return HttpServerResponse.jsonUnsafe(redactErrorBody(parsed), kept(response));
    }
    if (contentType.includes("text/plain")) {
      return HttpServerResponse.text(redactDetail(text), kept(response));
    }
    return response;
  });

/**
 * Installed on the router above every route and the request budgets, and beneath the origin
 * policy and the API's response headers, so a rewritten answer still gets its CORS and security
 * headers (http-middleware.ts states the order; http-middleware.test.ts holds it).
 */
export const errorBoundary = (
  detail: ErrorDetail["Service"],
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.middleware(
    (handler) =>
      handler.pipe(
        Effect.flatMap((response) =>
          detail.mode === "verbose" ? Effect.succeed(response) : redactErrorResponse(response),
        ),
        Effect.catchCause((cause) => {
          // Only a defect is answered here. An interruption is the client going away, and a typed
          // failure (a route that does not exist, a malformed request) is the router's to answer
          // with its own status; both pass through untouched.
          if (!Cause.hasDies(cause)) return Effect.failCause(cause);
          const reference = makeReference();
          return Effect.logError("an unhandled failure reached the error boundary").pipe(
            Effect.annotateLogs({ reference, cause: Cause.pretty(cause) }),
            Effect.as(internalError(reference)),
          );
        }),
      ),
    { global: true },
  );
