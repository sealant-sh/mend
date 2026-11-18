import { createCookieStore } from "./cookie-store.ts";
import {
  DEFAULT_INBOX_FILTERS,
  DEFAULT_INBOX_FOLDS,
  INBOX_GROUPS,
  type InboxFilters,
  type InboxFolds,
} from "./inbox.ts";
import { parseKeptArrangements } from "./tiles.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads what this browser kept for the inbox filters; anything else is the default. */
export const parseInboxFilters = (stored: unknown): InboxFilters => {
  if (!isRecord(stored)) return DEFAULT_INBOX_FILTERS;
  const { projectId, mine } = stored;
  return {
    projectId: typeof projectId === "string" ? projectId : null,
    mine: typeof mine === "boolean" ? mine : true,
  };
};

/** Which groups are open, by group; a group this browser never folded keeps its default. */
export const parseInboxFolds = (stored: unknown): InboxFolds => {
  if (!isRecord(stored)) return DEFAULT_INBOX_FOLDS;
  const folds = { ...DEFAULT_INBOX_FOLDS };
  for (const { group } of INBOX_GROUPS) {
    const open = stored[group];
    if (typeof open === "boolean") folds[group] = open;
  }
  return folds;
};

/** The inbox's two filters, kept per browser so the inbox reads the same on every page. */
export const inboxFilters = createCookieStore(
  "mend-inbox-filters",
  parseInboxFilters,
  DEFAULT_INBOX_FILTERS,
);

/** Whether the sidebar is open in full; anything but a kept `false` opens it. */
export const parseSidebarExpanded = (stored: unknown): boolean => stored !== false;

/**
 * The sidebar open in full or folded to its rail, kept per browser in a cookie, so the server
 * renders the page the way it was left and nothing jumps as it hydrates.
 */
export const sidebarExpanded = createCookieStore(
  "mend-sidebar-expanded",
  parseSidebarExpanded,
  true,
);

/** Which inbox groups are open, kept per browser. */
export const inboxFolds = createCookieStore(
  "mend-inbox-folds",
  parseInboxFolds,
  DEFAULT_INBOX_FOLDS,
);

/**
 * How each workspace's sheet is split into tiles, for the last few workspaces used in this
 * browser (`keepArrangement` says how many fit), so the server renders a session's sheet as it was
 * left.
 */
export const tileArrangements = createCookieStore("mend-tiles", parseKeptArrangements, []);
