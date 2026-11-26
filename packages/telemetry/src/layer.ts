import { Config, Duration, Effect, Layer, Logger, Option, Tracer } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { OtlpExporter, OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

import { enrichingSerialization } from "./enrich.ts";
import { ErrorReporter, makeSentryReporter, type SentryReporterOptions } from "./errors.ts";
import { scrubbingSerialization } from "./scrub.ts";
import { type TelemetrySettings, TelemetrySettingsError, telemetrySettings } from "./settings.ts";

export interface TelemetryService {
  /** `service.name` on every span and log, and the `service` tag on every error. */
  readonly name: string;
  /** The release when `SENTRY_RELEASE` names none, `<sentry project>@<version>`, e.g. `mend-server@0.40.0` (never a
   * scoped npm name: Sentry drops a release with a `/` in it). */
  readonly release?: string | undefined;
}

/** At most this long at shutdown, inside the API's five-second deadline (main.ts). */
const SHUTDOWN_FLUSH = Duration.seconds(2);
/** An export that has not answered by now is given up, and its batch dropped with it. */
const EXPORT_TIMEOUT = Duration.seconds(10);

const jsonSerialization: OtlpSerialization.OtlpSerialization["Service"] = {
  traces: (data) => HttpBody.jsonUnsafe(data),
  metrics: (data) => HttpBody.jsonUnsafe(data),
  logs: (data) => HttpBody.jsonUnsafe(data),
};

/** Root spans sampled at `rate`; a span with a parent keeps the parent's decision. */
export const sampledRoots =
  (rate: number) =>
  (tracer: Tracer.Tracer): Tracer.Tracer =>
    rate >= 1
      ? tracer
      : Tracer.make({
          span: (options) =>
            tracer.span(
              Option.isNone(options.parent) && options.sampled
                ? { ...options, sampled: Math.random() < rate }
                : options,
            ),
          ...(tracer.context === undefined ? {} : { context: tracer.context }),
        });

/**
 * Spans a library opens around a single call of its own, which say nothing their one child does
 * not: drizzle's `drizzle.operation` around each insert's query, and the sealant SDK's
 * `sealant.sdk.<group>.<endpoint>` around each request it sends, inside the Mend span that made
 * the call (`mend.sealant — create workspace`) and around the request's own `http.client` span.
 * Their children hang off the span above instead, and what they record lands on it.
 */
const isWrapperSpan = (name: string): boolean =>
  name === "drizzle.operation" || name.startsWith("sealant.sdk.");

/**
 * What a wrapper says about itself, which is not its parent's to take: the sealant SDK (0.40.0-next.951
 * on) names its span's operation and description, and its own name, for Sentry.
 */
const WRAPPER_OWN = new Set(["sentry.op", "sentry.description", "code.function.name"]);

/**
 * A span that is its parent: its children are its parent's, and its attributes (the SDK's
 * workspace and run IDs) are set on the parent when that is a span of this process, all but what
 * describes the wrapper itself (`WRAPPER_OWN`), so the parent keeps its own operation and words.
 */
const parentAsSpan = (
  parent: Tracer.AnySpan,
  options: Parameters<Tracer.Tracer["span"]>[0],
): Tracer.Span => ({
  _tag: "Span",
  name: options.name,
  spanId: parent.spanId,
  traceId: parent.traceId,
  parent: parent._tag === "Span" ? parent.parent : Option.none(),
  annotations: options.annotations,
  status: { _tag: "Started", startTime: options.startTime },
  attributes: new Map(),
  links: [],
  sampled: parent.sampled,
  kind: options.kind,
  end: () => undefined,
  attribute: (key, value) => {
    if (WRAPPER_OWN.has(key)) return;
    if (parent._tag === "Span" && parent.status._tag === "Started") parent.attribute(key, value);
  },
  event: () => undefined,
  addLinks: () => undefined,
});

/** `tracer` without wrapper spans (`isWrapperSpan`): each becomes its parent. */
export const withoutWrapperSpans = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) =>
      isWrapperSpan(options.name) && Option.isSome(options.parent)
        ? parentAsSpan(options.parent.value, options)
        : tracer.span(options),
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
  });

/** Everything that drains at shutdown, for the signal handler that cannot wait for finalizers. */
const flushes = new Set<(timeoutMillis: number) => Promise<void>>();

/**
 * Send what is buffered, for at most `timeoutMillis`. The API calls it on SIGTERM, before its
 * forced exit: a finalizer that wedges would otherwise take the last spans and errors with it.
 */
export const flushTelemetry = async (timeoutMillis = 2_000): Promise<void> => {
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMillis).unref();
  });
  await Promise.race([
    Promise.all([...flushes].map((flush) => flush(timeoutMillis))).then(() => undefined),
    deadline,
  ]);
};

/**
 * The exporters' own client over a `fetch` that gives up after `EXPORT_TIMEOUT`: an export that
 * hangs would otherwise hold its batch, and the next, for as long as the collector does.
 */
const exporterClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
      fetch(input, {
        ...init,
        signal:
          init?.signal === undefined || init.signal === null
            ? AbortSignal.timeout(Duration.toMillis(EXPORT_TIMEOUT))
            : AbortSignal.any([
                init.signal,
                AbortSignal.timeout(Duration.toMillis(EXPORT_TIMEOUT)),
              ]),
      }),
    ),
  ),
);

/** Where telemetry leaves the process: replaced in tests, which read what would have been sent. */
export interface TelemetryTransports {
  readonly otlp: Layer.Layer<HttpClient.HttpClient>;
  readonly sentry?: SentryReporterOptions["transport"];
}

/** Telemetry for `settings`, on: the layer `telemetryLayer` gives a process with a DSN. */
export const enabledTelemetryLayer = (
  settings: TelemetrySettings,
  service: TelemetryService,
  transports: TelemetryTransports = { otlp: exporterClient },
): Layer.Layer<never> => {
  const resource = {
    serviceName: service.name,
    ...(settings.release === undefined ? {} : { serviceVersion: settings.release }),
    attributes: {
      "deployment.environment.name": settings.environment,
      "sentry.environment": settings.environment,
      ...(settings.release === undefined ? {} : { "sentry.release": settings.release }),
    },
  };
  const shared = {
    resource,
    headers: settings.otlp.headers,
    shutdownTimeout: SHUTDOWN_FLUSH,
  };
  const tracer = Layer.effect(
    Tracer.Tracer,
    Effect.map(OtlpTracer.make({ ...shared, url: `${settings.otlp.baseUrl}/v1/traces` }), (otlp) =>
      withoutWrapperSpans(sampledRoots(settings.tracesSampleRate)(otlp)),
    ),
  );
  const logger = Logger.layer(
    [OtlpLogger.make({ ...shared, url: `${settings.otlp.baseUrl}/v1/logs` })],
    { mergeWithExisting: true },
  );
  const reporter = makeSentryReporter({
    settings,
    service: service.name,
    ...(transports.sentry === undefined ? {} : { transport: transports.sentry }),
  });
  const flushOnSignal = Layer.effectDiscard(
    Effect.gen(function* () {
      const flusher = yield* OtlpExporter.Flusher;
      const context = yield* Effect.context();
      const flush = (timeoutMillis: number) =>
        Promise.all([
          Effect.runPromiseWith(context)(
            flusher.flush.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis))),
          ),
          reporter.flush(timeoutMillis),
        ]).then(
          () => undefined,
          () => undefined,
        );
      flushes.add(flush);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => reporter.flush(Duration.toMillis(SHUTDOWN_FLUSH))).pipe(
          Effect.ensuring(Effect.sync(() => flushes.delete(flush))),
        ),
      );
    }),
  );
  return Layer.mergeAll(tracer, logger, flushOnSignal, Layer.succeed(ErrorReporter, reporter)).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(
      Layer.succeed(
        OtlpSerialization.OtlpSerialization,
        enrichingSerialization(scrubbingSerialization(jsonSerialization)),
      ),
    ),
    Layer.provide(transports.otlp),
  );
};

const read = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined));

/**
 * Traces and logs over OTLP and errors to Sentry for this process, or nothing at all when it has
 * no `SENTRY_DSN`: no client, no exporter, no network call. Provide it beneath everything else,
 * so every layer above builds with its tracer, its logger and its `ErrorReporter`.
 *
 * Telemetry never stops a server: a DSN that is not one is logged and leaves telemetry off.
 */
export const telemetryLayer = (service: TelemetryService): Layer.Layer<never, Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const environment = yield* Config.all({
        SENTRY_DSN: read("SENTRY_DSN"),
        SENTRY_ENVIRONMENT: read("SENTRY_ENVIRONMENT"),
        SENTRY_RELEASE: read("SENTRY_RELEASE"),
        SENTRY_TRACES_SAMPLE_RATE: read("SENTRY_TRACES_SAMPLE_RATE"),
        OTEL_EXPORTER_OTLP_ENDPOINT: read("OTEL_EXPORTER_OTLP_ENDPOINT"),
        OTEL_EXPORTER_OTLP_HEADERS: read("OTEL_EXPORTER_OTLP_HEADERS"),
      });
      let settings: TelemetrySettings | null;
      try {
        settings = telemetrySettings(environment, { release: service.release });
      } catch (error) {
        if (!(error instanceof TelemetrySettingsError)) throw error;
        yield* Effect.logWarning(`${error.message}: telemetry is off`);
        return Layer.empty;
      }
      if (settings === null) return Layer.empty;
      yield* Effect.logInfo("telemetry on").pipe(
        Effect.annotateLogs({
          service: service.name,
          environment: settings.environment,
          release: settings.release ?? "none",
          tracesSampleRate: settings.tracesSampleRate,
        }),
      );
      return enabledTelemetryLayer(settings, service);
    }),
  );
