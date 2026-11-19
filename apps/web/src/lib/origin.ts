import { useSyncExternalStore } from "react";

const noChange = () => () => {};

/** This server's address as the browser reached it, for `mend login --url`; empty while rendering on the server. */
export const useOrigin = (): string =>
  useSyncExternalStore(
    noChange,
    () => window.location.origin,
    () => "",
  );
