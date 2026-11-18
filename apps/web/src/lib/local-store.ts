import { useSyncExternalStore } from "react";

/**
 * One value kept in this browser's localStorage, read through `useSyncExternalStore` so every
 * component that shows it re-renders on a write, in this tab and in others. The server and the
 * first client render see `fallback`; `parse` turns whatever was stored into a valid value.
 */
export function createLocalStore<T>(
  key: string,
  parse: (stored: unknown) => T,
  fallback: T,
): {
  readonly use: () => T;
  readonly set: (value: T) => void;
} {
  const listeners = new Set<() => void>();
  let loaded = false;
  let current = fallback;

  const read = () => {
    if (loaded || typeof window === "undefined") return current;
    loaded = true;
    try {
      const raw = window.localStorage.getItem(key);
      current = raw === null ? fallback : parse(JSON.parse(raw));
    } catch {
      current = fallback;
    }
    return current;
  };

  const subscribe = (onChange: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      loaded = false;
      onChange();
    };
    listeners.add(onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  };

  return {
    use: () => useSyncExternalStore(subscribe, read, () => fallback),
    set: (value) => {
      current = value;
      loaded = true;
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Private browsing or a full quota: the choice still holds for this tab.
      }
      for (const listener of listeners) listener();
    },
  };
}
