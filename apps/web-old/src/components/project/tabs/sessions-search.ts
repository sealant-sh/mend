/**
 * The Sessions tab's search, parsed before anything renders: its own module, so the route does not
 * bring the tab's filter menus with it.
 */

/**
 * The filters as the URL keeps them: only what differs from the default ("Mine"), so a plain
 * project link opens on your own sessions and a filtered one survives a reload.
 */
export interface ProjectSessionSearch {
  readonly who?: "anyone";
  readonly agent?: string;
  readonly branch?: string;
}

export const parseSessionSearch = (search: Record<string, unknown>): ProjectSessionSearch => ({
  ...(search["who"] === "anyone" ? { who: "anyone" as const } : {}),
  ...(typeof search["agent"] === "string" && search["agent"] !== ""
    ? { agent: search["agent"] }
    : {}),
  ...(typeof search["branch"] === "string" && search["branch"] !== ""
    ? { branch: search["branch"] }
    : {}),
});
