import { redactDetail } from "@mend/network";
import { pathOf, templatePath } from "@mend/telemetry/url-template";
import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  type BrowserOptions,
  browserTracingIntegration,
  captureException,
  dedupeIntegration,
  type ErrorEvent,
  eventFiltersIntegration,
  functionToStringIntegration,
  getActiveSpan,
  getClient,
  getCurrentScope,
  getRootSpan,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
  spanToJSON,
  startBrowserTracingNavigationSpan,
  startBrowserTracingPageLoadSpan,
  startInactiveSpan,
  startNewTrace,
  withActiveSpan,
} from "@sentry/browser";
import type { AnyRouter } from "@tanstack/react-router";
import { isTRPCClientError } from "@trpc/client";

import type { BrowserTelemetry } from "./telemetry-config.ts";
import type { Action, Awaiting } from "./telemetry.ts";

type Integration = Exclude<NonNullable<BrowserOptions["integrations"]>, Function>[number];

/**
 * The browser's Sentry client (SLNT-1349), loaded only on a page served with a DSN
 * (`telemetry-config.ts`). It reports errors and traces and nothing else: no session replay (a
 * terminal, a diff or a screen can show a secret), no console or click breadcrumbs, no request or
 * response bodies, no cookies, and no query strings. Error text goes through `redactDetail`.
 */

/** Calls to Mend's own server carry the trace on: its tRPC and its API, never another origin. */
const MEND_PATHS = /^\/(?:trpc|api)(?:[/?]|$)/;

/**
 * Every path or URL in a text with its query and fragment gone (`GET /trpc/a?batch=1`): they can
 * carry a token, a ticket or a search.
 */
const withoutQueries = (text: string): string =>
  text.replace(/((?:^|\s)(?:https?:\/\/\S*?|\/\S*?))[?#]\S*/g, "$1");

/** Span attributes that only ever hold a query or a fragment. */
const QUERY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.query",
  "http.fragment",
  "url.query",
  "url.fragment",
]);

/**
 * Reads the page repeats on a timer whatever the person does: the session's Executor calls every
 * five seconds. Each is a trace of its own (`aside`), even while the page loads: as part of the
 * load, they would stretch it to its thirty-second cap and bury what the person did under them.
 */
const BACKGROUND_READS: ReadonlySet<string> = new Set(["executor.calls"]);

/** The procedures a tRPC request batches, from its path: `/trpc/a.b,c.d` names `a.b` and `c.d`. */
const proceduresOf = (path: string): ReadonlyArray<string> | null => {
  const match = /^\/trpc\/([^/?#]+)/.exec(path);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]).split(",");
};

/** Whether a request to `url` only repeats a background read. */
export const backgroundRead = (url: string): boolean => {
  const procedures = proceduresOf(pathOf(url) ?? url);
  return procedures !== null && procedures.every((procedure) => BACKGROUND_READS.has(procedure));
};

/** The name of a tRPC request, however many calls it batches: the route, never what it carries. */
const TRPC_REQUEST = "/trpc/:procedures";

/**
 * A procedure's span, `trpc sessions.inbox_row`: its router and procedure, each part in snake
 * case, the shape the server's procedure spans take (`mend.web.<router>.<procedure>`, SLNT-1407).
 */
export const procedureSpanName = (procedure: string): string =>
  `trpc ${procedure
    .split(".")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join(".")}`;

const stringAttribute = (attributes: Readonly<Record<string, unknown>>, key: string) => {
  const value = attributes[key];
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = value.value;
    if (typeof inner === "string") return inner;
  }
  return undefined;
};

/** A string attribute rewritten by `change`, whether bare or wrapped (`{ value }`). */
const mapString = (value: unknown, change: (text: string) => string): unknown => {
  if (typeof value === "string") return change(value);
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = value.value;
    if (typeof inner === "string") return { ...value, value: change(inner) };
  }
  return value;
};

/** A string attribute that is a URL loses its query. */
const scrubbed = (value: unknown): unknown => mapString(value, withoutQueries);

/**
 * A web vital's or an interaction's name when Sentry found no component around it (the SDK's own),
 * and what it measured, for its description.
 */
const VITALS: Readonly<Record<string, readonly [name: string, measured: string]>> = {
  "ui.webvital.cls": ["Layout shift", "layout shift"],
  "ui.webvital.lcp": ["Largest contentful paint", "largest contentful paint"],
  "ui.interaction.click": ["Click", "click"],
  "ui.interaction.press": ["Key press", "key press"],
  "ui.interaction.hover": ["Hover", "hover"],
  "ui.interaction.drag": ["Drag", "drag"],
};

/**
 * The attributes in which Sentry writes the element a vital or an interaction measured, as a
 * selector: its classes, and its `aria-label`, `title`, `alt` and `name` with their values as they
 * are, which can hold a session's or a file's name. No split of that text is safe (a value can hold
 * ` > ` or a quote), so none of it leaves: the component names where it happened.
 */
const ELEMENT_ATTRIBUTE = /^browser\.web_vital\.(?:inp\.target|lcp\.element|cls\.source\.\d+)$/;

/**
 * A web vital's or an interaction's span, named for the Mend component it happened in
 * (`ui.component_name`, from `data-sentry-component`): `SessionRow`, described `click in
 * SessionRow`. With no component around it, it keeps the SDK's name (`Click`) and says what it
 * measured; `no layout shift` for a page whose layout never moved.
 */
const vitalNamed = (
  op: string,
  attributes: Record<string, unknown>,
): { readonly name: string; readonly attributes: Record<string, unknown> } => {
  const kept = Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !ELEMENT_ATTRIBUTE.test(key)),
  );
  const [fallback, measured] = VITALS[op] ?? [op, op];
  const component = stringAttribute(attributes, "ui.component_name");
  if (component !== undefined) {
    return {
      name: component,
      attributes: { ...kept, "sentry.description": `${measured} in ${component}` },
    };
  }
  const still = op === "ui.webvital.cls" && !("browser.web_vital.cls.source.1" in attributes);
  return {
    name: fallback,
    attributes: { ...kept, "sentry.description": still ? "no layout shift" : measured },
  };
};

/**
 * A span as a trace reads it. A request: `POST /trpc/:procedures` for any tRPC request (its calls
 * are its child spans, and in `mend.trpc.procedures`), or `GET /api/sessions/:sessionId/output`:
 * never the page's origin, its port, an ID, a query or a count. A page timing by its page's path,
 * and a web vital or an interaction by its component (`vitalNamed`).
 */
const requestNamed = (
  name: string,
  attributes: Record<string, unknown>,
): { readonly name: string; readonly attributes: Record<string, unknown> } => {
  const op = stringAttribute(attributes, "sentry.op");
  // The page's own timings (DNS, connect, request, response, load) describe the page they timed:
  // by its path, not the origin and port it was served from.
  if (op?.startsWith("browser.") === true) {
    const page = pathOf(stringAttribute(attributes, "url.full") ?? "");
    return page === undefined
      ? { name, attributes }
      : { name, attributes: { ...attributes, "sentry.description": templatePath(page) } };
  }
  if (op?.startsWith("ui.webvital.") === true || op?.startsWith("ui.interaction.") === true) {
    return vitalNamed(op, attributes);
  }
  if (op !== "http.client") return { name, attributes };
  const method = stringAttribute(attributes, "http.request.method") ?? name.split(" ")[0] ?? "GET";
  const path = pathOf(stringAttribute(attributes, "url.full") ?? name.split(" ")[1] ?? "");
  if (path === undefined) return { name, attributes };
  const procedures = proceduresOf(path);
  const template = procedures === null ? templatePath(path) : TRPC_REQUEST;
  const description = `${method} ${template}`;
  return {
    name: description,
    attributes: {
      ...attributes,
      "sentry.description": description,
      "url.template": template,
      ...(procedures === null
        ? {}
        : {
            "mend.trpc.procedures": procedures.join(","),
            "mend.trpc.batch_size": procedures.length,
          }),
    },
  };
};

/**
 * An answer from Mend's server, a refusal or a failure it already reported with its own cause
 * (`server/api/run.ts`): reporting it again from the browser would count one failure twice.
 */
const answeredByServer = (error: unknown): boolean =>
  isTRPCClientError(error) && error.data !== undefined && error.data !== null;

/** Attributes with every query gone: the ones that hold only a query, and any URL's own. */
const scrubAttributes = (attributes: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => !QUERY_ATTRIBUTES.has(key))
      .map(([key, value]) => [key, scrubbed(value)]),
  );

/** One error event with nothing in it the privacy rules keep out (CONTRACT.md, Privacy). */
const scrubEvent = ({ user: _user, extra: _extra, ...event }: ErrorEvent): ErrorEvent => {
  const request = event.request;
  return {
    ...event,
    ...(request === undefined
      ? {}
      : {
          request: {
            ...(request.url === undefined ? {} : { url: withoutQueries(request.url) }),
            // The browser's name, nothing else: no cookies, no Referer (a page's query).
            ...(request.headers?.["User-Agent"] === undefined
              ? {}
              : { headers: { "User-Agent": request.headers["User-Agent"] } }),
          },
        }),
    ...(event.message === undefined ? {} : { message: redactDetail(event.message) }),
    ...(event.exception?.values === undefined
      ? {}
      : {
          exception: {
            ...event.exception,
            values: event.exception.values.map((value) =>
              value.value === undefined ? value : { ...value, value: redactDetail(value.value) },
            ),
          },
        }),
    ...(event.breadcrumbs === undefined
      ? {}
      : {
          breadcrumbs: event.breadcrumbs.map((breadcrumb) => ({
            ...breadcrumb,
            ...(breadcrumb.message === undefined
              ? {}
              : { message: redactDetail(breadcrumb.message) }),
            ...(breadcrumb.data === undefined ? {} : { data: scrubAttributes(breadcrumb.data) }),
          })),
        }),
  };
};

/**
 * The trace header names the trace's root span as it was when the trace began, and the `baggage`
 * Mend's server receives carries the same name: an `http.client` root is named for the URL it
 * fetched, so the name loses its query there too.
 */
const traceHeaderWithoutQueries = (): Integration => ({
  name: "MendTraceHeader",
  setup: (client) => {
    client.on("createDsc", (dsc) => {
      if (dsc.transaction !== undefined) dsc.transaction = withoutQueries(dsc.transaction);
    });
  },
});

type Span = NonNullable<ReturnType<typeof getActiveSpan>>;
type PropagationContext = ReturnType<ReturnType<typeof getCurrentScope>["getPropagationContext"]>;

/** Sentry's span status for a failure (`SPAN_STATUS_ERROR` in @sentry/core, not re-exported). */
const SPAN_STATUS_ERROR = 2;

/** A trace no span has used yet, as the SDK starts one (`startNewTrace`). */
const freshTrace = (): PropagationContext =>
  startNewTrace(() => getCurrentScope().getPropagationContext());

/**
 * Each trace covers one thing the page did, and ends with it (SLNT-1408). Left to itself, the
 * SDK keeps a page's trace ID once its load or navigation ends, and every span started with no
 * parent after it (a poll, a refetch, a click's timing) joins that trace for as long as the tab
 * stays open:
 *
 * - a span started with no parent begins a trace of its own, unless the page continues one it
 *   was handed;
 * - a span started under a parent that already ended (a web vital, reported when the page is left
 *   or the next navigation starts) begins a trace of its own too, linked to that parent, so it
 *   never stretches the page's trace to the minute it happened;
 * - once a page's load or navigation ends, what no span holds (an error, a request) is part of no
 *   old trace either.
 */
const traceShape = (): Integration => ({
  name: "MendTraceShape",
  setup: (client) => {
    let endedParent: Span | undefined;
    client.on("prepareSpanScope", (spanScope) => {
      // Every span passes here before it starts: a link meant for one never reaches the next.
      endedParent = undefined;
      const { parentSpan, scope } = spanScope;
      // A span not ended yet has no end timestamp (`browserTracingIntegration` reads it so too).
      if (parentSpan !== undefined && !spanToJSON(parentSpan).end_timestamp) return;
      if (parentSpan === undefined && scope.getPropagationContext().parentSpanId !== undefined) {
        return;
      }
      const own = scope.clone();
      own.setPropagationContext(freshTrace());
      spanScope.scope = own;
      spanScope.parentSpan = undefined;
      endedParent = parentSpan;
    });
    client.on("spanStart", (span) => {
      nameAtStart(span);
      const parent = endedParent;
      endedParent = undefined;
      if (parent !== undefined && getRootSpan(span) === span) {
        span.addLink({
          context: parent.spanContext(),
          attributes: { "sentry.link.type": "mend.ended_parent" },
        });
      }
      startProcedures(span);
    });
    client.on("spanEnd", endProcedures);
    // Registered after `browserTracingIntegration`'s own, which keeps the ended span's trace.
    client.on("beforeIdleSpanEnd", () => {
      getCurrentScope().setPropagationContext(freshTrace());
    });
  },
});

/**
 * A span is named as it starts (`requestNamed`), not only as it leaves: the trace's root name,
 * which the trace header carries and every span of the trace repeats (`sentry.segment.name`), is
 * the name its root span started with.
 */
const nameAtStart = (span: Span): void => {
  const { name, attributes } = spanToJSON(span);
  const named = requestNamed(withoutQueries(name), scrubAttributes(attributes ?? {}));
  if (named.name !== name) span.updateName(named.name);
};

/** Each tRPC request's span's procedure spans, while it runs. */
const procedureSpans = new WeakMap<Span, ReadonlyArray<Span>>();

/**
 * A tRPC request's span gets one child span for each procedure it carries, named
 * `trpc <router>.<procedure>`. Its op is `rpc.client`, not `http.client`: Sentry's request views
 * count every `http.client` span as a request of its own, and a batch is one.
 */
const startProcedures = (span: Span): void => {
  const { attributes } = spanToJSON(span);
  if (attributes?.["sentry.op"] !== "http.client") return;
  const url = attributes["url.full"];
  const procedures = typeof url === "string" ? proceduresOf(pathOf(url) ?? url) : null;
  if (procedures === null) return;
  procedureSpans.set(
    span,
    procedures.map((procedure) =>
      startInactiveSpan({
        name: procedureSpanName(procedure),
        op: "rpc.client",
        parentSpan: span,
        attributes: { "rpc.system": "trpc", "rpc.method": procedure },
      }),
    ),
  );
};

/** A tRPC request's procedures end with it, failed if it failed. */
const endProcedures = (span: Span): void => {
  const procedures = procedureSpans.get(span);
  if (procedures === undefined) return;
  procedureSpans.delete(span);
  const { status, end_timestamp: end } = spanToJSON(span);
  for (const procedure of procedures) {
    if (status === "error")
      procedure.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
    procedure.end(end);
  }
};

/**
 * Run `send`, a request leaving, in a trace of its own when it only repeats a background read
 * (`BACKGROUND_READS`); in the page's current span otherwise.
 */
export const aside = <A>(url: string, send: () => A): A => {
  if (!backgroundRead(url)) return send();
  let result: { readonly value: A } | undefined;
  // `startNewTrace` given a promise keeps its scope until the promise settles: only the request's
  // synchronous start runs inside it.
  startNewTrace(() => {
    result = { value: send() };
  });
  if (result === undefined) throw new Error("startNewTrace did not run its callback");
  return result.value;
};

/**
 * Every option the client starts with. The transport is the SDK's own unless a test records
 * what would leave.
 */
export const sentryOptions = (
  telemetry: BrowserTelemetry,
  overrides: Pick<BrowserOptions, "transport"> = {},
): BrowserOptions => ({
  dsn: telemetry.dsn,
  environment: telemetry.environment,
  ...(telemetry.release === null ? {} : { release: telemetry.release }),
  tracesSampleRate: telemetry.tracesSampleRate,
  // What Sentry 11 calls `sendDefaultPii: false`, and more: nothing about the person, no cookies,
  // headers, bodies or query strings, no variables from a stack frame.
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
  },
  // Mend's own origin and paths only, with W3C `traceparent` beside Sentry's headers: the web
  // server and the API continue the trace from it (`server/api/run.ts`).
  tracePropagationTargets: [MEND_PATHS],
  propagateTraceparent: true,
  // Named here, so a default added by a new SDK version (console capture, sessions) stays out.
  defaultIntegrations: false,
  integrations: [
    eventFiltersIntegration(),
    functionToStringIntegration(),
    browserApiErrorsIntegration(),
    breadcrumbsIntegration({ dom: false, sentry: false }),
    globalHandlersIntegration(),
    linkedErrorsIntegration(),
    dedupeIntegration(),
    httpContextIntegration(),
    // Pages and navigations are started below, named for their route, never their address. A
    // page's ~250 assets would each be a span: none says anything a trace of Mend needs.
    browserTracingIntegration({
      instrumentPageLoad: false,
      instrumentNavigation: false,
      ignoreResourceSpans: [
        "resource.script",
        "resource.css",
        "resource.img",
        "resource.link",
        "resource.other",
      ],
    }),
    traceHeaderWithoutQueries(),
    // After `browserTracingIntegration`, so its hooks run after the SDK's own.
    traceShape(),
  ],
  beforeSend: (event, hint) =>
    answeredByServer(hint.originalException) ? null : scrubEvent(event),
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.data === undefined
      ? breadcrumb
      : { ...breadcrumb, data: scrubAttributes(breadcrumb.data) },
  beforeSendSpan: (span) => {
    const named = requestNamed(withoutQueries(span.name), scrubAttributes(span.attributes));
    return { ...span, ...named };
  },
  ...overrides,
});

/**
 * A route's path as a URL template: `/sessions/$sessionId`, `/projects` for the index the router
 * writes `/projects/`, and `/settings/*` for a splat (`/settings/$`, any address under Settings no
 * page owns), which the router writes as a bare `$`.
 */
export const routeTemplate = (fullPath: string): string =>
  fullPath.replace(/(^|\/)\$$/, "$1*").replace(/(.)\/$/, "$1");

/** The route a path renders, as its template (`/sessions/$sessionId`): no ids in a span's name. */
const routeOf = (router: AnyRouter, pathname: string): string => {
  const [, , found] = router.getMatchedRoutes(pathname);
  return routeTemplate(found?.fullPath ?? "/");
};

/** Start reporting: errors from now on, the page's load, and each navigation after it. */
export const start = (telemetry: BrowserTelemetry, router: AnyRouter): void => {
  init(sentryOptions(telemetry));
  const client = getClient();
  if (client === undefined) return;
  const attributes = { "sentry.source": "route" } as const;
  startBrowserTracingPageLoadSpan(client, {
    name: routeOf(router, router.state.location.pathname),
    attributes,
  });
  router.subscribe("onBeforeNavigate", (event) => {
    if (!event.pathChanged) return;
    startBrowserTracingNavigationSpan(client, {
      name: routeOf(router, event.toLocation.pathname),
      attributes,
    });
  });
};

/**
 * An error a boundary caught and drew a screen for. React does not hand those to the page's error
 * handlers, so each is reported here, once (`dedupeIntegration` drops a repeat).
 */
export const reportCaught = (error: unknown): void => {
  if (answeredByServer(error)) return;
  captureException(error, { mechanism: { type: "mend.error_boundary", handled: true } });
};

/** Each action's span while it runs, by its span id: what a request names to be part of it. */
const actions = new Map<string, Span>();

/**
 * The actions whose steps are running now, innermost last. A call made in a step belongs to the
 * innermost: not to whatever span the page made active meanwhile (a start shows its page first,
 * and the router's navigation span becomes the active one).
 */
const running: Array<string> = [];

/**
 * Run `step` with `span` active for its synchronous part only. `withActiveSpan` given a promise
 * keeps its scope until the promise settles, and in a browser that scope is the page's: every
 * request the page made meanwhile, and a second action, would land in this one's trace.
 */
const activeFor = <A>(span: Span, step: () => A): A => {
  let result: { readonly value: A } | undefined;
  running.push(span.spanContext().spanId);
  try {
    withActiveSpan(span, () => {
      result = { value: step() };
    });
  } finally {
    running.pop();
  }
  if (result === undefined) throw new Error("withActiveSpan did not run its callback");
  return result.value;
};

/**
 * An action as the root span of a trace of its own: a start or a send is not part of the page's
 * load or of the navigation it happened during. Its span is active only while its own steps run.
 */
export const traceAction = async <A>(
  name: string,
  attributes: Readonly<Record<string, string>>,
  run: (action: Action) => Promise<A>,
): Promise<A> => {
  const span = startNewTrace(() =>
    startInactiveSpan({ name, op: "mend.action", attributes, forceTransaction: true }),
  );
  const { traceId, spanId } = span.spanContext();
  actions.set(spanId, span);
  try {
    return await activeFor(span, () =>
      run({
        annotate: (more) => {
          span.setAttributes(more);
        },
        within: (call) => activeFor(span, call),
        ref: { traceId, spanId },
      }),
    );
  } catch (error) {
    span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
    throw error;
  } finally {
    actions.delete(spanId);
    span.end();
  }
};

/** The action whose step is running now, if any: a tRPC call made now is part of it. */
export const currentAction = (): string | null => {
  const spanId = running.at(-1);
  return spanId !== undefined && actions.has(spanId) ? spanId : null;
};

/** Run `call` (a request leaving) with the named action's span active, if it still runs. */
export const withinAction = <A>(key: string, call: () => A): A => {
  const span = actions.get(key);
  return span === undefined ? call() : activeFor(span, call);
};

/**
 * A turn's first visible output, as a span of its own carrying `mend.turn_id`: from when this tab
 * sent the turn (linked to that send's trace) or first saw it open, to the frame after the agent's
 * first item reached the page.
 */
export const firstVisibleOutput = (turnId: string, waited: Awaiting): void => {
  requestAnimationFrame(() => {
    startNewTrace(() => {
      startInactiveSpan({
        name: "mend.web.turn.first_visible_output",
        op: "mend.ui",
        startTime: waited.since,
        forceTransaction: true,
        attributes: {
          "mend.turn_id": turnId,
          "mend.session_id": waited.sessionId,
          "mend.turn.waited_from": waited.from,
        },
        ...(waited.ref === null
          ? {}
          : {
              links: [
                {
                  context: { ...waited.ref, traceFlags: 1 },
                  attributes: { "sentry.link.type": "mend.send" },
                },
              ],
            }),
      }).end();
    });
  });
};
