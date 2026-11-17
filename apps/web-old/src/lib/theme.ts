import { useSyncExternalStore } from "react";

/**
 * The theme preference: the design system ships light and dark as one
 * structure (DESIGN.md §1 — warm-dark counterpart, same tokens), toggled by
 * the `.dark` class on <html>. "system" follows the OS and tracks its
 * changes live. A no-flash inline script in __root.tsx applies the class
 * before first paint from the same localStorage key.
 */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "mend-theme";
const listeners = new Set<() => void>();
let current: ThemePreference = "system";

const media =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

const resolveDark = (): boolean =>
  current === "dark" || (current === "system" && media?.matches === true);

const apply = () => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark());
};

if (typeof window !== "undefined") {
  const stored = localStorage.getItem(KEY);
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
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode without storage — the choice still applies for this tab.
  }
  apply();
  for (const listener of listeners) listener();
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => "system",
  );

/** True when the page is currently rendered dark (preference + OS resolved). */
export const useResolvedDark = (): boolean =>
  useSyncExternalStore(subscribe, resolveDark, () => false);
