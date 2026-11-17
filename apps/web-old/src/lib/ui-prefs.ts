import { DEFAULT_INBOX_FILTERS, type InboxFilters } from "./inbox.ts";
import { createLocalStore } from "./local-store.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parse = (stored: unknown): InboxFilters => {
  if (!isRecord(stored)) return DEFAULT_INBOX_FILTERS;
  const { projectIds, startedBy, agent, branch } = stored;
  return {
    projectIds: Array.isArray(projectIds)
      ? projectIds.filter((id): id is string => typeof id === "string")
      : [],
    startedBy: startedBy === "anyone" ? "anyone" : "me",
    agent: typeof agent === "string" ? agent : null,
    branch: typeof branch === "string" ? branch : null,
  };
};

/** The inbox's filter line, kept per browser so the inbox reads the same on every page. */
export const inboxFilters = createLocalStore("mend-inbox-filters", parse, DEFAULT_INBOX_FILTERS);

/** Whether the rail shows labels and projects, kept per browser. */
export const railExpanded = createLocalStore(
  "mend-rail-expanded",
  (stored) => stored === true,
  false,
);

export type SkillLibraryView = "cards" | "list";

/** Whether the skill library shows cards or a list, kept per browser. */
export const skillLibraryView = createLocalStore<SkillLibraryView>(
  "mend-skill-library-view",
  (stored) => (stored === "list" ? "list" : "cards"),
  "cards",
);
