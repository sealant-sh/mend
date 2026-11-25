import {
  applySdkMetadata,
  type BaseTransportOptions,
  createStackParser,
  createTransport,
  type ErrorEvent,
  linkedErrorsIntegration,
  Scope,
  type StackFrame,
  type Transport,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";
import { Cause, Context, Effect, Option, type Tracer } from "effect";

import { scrubText } from "./scrub.ts";
import type { TelemetrySettings } from "./settings.ts";

/** What a reported failure was doing, for grouping and search. IDs and enums only. */
export interface ErrorReport {
  /** Where it was caught, low cardinality: `http.request`, `mend.session.start`, `job:<queue>`. */
  readonly operation: string;
  readonly tags?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface ErrorReporterShape {
  readonly capture: (
    cause: Cause.Cause<unknown>,
    report: ErrorReport,
    span: Tracer.AnySpan | undefined,
  ) => void;
  /** Resolves once queued events are sent, or after `timeoutMillis`. Never rejects. */
  readonly flush: (timeoutMillis: number) => Promise<void>;
}

const disabledReporter: ErrorReporterShape = {
  capture: () => undefined,
  flush: () => Promise.resolve(),
};

/**
 * Where errors go: Sentry when the process has a DSN (`telemetryLayer` provides it), nowhere
 * otherwise. A reference, so code anywhere reports through `reportCause` without a requirement in
 * its type, and a test or a process without telemetry reports to nothing.
 */
export const ErrorReporter = Context.Reference<ErrorReporterShape>(
  "@mend/telemetry/ErrorReporter",
  { defaultValue: () => disabledReporter },
);

/**
 * Report `cause` once, with the current span, so Sentry links the error to its trace. Call it at
 * an error boundary, where a failure stops being handled. An interruption alone is not a failure
 * and is not reported.
 */
export const reportCause = (
  cause: Cause.Cause<unknown>,
  report: ErrorReport,
): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Effect.gen(function* () {
        const span = yield* Effect.option(Effect.currentParentSpan);
        const reporter = yield* ErrorReporter;
        reporter.capture(cause, report, Option.getOrUndefined(span));
      });

/**
 * A frame as it reads in Sentry: `app:///main.js` for a bundle in a `dist` directory, matching the
 * source maps CI uploads under that prefix; the last two segments of anything else. Neither keeps
 * the directory the server runs from, which can name a person's home.
 */
export const frameFilename = (filename: string): string => {
  const path = filename.replace(/^file:\/\//, "").replaceAll("\\", "/");
  const dist = path.lastIndexOf("/dist/");
  if (dist !== -1) return `app:///${path.slice(dist + "/dist/".length)}`;
  if (path.startsWith("node:") || !path.includes("/")) return path;
  const segments = path.split("/").filter(Boolean);
  // A bundle copied out of its dist, as the gateway's is into its own root (`/app/bin.js`).
  if (/\.m?js$/.test(path) && !segments.includes("node_modules"))
    return `app:///${segments.at(-1)}`;
  return `app:///${segments.slice(-2).join("/")}`;
};

const scrubFrame = (frame: StackFrame): StackFrame => {
  const {
    vars: _vars,
    pre_context: _pre,
    context_line: _line,
    post_context: _post,
    ...kept
  } = frame;
  return {
    ...kept,
    ...(frame.filename === undefined ? {} : { filename: frameFilename(frame.filename) }),
    ...(frame.abs_path === undefined ? {} : { abs_path: frameFilename(frame.abs_path) }),
    ...(frame.module === undefined ? {} : { module: scrubText(frame.module) }),
  };
};

/**
 * The event as it may leave the process: exception text scrubbed, frames without local paths or
 * source, and nothing about the request, the person, the host or the environment.
 */
export const scrubEvent = (event: ErrorEvent): ErrorEvent => {
  const {
    request: _request,
    user: _user,
    server_name: _server,
    breadcrumbs: _breadcrumbs,
    extra: _extra,
    modules: _modules,
    ...kept
  } = event;
  return {
    ...kept,
    ...(event.message === undefined ? {} : { message: scrubText(event.message) }),
    ...(event.contexts === undefined
      ? {}
      : {
          contexts: Object.fromEntries(
            Object.entries(event.contexts).filter(([name]) =>
              ["trace", "runtime", "mend"].includes(name),
            ),
          ),
        }),
    ...(event.exception?.values === undefined
      ? {}
      : {
          exception: {
            values: event.exception.values.map((exception) => ({
              ...exception,
              ...(exception.value === undefined ? {} : { value: scrubText(exception.value) }),
              ...(exception.stacktrace?.frames === undefined
                ? {}
                : {
                    stacktrace: {
                      ...exception.stacktrace,
                      frames: exception.stacktrace.frames.map(scrubFrame),
                    },
                  }),
            })),
          },
        }),
  };
};

const REQUEST_TIMEOUT_MILLIS = 5_000;

/** Sentry's envelopes over `fetch`: a bounded buffer, no retries, a request that gives up. */
const fetchTransport = (options: BaseTransportOptions): Transport =>
  createTransport({ ...options, bufferSize: 30 }, async (request) => {
    const response = await fetch(options.url, {
      method: "POST",
      body: typeof request.body === "string" ? request.body : new Uint8Array(request.body),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    });
    await response.arrayBuffer().catch(() => undefined);
    return {
      statusCode: response.status,
      headers: {
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
        "retry-after": response.headers.get("retry-after"),
      },
    };
  });

/** The error (or the defect) a cause reports: the first that is not an interruption. */
const errorOf = (cause: Cause.Cause<unknown>): Error | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isDieReason(reason) && reason.defect instanceof Error) return reason.defect;
    if (Cause.isFailReason(reason) && reason.error instanceof Error) return reason.error;
  }
  return Cause.prettyErrors(cause)[0];
};

export interface SentryReporterOptions {
  readonly settings: TelemetrySettings;
  /** What every event carries: the process's service (`mend-api`, `mend-t3-gateway`). */
  readonly service: string;
  /** Replaces the network, for tests. */
  readonly transport?: (options: BaseTransportOptions) => Transport;
}

/** Errors-only Sentry: no tracing of its own (Effect's spans are exported over OTLP), no PII. */
export const makeSentryReporter = (options: SentryReporterOptions): ErrorReporterShape => {
  const clientOptions: ServerRuntimeClientOptions = {
    dsn: options.settings.dsn,
    environment: options.settings.environment,
    ...(options.settings.release === undefined ? {} : { release: options.settings.release }),
    // v11's `sendDefaultPii: false`: nothing about the person, the request or the code's state.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations: [linkedErrorsIntegration()],
    stackParser: createStackParser(nodeStackLineParser()),
    transport: options.transport ?? fetchTransport,
    platform: "node",
    runtime: { name: "node", version: process.version },
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  };
  // Names the SDK on every event; a bare core client sends none without it.
  applySdkMetadata(clientOptions, "mend-telemetry", ["core"], "npm");
  const client = new ServerRuntimeClient(clientOptions);
  client.init();
  return {
    capture: (cause, report, span) => {
      try {
        const error = errorOf(cause);
        if (error === undefined) return;
        const scope = new Scope();
        scope.setClient(client);
        scope.setTags({ service: options.service, operation: report.operation, ...report.tags });
        if (span !== undefined) {
          const trace = { trace_id: span.traceId.padStart(32, "0"), span_id: span.spanId };
          // After the scope's own trace context, which names a trace of Sentry's own making.
          scope.addEventProcessor((event) => ({
            ...event,
            contexts: { ...event.contexts, trace },
          }));
        }
        client.captureException(
          error,
          { mechanism: { type: "mend.error_boundary", handled: false } },
          scope,
        );
      } catch {
        // Reporting never fails the work it reports on.
      }
    },
    flush: (timeoutMillis) =>
      Promise.resolve(client.flush(timeoutMillis)).then(
        () => undefined,
        () => undefined,
      ),
  };
};
