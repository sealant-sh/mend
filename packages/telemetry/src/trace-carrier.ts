import { Effect, Option, Schema, Tracer } from "effect";

/**
 * A trace's W3C context, kept where work waits for later: in a pg-boss job's data (under `_trace`)
 * and on a conversation turn's row. Whatever picks the work up continues the trace from it
 * (SLNT-1349, "Crossing async boundaries").
 */
export const TraceCarrier = Schema.Struct({
  traceparent: Schema.String,
  tracestate: Schema.optional(Schema.String),
});
export type TraceCarrier = typeof TraceCarrier.Type;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The carrier for `span`. */
export const carrierOf = (span: Tracer.AnySpan): TraceCarrier => ({
  traceparent: `00-${span.traceId.padStart(32, "0")}-${span.spanId}-${span.sampled ? "01" : "00"}`,
});

/** The current span's carrier, or undefined outside any span. */
export const currentTraceCarrier: Effect.Effect<TraceCarrier | undefined> = Effect.map(
  Effect.option(Effect.currentParentSpan),
  (span) => (Option.isSome(span) ? carrierOf(span.value) : undefined),
);

/**
 * The span a carrier names, as a parent or a link, or undefined when it names none: written by
 * another process, or by an older Mend, a carrier is read as untrusted text.
 */
export const spanOfCarrier = (carrier: unknown): Tracer.ExternalSpan | undefined => {
  if (!Schema.is(TraceCarrier)(carrier)) return undefined;
  const match = TRACEPARENT.exec(carrier.traceparent);
  if (match === null) return undefined;
  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return Tracer.externalSpan({
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  });
};
