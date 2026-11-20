/**
 * A table row with one destination (a project, a session) opens it from anywhere on the row: the
 * row's one link stretches over the whole row, so the row is still a single stop for the keyboard,
 * Enter opens it, and a middle-click or ⌘-click opens it in a new tab. Every other control in the
 * row sits above the stretched link and keeps working on its own.
 *
 * - `LINK_ROW` on the row (`TableRow`): the box the link stretches over.
 * - `ROW_LINK` on the row's link: covers the row, and underlines while the row is pointed at.
 * - `ABOVE_ROW_LINK` on each other control in the row (its "…").
 */
export const LINK_ROW = "group/link-row relative";
export const ROW_LINK = "group-hover/link-row:underline after:absolute after:inset-0";
export const ABOVE_ROW_LINK = "relative z-10";
