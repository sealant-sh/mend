import { redactDetail } from "@mend/network";
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
  getClient,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
  startBrowserTracingNavigationSpan,
  startBrowserTracingPageLoadSpan,
} from "@sentry/browser";
import type { AnyRouter } from "@tanstack/react-router";
import { isTRPCClientError } from "@trpc/client";

import type { BrowserTelemetry } from "./telemetry-config.ts";

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
 * An answer from Mend's server, a refusal or a failure it already reported with its own cause
 * (`server/api/run.ts`): reporting it again from the browser would count one failure twice.
 */
const answeredByServer = (error: unknown): boolean =>
  isTRPCClientError(error) && error.data !== undefined && error.data !== null;

/** A string attribute that is a URL loses its query, whether bare or wrapped (`{ value }`). */
const scrubbed = (value: unknown): unknown => {
  if (typeof value === "string") return withoutQueries(value);
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = value.value;
    if (typeof inner === "string") return { ...value, value: withoutQueries(inner) };
  }
  return value;
};

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
  ],
  beforeSend: (event, hint) =>
    answeredByServer(hint.originalException) ? null : scrubEvent(event),
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.data === undefined
      ? breadcrumb
      : { ...breadcrumb, data: scrubAttributes(breadcrumb.data) },
  beforeSendSpan: (span) => ({
    ...span,
    name: withoutQueries(span.name),
    attributes: scrubAttributes(span.attributes),
  }),
  ...overrides,
});

/** The route a path renders, as its template (`/sessions/$sessionId`): no ids in a span's name. */
const routeOf = (router: AnyRouter, pathname: string): string => {
  const [, , found] = router.getMatchedRoutes(pathname);
  return found?.fullPath ?? "/";
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
