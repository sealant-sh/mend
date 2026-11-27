import { Cause, Clock, Context, Data, Effect, Exit, Layer, Option, Stream, Tracer } from "effect";
import {
  Headers,
  HttpBody,
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpTraceContext,
  UrlParams,
} from "effect/http";

import { INVITATION_HEADER } from "./handed-links.ts";
import { PAGE_VIEW_TOKEN_PARAM } from "./page-view.ts";
import { CREDENTIAL_QUERY_PARAMETERS } from "./redact.ts";
import { templatePath } from "./url-template.ts";

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
          return Effect.annotateLogs(effect, "http.route", route.path);
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

const clientWentAway = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      Cause.isInterruptReason(reason) && reason.annotations.has(HttpServerError.ClientAbort.key),
  );

const outcomeOf = (exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { kind: "response", status: exit.value.status };
  if (clientWentAway(exit.cause)) return { kind: "aborted" };
  return { kind: "response", status: HttpServerError.causeResponseStripped(exit.cause)[0].status };
};

const failureOf = (outcome: Outcome): string | null => {
  if (outcome.kind === "aborted") return "aborted";
  return outcome.status >= 500 ? `status ${outcome.status}` : null;
};

/**
 * A request no route matched has only its path to be named by: the span takes it templated, as
 * `url.template` (`/api/devices/:secret`, `/nowhere/:id`), never as it came, and the exporter names
 * the span by it (`@mend/telemetry`'s `enrich.ts`).
 */
const endSpan = (
  span: Tracer.Span,
  observation: HttpObservation,
  endTime: bigint,
  path: string,
) => {
  span.attribute("http.request.method", observation.method);
  span.attribute("http.route", observation.route);
  if (observation.route === UNROUTED) span.attribute("url.template", templatePath(path));
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

const SENTRY_TRACE = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-([01]))?$/;

/**
 * The caller's span: W3C `traceparent` (or B3), else Sentry's own `sentry-trace`, which a Sentry
 * SDK sends alone when it was told not to propagate W3C (SLNT-1349: a fallback only).
 */
export const callerSpanOf = (headers: Headers.Headers): Tracer.ExternalSpan | undefined => {
  const traced = HttpTraceContext.fromHeaders(headers);
  if (Option.isSome(traced)) return traced.value;
  const match = SENTRY_TRACE.exec(headers["sentry-trace"]?.trim() ?? "");
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return Tracer.externalSpan({ traceId: match[1], spanId: match[2], sampled: match[3] !== "0" });
};

/**
 * The paths a load balancer, an orchestrator or an uptime check asks every few seconds. Asked
 * without a caller's trace, such a request makes no trace unless it fails: each would otherwise be
 * a root trace of its own in Sentry, hundreds an hour, saying only that the server answered.
 */
const PROBE_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/api/health",
]);

const pathnameOf = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrUndefined(HttpServerRequest.toURL(request))?.pathname ??
  request.url.split("?")[0] ??
  "";

const isProbe = (request: HttpServerRequest.HttpServerRequest): boolean =>
  PROBE_PATHS.has(pathnameOf(request));

/** A span for a probe that failed, started when the request was, with no parent: its own trace. */
const failedProbeSpan = (name: string, startTime: bigint) =>
  Effect.gen(function* () {
    const tracer = yield* Tracer.Tracer;
    return tracer.span({
      name,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime,
      kind: "server",
      root: true,
      sampled: true,
    });
  });

/**
 * A request that lives on once it is open, a socket or an event stream (SLNT-1404): its span
 * covers the opening, never the connection's life, which can be days.
 */
class OpenedRequest extends Context.Service<
  OpenedRequest,
  { readonly opened: (status: number) => Effect.Effect<void> }
>()("@mend/network/http-observation/OpenedRequest") {}

/**
 * The request being served is open, and what it does from now on is not the request: its span
 * ends now, with `status` (101 for a socket). A socket handler calls it once it has upgraded what
 * it needs, and runs the rest detached from the request's trace. An event stream needs no call:
 * its span ends when its headers go out, and its body runs outside the request's trace.
 */
export const requestOpened = (status = 101): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(OpenedRequest), (opened) =>
    Option.isNone(opened) ? Effect.void : opened.value.opened(status),
  );

const EVENT_STREAM = "text/event-stream";

const withoutParentSpanOf = (context: Context.Context<never>): Context.Context<never> => {
  const services = new Map(context.mapUnsafe);
  services.delete(Tracer.ParentSpan.key);
  return Context.makeUnsafe<never>(services);
};

/**
 * `stream` pulled with no parent span: what it does is not part of the request that answered it.
 * Each pull runs without it (`Stream.updateContext` leaves the span a stream is run under).
 */
const withoutParentSpan = <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E> =>
  Stream.transformPull(stream, (pull) =>
    Effect.succeed(Effect.updateContext(pull, withoutParentSpanOf)),
  );

const observed = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    let route: RouteTemplate = UNROUTED;
    const startTime = yield* Clock.currentTimeNanos;
    const parent = callerSpanOf(request.headers);
    const span =
      parent === undefined && isProbe(request)
        ? undefined
        : yield* Effect.makeSpan(request.method, { kind: "server", parent });
    /** Whether the span has ended: at the request's end, or once it was open (`requestOpened`). */
    let spanEnded = false;
    const endOpened = (status: number) =>
      Effect.gen(function* () {
        if (span === undefined || spanEnded) return;
        spanEnded = true;
        const endTime = yield* Clock.currentTimeNanos;
        endSpan(
          span,
          {
            method: request.method,
            route,
            outcome: { kind: "response", status },
            durationMillis: Number(endTime - startTime) / 1_000_000,
          },
          endTime,
          pathnameOf(request),
        );
      });
    /** An event stream's span ends as its headers go out, and its body leaves the request's trace. */
    const openEventStream: HttpEffect.PreResponseHandler = (_request, response) =>
      Effect.gen(function* () {
        const body = response.body;
        if (body._tag !== "Stream" || !body.contentType.startsWith(EVENT_STREAM)) return response;
        yield* endOpened(response.status);
        return HttpServerResponse.setBody(
          response,
          HttpBody.stream(withoutParentSpan(body.stream), body.contentType, body.contentLength),
        );
      });
    const observe = Effect.onExit((exit: Exit.Exit<HttpServerResponse.HttpServerResponse, E>) =>
      Effect.gen(function* () {
        const endTime = yield* Clock.currentTimeNanos;
        const observation: HttpObservation = {
          method: request.method,
          route,
          outcome: outcomeOf(exit),
          durationMillis: Number(endTime - startTime) / 1_000_000,
        };
        const cause = Option.map(failedCause(exit, observation.outcome), (failed) =>
          withoutUrlOf(Cause.pretty(failed), request, route),
        );
        yield* logObservation(observation, cause);
        const ended =
          span ??
          (failureOf(observation.outcome) === null
            ? undefined
            : yield* failedProbeSpan(request.method, startTime));
        if (ended !== undefined && !(ended === span && spanEnded))
          endSpan(ended, observation, endTime, pathnameOf(request));
      }),
    );
    const served =
      span === undefined
        ? // Untraced, and no `noop` trace header on a request the app makes (SLNT-1404).
          app.pipe(
            Effect.withTracerEnabled(false),
            Effect.provideService(Tracer.DisablePropagation, true),
            observe,
          )
        : app.pipe(observe, Effect.withParentSpan(span));
    if (span !== undefined) HttpEffect.appendPreResponseHandlerUnsafe(request, openEventStream);
    return yield* served.pipe(
      Effect.provideService(MatchedRoute, {
        matched: (template) => {
          route = template;
        },
        route: () => route,
      }),
      Effect.provideService(OpenedRequest, { opened: endOpened }),
    );
  });

const observeRequests = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> => Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => observed(request, app));

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
  options: { readonly disableListenLog?: boolean } = {},
) =>
  HttpRouter.serve(Layer.provide(appLayer, reportsMatchedRoute), {
    disableLogger: true,
    disableListenLog: options.disableListenLog ?? false,
    middleware: observeRequests,
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
) =>
  HttpRouter.toWebHandler(
    Layer.provide(appLayer, reportsMatchedRoute).pipe(Layer.provideMerge(observationDefaults)),
    { disableLogger: true, middleware: observeRequests },
  );
