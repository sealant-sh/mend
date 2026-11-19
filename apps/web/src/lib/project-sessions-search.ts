/**
 * A project's Sessions tab keeps its filters in the address, so a filtered list can be linked and
 * reloaded. A route's `validateSearch` and `beforeLoad` ride in the route tree's chunk on every page, so this module stays apart from the tab's rows (`project-sessions.ts`).
 */

/** The filters as the address keeps them: only what differs from the default. */
export interface ProjectSessionsSearch {
  /** Words to find in a session's title, worktree or branch. */
  readonly q?: string;
  /** Only the viewer's own sessions; absent is everyone's. */
  readonly who?: "mine";
  /** The stopped sessions; absent is the open ones. */
  readonly show?: "stopped";
  readonly agent?: string;
  readonly branch?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Read the tab's filters from the address; anything else there is dropped. */
export const parseProjectSessionsSearch = (
  search: Record<string, unknown>,
): ProjectSessionsSearch => {
  const q = text(search["q"]);
  const agent = text(search["agent"]);
  const branch = text(search["branch"]);
  return {
    ...(q === undefined ? {} : { q }),
    ...(search["who"] === "mine" ? { who: "mine" as const } : {}),
    ...(search["show"] === "stopped" ? { show: "stopped" as const } : {}),
    ...(agent === undefined ? {} : { agent }),
    ...(branch === undefined ? {} : { branch }),
  };
};
