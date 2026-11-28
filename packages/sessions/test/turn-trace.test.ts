import { it as effectIt, TestClock } from "@mend/test-ci/effect-vitest";
import { Effect, Layer, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { makeTurnTraces } from "../src/turn-trace.ts";

/** The spans a run made, as their name, trace, parent and ended state. */
const recording = () => {
  const spans: Array<Tracer.Span> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);
      return span;
    },
  });
  const seen = () =>
    spans.map((span) => ({
      name: span.name,
      traceId: span.traceId,
      parent: Option.getOrNull(Option.map(span.parent, (parent) => parent.spanId)),
      ended: span.status._tag === "Ended",
      status: span.attributes.get("mend.turn.status") ?? null,
    }));
  return { layer: Layer.succeed(Tracer.Tracer, tracer), seen, spans };
};

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const ACCEPTED = "00f067aa0ba902b7";
const turn = { id: "turn-1", sessionId: "ses-1" };

describe("a turn's trace", () => {
  it("continues the context the turn was accepted in, one span per stage", async () => {
    const { layer, seen } = recording();
    const traces = makeTurnTraces((id: string) =>
      Effect.succeed(id === "turn-1" ? { traceparent: `00-${TRACE}-${ACCEPTED}-01` } : null),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* traces.dispatch(turn, Effect.withSpan(Effect.void, "mend.turn.input"));
        yield* traces.begin(turn, "codex-turn-1");
        // Taking the same turn twice (its start, then the send's answer) begins it once.
        yield* traces.begin(turn, "codex-turn-1");
        for (let item = 0; item < 5; item++) yield* traces.output("codex-turn-1");
        yield* traces.output("someone-elses-turn");
        yield* traces.end({ ...turn, status: "completed" }, "codex-turn-1");
      }).pipe(Effect.provide(layer)),
    );
    const spans = seen();
    expect(spans.map((span) => span.name)).toEqual([
      "mend.turn.dispatch",
      "mend.turn.input",
      "mend.turn.run",
      "mend.turn.first_output",
    ]);
    expect(spans.every((span) => span.traceId === TRACE && span.ended)).toBe(true);
    const [dispatch, input, run, first] = spans;
    expect(dispatch?.parent).toBe(ACCEPTED);
    expect(run?.parent).toBe(ACCEPTED);
    expect(input?.parent).not.toBeNull();
    expect(first?.parent).not.toBeNull();
    expect(run?.status).toBe("completed");
  });

  it("ends a turn this process never began, and starts a trace for a turn that has none", async () => {
    const { layer, seen } = recording();
    const traces = makeTurnTraces((id: string) =>
      Effect.succeed(id === "turn-1" ? { traceparent: `00-${TRACE}-${ACCEPTED}-01` } : "garbage"),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        // After a restart: the run span went with the old process.
        yield* traces.end({ ...turn, status: "failed" }, "codex-turn-1");
        yield* traces.dispatch({ id: "turn-2", sessionId: "ses-1" }, Effect.void);
      }).pipe(Effect.provide(layer)),
    );
    const [complete, fresh] = seen();
    expect(complete).toMatchObject({
      name: "mend.turn.complete",
      traceId: TRACE,
      parent: ACCEPTED,
      status: "failed",
    });
    expect(fresh?.name).toBe("mend.turn.dispatch");
    expect(fresh?.traceId).not.toBe(TRACE);
    expect(fresh?.parent).toBeNull();
  });

  effectIt.effect(
    "ends a turn's run span after ten minutes while the turn runs on, and its end then completes the trace",
    () => {
      const { layer, seen } = recording();
      const traces = makeTurnTraces((id: string) =>
        Effect.succeed(id === "turn-1" ? { traceparent: `00-${TRACE}-${ACCEPTED}-01` } : null),
      );
      return Effect.gen(function* () {
        yield* traces.begin(turn, "codex-turn-1");
        yield* TestClock.adjust("9 minutes");
        expect(seen()[0]).toMatchObject({ name: "mend.turn.run", ended: false });
        yield* TestClock.adjust("1 minute");
        expect(seen()[0]).toMatchObject({ name: "mend.turn.run", ended: true, status: "running" });
        yield* TestClock.adjust("20 minutes");
        yield* traces.end({ ...turn, status: "completed" }, "codex-turn-1");
        const [, complete] = seen();
        expect(complete).toMatchObject({
          name: "mend.turn.complete",
          traceId: TRACE,
          parent: ACCEPTED,
          ended: true,
          status: "completed",
        });
      }).pipe(Effect.provide(layer));
    },
  );
});
