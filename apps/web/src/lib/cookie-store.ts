import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useSyncExternalStore } from "react";

/** One cookie's raw value out of a `Cookie` header or `document.cookie`, undefined when unset. */
export const cookieValue = (cookies: string, name: string): string | undefined => {
  for (const pair of cookies.split(";")) {
    const at = pair.indexOf("=");
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
};

/** The cookie as this page sees it: the request's on the server, the document's in the browser. */
const readCookie = createIsomorphicFn()
  .server((name: string) => cookieValue(getRequest().headers.get("cookie") ?? "", name))
  .client((name: string) => cookieValue(document.cookie, name));

const YEAR_S = 60 * 60 * 24 * 365;

/**
 * One value this browser keeps, in a cookie, so the server renders the page with it: a folded
 * group or a picked filter shows as kept from the first paint, with no jump as the page hydrates.
 * Every component that shows it re-renders on a write in this tab. `parse` turns whatever was
 * stored into a valid value; anything it can't read is `fallback`.
 */
export function createCookieStore<T>(
  name: string,
  parse: (stored: unknown) => T,
  fallback: T,
): {
  readonly use: () => T;
  readonly set: (value: T) => void;
} {
  const listeners = new Set<() => void>();
  // The last raw value read and what it parsed to, so a read that finds the same cookie returns
  // the same value (useSyncExternalStore compares snapshots by identity).
  let last: { readonly raw: string | undefined; readonly value: T } | null = null;

  const snapshot = (): T => {
    const raw = readCookie(name);
    if (last !== null && last.raw === raw) return last.value;
    let value = fallback;
    if (raw !== undefined) {
      try {
        value = parse(JSON.parse(decodeURIComponent(raw)));
      } catch {
        value = fallback;
      }
    }
    last = { raw, value };
    return value;
  };

  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  };

  return {
    use: () => useSyncExternalStore(subscribe, snapshot, snapshot),
    set: (value) => {
      document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; path=/; max-age=${YEAR_S}; samesite=lax`;
      for (const listener of listeners) listener();
    },
  };
}
