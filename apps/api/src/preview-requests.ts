import { Brand } from "effect";

import type { PreviewNoIdentity, PreviewNotFound, PreviewUnavailable } from "./preview-identity.ts";
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

export interface BrowserHead {
  readonly method: string;
  readonly upgrade: boolean;
  readonly origins: ReadonlyArray<string>;
  readonly fetchSite: string | undefined;
  readonly fetchMode: string | undefined;
  readonly fetchDest: string | undefined;
}

const FETCH_SITES = new Set(["none", "same-origin", "same-site", "cross-site"]);

export const isDocumentNavigation = (head: BrowserHead): boolean =>
  head.method === "GET" &&
  !head.upgrade &&
  head.fetchMode === "navigate" &&
  head.fetchDest === "document";

export const browserAdmits = (head: BrowserHead, own: PreviewOrigin): boolean => {
  if (head.origins.length > 1) return false;
  const [origin] = head.origins;
  if (origin !== undefined && origin !== own) return false;
  const safe = (head.method === "GET" || head.method === "HEAD") && !head.upgrade;
  if (origin === undefined && !safe) return false;
  if (head.fetchSite === undefined) return true;
  if (!FETCH_SITES.has(head.fetchSite)) return false;
  return head.fetchSite === "same-site" || head.fetchSite === "cross-site"
    ? isDocumentNavigation(head)
    : true;
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

export const redirect = (
  status: 302 | 303,
  location: string,
  headers: Readonly<Record<string, string>> = {},
): PreviewAnswer => answer(status, "", { location, ...headers });

export const refusalAnswer = (
  error: PreviewNoIdentity | PreviewNotFound | PreviewUnavailable,
): PreviewAnswer => {
  switch (error._tag) {
    case "PreviewNoIdentity":
      return answer(401, "Not signed in to this preview.");
    case "PreviewNotFound":
      return answer(404, "No such preview.");
    case "PreviewUnavailable":
      return answer(503, "Previews are unavailable right now.");
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
