/**
 * The workspace views' ids, in the "+" menu's order, and nothing else: the route that serves a
 * view's address (`/sessions/<id>/<view>`) checks its name against this list before it loads, and
 * a route's `beforeLoad` rides in the route tree's chunk on every page, so it must not reach any
 * view's code. `WORKSPACE_VIEWS` (`views.tsx`) holds an entry for each id, in this order; its test
 * says so.
 */
export const WORKSPACE_VIEW_IDS = [
  "change",
  "checks",
  "preview",
  "terminal",
  "screen",
  "record",
  "details",
] as const;

export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];

export const isWorkspaceViewId = (id: string): id is WorkspaceViewId =>
  WORKSPACE_VIEW_IDS.some((known) => known === id);
