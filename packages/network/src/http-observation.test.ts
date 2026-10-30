import { Cause, Effect, Exit, Layer, Logger, Option, Tracer } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { observedWebHandler } from "./http-observation.ts";

const SENTINEL = "SENTINEL-7731";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

interface LogLine {
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

const harness = () => {
  const logs: Array<string> = [];
  const spans: Array<Tracer.Span> = [];
  const slowStarted = Promise.withResolvers<void>();
  const routes = HttpRouter.use((router) =>
    Effect.all([
      router.add(
        "GET",
        "/future/:id",
        Effect.succeed(HttpServerResponse.text("seen")).pipe(Effect.withSpan("handler")),
      ),
      router.add("POST", "/future/:id/refuse", HttpServerResponse.empty({ status: 403 })),
      router.add("GET", "/future/:id/broken", Effect.die(new Error(`broken at ${SENTINEL}`))),
      router.add(
        "GET",
        "/future/:id/internal",
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          Effect.fail(
            new HttpServerError.HttpServerError({
              reason: new HttpServerError.InternalError({ request }),
            }),
          ),
        ),
      ),
      router.add(
        "GET",
        "/future/:id/slow",
        Effect.andThen(
          Effect.sync(() => slowStarted.resolve()),
          Effect.never,
        ),
      ),
      router.add("GET", "/quiet/:id", HttpServerResponse.text("quiet")),
    ]),
  );
  const refusedBeforeRouting = HttpRouter.middleware(
    (effect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        request.headers["x-refuse"] === undefined
          ? effect
          : Effect.succeed(HttpServerResponse.empty({ status: 429 })),
      ),
    { global: true },
  );
  const { handler, dispose } = observedWebHandler(
    Layer.mergeAll(routes, refusedBeforeRouting).pipe(
      Layer.provideMerge(
        Layer.succeed(
          Tracer.Tracer,
          Tracer.make({
            span(options) {
              const span = Tracer.nativeTracer.span(options);
              spans.push(span);
              return span;
            },
          }),
        ),
      ),
      Layer.provideMerge(
        Logger.layer([Logger.make((entry) => logs.push(String(Logger.formatJson.log(entry))))]),
      ),
    ),
    { unobserved: (request) => request.url.startsWith("/quiet/") },
  );
  const send = (method: string, path: string, init: RequestInit = {}) =>
    handler(new Request(`http://mend.internal${path}`, { method, ...init }));
  return { logs, spans, send, started: slowStarted.promise, dispose };
};

const lines = (logs: ReadonlyArray<string>): ReadonlyArray<LogLine> =>
  logs.map((line) => JSON.parse(line));

const observed = (logs: ReadonlyArray<string>) =>
  lines(logs).map(({ annotations }) => ({
    method: annotations["http.method"],
    route: annotations["http.route"],
    status: annotations["http.status"],
  }));

const serverSpans = (spans: ReadonlyArray<Tracer.Span>) => spans.filter((s) => s.kind === "server");

const spanOutcome = (span: Tracer.Span) => ({
  method: span.attributes.get("http.request.method"),
  route: span.attributes.get("http.route"),
  status: span.attributes.get("http.response.status_code"),
});

const recorded = (spans: ReadonlyArray<Tracer.Span>) =>
  JSON.stringify(
    spans.map((span) => [
      span.name,
      [...span.attributes],
      span instanceof Tracer.NativeSpan ? span.events : [],
      span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
        ? Cause.pretty(span.status.exit.cause)
        : null,
    ]),
  );

const settled = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("what a request leaves in the log and the trace", () => {
  it("one observation per request, with its method, its route's template and its status", async () => {
    const { logs, spans, send, started, dispose } = harness();
    try {
      const statuses = [
        (await send("GET", `/future/${SENTINEL}?token=${SENTINEL}#${SENTINEL}`)).status,
        (await send("POST", `/future/${SENTINEL}/refuse`)).status,
        (await send("GET", `/nowhere/${SENTINEL}?code=${SENTINEL}`)).status,
        (await send("GET", `/future/${SENTINEL}`, { headers: { "x-refuse": "1" } })).status,
        (await send("GET", `/future/${SENTINEL}/broken`)).status,
        (await send("GET", `/future/${SENTINEL}/internal`)).status,
      ];
      expect(statuses).toEqual([200, 403, 404, 429, 500, 500]);
      const aborting = new AbortController();
      const slow = send("GET", `/future/${SENTINEL}/slow`, { signal: aborting.signal }).catch(
        () => null,
      );
      await started;
      aborting.abort();
      await slow;
      await settled(() => logs.length >= 7);
      const expected = [
        { method: "GET", route: "/future/:id", status: 200 },
        { method: "POST", route: "/future/:id/refuse", status: 403 },
        { method: "GET", route: "unrouted", status: 404 },
        { method: "GET", route: "unrouted", status: 429 },
        { method: "GET", route: "/future/:id/broken", status: 500 },
        { method: "GET", route: "/future/:id/internal", status: 500 },
        { method: "GET", route: "/future/:id/slow", status: "aborted" },
      ];
      expect(observed(logs)).toEqual(expected);
      expect(serverSpans(spans).map(spanOutcome)).toEqual(
        expected.map((outcome) => ({
          ...outcome,
          status: outcome.status === "aborted" ? undefined : outcome.status,
        })),
      );
    } finally {
      await dispose();
    }
  });

  it("holds no part of a URL a route does not name, whatever the route or its parameter is called", async () => {
    const { logs, spans, send, started, dispose } = harness();
    try {
      await send("GET", `/future/${SENTINEL}?token=${SENTINEL}`);
      await send("POST", `/future/${SENTINEL}/refuse`);
      await send("GET", `/nowhere/${SENTINEL}/${SENTINEL}?x=${SENTINEL}`);
      await send("GET", `/future/${SENTINEL}/broken`);
      await send("GET", `/future/${SENTINEL}/internal`);
      const aborting = new AbortController();
      const slow = send("GET", `/future/${SENTINEL}/slow`, { signal: aborting.signal }).catch(
        () => null,
      );
      await started;
      aborting.abort();
      await slow;
      await settled(() => logs.length >= 6);
      expect(logs).toHaveLength(6);
      expect(serverSpans(spans)).toHaveLength(6);
      expect(logs.filter((line) => line.includes(SENTINEL))).toEqual([]);
      expect(recorded(spans)).not.toContain(SENTINEL);
    } finally {
      await dispose();
    }
  });

  it("fails a span only for a 5xx or an abort, with a bounded reason and never the request", async () => {
    const { spans, send, started, dispose } = harness();
    try {
      await send("GET", `/future/${SENTINEL}`);
      await send("GET", `/nowhere/${SENTINEL}`);
      await send("GET", `/future/${SENTINEL}/broken`);
      await send("GET", `/future/${SENTINEL}/internal`);
      const aborting = new AbortController();
      const slow = send("GET", `/future/${SENTINEL}/slow`, { signal: aborting.signal }).catch(
        () => null,
      );
      await started;
      aborting.abort();
      await slow;
      await settled(() => serverSpans(spans).every((span) => span.status._tag === "Ended"));
      expect(
        serverSpans(spans).map((span) =>
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.pretty(span.status.exit.cause).split("\n")[0]
            : "ok",
        ),
      ).toEqual([
        "ok",
        "ok",
        "HttpRequestFailed: status 500",
        "HttpRequestFailed: status 500",
        "HttpRequestFailed: aborted",
      ]);
    } finally {
      await dispose();
    }
  });

  it("parents its span on the caller's trace, and the handler's spans on it", async () => {
    const { spans, send, dispose } = harness();
    try {
      await send("GET", `/future/${SENTINEL}`, {
        headers: { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
      });
      const [server] = serverSpans(spans);
      const child = spans.find((span) => span.name === "handler");
      expect(server?.traceId).toBe(TRACE_ID);
      expect(Option.map(server?.parent ?? Option.none(), (parent) => parent.spanId)).toEqual(
        Option.some("00f067aa0ba902b7"),
      );
      expect(Option.map(child?.parent ?? Option.none(), (parent) => parent.spanId)).toEqual(
        Option.some(server?.spanId),
      );
    } finally {
      await dispose();
    }
  });

  it("leaves nothing for a request the policy leaves unobserved", async () => {
    const { logs, spans, send, dispose } = harness();
    try {
      expect((await send("GET", `/quiet/${SENTINEL}`)).status).toBe(200);
      expect(logs).toEqual([]);
      expect(serverSpans(spans)).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
