import { Cause, Clock, Context, Data, Effect, Exit, Layer, Option, type Tracer } from "effect";
import {
  Headers,
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
  HttpTraceContext,
  UrlParams,
} from "effect/http";

import { INVITATION_HEADER } from "./handed-links.ts";
import { PAGE_VIEW_TOKEN_PARAM } from "./page-view.ts";
import { CREDENTIAL_QUERY_PARAMETERS } from "./redact.ts";

export interface ObservationPolicy {
  /** Requests that leave no log line and no span. */
  readonly unobserved: (request: HttpServerRequest.HttpServerRequest) => boolean;
}

/** The route of a request no route answered: none matched, or a middleware refused it first. */
export const UNROUTED = "unrouted";

type RouteTemplate = HttpRouter.PathInput | typeof UNROUTED;

type Outcome =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "aborted" };

interface HttpObservation {
  readonly method: string;
  readonly route: RouteTemplate;
  readonly outcome: Outcome;
  readonly durationMillis: number;
}

class HttpRequestFailed extends Data.TaggedError("HttpRequestFailed")<{
  readonly message: string;
}> {}

class MatchedRoute extends Context.Service<
  MatchedRoute,
  {
    readonly matched: (template: HttpRouter.PathInput) => void;
    readonly route: () => RouteTemplate;
  }
>()("@mend/network/http-observation/MatchedRoute") {}

const reportsMatchedRoute = HttpRouter.middleware((effect) =>
  Effect.flatMap(Effect.serviceOption(MatchedRoute), (slot) =>
    Option.isNone(slot)
      ? effect
      : Effect.flatMap(HttpRouter.RouteContext, ({ route }) => {
          slot.value.matched(route.path);
          return effect;
        }),
  ),
).layer;

const urlSpellingsOf = (request: HttpServerRequest.HttpServerRequest): ReadonlyArray<string> => {
  const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
  const written = [
    request.url,
    request.originalUrl,
    url?.href,
    url === undefined ? undefined : `${url.pathname}${url.search}`,
    url?.pathname,
  ];
  const spellings = written.flatMap((spelling) =>
    spelling === undefined || spelling.length < 2 ? [] : [spelling, UrlParams.redactUrl(spelling)],
  );
  return [...new Set(spellings)].toSorted((a, b) => b.length - a.length);
};

const withoutUrlOf = (
  text: string,
  request: HttpServerRequest.HttpServerRequest,
  route: RouteTemplate,
): string =>
  urlSpellingsOf(request).reduce(
    (scrubbed, spelling) => scrubbed.replaceAll(spelling, route),
    text,
  );

/**
 * `text`, a diagnostic about the request being served, with its URL in each spelling replaced by
 * its route's template: an `HttpServerError`'s message, and a `TypeError` from `new Request`, hold
 * the URL whole.
 */
export const withoutRequestUrl = (
  text: string,
): Effect.Effect<string, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const slot = yield* Effect.serviceOption(MatchedRoute);
    const route = Option.isNone(slot) ? UNROUTED : slot.value.route();
    return withoutUrlOf(text, request, route);
  });

/** What Effect answers for a request whose client went away (`HttpServerError.causeResponse`). */
const CLIENT_ABORT_STATUS = 499;

const outcomeOf = (exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>): Outcome => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return { kind: "aborted" };
  const status = Exit.isSuccess(exit)
    ? exit.value.status
    : HttpServerError.causeResponseStripped(exit.cause)[0].status;
  return status === CLIENT_ABORT_STATUS ? { kind: "aborted" } : { kind: "response", status };
};

const failureOf = (outcome: Outcome): string | null => {
  if (outcome.kind === "aborted") return "aborted";
  return outcome.status >= 500 ? `status ${outcome.status}` : null;
};

const endSpan = (span: Tracer.Span, observation: HttpObservation, endTime: bigint) => {
  span.attribute("http.request.method", observation.method);
  span.attribute("http.route", observation.route);
  if (observation.outcome.kind === "response")
    span.attribute("http.response.status_code", observation.outcome.status);
  const failure = failureOf(observation.outcome);
  span.end(
    endTime,
    failure === null ? Exit.void : Exit.fail(new HttpRequestFailed({ message: failure })),
  );
};

const failedCause = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>,
  outcome: Outcome,
): Option.Option<Cause.Cause<unknown>> =>
  Exit.isFailure(exit) && outcome.kind === "response" && outcome.status >= 500
    ? HttpServerError.causeResponseStripped(exit.cause)[1]
    : Option.none();

const logObservation = (observation: HttpObservation, cause: Option.Option<string>) =>
  Effect.logWithLevel(failureOf(observation.outcome)?.startsWith("status") ? "Error" : "Info")(
    observation.outcome.kind === "aborted" ? "HTTP request aborted" : "Sent HTTP response",
  ).pipe(
    Effect.annotateLogs({
      "http.method": observation.method,
      "http.route": observation.route,
      "http.status":
        observation.outcome.kind === "response" ? observation.outcome.status : "aborted",
      "http.duration_ms": Math.round(observation.durationMillis),
      ...(Option.isSome(cause) ? { cause: cause.value } : {}),
    }),
  );

const observed = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  formatCause: (cause: Cause.Cause<unknown>) => string,
) =>
  Effect.gen(function* () {
    let route: RouteTemplate = UNROUTED;
    const startTime = yield* Clock.currentTimeNanos;
    const span = yield* Effect.makeSpan(request.method, {
      kind: "server",
      parent: Option.getOrUndefined(HttpTraceContext.fromHeaders(request.headers)),
    });
    return yield* app.pipe(
      Effect.withParentSpan(span),
      Effect.provideService(MatchedRoute, {
        matched: (template) => {
          route = template;
        },
        route: () => route,
      }),
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeNanos, (endTime) => {
          const observation: HttpObservation = {
            method: request.method,
            route,
            outcome: outcomeOf(exit),
            durationMillis: Number(endTime - startTime) / 1_000_000,
          };
          endSpan(span, observation, endTime);
          const cause = Option.map(failedCause(exit, observation.outcome), (failed) =>
            withoutUrlOf(formatCause(failed), request, route),
          );
          return logObservation(observation, cause);
        }),
      ),
    );
  });

interface ObservationOptions extends ObservationPolicy {
  /** How a 5xx's cause is written, before its URL is taken out. `Cause.pretty` by default. */
  readonly formatCause?: (cause: Cause.Cause<unknown>) => string;
}

const observeRequests =
  (options: ObservationOptions) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      options.unobserved(request)
        ? app
        : observed(request, app, options.formatCause ?? Cause.pretty),
    );

/** Effect's own server tracer records the URL a client sent; the observation replaces it. */
const effectTracerOff = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true);

const mendCredentialsRedacted = Layer.mergeAll(
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    Effect.gen(function* () {
      return [
        ...(yield* UrlParams.CurrentRedactedNames),
        ...CREDENTIAL_QUERY_PARAMETERS,
        PAGE_VIEW_TOKEN_PARAM,
      ];
    }),
  ),
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.gen(function* () {
      return [...(yield* Headers.CurrentRedactedNames), INVITATION_HEADER];
    }),
  ),
);

const observationDefaults = Layer.merge(effectTracerOff, mendCredentialsRedacted);

/** `HttpRouter.serve`, logging and tracing each request by its route's template. */
export const serveObserved = <A, E, R>(
  appLayer: Layer.Layer<A, E, R>,
  options: ObservationOptions & { readonly disableListenLog?: boolean },
) =>
  HttpRouter.serve(Layer.provide(appLayer, reportsMatchedRoute), {
    disableLogger: true,
    disableListenLog: options.disableListenLog ?? false,
    middleware: observeRequests(options),
  }).pipe(Layer.provide(observationDefaults));

/** `HttpRouter.toWebHandler`, logging and tracing each request by its route's template. */
export const observedWebHandler = <
  A,
  E,
  R extends
    | HttpRouter.HttpRouter
    | HttpRouter.Request<"Requires", unknown>
    | HttpRouter.Request<"GlobalRequires", unknown>
    | HttpRouter.Request<"Error", unknown>
    | HttpRouter.Request<"GlobalError", unknown>,
>(
  appLayer: Layer.Layer<A, E, R>,
  options: ObservationOptions,
) =>
  HttpRouter.toWebHandler(
    Layer.provide(appLayer, reportsMatchedRoute).pipe(Layer.provideMerge(observationDefaults)),
    { disableLogger: true, middleware: observeRequests(options) },
  );
