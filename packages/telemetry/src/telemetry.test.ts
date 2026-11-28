import { observedWebHandler } from "@mend/network/http-observation";
import { createTransport } from "@sentry/core";
import { Cause, ConfigProvider, Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { frameFilename, reportCause } from "./errors.ts";
import { enabledTelemetryLayer, telemetryLayer } from "./layer.ts";
import { telemetrySettings } from "./settings.ts";

/** A secret in the shapes Mend handles: a provider token, a named password, a bearer. */
const CANARY = "sk-canary4f1d9c2e7b30aa";
const CANARY_PASSWORD = "canary-hunter2-0451";
const DSN = "https://0123456789abcdef0123456789abcdef@sentry.example.test/3";

const decoder = new TextDecoder();
const textOf = (body: string | Uint8Array): string =>
  typeof body === "string" ? body : decoder.decode(body);

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Everything the exporters and the Sentry client hand to their transports. */
const capturingTransports = () => {
  const otlp: Array<Sent> = [];
  const sentry: Array<string> = [];
  const client = HttpClient.make((request) => {
    const body = request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "";
    otlp.push({ url: request.url, headers: { ...request.headers }, body });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
  });
  return {
    otlp,
    sentry,
    transports: {
      otlp: Layer.succeed(HttpClient.HttpClient, client),
      sentry: (options: Parameters<typeof createTransport>[0]) =>
        createTransport(options, (request) => {
          sentry.push(textOf(request.body));
          return Promise.resolve({ statusCode: 200 });
        }),
    },
  };
};

interface ExportedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: ReadonlyArray<{
    readonly key: string;
    readonly value: { readonly stringValue?: string };
  }>;
}

const attribute = (span: ExportedSpan | undefined, key: string) =>
  span?.attributes.find((a) => a.key === key)?.value.stringValue;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEND_TELEMETRY_CANARY;
});

describe("what telemetry may send", () => {
  it("never hands a planted secret to a transport, and keeps the trace an error belongs to", async () => {
    process.env.MEND_TELEMETRY_CANARY = CANARY;
    const settings = telemetrySettings({ SENTRY_DSN: DSN, SENTRY_RELEASE: "mend-server@1.2.3" });
    if (settings === null) throw new Error("expected settings");
    const { otlp, sentry, transports } = capturingTransports();
    const work = Effect.gen(function* () {
      yield* Effect.logWarning(`upstream said token=${CANARY} and password=${CANARY_PASSWORD}`);
      yield* Effect.annotateCurrentSpan("note", `Authorization: Bearer ${CANARY}`);
      return yield* Effect.die(
        new Error(`git push failed for https://x:${CANARY}@github.com/o/r?token=${CANARY}`),
      );
    }).pipe(Effect.withSpan("mend.test.work", { attributes: { "mend.session_id": "ses_01J9Z" } }));
    const routes = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/things/:id",
        work.pipe(
          Effect.catchCause((cause) =>
            reportCause(cause, { operation: "http.request" }).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
          ),
        ),
      ),
    );
    const { handler, dispose } = observedWebHandler(
      routes.pipe(
        Layer.provideMerge(enabledTelemetryLayer(settings, { name: "mend-test" }, transports)),
      ),
    );
    const response = await handler(
      new Request(`http://mend.internal/things/${CANARY}?token=${CANARY}`, {
        headers: { authorization: `Bearer ${CANARY}`, cookie: `session=${CANARY}` },
      }),
    );
    expect(response.status).toBe(500);
    await dispose();

    const sent = [...otlp.map((request) => request.body), ...sentry].join("\n");
    expect(otlp.map((request) => new URL(request.url).pathname).toSorted()).toEqual([
      "/api/3/integration/otlp/v1/logs",
      "/api/3/integration/otlp/v1/traces",
    ]);
    expect(otlp[0]?.headers["x-sentry-auth"]).toBe(
      "sentry sentry_key=0123456789abcdef0123456789abcdef",
    );
    expect(sentry).toHaveLength(1);
    expect(sent).not.toContain(CANARY);
    expect(sent).not.toContain(CANARY_PASSWORD);
    expect(sent).not.toContain("canary4f1d9c2e7b30aa");

    const traces = otlp.find((request) => request.url.endsWith("/v1/traces"));
    const spans: ReadonlyArray<ExportedSpan> = JSON.parse(traces?.body ?? "{}").resourceSpans[0]
      .scopeSpans[0].spans;
    // Named for its route, never for the path it was asked for (the canary is in that path).
    const server = spans.find((span) => span.name === "GET /things/:id");
    const workSpan = spans.find((span) => span.name === "mend.test.work");
    expect(attribute(server, "http.route")).toBe("/things/:id");
    expect(attribute(server, "sentry.op")).toBe("http.server");
    expect(attribute(server, "sentry.description")).toBe("GET /things/:id");
    expect(attribute(workSpan, "sentry.op")).toBe("mend.test");
    expect(attribute(workSpan, "mend.session_id")).toBe("ses_01J9Z");

    // One envelope, one event: its header line, the item header, the event.
    const event = JSON.parse(sentry[0]?.split("\n")[2] ?? "{}");
    // Caught by the route, outside the work's span: the error belongs to the request's.
    expect(event.contexts.trace).toEqual({ trace_id: server?.traceId, span_id: server?.spanId });
    expect(workSpan?.traceId).toBe(server?.traceId);
    expect(server?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.release).toBe("mend-server@1.2.3");
    expect(event.tags).toMatchObject({ service: "mend-test", operation: "http.request" });
    expect(event.sdk).toMatchObject({ name: "sentry.javascript.mend-telemetry" });
    expect(event.request).toBeUndefined();
    expect(event.server_name).toBeUndefined();
  });

  it("never names a span for a sign-in code in a path, asked for or called", async () => {
    // Letters only, as a CLI sign-in's user code can be: no digit gives it away as an ID.
    const CODE = "QZXW-PLMK";
    const settings = telemetrySettings({ SENTRY_DSN: DSN });
    if (settings === null) throw new Error("expected settings");
    const { otlp, transports } = capturingTransports();
    // The API knows no such code: a lookup answers 404, which fails the call with its URL in the
    // message; a call that never reaches the API fails in transport, with its URL too.
    const api = HttpClient.make((request) =>
      request.url.includes("unreachable")
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "refused" }),
            }),
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", { status: request.method === "GET" ? 404 : 200 }),
            ),
          ),
    ).pipe(HttpClient.filterStatusOk);
    const routes = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/approve",
        Effect.gen(function* () {
          yield* api
            .get(`http://mend-api.internal/api/me/cli-auth/${CODE}?x=1`)
            .pipe(Effect.ignore);
          yield* api.get(`http://unreachable.internal/api/me/cli-auth/${CODE}`).pipe(Effect.ignore);
          yield* api.post(`http://mend-api.internal/api/me/cli-auth/${CODE}/approve`);
          return HttpServerResponse.empty();
        }).pipe(Effect.orDie),
      ),
    );
    const { handler, dispose } = observedWebHandler(
      routes.pipe(
        Layer.provideMerge(enabledTelemetryLayer(settings, { name: "mend-test" }, transports)),
      ),
    );
    expect((await handler(new Request("http://mend.internal/approve"))).status).toBe(204);
    // No route of this server: the request is named by its path, templated where it is observed.
    expect(
      (await handler(new Request(`http://mend.internal/api/me/cli-auth/${CODE}`))).status,
    ).toBe(404);
    await dispose();

    const sent = otlp.map((request) => request.body).join("\n");
    expect(sent).not.toContain(CODE);
    const traces = otlp.find((request) => request.url.endsWith("/v1/traces"));
    const names = JSON.parse(traces?.body ?? "{}").resourceSpans.flatMap(
      (resource: { scopeSpans: ReadonlyArray<{ spans: ReadonlyArray<ExportedSpan> }> }) =>
        resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "GET /approve",
        "GET /api/me/cli-auth/:secret",
        "GET /api/me/cli-auth/:code",
        "POST /api/me/cli-auth/:code/approve",
      ]),
    );
  });

  it("makes no network call, and builds no client, when the process has no DSN", async () => {
    const fetching = vi.spyOn(globalThis, "fetch");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logError("something failed");
        yield* reportCause(Cause.die(new Error("boom")), { operation: "test" });
      }).pipe(
        Effect.withSpan("mend.test.work"),
        Effect.provide(telemetryLayer({ name: "mend-test" })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    );
    expect(fetching).not.toHaveBeenCalled();
  });
});

describe("telemetry settings", () => {
  it("are off without a DSN", () => {
    expect(telemetrySettings({})).toBeNull();
    expect(telemetrySettings({ SENTRY_DSN: "  " })).toBeNull();
  });

  it("send traces and logs to the DSN's project over OTLP, at every trace by default", () => {
    expect(telemetrySettings({ SENTRY_DSN: DSN }, { release: "mend-server@0.40.0" })).toEqual({
      dsn: DSN,
      environment: "development",
      release: "mend-server@0.40.0",
      tracesSampleRate: 1,
      otlp: {
        baseUrl: "https://sentry.example.test/api/3/integration/otlp",
        headers: { "x-sentry-auth": "sentry sentry_key=0123456789abcdef0123456789abcdef" },
      },
    });
  });

  it("take a local collector and its headers instead, and SENTRY_* over the process's own", () => {
    expect(
      telemetrySettings(
        {
          SENTRY_DSN: DSN,
          SENTRY_ENVIRONMENT: "box",
          SENTRY_RELEASE: "mend@abc",
          SENTRY_TRACES_SAMPLE_RATE: "7",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/",
          OTEL_EXPORTER_OTLP_HEADERS: "x-a=1,x-b=a%20b",
        },
        { release: "mend-server@0.40.0" },
      ),
    ).toMatchObject({
      environment: "box",
      release: "mend@abc",
      tracesSampleRate: 1,
      otlp: { baseUrl: "http://127.0.0.1:4318", headers: { "x-a": "1", "x-b": "a b" } },
    });
  });

  it("refuse a DSN that is not one", () => {
    expect(() => telemetrySettings({ SENTRY_DSN: "sentry.mend.run/3" })).toThrow(
      /not a Sentry DSN/,
    );
  });
});

describe("stack frames", () => {
  it("name a bundle by its place in dist, and never the directory it runs from", () => {
    expect(frameFilename("file:///home/someone/mend/apps/api/dist/main.js")).toBe("app:///main.js");
    expect(frameFilename("/app/apps/t3-gateway/dist/bin.js")).toBe("app:///bin.js");
    expect(frameFilename("/app/bin.js")).toBe("app:///bin.js");
    expect(frameFilename("/home/someone/mend/packages/jobs/src/job-runner.ts")).toBe(
      "app:///src/job-runner.ts",
    );
    expect(frameFilename("node:internal/process/task_queues")).toBe(
      "node:internal/process/task_queues",
    );
  });
});
