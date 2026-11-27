import { Context, Effect, Fiber, Layer, Option, References, Tracer } from "effect";
import { HttpClient } from "effect/http";

import { QuietWhenIdle } from "./quiet-passes.ts";

/**
 * The shape of a trace (SLNT-1404): a trace covers one thing a person or a timer asked for, and
 * ends when that thing ends. Work that outlives what started it (a stream, a poller, a sweep, a
 * supervisor) runs each unit of its work as a trace of its own, linked to the span it serves
 * instead of parented on it, so no trace runs for days and no span stays open for a session's life.
 */

/** Whether this process traces at all: false under `telemetryLayer` with no DSN. */
export const Tracing = Context.Reference<boolean>("@mend/telemetry/Tracing", {
  defaultValue: () => true,
});

/**
 * Tracing off, for a process with telemetry off: Effect makes no span (`TracerEnabled`), and no
 * request carries a trace header. A disabled span still has IDs (`noop`), and Effect's HTTP client
 * writes them into `traceparent` and `b3` unless propagation is off too (`DisablePropagation`).
 */
export const tracingOff: Layer.Layer<never> = Layer.mergeAll(
  Layer.succeed(Tracing, false),
  Layer.succeed(References.TracerEnabled, false),
  Layer.succeed(Tracer.DisablePropagation, true),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

/**
 * `self` with no spans of its own, for a hot path (each token of a stream, each record entry): and
 * no trace header on a request it makes, which a disabled span would otherwise fill with `noop`.
 */
export const untraced = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  self.pipe(
    Effect.withTracerEnabled(false),
    Effect.provideService(Tracer.DisablePropagation, true),
  );

/**
 * `self` traced again inside an `untraced` region, as this process traces: a turn's stages are
 * spans of their own even though the stream that observes them is not. With telemetry off it
 * stays untraced.
 */
export const traced = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if (!(yield* Tracing)) return yield* self;
    return yield* self.pipe(
      Effect.withTracerEnabled(true),
      Effect.provideService(Tracer.DisablePropagation, false),
    );
  });

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** Whether `span` stands for a span a trace can name: not a disabled one (`noop`). */
export const isTraceable = (span: Tracer.AnySpan): boolean =>
  TRACE_ID.test(span.traceId.padStart(32, "0")) && SPAN_ID.test(span.spanId);

/** The current span, when there is one a trace can name. */
export const currentOrigin: Effect.Effect<Tracer.AnySpan | undefined> = Effect.map(
  Effect.option(Effect.currentParentSpan),
  (span) => (Option.isSome(span) && isTraceable(span.value) ? span.value : undefined),
);

/** The link to `origin`, the span a trace of its own serves; none without one. */
export const linksTo = (origin: Tracer.AnySpan | undefined): Array<Tracer.SpanLink> =>
  origin === undefined || !isTraceable(origin) ? [] : [{ span: origin, attributes: {} }];

/**
 * The span the detached work around here serves (`detachTrace`): every trace that work starts is
 * linked to it (`linkingRoots`), so a supervisor's or a poller's traces still lead back to the
 * request or the launch that started it.
 */
export const TraceOrigin = Context.Reference<Tracer.AnySpan | undefined>(
  "@mend/telemetry/TraceOrigin",
  { defaultValue: () => undefined },
);

/**
 * `tracer`, linking each root span it makes inside detached work to that work's origin
 * (`TraceOrigin`). A root made with links of its own keeps them.
 */
export const linkingRoots = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => {
      if (Option.isSome(options.parent) || options.links.length > 0) return tracer.span(options);
      const origin = Fiber.getCurrent()?.getRef(TraceOrigin);
      const links = linksTo(origin);
      return tracer.span(links.length === 0 ? options : { ...options, links });
    },
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
  });

export interface OwnTraceOptions {
  /** The span this work serves: linked, never its parent. The detached work's origin otherwise. */
  readonly origin?: Tracer.AnySpan | undefined;
  /** IDs and enums only (`mend.session_id`), never content. */
  readonly attributes?: Record<string, unknown>;
  readonly kind?: Tracer.SpanKind;
}

/**
 * `self` as the first span of a trace of its own, `name`, linked to `options.origin` (or to the
 * origin of the detached work it runs in): one unit of long-lived work (one poll, one sweep pass,
 * one delivered batch), so the trace ends when the unit does.
 */
export const inOwnTrace =
  (name: string, options: OwnTraceOptions = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const detachedFrom = yield* TraceOrigin;
      return yield* Effect.withSpan(self, name, {
        root: true,
        links: linksTo(options.origin ?? detachedFrom),
        ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
      });
    });

/**
 * `self` cut loose from the trace it was started in: a span it opens starts a trace of its own,
 * linked to the span it was started from (`TraceOrigin`). For a fiber that lives on after the
 * request that forked it (a stream, a poller, a supervisor), whose units of work each open their
 * own trace. Without it, every request such a fiber makes joins the trace that forked it, for as
 * long as the fiber lives.
 */
export const detachTrace = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(currentOrigin, (current) =>
    Effect.updateContext(self, (context: Context.Context<R>) => {
      const services = new Map(context.mapUnsafe);
      services.delete(Tracer.ParentSpan.key);
      // Work forked from a timer's pass is work, sent whatever it does (`quietWhenIdle`).
      services.delete(QuietWhenIdle.key);
      if (current !== undefined) services.set(TraceOrigin.key, current);
      return Context.makeUnsafe<R>(services);
    }),
  );
