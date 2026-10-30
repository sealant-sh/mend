import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

export interface ObservationPolicy {
  /** Requests that leave no log line and no span. */
  readonly unobserved: (request: HttpServerRequest.HttpServerRequest) => boolean;
}

const unobservedLogs = (policy: ObservationPolicy) =>
  HttpRouter.middleware(
    (handler) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        policy.unobserved(request) ? HttpMiddleware.withLoggerDisabled(handler) : handler,
      ),
    { global: true },
  );

const unobservedSpans = (policy: ObservationPolicy) =>
  Layer.succeed(HttpMiddleware.TracerDisabledWhen)(policy.unobserved);

/** `HttpRouter.serve`, with the policy's log and span for each request. */
export const serveObserved = <A, E, R>(
  appLayer: Layer.Layer<A, E, R>,
  options: ObservationPolicy & { readonly disableListenLog?: boolean },
) =>
  HttpRouter.serve(Layer.merge(unobservedLogs(options), appLayer), {
    disableListenLog: options.disableListenLog ?? false,
  }).pipe(Layer.provide(unobservedSpans(options)));

/** `HttpRouter.toWebHandler`, with the policy's log and span for each request. */
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
    Layer.merge(unobservedLogs(options), appLayer).pipe(
      Layer.provideMerge(unobservedSpans(options)),
    ),
  );
