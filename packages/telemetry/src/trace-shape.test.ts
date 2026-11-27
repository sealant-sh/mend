import { ConfigProvider, Effect, Layer, Option, Tracer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { telemetryLayer } from "./layer.ts";
import { currentTraceCarrier } from "./trace-carrier.ts";
import {
  currentOrigin,
  detachTrace,
  inOwnTrace,
  isTraceable,
  linkingRoots,
  traced,
  untraced,
} from "./trace-shape.ts";

const TRACE_HEADERS = ["traceparent", "tracestate", "baggage", "b3", "sentry-trace"];

/** A client that keeps the headers of every request it is handed. */
const recordingClient = () => {
  const sent: Array<Record<string, string>> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push({ ...request.headers });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
    }),
  );
  return { sent, layer };
};

const traceHeadersOf = (headers: Record<string, string>) =>
  TRACE_HEADERS.filter((name) => headers[name] !== undefined);

/** Telemetry as a process with no DSN has it. */
const off = telemetryLayer({ name: "mend-test" }).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
);

describe("a process with telemetry off", () => {
  it("sends no trace header and makes no span, even inside spans and re-enabled regions", async () => {
    const { sent, layer } = recordingClient();
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        yield* HttpClient.get("http://mend.test/api/changes/1/landings");
        yield* HttpClient.get("http://mend.test/api/me/devices").pipe(
          Effect.withSpan("mend.test.inner"),
          traced,
        );
        yield* HttpClient.get("http://mend.test/api/events").pipe(untraced);
        return {
          origin: yield* currentOrigin,
          carrier: yield* currentTraceCarrier,
          span: yield* Effect.currentParentSpan,
        };
      }).pipe(Effect.withSpan("mend.test.long_lived"), Effect.provide(Layer.merge(off, layer))),
    );
    expect(sent).toHaveLength(3);
    for (const headers of sent) expect(traceHeadersOf(headers)).toEqual([]);
    expect(seen.origin).toBeUndefined();
    expect(seen.carrier).toBeUndefined();
    expect(isTraceable(seen.span)).toBe(false);
  });
});

describe("a process with telemetry on", () => {
  it("sends no `noop` header from an untraced region, and traces again where asked", async () => {
    const { sent, layer } = recordingClient();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* HttpClient.get("http://mend.test/hot").pipe(untraced);
        yield* HttpClient.get("http://mend.test/turn").pipe(
          Effect.withSpan("mend.test.turn"),
          traced,
          untraced,
        );
      }).pipe(Effect.withSpan("mend.test.request"), Effect.provide(layer)),
    );
    expect(traceHeadersOf(sent[0] ?? {})).toEqual([]);
    expect(sent[1]?.["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("runs a unit of long-lived work as a trace of its own, linked to what it serves", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const origin = yield* currentOrigin;
        const unit = yield* Effect.currentSpan.pipe(
          inOwnTrace("mend.test.poll", { origin, attributes: { "mend.session_id": "ses_1" } }),
        );
        return { origin, unit };
      }).pipe(Effect.withSpan("mend.test.request")),
    );
    expect(result.origin).toBeDefined();
    expect(result.unit.traceId).not.toBe(result.origin?.traceId);
    expect(Option.isNone(result.unit.parent)).toBe(true);
    expect(result.unit.links.map((link) => link.span.spanId)).toEqual([result.origin?.spanId]);
    expect(result.unit.attributes.get("mend.session_id")).toBe("ses_1");
  });

  it("cuts a long-lived fiber loose from the trace that forked it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const request = yield* Effect.currentSpan;
        const inside = yield* Effect.currentSpan.pipe(
          Effect.withSpan("mend.test.poll"),
          detachTrace,
        );
        const outside = yield* Effect.option(Effect.currentParentSpan).pipe(detachTrace);
        return { request, inside, outside };
      }).pipe(Effect.withSpan("mend.test.request")),
    );
    expect(result.inside.traceId).not.toBe(result.request.traceId);
    expect(Option.isNone(result.inside.parent)).toBe(true);
    expect(Option.isNone(result.outside)).toBe(true);
  });

  it("links every trace detached work starts to the span it was started from", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const launch = yield* Effect.currentSpan;
        const detached = Effect.gen(function* () {
          const step = yield* Effect.currentSpan.pipe(Effect.withSpan("mend.test.step"));
          const unit = yield* Effect.currentSpan.pipe(inOwnTrace("mend.test.unit"));
          const child = yield* Effect.currentSpan.pipe(
            Effect.withSpan("mend.test.child"),
            Effect.withSpan("mend.test.parent"),
          );
          return { step, unit, child };
        }).pipe(detachTrace);
        return { launch, ...(yield* detached) };
      }).pipe(
        Effect.withSpan("mend.test.launch"),
        Effect.withTracer(linkingRoots(Tracer.nativeTracer)),
      ),
    );
    expect(result.step.traceId).not.toBe(result.launch.traceId);
    expect(result.step.links.map((link) => link.span.spanId)).toEqual([result.launch.spanId]);
    expect(result.unit.links.map((link) => link.span.spanId)).toEqual([result.launch.spanId]);
    // Only a trace's first span carries the link; its children are in that trace.
    expect(result.child.links).toEqual([]);
  });

  it("links nothing to a disabled span", () => {
    const noop = Tracer.externalSpan({ traceId: "noop", spanId: "noop", sampled: false });
    expect(isTraceable(noop)).toBe(false);
  });
});
