import { useSyncExternalStore } from "react";

/** Under 1024px the app takes the phone layout (DESIGN.md, the "Phone · " frames). */
const PHONE_QUERY = "(max-width: 1023.98px)";

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * Whether the screen is phone width, for the few kit components that take their touch size as a
 * prop (`CopyField`, `InlineAlert`). Layout itself follows the width in CSS (`max-lg:`). The server
 * renders the desktop size.
 */
export const usePhone = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
