import { useSyncExternalStore } from "react";

import { createCookieStore } from "./cookie-store.ts";

/**
 * The theme preference: the design system ships light and dark as one
 * structure (DESIGN.md §1 — warm-dark counterpart, same tokens), toggled by
 * the `.dark` class on <html>. "system" follows the OS and tracks its
 * changes live. A no-flash inline script in __root.tsx applies the class
 * before first paint from the same localStorage key.
 *
 * The choice is also kept in a cookie, so the server renders the controls that show it (Settings
 * → Appearance, the account menu) as chosen. localStorage stays the source: the old app and the
 * no-flash script read it.
 */
export type ThemePreference = "system" | "light" | "dark";

/** The old app's key: a person's choice carries over between the two apps. */
export const THEME_KEY = "mend-theme";
const listeners = new Set<() => void>();
let current: ThemePreference = "system";

export const parseTheme = (stored: unknown): ThemePreference =>
  stored === "light" || stored === "dark" ? stored : "system";

const themeCookie = createCookieStore<ThemePreference>("mend-theme", parseTheme, "system");

const media =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

const resolveDark = (): boolean =>
  current === "dark" || (current === "system" && media?.matches === true);

const apply = () => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark());
};

if (typeof window !== "undefined") {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") current = stored;
  apply();
  media?.addEventListener("change", () => {
    if (current !== "system") return;
    apply();
    for (const listener of listeners) listener();
  });
}

export const setThemePreference = (next: ThemePreference): void => {
  current = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private mode without storage — the choice still applies for this tab.
  }
  themeCookie.set(next);
  apply();
  for (const listener of listeners) listener();
};

const subscribe = (onChange: () => void): (() => void) => {
  // Once the page has hydrated: a choice made before the cookie existed, or in the old app,
  // reaches the server from now on. Earlier, the hydrating render would read the new cookie and
  // disagree with what the server drew.
  if (themeCookie.read() !== current) themeCookie.set(current);
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(
    subscribe,
    () => current,
    // The server's render, and the browser's while it hydrates: the cookie's choice.
    themeCookie.read,
  );

/** True when the page is currently rendered dark (preference + OS resolved). */
export const useResolvedDark = (): boolean =>
  useSyncExternalStore(subscribe, resolveDark, () => false);
