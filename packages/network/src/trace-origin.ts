import { Context, type Tracer } from "effect";

/**
 * The span the detached work around here serves (SLNT-1404): work cut loose from the trace it was
 * started in (`@mend/telemetry`'s `detachTrace`, or a request that is open, `requestOpened`)
 * records it, and every trace that work starts is linked to it.
 */
export const TraceOrigin = Context.Reference<Tracer.AnySpan | undefined>(
  "@mend/telemetry/TraceOrigin",
  { defaultValue: () => undefined },
);
