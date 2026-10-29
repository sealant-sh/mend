export type SessionCookiePrefix = "" | "__Host-";

/** Better Auth's cookie prefix, before Mend's own `__Host-`. */
export const SESSION_COOKIE_BASE = "better-auth";

export type SessionCookieName = `${SessionCookiePrefix}${typeof SESSION_COOKIE_BASE}.session_token`;

/**
 * On every https APP_URL Mend's cookies are `__Host-` (ADR 0017), so `Path=/`, host-only and
 * `Secure`: a sibling host on Mend's site cannot set or replace them. Over http the prefix is off,
 * and a sibling host can plant a cookie for the whole site that Mend then reads.
 */
export const sessionCookiePrefix = (appUrl: string): SessionCookiePrefix =>
  appUrl.startsWith("https://") ? "__Host-" : "";

export const sessionCookieName = (appUrl: string): SessionCookieName =>
  `${sessionCookiePrefix(appUrl)}${SESSION_COOKIE_BASE}.session_token`;

/** The non-empty values a `Cookie` header gives the cookie named exactly `name`. */
export const cookieValues = (header: string | undefined, name: string): ReadonlyArray<string> =>
  (header ?? "").split(";").flatMap((pair) => {
    const at = pair.indexOf("=");
    if (at < 0 || pair.slice(0, at).trim() !== name) return [];
    const value = pair.slice(at + 1).trim();
    return value === "" ? [] : [value];
  });
