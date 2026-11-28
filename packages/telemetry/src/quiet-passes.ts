import { Context, Effect, Exit, Fiber, Option, Tracer } from "effect";

/**
 * A timer's pass that found nothing to do leaves no trace (SLNT-1404). Mend's sweeps and reapers
 * look every few seconds; each look was a trace of its own, thousands a day saying only that
 * nothing needed doing, the way a health check nobody traced would be (`http-observation.ts`).
 * A pass under `quietWhenIdle` is held in memory until it ends, and sent only when it did
 * something: wrote to the database, called out over HTTP, or failed.
 */

/** Whether the roots made around here are passes of a timer, kept only when busy. */
export const QuietWhenIdle = Context.Reference<boolean>("@mend/telemetry/QuietWhenIdle", {
  defaultValue: () => false,
});

/** `self`, a timer's loop: each of its passes is sent only when it did something. */
export const quietWhenIdle = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(self, QuietWhenIdle, true);

/** A statement that changes something, or tells listeners it did. */
const WRITE = /^\s*(?:insert|update|delete|merge|truncate|select\s+pg_notify)\b/i;

/** Whether `span`, as it ends with `exit`, did something a pass is kept for. */
const isBusy = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): boolean => {
  if (Exit.isFailure(exit)) return true;
  if (span.attributes.has("http.request.method")) return true;
  const query = span.attributes.get("db.query.text");
  return typeof query === "string" && WRITE.test(query);
};

/** A pass held back until it ends: its spans, in the order they ended. */
interface HeldPass {
  busy: boolean;
  readonly ended: Array<() => void>;
}

/** A pass holds at most this many spans; past it, it is sent as it is, held no more. */
const MAX_HELD = 2_000;
/** Passes dropped lately, so a span of one that ends late is dropped too. */
const MAX_DROPPED = 1_000;

/** `tracer`, holding each timer's pass (`QuietWhenIdle`) until it ends, and dropping it if idle. */
export const quietIdlePasses = (tracer: Tracer.Tracer): Tracer.Tracer => {
  const held = new Map<string, HeldPass>();
  const dropped = new Set<string>();

  const release = (pass: HeldPass) => {
    pass.busy = true;
    for (const end of pass.ended.splice(0)) end();
  };

  return Tracer.make({
    span: (options) => {
      const span = tracer.span(options);
      const traceId = span.traceId;
      const isRoot = Option.isNone(options.parent);
      if (isRoot) {
        if (Fiber.getCurrent()?.getRef(QuietWhenIdle) !== true) return span;
        held.set(traceId, { busy: false, ended: [] });
      } else if (!held.has(traceId) && !dropped.has(traceId)) {
        return span;
      }
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        if (dropped.has(traceId)) return;
        const pass = held.get(traceId);
        if (pass === undefined || pass.busy) {
          end(endTime, exit);
          if (isRoot) held.delete(traceId);
          return;
        }
        if (isBusy(span, exit)) {
          release(pass);
          end(endTime, exit);
          if (isRoot) held.delete(traceId);
          return;
        }
        if (!isRoot) {
          // Held spans all succeeded (a failure sends the pass): keep no result in memory.
          pass.ended.push(() => end(endTime, Exit.void));
          if (pass.ended.length >= MAX_HELD) release(pass);
          return;
        }
        // The pass ended idle: nothing of it is sent.
        held.delete(traceId);
        dropped.add(traceId);
        if (dropped.size > MAX_DROPPED) {
          const oldest = dropped.values().next();
          if (oldest.done !== true) dropped.delete(oldest.value);
        }
      };
      return span;
    },
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
  });
};
