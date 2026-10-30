import { requestPathOf, routedPath } from "./request-path.ts";

const HANDED_LINK_PAGES = {
  invitation: "/join",
  passwordReset: "/reset",
  slackLink: "/slack/link",
} as const;

export type HandedLinkKind = keyof typeof HANDED_LINK_PAGES;

export type HandedLinkRead =
  | { readonly _tag: "Fragment"; readonly secret: string }
  | { readonly _tag: "Path"; readonly secret: string }
  | { readonly _tag: "Incomplete" };

export interface HandedLinkLocation {
  readonly pathname: string;
  readonly hash: string;
}

const MAX_ENCODED_SECRET = 512;
const SECRET = /^[\x21-\x7e]{1,256}$/;
const INCOMPLETE: HandedLinkRead = { _tag: "Incomplete" };

export const handedLinkPath = (kind: HandedLinkKind, secret: string): string =>
  `${HANDED_LINK_PAGES[kind]}#${encodeURIComponent(secret)}`;

const decodedSecret = (encoded: string): string | null => {
  if (encoded.length > MAX_ENCODED_SECRET) return null;
  try {
    const secret = decodeURIComponent(encoded);
    return SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
};

/** `location` as the browser holds it: the pathname and the hash still percent-encoded. */
export const readHandedLink = (
  kind: HandedLinkKind,
  location: HandedLinkLocation,
): HandedLinkRead => {
  const page = HANDED_LINK_PAGES[kind];
  const pathname = location.pathname.replace(/\/$/, "");
  const fragment = location.hash.replace(/^#/, "");
  const secret = (encoded: string, _tag: "Fragment" | "Path"): HandedLinkRead => {
    const decoded = decodedSecret(encoded);
    return decoded === null ? INCOMPLETE : { _tag, secret: decoded };
  };
  const lowered = pathname.toLowerCase();
  if (lowered === page) return secret(fragment, "Fragment");
  if (!lowered.startsWith(`${page}/`) || fragment !== "") return INCOMPLETE;
  const segment = pathname.slice(page.length + 1);
  return segment.includes("/") ? INCOMPLETE : secret(segment, "Path");
};

/** Where a link's page belongs: its fragment form, or the bare page when it holds no secret. */
export const canonicalHandedLinkPath = (
  kind: HandedLinkKind,
  location: HandedLinkLocation,
): string => {
  const read = readHandedLink(kind, location);
  return read._tag === "Incomplete" ? HANDED_LINK_PAGES[kind] : handedLinkPath(kind, read.secret);
};

export const isHandedLinkPage = (target: string): boolean => {
  const pathname = routedPath(requestPathOf(target));
  return Object.values(HANDED_LINK_PAGES).some(
    (page) => pathname === page || pathname.startsWith(`${page}/`),
  );
};
