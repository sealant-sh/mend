const HANDED_LINK_PAGES = {
  invitation: "/join",
  passwordReset: "/reset",
  slackLink: "/slack/link",
} as const;

export type HandedLinkKind = keyof typeof HANDED_LINK_PAGES;

export const INVITATION_HEADER = "x-mend-invitation";

export const HANDED_LINK_PAGE_PATHS: ReadonlyArray<string> = Object.values(HANDED_LINK_PAGES);

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

export const fragmentSecret = (encodedHash: string): string | null =>
  decodedSecret(encodedHash.replace(/^#/, ""));

export const legacyPathSecret = (kind: HandedLinkKind, pathname: string): string | null => {
  const page = HANDED_LINK_PAGES[kind];
  const trimmed = pathname.replace(/\/$/, "");
  if (!trimmed.toLowerCase().startsWith(`${page}/`)) return null;
  const segment = trimmed.slice(page.length + 1);
  return segment.includes("/") ? null : decodedSecret(segment);
};

export const fragmentFormOf = (
  kind: HandedLinkKind,
  location: { readonly pathname: string; readonly hash: string },
): string => {
  const pathAndFragmentBothNamed = location.hash !== "";
  const secret = pathAndFragmentBothNamed ? null : legacyPathSecret(kind, location.pathname);
  return secret === null ? HANDED_LINK_PAGES[kind] : handedLinkPath(kind, secret);
};
