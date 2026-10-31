import { TAILNET_PORT_QUIET_HOURS } from "@mend/db";
import {
  type BrowserRequest,
  isDocumentNavigation,
  NO_SUCH_PREVIEW,
  siblingRequestAdmitted,
} from "@mend/network";
import { type PageTheme, pageThemes } from "@mend/ui/page-theme";
import { Brand } from "effect";

import type {
  PreviewNoIdentity,
  PreviewNotFound,
  PreviewPoolFull,
  PreviewUnavailable,
} from "./preview-identity.ts";
import type { PreviewOrigin } from "./preview-routing.ts";

export type PreviewPath = string & Brand.Brand<"PreviewPath">;
const PreviewPath = Brand.nominal<PreviewPath>();

export const PREVIEW_ROOT: PreviewPath = PreviewPath("/");

const PLACEHOLDER_ORIGIN = "http://preview.invalid";

/** A control character or a backslash, which a URL parser drops or reads as `/`. */
const isRefusedCharacter = (character: string) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f || character === "\\";
};

const decodedPath = (pathname: string): string | null => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
};

/** Apps decode `/%5F%5Fmend` to `/__mend`. */
export const mustNotForward = (pathname: string): boolean => {
  const decoded = decodedPath(pathname);
  return decoded === null || decoded === "/__mend" || decoded.startsWith("/__mend/");
};

export const parsePreviewPath = (raw: string): PreviewPath | null => {
  if (raw.length === 0 || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }
  if ([...raw].some(isRefusedCharacter) || /%(?:[01][0-9a-f]|7f|5c)/i.test(raw)) return null;
  const url = URL.parse(raw, PLACEHOLDER_ORIGIN);
  if (url === null || url.origin !== PLACEHOLDER_ORIGIN) return null;
  const decoded = decodedPath(url.pathname);
  if (decoded === null || decoded.startsWith("//") || mustNotForward(url.pathname)) return null;
  return PreviewPath(`${url.pathname}${url.search}${url.hash}`);
};

export const strictQuery = (
  search: string,
  names: ReadonlyArray<string>,
): ReadonlyMap<string, string> | null => {
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(search)) {
    if (!names.includes(name) || values.has(name)) return null;
    values.set(name, value);
  }
  return values;
};

export interface BrowserHead extends BrowserRequest {
  readonly origins: ReadonlyArray<string>;
  readonly sentFetchMetadata: boolean;
  readonly acceptsHtml: boolean;
}

const FETCH_SITES = new Set(["none", "same-origin", "same-site", "cross-site"]);

/**
 * Browsers send Fetch Metadata only to an origin they trust, and one that does not trust
 * `x.localhost` sends none: a navigation there reads as a GET asking for HTML.
 */
export const opensSignIn = (head: BrowserHead): boolean =>
  isDocumentNavigation(head) ||
  (head.method === "GET" && !head.upgrade && !head.sentFetchMetadata && head.acceptsHtml);

export const browserAdmits = (head: BrowserHead, own: PreviewOrigin): boolean => {
  if (head.origins.length > 1) return false;
  const [origin] = head.origins;
  if (origin !== undefined && origin !== own) return false;
  const safe = (head.method === "GET" || head.method === "HEAD") && !head.upgrade;
  if (origin === undefined && !safe) return false;
  if (head.fetchSite !== undefined && !FETCH_SITES.has(head.fetchSite)) return false;
  return siblingRequestAdmitted(head);
};

export interface PreviewAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const CREDENTIALED = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

export const answer = (
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): PreviewAnswer => ({
  status,
  headers: { ...CREDENTIALED, "content-type": "text/plain; charset=utf-8", ...headers },
  body,
});

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const themeVariables = (theme: PageTheme) =>
  `color-scheme:${theme.appearance};${Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("")}`;

// Self-contained: no font, script or stylesheet is fetched, so the page reads the same on a preview
// host that serves nothing else and under any edge's Content-Security-Policy.
const GATEWAY_PAGE_CSS =
  `:root{${themeVariables(pageThemes.light)}}` +
  `@media (prefers-color-scheme: dark){:root{${themeVariables(pageThemes.dark)}}}` +
  "*{box-sizing:border-box}" +
  "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;" +
  "background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}" +
  "main{max-width:560px;width:100%;padding:20px 24px;border:1px solid var(--border);" +
  "border-radius:16px;background:var(--card)}" +
  "h1{margin:0 0 8px;font:500 12px/1.4 var(--font-mono);letter-spacing:.06em;" +
  "text-transform:uppercase;color:var(--muted-foreground)}" +
  "p{margin:0;font:13px/1.6 var(--font-mono);overflow-wrap:anywhere}" +
  "a{display:inline-block;margin-top:14px;color:var(--primary);text-decoration:none;font-weight:500}" +
  "a:hover{text-decoration:underline}";

/** `back`: where in Mend the preview's project is, so a person can Start it; null when unknown. */
export const gatewayPage = (
  status: number,
  text: string,
  back: string | null = null,
): PreviewAnswer => {
  const line = escapeHtml(text);
  const link = back === null ? "" : `<a href="${escapeHtml(back)}">Open in Mend</a>`;
  return answer(
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${line}</title><style>${GATEWAY_PAGE_CSS}</style></head>` +
      `<body><main><h1>Mend preview · ${status}</h1><p>${line}</p>${link}</main></body></html>`,
    {
      "cache-control": "no-store, private",
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
    },
  );
};

export const redirect = (
  status: 302 | 303,
  location: string,
  headers: Readonly<Record<string, string>> = {},
): PreviewAnswer => answer(status, "", { location, ...headers });

const nextMinuteUtc = (at: Date): string =>
  new Date(Math.ceil(at.getTime() / 60_000) * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")
    .concat(" UTC");

export const refusalAnswer = (
  error: PreviewNoIdentity | PreviewNotFound | PreviewUnavailable | PreviewPoolFull,
): PreviewAnswer => {
  switch (error._tag) {
    case "PreviewNoIdentity":
      return gatewayPage(401, "Not signed in to this preview.");
    case "PreviewNotFound":
      return gatewayPage(404, NO_SUCH_PREVIEW);
    case "PreviewUnavailable":
      return gatewayPage(503, "Previews are unavailable right now.");
    case "PreviewPoolFull":
      return answer(
        503,
        `No preview port is free. All ${error.size} ports this server serves previews on had a preview open within the last ${TAILNET_PORT_QUIET_HOURS} hours, and a port goes to another preview only after ${TAILNET_PORT_QUIET_HOURS} hours with no connection to its own. The next one frees at ${nextMinuteUtc(error.nextFreeAt)} at the earliest, if its preview stays closed until then. The operator can serve more ports (mend server setup --preview-tailnet-ports).`,
      );
  }
};

export type HeaderPair = readonly [name: string, value: string];

/** One request head as the parser read it: raw pairs in order, duplicates kept. */
export interface PreviewRequestHead {
  readonly method: string;
  readonly target: string;
  readonly headers: ReadonlyArray<HeaderPair>;
}

export const valuesOf = (headers: ReadonlyArray<HeaderPair>, name: string): Array<string> =>
  headers.flatMap(([field, value]) => (field.toLowerCase() === name ? [value] : []));

/** Comma-separated list members, trimmed and lowercased; an empty member is kept so it counts. */
export const membersOf = (headers: ReadonlyArray<HeaderPair>, name: string) =>
  valuesOf(headers, name).flatMap((value) =>
    value.split(",").map((member) => member.trim().toLowerCase()),
  );

const isOnly = (members: ReadonlyArray<string>, expected: string) =>
  members.length === 1 && members[0] === expected;

/**
 * Node's parser (llhttp, `insecureHTTPParser: false`) already refuses Content-Length beside
 * Transfer-Encoding, repeated or listed Content-Length, and repeated `chunked`, but passes other
 * codings, absolute-form, `*` and fragment targets and an Upgrade without `Connection: upgrade`.
 * Each row stands whatever the parser does, because the gateway forwards this head.
 */
const HEAD_REFUSALS: ReadonlyArray<{
  readonly refuses: (head: PreviewRequestHead) => boolean;
  readonly answer: PreviewAnswer;
}> = [
  {
    refuses: ({ headers }) =>
      membersOf(headers, "service-worker").includes("script") ||
      membersOf(headers, "sec-fetch-dest").includes("serviceworker"),
    answer: answer(403, "Refused."),
  },
  {
    refuses: ({ target }) =>
      !target.startsWith("/") || target.startsWith("//") || target.includes("#"),
    answer: answer(400, "Bad request."),
  },
  {
    refuses: ({ headers }) => {
      const lengths = membersOf(headers, "content-length");
      const codings = membersOf(headers, "transfer-encoding");
      return lengths.length > 0
        ? codings.length > 0 || lengths.length > 1 || !/^[0-9]+$/.test(lengths[0] ?? "")
        : codings.length > 0 && !isOnly(codings, "chunked");
    },
    answer: answer(400, "Bad request."),
  },
  {
    refuses: ({ headers }) => {
      const expectations = membersOf(headers, "expect");
      return expectations.length > 0 && !isOnly(expectations, "100-continue");
    },
    answer: answer(417, "Expectation failed."),
  },
  {
    refuses: ({ headers }) => {
      const protocols = membersOf(headers, "upgrade");
      return protocols.length > 0 && !isOnly(protocols, "websocket");
    },
    answer: answer(400, "Bad request."),
  },
  {
    // Node hands an upgrade's body over as the upgraded socket's first bytes: the app would read
    // it as WebSocket frames.
    refuses: ({ headers }) =>
      membersOf(headers, "upgrade").length > 0 &&
      (membersOf(headers, "transfer-encoding").length > 0 ||
        membersOf(headers, "content-length").some((length) => Number(length) > 0)),
    answer: answer(400, "Bad request."),
  },
];

export const headRefusal = (head: PreviewRequestHead): PreviewAnswer | null =>
  HEAD_REFUSALS.find((rule) => rule.refuses(head))?.answer ?? null;

export const queryOf = (target: string): string => {
  const mark = target.indexOf("?");
  return mark === -1 ? "" : target.slice(mark + 1);
};
