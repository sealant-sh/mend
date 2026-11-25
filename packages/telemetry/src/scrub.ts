import { redactDetail } from "@mend/network";
import type { OtlpLogger, OtlpResource, OtlpSerialization, OtlpTracer } from "effect/observability";

/**
 * What may leave the process in a span or a log record (SLNT-1349, "Privacy"). Every OTLP payload
 * passes here, beneath the exporters, on its way to the wire: span and event names, status
 * messages, attribute values and log bodies are scrubbed by `redactDetail` (credentials, tokens,
 * server paths, internal hosts, URL queries); values under keys that carry content (a response
 * body, a command's output, a prompt) are dropped whole.
 *
 * Trace and span IDs travel in their own fields (`traceId`, `spanId`, `parentSpanId`, a link's
 * IDs), which this never reads: `redactDetail` shortens any 32-character hex word, and a trace ID
 * is one. An attribute naming an ID (`mend.session_id`, `sessionId`) keeps its value when the value
 * has an ID's shape, for the same reason.
 */

/** Keys whose values are content, not diagnostics: dropped whatever they hold. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "body",
  "commands",
  "content",
  "diff",
  "files",
  "input",
  "output",
  "paths",
  "prompt",
  "said",
  "stderr",
  "stdout",
  "summary",
  "text",
  "url.query",
  "words",
]);

const OMITTED = "<omitted>";

/** `mend.session_id`, `sealant.job_id`, `sessionId`, `providerTurnId`: a key that names an ID. */
const ID_KEY = /(?:^|[._])id$|[a-z]Id$/;
/** What an ID looks like: no spaces, no slashes, short. */
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** `text` as it may leave the process. */
export const scrubText = (text: string): string => redactDetail(text);

type AnyValue = OtlpResource.AnyValue;
type KeyValue = OtlpResource.KeyValue;

const scrubValue = (value: AnyValue): AnyValue => {
  if (typeof value.stringValue === "string")
    return { ...value, stringValue: scrubText(value.stringValue) };
  if (value.arrayValue !== undefined)
    return { ...value, arrayValue: { values: value.arrayValue.values.map(scrubValue) } };
  if (value.kvlistValue !== undefined)
    return { ...value, kvlistValue: { values: scrubAttributes(value.kvlistValue.values) } };
  if (value.bytesValue !== undefined) return { stringValue: OMITTED };
  return value;
};

const scrubAttribute = ({ key, value }: KeyValue): KeyValue => {
  if (CONTENT_KEYS.has(key)) return { key, value: { stringValue: OMITTED } };
  if (ID_KEY.test(key) && typeof value.stringValue === "string" && ID_VALUE.test(value.stringValue))
    return { key, value };
  return { key, value: scrubValue(value) };
};

export const scrubAttributes = (attributes: ReadonlyArray<KeyValue>): Array<KeyValue> =>
  attributes.map(scrubAttribute);

type Span = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

const scrubSpan = (span: Span): Span => ({
  ...span,
  name: scrubText(span.name),
  attributes: scrubAttributes(span.attributes),
  events: span.events.map((event) => ({
    ...event,
    name: scrubText(event.name),
    attributes: scrubAttributes(event.attributes),
  })),
  status:
    span.status.message === undefined
      ? span.status
      : { ...span.status, message: scrubText(span.status.message) },
  links: span.links.map((link) => ({ ...link, attributes: scrubAttributes(link.attributes) })),
});

export const scrubTraces = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
  resourceSpans: data.resourceSpans.map((resource) => ({
    ...resource,
    scopeSpans: resource.scopeSpans.map((scope) => ({
      ...scope,
      spans: scope.spans.map(scrubSpan),
    })),
  })),
});

type LogRecord = NonNullable<
  OtlpLogger.LogsData["resourceLogs"][number]["scopeLogs"][number]["logRecords"]
>[number];

const scrubLogRecord = (record: LogRecord): LogRecord => ({
  ...record,
  ...(record.body === undefined ? {} : { body: scrubValue(record.body) }),
  attributes: scrubAttributes(record.attributes),
});

export const scrubLogs = (data: OtlpLogger.LogsData): OtlpLogger.LogsData => ({
  resourceLogs: data.resourceLogs.map((resource) => ({
    ...resource,
    scopeLogs: resource.scopeLogs.map((scope) => ({
      ...scope,
      ...(scope.logRecords === undefined
        ? {}
        : { logRecords: scope.logRecords.map(scrubLogRecord) }),
    })),
  })),
});

/** `inner`, handed only scrubbed payloads. Mend exports no metrics; those pass as they are. */
export const scrubbingSerialization = (
  inner: OtlpSerialization.OtlpSerialization["Service"],
): OtlpSerialization.OtlpSerialization["Service"] => ({
  traces: (data) => inner.traces(scrubTraces(data)),
  logs: (data) => inner.logs(scrubLogs(data)),
  metrics: (data) => inner.metrics(data),
});
