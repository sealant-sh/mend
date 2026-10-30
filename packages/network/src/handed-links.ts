const HANDED_LINK_PAGES = {
  invitation: "/join",
  passwordReset: "/reset",
  slackLink: "/slack/link",
} as const;

export type HandedLinkKind = keyof typeof HANDED_LINK_PAGES;

export const HANDED_LINK_PAGE_PATHS: ReadonlyArray<string> = Object.values(HANDED_LINK_PAGES);

/**
 * What every issuer mints: 32 random bytes in base64url for an invitation or a reset, `msl_` and
 * the same for a Slack code. The verify skill's redaction reads the same shape.
 */
export const HANDED_LINK_SECRET_SHAPE = "[A-Za-z0-9_-]{8,256}";
const SECRET = new RegExp(`^${HANDED_LINK_SECRET_SHAPE}$`);

export const handedLinkPath = (kind: HandedLinkKind, secret: string): string => {
  if (!SECRET.test(secret)) throw new Error(`A ${kind} link's secret is not ${SECRET.source}`);
  return `${HANDED_LINK_PAGES[kind]}#${secret}`;
};

const decodedSecret = (encoded: string): string | null => {
  try {
    const secret = decodeURIComponent(encoded);
    return SECRET.test(secret) ? secret : null;
  } catch {
    return null;
  }
};

/** `hash` as the browser holds it, still percent-encoded: a link page's secret, or none. */
export const fragmentSecret = (hash: string): string | null =>
  decodedSecret(hash.replace(/^#/, ""));

/** The secret of a link issued before the fragment, `/join/<token>`, or none. */
export const legacyPathSecret = (kind: HandedLinkKind, pathname: string): string | null => {
  const page = HANDED_LINK_PAGES[kind];
  const trimmed = pathname.replace(/\/$/, "");
  if (!trimmed.toLowerCase().startsWith(`${page}/`)) return null;
  const segment = trimmed.slice(page.length + 1);
  return segment.includes("/") ? null : decodedSecret(segment);
};

/**
 * Where a link issued before the fragment moves to: its fragment form, or the bare page when its
 * path holds no secret or it carries a fragment as well, since then which one is meant is unknown.
 */
export const fragmentFormOf = (
  kind: HandedLinkKind,
  location: { readonly pathname: string; readonly hash: string },
): string => {
  const secret = location.hash === "" ? legacyPathSecret(kind, location.pathname) : null;
  return secret === null ? HANDED_LINK_PAGES[kind] : handedLinkPath(kind, secret);
};
