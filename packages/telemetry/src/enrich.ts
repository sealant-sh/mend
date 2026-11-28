import { MEND_API_ROUTE_TEMPLATES } from "@mend/api-contracts/route-templates";
import { UNROUTED } from "@mend/network/http-observation";
import { pathOf, routeTemplates, templatePath } from "@mend/network/url-template";
import type { OtlpResource, OtlpSerialization, OtlpTracer } from "effect/observability";

import { LIBRARY_SPAN_NAMES, SPAN_NAMES } from "./span-names.ts";
import { summarizeSql } from "./sql-summary.ts";

/**
 * How Mend's spans read in Sentry (SLNT-1375). Sentry files an OTLP span under the operation in
 * its `sentry.op` attribute, else one it infers from a handful of OTel attributes
 * (`http.request.method`, `db.system.name`, `messaging.system`, `rpc.service`), else `default`;
 * and shows the description in `sentry.description`, else one it builds from those attributes,
 * else nothing. Effect's own spans (`Effect.fn`, `withSpan`) carry none of that, so this gives each
 * span the operation, the description and the name a person scanning a trace wants:
 *
 * - an HTTP server span: `GET /api/sessions/:id`, from its route template, or from its path
 *   templated when no route matched;
 * - an HTTP client span: `GET /v1/sessions/:sessionId/output`, the path with its IDs templated
 *   out, or the API route it matches (`GET /api/me/cli-auth/:code`), never the host, a port or the
 *   query;
 * - a database span: `select .. from agent_sessions where agent_sessions.id = $1 limit $2`, with
 *   its system, operation and table;
 * - a queue span: the queue's name, as `queue.publish` or `queue.process`;
 * - a procedure of the web tier: `mend.web.sessions.send_message`, described by its tRPC path
 *   `sessions.sendMessage`;
 * - anything else: the name and words `SPAN_NAMES` gives it (SLNT-1407): an
 *   `Effect.fn("SessionEngine.provision")` becomes `mend.session.provision`, filed under
 *   `mend.session`, described "record new session", and keeps its own name in
 *   `code.function.name`.
 *
 * It runs on the spans as Effect made them, before `scrub.ts` scrubs everything it wrote.
 */

type KeyValue = OtlpResource.KeyValue;
type Span = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

/** OTLP's span kinds, as Effect's exporter numbers them. */
const KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;

/**
 * The words Sentry's default scrubber (Relay's `@password:filter`) looks for in an attribute it
 * scrubs, `db.query.text` among them, replacing the whole value with `[Filtered]` when one
 * appears: so a query that names a column such as `author` or `git_auth_kind` loses its text.
 * `sentry.description` is not one it scrubs, so the description keeps the query; the attribute is
 * left out instead of arriving blank.
 */
const SENTRY_FILTERED =
  /password|secret|passwd|api[-_]key|apikey|auth|credentials|mysql_pwd|privatekey|private[-_]key|token\S*[:=]/i;

const stringOf = (attributes: ReadonlyArray<KeyValue>, key: string): string | undefined => {
  for (const attribute of attributes) {
    if (attribute.key === key) {
      const value = attribute.value;
      if (typeof value.stringValue === "string") return value.stringValue;
      if (value.intValue !== undefined) return String(value.intValue);
      return undefined;
    }
  }
  return undefined;
};

const has = (attributes: ReadonlyArray<KeyValue>, key: string): boolean =>
  attributes.some((attribute) => attribute.key === key);

/** `attributes` with each of `set` in place of any attribute of the same key. */
const withAttributes = (
  attributes: ReadonlyArray<KeyValue>,
  set: Readonly<Record<string, string | undefined>>,
  drop: ReadonlyArray<string> = [],
): Array<KeyValue> => {
  const written = Object.entries(set).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const replaced = new Set([...written.map(([key]) => key), ...drop]);
  return [
    ...attributes.filter((attribute) => !replaced.has(attribute.key)),
    ...written.map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
};

// --- Names ----------------------------------------------------------------------------------

/** `inboxRow` → `inbox_row`, `SessionEngine` → `session_engine`. */
const snake = (word: string): string =>
  word
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

/** `sessions.inboxRow` → `sessions.inbox_row`: each part of a dotted or slashed path. */
const snakeParts = (path: string): string =>
  path
    .split(/[./]/)
    .filter((part) => part !== "")
    .map(snake)
    .join(".");

/** `snake_case.words` as words: `deliver_skills` reads `deliver skills`. */
const words = (name: string): string => name.replace(/[._]+/g, " ").trim();

/** `Service.method`, the way `Effect.fn` spans are named; `SessionEngine.changingBoatKey.drain`. */
const SERVICE_METHOD = /^([A-Z][A-Za-z0-9]*)[. ]([A-Za-z][\w./]*)$/;
/** Already `<product>.<area>.<operation>`, lower-case words. */
const DOTTED = /^[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

interface Named {
  readonly name: string;
  readonly op: string;
  readonly description: string;
  readonly codeName?: string | undefined;
}

/** The operation a `<product>.<area>.<operation>` name files under. */
const opOf = (name: string): string => {
  if (name.startsWith("sealant.sdk.")) return "mend.sealant";
  const [product, area] = name.split(".");
  return area === undefined ? (product ?? name) : `${product}.${area}`;
};

/** An MCP method as an operation: `tools/call` → `call_tool`, `resources/list` → `list_resources`. */
const mcpOperation = (method: string): string => {
  const parts = method.split("/").map(snake);
  const verb = parts.at(-1) ?? "";
  const objects = parts.slice(0, -1);
  if (objects.length === 0) return verb;
  const object = objects.join("_");
  return `${verb}_${verb === "list" ? object : object.replace(/s$/, "")}`;
};

const renamed = (name: string, codeName: string, description?: string): Named => {
  const op = opOf(name);
  const rest = name.startsWith(`${op}.`) ? name.slice(op.length + 1) : name;
  return { name, op, description: description ?? words(rest), codeName };
};

/**
 * The name, operation and words of a span the code named `name`: its entry in `SPAN_NAMES`, every
 * span Mend's own code names; else, for the names libraries and routers make, the name they would
 * have there: a tRPC procedure `mend.web.sessions.inbox_row`, a gateway call
 * `mend.gateway.orchestration.get_snapshot`, an MCP call `mend.mcp.call_tool`.
 */
const nameOf = (name: string): Named => {
  const entry = Object.hasOwn(SPAN_NAMES, name)
    ? SPAN_NAMES[name]
    : Object.hasOwn(LIBRARY_SPAN_NAMES, name)
      ? LIBRARY_SPAN_NAMES[name]
      : undefined;
  if (entry !== undefined) {
    const [named, description] = entry;
    return { ...renamed(named, name, description), codeName: named === name ? undefined : name };
  }
  if (name.startsWith("Migrator ")) return renamed("mend.db.migrate", name, "migrate database");
  if (name.startsWith("mend.web.")) return renamed(`mend.web.${snakeParts(name.slice(9))}`, name);
  if (name.startsWith("mend.gateway.rpc."))
    return renamed(`mend.gateway.${snakeParts(name.slice(17))}`, name);
  if (name.startsWith("McpServer."))
    return renamed(`mend.mcp.${mcpOperation(name.slice(10))}`, name);
  if (name.startsWith("sealant.sdk."))
    return { name, op: "mend.sealant", description: words(name.split(".").slice(3).join(".")) };
  if (DOTTED.test(name)) return { ...renamed(name, name), codeName: undefined };
  const serviceMethod = SERVICE_METHOD.exec(name);
  if (serviceMethod !== null) {
    const [, service = "", method = ""] = serviceMethod;
    const area = snake(service.replace(/(?:Repo|Store|Service|Live)$/, ""));
    return renamed(`mend.${area}.${snakeParts(method)}`, name);
  }
  return { name, op: "function", description: words(name) || name };
};

/** Library spans that tell a reader nothing: an MCP server telling its client its tools changed. */
const isDropped = (span: Span): boolean => span.name.startsWith("McpServer/Notifications.");

// --- Spans ----------------------------------------------------------------------------------

interface Enriched {
  readonly name: string;
  readonly set: Readonly<Record<string, string | undefined>>;
  readonly drop?: ReadonlyArray<string>;
  /** Rewrites the span's own words: its status message and its events' attributes. */
  readonly rewrite?: ((text: string) => string) | undefined;
}

/** Mend's API's routes, for naming a call to it by its route (`/api/me/cli-auth/:code`). */
const API_ROUTES = routeTemplates(MEND_API_ROUTE_TEMPLATES);

/**
 * A request no route matched (`UNROUTED`) is named by its path, which the observation records only
 * then, and only templated (`url.template`).
 */
const httpServer = (span: Span, method: string): Enriched => {
  const route = stringOf(span.attributes, "http.route");
  const template =
    route !== undefined && route !== UNROUTED
      ? route
      : (stringOf(span.attributes, "url.template") ?? "/*");
  const description = `${method} ${template}`;
  return {
    name: description,
    set: { "sentry.op": "http.server", "sentry.description": description, "http.route": template },
  };
};

/** `url` with its path replaced by `template`, and no query or fragment. */
const withPath = (url: string | undefined, template: string): string | undefined => {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${template}`;
  } catch {
    return template;
  }
};

/** `text` with its percent-escapes read, as a caller that built the URL by hand may have spelled it. */
const decoded = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Named for its path's template; the URL it records keeps that template too, never the path it
 * called: an ID is no secret, but a sign-in code or a link's token in a path is. So do its words:
 * a call that failed ends with the URL in its status and its exception (`StatusCode error (404 GET
 * http://…/api/me/cli-auth/<code>)`), and each spelling of the path there, with any query after
 * it, becomes the template.
 */
const httpClient = (span: Span, method: string): Enriched => {
  const full = stringOf(span.attributes, "url.full");
  const rawPath = stringOf(span.attributes, "url.path");
  const path = pathOf(full) ?? pathOf(rawPath);
  const template = path === undefined ? undefined : templatePath(path, API_ROUTES);
  const description = template === undefined ? method : `${method} ${template}`;
  const spellings = [
    ...new Set(
      [path, rawPath, full?.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")]
        .flatMap((spelling) => [spelling, decoded(spelling)])
        .filter((spelling): spelling is string => spelling !== undefined && spelling.length > 1),
    ),
  ].toSorted((a, b) => b.length - a.length);
  const pattern =
    template === undefined || spellings.length === 0
      ? undefined
      : new RegExp(`(?:${spellings.map(escaped).join("|")})(?:[?#][^\\s)"'<>]*)?`, "g");
  return {
    rewrite:
      pattern === undefined || template === undefined
        ? undefined
        : (text) => text.replace(pattern, () => template),
    name: description,
    set: {
      "sentry.op": "http.client",
      "sentry.description": description,
      "url.template": template,
      "url.full": template === undefined ? undefined : withPath(full, template),
      "url.path": template,
    },
    drop: ["url.full", "url.path", "url.query"],
  };
};

/** Mend's databases are all SQL (Postgres, through Effect's SQL client). */
const database = (span: Span): Enriched => {
  if (span.name === "sql.transaction")
    return {
      name: "mend.db.transaction",
      set: { "sentry.op": "db.sql.transaction", "sentry.description": "database transaction" },
    };
  const query = stringOf(span.attributes, "db.query.text");
  if (query === undefined)
    return { name: span.name, set: { "sentry.op": "db", "sentry.description": span.name } };
  const { operation, collection, summary, text } = summarizeSql(query);
  const filtered = SENTRY_FILTERED.test(text);
  return {
    name: summary,
    set: {
      "sentry.op": "db.sql.query",
      "sentry.description": text,
      "db.query.summary": summary,
      "db.operation.name": operation,
      "db.collection.name": collection,
      "db.query.text": filtered ? undefined : text,
    },
    drop: filtered ? ["db.query.text"] : [],
  };
};

const messaging = (span: Span): Enriched => {
  const queue = stringOf(span.attributes, "messaging.destination.name");
  const named = nameOf(span.name);
  const op =
    span.kind === KIND.producer
      ? "queue.publish"
      : span.kind === KIND.consumer
        ? "queue.process"
        : named.op;
  return {
    name: named.name,
    set: { "sentry.op": op, "sentry.description": queue ?? named.description },
  };
};

/**
 * A procedure, `mend.web.sessions.send_message`, described by the method its caller sent,
 * `sessions.sendMessage`.
 */
const rpc = (span: Span): Enriched => {
  const named = nameOf(span.name);
  const op =
    span.kind === KIND.server ? "rpc.server" : span.kind === KIND.client ? "rpc.client" : named.op;
  return {
    name: named.name,
    set: {
      "sentry.op": op,
      "sentry.description": stringOf(span.attributes, "rpc.method") ?? named.description,
      "code.function.name": named.codeName,
    },
  };
};

const internal = (span: Span): Enriched => {
  const named = nameOf(span.name);
  return {
    name: named.name,
    set: {
      "sentry.op": named.op,
      "sentry.description": named.description,
      "code.function.name": named.codeName,
    },
  };
};

const enrichmentOf = (span: Span): Enriched => {
  const method = stringOf(span.attributes, "http.request.method");
  if (method !== undefined && span.kind === KIND.server) return httpServer(span, method);
  if (method !== undefined) return httpClient(span, method);
  if (has(span.attributes, "db.system.name")) return database(span);
  if (has(span.attributes, "messaging.system")) return messaging(span);
  if (has(span.attributes, "rpc.system") || has(span.attributes, "rpc.system.name"))
    return rpc(span);
  return internal(span);
};

const rewritten = (
  attributes: ReadonlyArray<KeyValue>,
  rewrite: (text: string) => string,
): Array<KeyValue> =>
  attributes.map((attribute) =>
    typeof attribute.value.stringValue === "string"
      ? { ...attribute, value: { stringValue: rewrite(attribute.value.stringValue) } }
      : attribute,
  );

/** `span` with the operation, description and name Sentry shows; one it already has is kept. */
export const enrichSpan = (span: Span): Span => {
  const enriched = enrichmentOf(span);
  const set = has(span.attributes, "sentry.op")
    ? { ...enriched.set, "sentry.op": undefined }
    : enriched.set;
  const rewrite = enriched.rewrite;
  return {
    ...span,
    name: enriched.name,
    attributes: withAttributes(span.attributes, set, enriched.drop),
    ...(rewrite === undefined
      ? {}
      : {
          status:
            span.status.message === undefined
              ? span.status
              : { ...span.status, message: rewrite(span.status.message) },
          events: span.events.map((event) => ({
            ...event,
            attributes: rewritten(event.attributes, rewrite),
          })),
        }),
  };
};

/**
 * A query no span ran under: work outside any request, job or background pass. Alone it says
 * nothing about why it ran, and each one would be a root trace of its own in Sentry.
 */
const isOrphanQuery = (span: Span): boolean =>
  (span.parentSpanId === undefined || span.parentSpanId === "") &&
  has(span.attributes, "db.system.name");

/**
 * The attributes Sentry reads only off a span, never off its resource (SLNT-1403): a resource's
 * `sentry.release` is stored as `resource.sentry.release` and fills no span's `release`.
 */
const PER_SPAN = ["sentry.release", "sentry.environment"] as const;

/** The resource's `sentry.release` and `sentry.environment`, to put on each of its spans. */
const perSpanOf = (resource: OtlpResource.Resource): Record<string, string> =>
  Object.fromEntries(
    PER_SPAN.flatMap((key) => {
      const value = stringOf(resource.attributes, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );

/** `span` with the resource's release and environment, where it names none of its own. */
const withPerSpan = (span: Span, perSpan: Record<string, string>): Span => {
  const missing = Object.entries(perSpan).filter(([key]) => !has(span.attributes, key));
  return missing.length === 0
    ? span
    : {
        ...span,
        attributes: [
          ...span.attributes,
          ...missing.map(([key, value]) => ({ key, value: { stringValue: value } })),
        ],
      };
};

export const enrichTraces = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
  resourceSpans: data.resourceSpans.map((resource) => {
    const perSpan = perSpanOf(resource.resource);
    return {
      ...resource,
      scopeSpans: resource.scopeSpans.map((scope) => ({
        ...scope,
        spans: scope.spans
          .filter((span) => !isOrphanQuery(span) && !isDropped(span))
          .map((span) => withPerSpan(enrichSpan(span), perSpan)),
      })),
    };
  }),
});

/** `inner`, handed traces with the operation, description and name each span reads by. */
export const enrichingSerialization = (
  inner: OtlpSerialization.OtlpSerialization["Service"],
): OtlpSerialization.OtlpSerialization["Service"] => ({
  ...inner,
  traces: (data) => inner.traces(enrichTraces(data)),
});
