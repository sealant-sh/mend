import type { RouterAppContext } from "#/router";

/**
 * The reads one Settings tab needs before it shows: started at once from the route's loader, so
 * a tab never fetches in a waterfall. `ensureQueryData` for what the tab cannot draw without,
 * `prefetchQuery` for what it can show a pending line for.
 */
export type SettingsReads = (
  context: RouterAppContext,
  projectId: string,
) => ReadonlyArray<Promise<unknown>>;
