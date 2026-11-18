import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/**
 * Whether the browser says it has a network connection. The server render, and the first render
 * in the browser, assume it has: a page served at all was reached over one.
 */
export const useOnline = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );

const noChange = () => () => undefined;

/**
 * The address this Mend is reached at, as the account row and the loading line name it
 * ("mend.northwind.dev"). Empty in the server render; the browser fills it in as it hydrates.
 */
export const useServerHost = (): string =>
  useSyncExternalStore(
    noChange,
    () => window.location.host,
    () => "",
  );
