import {
  type PreviewGatewayRefusal,
  previewFactLine,
  type PreviewNotDelivered,
  previewUndeliveredLine,
  type ServiceHostPolicy,
} from "@mend/domain/workbench";
import type { ForwardIssueReason } from "@mend/sealant";

import {
  gatewayPage,
  type HeaderPair,
  membersOf,
  type PreviewAnswer,
  valuesOf,
} from "./preview-requests.ts";
import {
  appCookieHeader,
  appSetCookie,
  type CookiePolicy,
  type PreviewOrigin,
} from "./preview-routing.ts";

const HOP_BY_HOP = [
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Never copied from the browser: the gateway states host, cookies and framing itself. The app's
 * own `Authorization` passes: Mend's bearers are never ambient, so a browser sends one only when
 * the app's page asked it to.
 */
const REQUEST_DROPPED = new Set([
  ...HOP_BY_HOP,
  "host",
  "cookie",
  "expect",
  "proxy-authorization",
  "forwarded",
  "x-real-ip",
]);

/**
 * The gateway writes its own `X-Forwarded-*`. `tailscale serve` adds the viewer's tailnet identity
 * as `Tailscale-*`, and a client that reaches the gateway directly can send any of them: neither
 * may reach agent-written code.
 */
const REQUEST_DROPPED_PREFIXES = ["x-forwarded-", "tailscale-"];

const RESPONSE_DROPPED = new Set([
  ...HOP_BY_HOP,
  "proxy-authenticate",
  "set-cookie",
  "cache-control",
  "x-accel-buffering",
  // Clears cookies for the whole host, which on a tailnet holds every preview's grant.
  "clear-site-data",
  // Could send this origin's requests to another port of the same host.
  "alt-svc",
]);

const field = (name: string, value: string): HeaderPair => [name, value];

const UPGRADED: ReadonlyArray<HeaderPair> = [
  field("connection", "Upgrade"),
  field("upgrade", "websocket"),
];

/** A Connection token naming Content-Length would leave the forwarded body unframed. */
const nominatedBy = (headers: ReadonlyArray<HeaderPair>) =>
  membersOf(headers, "connection").filter((name) => name !== "content-length");

const keptFields = (headers: ReadonlyArray<HeaderPair>, dropped: ReadonlySet<string>) => {
  const nominated = new Set(nominatedBy(headers));
  return headers.filter(([raw]) => {
    const name = raw.toLowerCase();
    return !dropped.has(name) && !nominated.has(name);
  });
};

export interface ForwardRequest {
  readonly origin: PreviewOrigin;
  readonly port: number;
  readonly host: ServiceHostPolicy;
  readonly cookies: CookiePolicy;
  readonly upgrade: boolean;
}

/**
 * A chunked body is marked chunked here rather than left to Node: `http.request` frames a GET,
 * HEAD, DELETE or OPTIONS body only when the header says so, and otherwise writes it raw onto a
 * kept-alive socket.
 */
export const forwardRequestHead = (
  headers: ReadonlyArray<HeaderPair>,
  to: ForwardRequest,
): ReadonlyArray<HeaderPair> => {
  const cookie = appCookieHeader(valuesOf(headers, "cookie"), to.cookies);
  const origin = new URL(to.origin);
  return [
    field("host", to.host === "preserve" ? origin.host : `localhost:${to.port}`),
    ...keptFields(headers, REQUEST_DROPPED).filter(([name]) => {
      const lower = name.toLowerCase();
      return !REQUEST_DROPPED_PREFIXES.some((prefix) => lower.startsWith(prefix));
    }),
    ...(membersOf(headers, "transfer-encoding").length > 0
      ? [field("transfer-encoding", "chunked")]
      : []),
    ...(cookie === null ? [] : [field("cookie", cookie)]),
    field("x-forwarded-host", origin.host),
    field("x-forwarded-proto", origin.protocol.slice(0, -1)),
    ...(to.upgrade ? UPGRADED : []),
  ];
};

/** Directives split on commas outside quoted strings, as `private="Set-Cookie"` needs. */
const directivesOf = (values: ReadonlyArray<string>) =>
  values.flatMap((value) => value.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? []);

/** Private to the viewer's browser: no shared cache keeps a response a grant admitted. */
const privateCacheControl = (values: ReadonlyArray<string>) => {
  const kept = directivesOf(values)
    .map((directive) => directive.trim())
    .filter((directive) => {
      const name = (directive.split("=")[0] ?? "").trim().toLowerCase();
      return directive !== "" && name !== "public" && name !== "private" && name !== "s-maxage";
    });
  return ["private", ...kept].join(", ");
};

const robotsTags = (values: ReadonlyArray<string>): ReadonlyArray<HeaderPair> => {
  const indexed = !directivesOf(values).some((directive) =>
    ["noindex", "none"].includes(directive.trim().toLowerCase()),
  );
  return indexed ? [field("x-robots-tag", "noindex")] : [];
};

/** A 101 gets exactly `Connection: Upgrade` and `Upgrade: websocket` back: write it as is. */
export const forwardResponseHead = (
  response: { readonly status: number; readonly headers: ReadonlyArray<HeaderPair> },
  cookies: CookiePolicy,
): ReadonlyArray<HeaderPair> => {
  const { headers } = response;
  return [
    ...keptFields(headers, RESPONSE_DROPPED),
    ...valuesOf(headers, "set-cookie").flatMap((raw) =>
      appSetCookie(raw, cookies).map((kept) => field("set-cookie", kept)),
    ),
    field("cache-control", privateCacheControl(valuesOf(headers, "cache-control"))),
    ...robotsTags(valuesOf(headers, "x-robots-tag")),
    field("x-accel-buffering", "no"),
    ...(response.status === 101 ? UPGRADED : []),
  ];
};

export const undeliveredAnswer = (
  service: string,
  why: PreviewNotDelivered,
  back: string | null = null,
): PreviewAnswer =>
  gatewayPage(
    503,
    previewUndeliveredLine(service, why) +
      (why._tag === "DidNotStart" && why.reason === "workspace is not live"
        ? " · resume the session in Mend, then open this preview again"
        : ""),
    back,
  );

export const notDelivered = (service: string, fact: string): string =>
  `${previewFactLine(service, fact)} · your request was not delivered`;

export const CEILING_RETRY_SECONDS = 1;

export const budgetPage = (message: string, retryAfterSeconds: number): PreviewAnswer => {
  const page = gatewayPage(429, message);
  return { ...page, headers: { ...page.headers, "retry-after": String(retryAfterSeconds) } };
};

export const REFUSED = {
  "service-missing": { status: 503, fact: "no Service of this name in its worktree" },
  "not-browser-service": { status: 503, fact: "the Service serves no browser page" },
  "no-recorded-command": { status: 503, fact: "no recorded command starts it" },
  "https-unsupported": { status: 501, fact: "it speaks https, which previews do not relay yet" },
  "process-binding-unavailable": { status: 503, fact: "process binding is unavailable" },
} as const satisfies Record<PreviewGatewayRefusal, { status: number; fact: string }>;

export type DialDisposition =
  | { readonly _tag: "NotLent" }
  | { readonly _tag: "Undelivered"; readonly status: 502 | 503 | 504; readonly fact: string };

const undelivered = (status: 502 | 503 | 504, fact: string): DialDisposition => ({
  _tag: "Undelivered",
  status,
  fact,
});
const NOT_LENT: DialDisposition = { _tag: "NotLent" };

export const DIAL_DISPOSITION = {
  "connection-refused": undelivered(502, "nothing listens"),
  "name-unresolved": undelivered(502, "nothing listens"),
  "network-unreachable": undelivered(502, "the forward failed"),
  "dial-failed": undelivered(502, "the forward failed"),
  "transport-unavailable": undelivered(503, "the forward failed"),
  internal: undelivered(502, "the forward failed"),
  "platform-failed": undelivered(502, "the forward failed"),
  "unrecognized-refusal": undelivered(502, "the forward failed"),
  "protocol-unsupported": undelivered(502, "the forward failed"),
  "invalid-target": undelivered(502, "the forward failed"),
  "workspace-not-ready": undelivered(503, "workspace is not live"),
  "runtime-unreachable": undelivered(503, "workspace is not live"),
  "runtime-untargetable": undelivered(503, "workspace is not live"),
  "not-found": undelivered(503, "workspace is not live"),
  "dial-timeout": undelivered(504, "the forward timed out"),
  "deadline-exceeded": undelivered(504, "the forward timed out"),
  "budget-exceeded": undelivered(503, "the platform's forward budget is reached"),
  unauthorized: undelivered(503, "the platform refused the forward"),
  NO_PRINCIPAL: undelivered(503, "the platform refused the forward"),
  UNKNOWN_USER: undelivered(503, "the platform refused the forward"),
  "not-a-person": undelivered(503, "the platform refused the forward"),
  forbidden: NOT_LENT,
  no_standing: NOT_LENT,
  creator_no_access: NOT_LENT,
  "owner-exited": undelivered(502, "process exited"),
  "owner-required": undelivered(502, "process binding is unavailable"),
  "peer-mismatch": undelivered(502, "process binding is unavailable"),
  "binding-unverifiable": undelivered(502, "process binding is unavailable"),
  "binding-unsupported": undelivered(502, "process binding is unavailable"),
  cancelled: undelivered(503, "the forward was given up"),
} as const satisfies Record<ForwardIssueReason, DialDisposition>;
