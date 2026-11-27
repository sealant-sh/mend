import { Effect, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { openEnvelope, processAttempt, withTraceEnvelope } from "./job-trace.ts";

/** The span an attempt ran in, and the payload its handler was handed. */
const attemptOf = (data: unknown) =>
  Effect.gen(function* () {
    let seen: { readonly span: Tracer.Span; readonly payload: unknown } | undefined;
    yield* processAttempt({ queue: "name-session", id: "job_1", data }, (payload) =>
      Effect.map(Effect.currentSpan.pipe(Effect.orDie), (span) => {
        seen = { span, payload };
      }),
    );
    if (seen === undefined) throw new Error("the handler did not run");
    return seen;
  });

describe("a job's trace", () => {
  it("runs an attempt inside the trace that queued it", async () => {
    const { request, attempt } = await Effect.runPromise(
      Effect.gen(function* () {
        const request = yield* Effect.currentSpan;
        const data = yield* withTraceEnvelope({ sessionId: "ses_1" });
        return { request, attempt: yield* attemptOf(data).pipe(Effect.withSpan("unrelated")) };
      }).pipe(Effect.withSpan("mend.test.request")),
    );
    expect(attempt.span.traceId).toBe(request.traceId);
    expect(Option.getOrUndefined(attempt.span.parent)?.spanId).toBe(request.spanId);
    expect(attempt.payload).toEqual({ sessionId: "ses_1" });
  });

  it("runs an attempt of a job queued to link as a trace of its own, linked to the request", async () => {
    const { request, data, attempt } = await Effect.runPromise(
      Effect.gen(function* () {
        const request = yield* Effect.currentSpan;
        const data = yield* withTraceEnvelope({ sessionId: "ses_1" }, "link");
        return { request, data, attempt: yield* attemptOf(data) };
      }).pipe(Effect.withSpan("mend.test.request")),
    );
    expect(openEnvelope(data).link).toBe(true);
    expect(attempt.span.traceId).not.toBe(request.traceId);
    expect(Option.isNone(attempt.span.parent)).toBe(true);
    expect(attempt.span.links.map((link) => link.span.spanId)).toEqual([request.spanId]);
    expect(attempt.payload).toEqual({ sessionId: "ses_1" });
  });

  it("writes no envelope outside a span, or inside a disabled one", async () => {
    const outside = await Effect.runPromise(withTraceEnvelope({ sessionId: "ses_1" }, "link"));
    const disabled = await Effect.runPromise(
      withTraceEnvelope({ sessionId: "ses_1" }).pipe(
        Effect.withSpan("mend.test.request"),
        Effect.withTracerEnabled(false),
      ),
    );
    expect(outside).toEqual({ sessionId: "ses_1" });
    expect(disabled).toEqual({ sessionId: "ses_1" });
  });
});
