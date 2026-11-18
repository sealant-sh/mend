import { createCookieStore } from "./cookie-store.ts";
import {
  DEFAULT_INBOX_FILTERS,
  DEFAULT_INBOX_FOLDS,
  INBOX_GROUPS,
  type InboxFilters,
  type InboxFolds,
} from "./inbox.ts";

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

/** Which inbox groups are open, kept per browser. */
export const inboxFolds = createCookieStore(
  "mend-inbox-folds",
  parseInboxFolds,
  DEFAULT_INBOX_FOLDS,
);
