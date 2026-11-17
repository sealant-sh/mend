import { useHydrated } from "@tanstack/react-router";

import { clockTime } from "#/lib/session-view";

/**
 * A time of day in the reader's own time zone and locale. A page rendered on the server cannot
 * know them, so the time shows once the page is running in the browser: the server and the first
 * browser render agree on an empty `<time>`, and nothing is read in the wrong zone.
 */
export function Clock({ at, className }: { readonly at: string; readonly className?: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={at} className={className}>
      {hydrated ? clockTime(new Date(at)) : null}
    </time>
  );
}
