import { Cause, Clock, Context, Data, Effect, Exit, Layer, Option, type Tracer } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
  HttpTraceContext,
} from "effect/http";

export interface ObservationPolicy {
  /** Requests that leave no log line and no span. */
  readonly unobserved: (request: HttpServerRequest.HttpServerRequest) => boolean;
}

/** The route of a request no route answered: none matched, or a middleware refused it first. */
export const UNROUTED = "unrouted";

type Outcome =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "aborted" };

/**
 * What a request leaves in the log and the trace. The route is the router's registered template,
 * so no part of the URL a client sent is ever written.
 */
interface HttpObservation {
  readonly method: string;
  readonly route: string;
  readonly outcome: Outcome;
  readonly durationMillis: number;
}

class HttpRequestFailed extends Data.TaggedError("HttpRequestFailed")<{
  readonly message: string;
}> {}

class MatchedRoute extends Context.Service<
  MatchedRoute,
  { readonly matched: (template: string) => void }
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

const logObservation = (observation: HttpObservation) =>
  Effect.log(
    observation.outcome.kind === "aborted" ? "HTTP request aborted" : "Sent HTTP response",
  ).pipe(
    Effect.annotateLogs({
      "http.method": observation.method,
      "http.route": observation.route,
      "http.status":
        observation.outcome.kind === "response" ? observation.outcome.status : "aborted",
      "http.duration_ms": Math.round(observation.durationMillis),
    }),
  );

const observed = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    let route = UNROUTED;
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
          return logObservation(observation);
        }),
      ),
    );
  });

const observeRequests =
  (policy: ObservationPolicy) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      policy.unobserved(request) ? app : observed(request, app),
    );

/** Effect's own server tracer records the URL a client sent; the observation replaces it. */
const effectTracerOff = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true);

/** `HttpRouter.serve`, logging and tracing each request by its route's template. */
export const serveObserved = <A, E, R>(
  appLayer: Layer.Layer<A, E, R>,
  options: ObservationPolicy & { readonly disableListenLog?: boolean },
) =>
  HttpRouter.serve(Layer.provide(appLayer, reportsMatchedRoute), {
    disableLogger: true,
    disableListenLog: options.disableListenLog ?? false,
    middleware: observeRequests(options),
  }).pipe(Layer.provide(effectTracerOff));

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
  options: ObservationPolicy,
) =>
  HttpRouter.toWebHandler(
    Layer.provide(appLayer, reportsMatchedRoute).pipe(Layer.provideMerge(effectTracerOff)),
    { disableLogger: true, middleware: observeRequests(options) },
  );
