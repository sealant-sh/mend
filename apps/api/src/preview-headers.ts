import { type PreviewUndelivered, previewUndeliveredLine } from "@mend/domain/workbench";

import {
  answer,
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
  /** The Service's port inside the workspace, which the application reads as its own host. */
  readonly port: number;
  readonly cookies: CookiePolicy;
  readonly upgrade: boolean;
}

/**
 * The head an admitted request carries to the application. A chunked body is marked chunked
 * here rather than left to Node: `http.request` frames a GET, HEAD, DELETE or OPTIONS body
 * only when the header says so, and otherwise writes it raw onto a kept-alive socket.
 */
export const forwardRequestHead = (
  headers: ReadonlyArray<HeaderPair>,
  to: ForwardRequest,
): ReadonlyArray<HeaderPair> => {
  const cookie = appCookieHeader(valuesOf(headers, "cookie"), to.cookies);
  const origin = new URL(to.origin);
  return [
    field("host", `localhost:${to.port}`),
    ...keptFields(headers, REQUEST_DROPPED).filter(
      ([name]) => !name.toLowerCase().startsWith("x-forwarded-"),
    ),
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

/**
 * The head the viewer's browser receives for the application's answer. A 101 gets exactly
 * `Connection: Upgrade` and `Upgrade: websocket` back, so callers write the result as is.
 */
export const forwardResponseHead = (
  response: { readonly status: number; readonly headers: ReadonlyArray<HeaderPair> },
  cookies: CookiePolicy,
): ReadonlyArray<HeaderPair> => {
  const { headers } = response;
  return [
    ...keptFields(headers, RESPONSE_DROPPED),
    ...valuesOf(headers, "set-cookie").flatMap((raw) => {
      const kept = appSetCookie(raw, cookies);
      return kept === null ? [] : [field("set-cookie", kept)];
    }),
    field("cache-control", privateCacheControl(valuesOf(headers, "cache-control"))),
    ...robotsTags(valuesOf(headers, "x-robots-tag")),
    field("x-accel-buffering", "no"),
    ...(response.status === 101 ? UPGRADED : []),
  ];
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The gateway's own page for a request it held and did not deliver. No script, no retry. */
export const undeliveredAnswer = (fact: PreviewUndelivered): PreviewAnswer => {
  const line = escapeHtml(previewUndeliveredLine(fact));
  return answer(
    503,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${line}</title></head><body><p>${line}</p></body></html>`,
    {
      "cache-control": "no-store, private",
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
    },
  );
};
