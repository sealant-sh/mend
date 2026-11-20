import { fuzzyFilter } from "./fuzzy.ts";
import { askLine, type InboxRow } from "./inbox.ts";
import { STATUS_WORDS } from "./session-sheet.ts";

/**
 * Search from anywhere (⌘K, the sidebar's field, the phone inbox's search): what it finds in the
 * lists the app already holds. Sessions come from the inbox's read (every session the person can
 * see, filters aside), projects from `projects.list`, skills from `skills.list`, and the actions
 * from what the page can do. Nothing here asks the server to search.
 */

/** What an action does; the caller offers only the ones that lead somewhere. */
export type SearchActionId = "new-session" | "add-project" | "toggle-sidebar";

export interface SearchAction {
  readonly id: SearchActionId;
  readonly name: string;
  /** Its own shortcut, as the palette shows it beside the name: "⌘B" or "Ctrl B". */
  readonly keys?: string;
}

export interface SearchProject {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
}

export interface SearchSkill {
  readonly id: string;
  readonly name: string;
}

export interface SearchSources {
  /** Newest activity first, as the inbox orders them. */
  readonly sessions: ReadonlyArray<InboxRow>;
  readonly projects: ReadonlyArray<SearchProject>;
  readonly skills: ReadonlyArray<SearchSkill>;
  readonly actions: ReadonlyArray<SearchAction>;
}

/** One result: what it is, and which characters of its name the query matched. */
export type SearchHit = { readonly key: string; readonly indices: ReadonlyArray<number> } & (
  | { readonly kind: "action"; readonly action: SearchAction }
  | { readonly kind: "session"; readonly row: InboxRow }
  | { readonly kind: "project"; readonly project: SearchProject }
  | { readonly kind: "skill"; readonly skill: SearchSkill }
);

export interface SearchGroup {
  readonly heading: string;
  readonly hits: ReadonlyArray<SearchHit>;
}

export interface SearchResults {
  readonly groups: ReadonlyArray<SearchGroup>;
  /** How many results the groups hold; null with nothing typed. */
  readonly count: number | null;
}

/** How many of each kind are listed for a query: type more to find the rest. */
const LISTED = { action: 4, session: 8, project: 5, skill: 5 } as const;

/**
 * The palette's groups. With nothing typed: the most recent `recent` sessions, then the actions.
 * With a query: Actions, Sessions, Projects and Skills that match it, best first, each group
 * left out when nothing in it matches.
 */
export const searchResults = (
  sources: SearchSources,
  query: string,
  recent: number,
): SearchResults => {
  if (query.trim() === "") {
    const groups: ReadonlyArray<SearchGroup> = [
      { heading: "Recent sessions", hits: sources.sessions.slice(0, recent).map(sessionHit([])) },
      { heading: "Actions", hits: sources.actions.map(actionHit([])) },
    ];
    return { groups: groups.filter((group) => group.hits.length > 0), count: null };
  }
  const groups: ReadonlyArray<SearchGroup> = [
    {
      heading: "Actions",
      hits: fuzzyFilter(sources.actions, query, (action) => action.name)
        .slice(0, LISTED.action)
        .map(({ item, match }) => actionHit(match.indices)(item)),
    },
    {
      heading: "Sessions",
      hits: fuzzyFilter(sources.sessions, query, (row) => row.title)
        .slice(0, LISTED.session)
        .map(({ item, match }) => sessionHit(match.indices)(item)),
    },
    {
      heading: "Projects",
      hits: fuzzyFilter(sources.projects, query, (project) => project.name)
        .slice(0, LISTED.project)
        .map(({ item, match }) => ({
          kind: "project" as const,
          key: `project:${item.id}`,
          indices: match.indices,
          project: item,
        })),
    },
    {
      heading: "Skills",
      hits: fuzzyFilter(sources.skills, query, (skill) => skill.name)
        .slice(0, LISTED.skill)
        .map(({ item, match }) => ({
          kind: "skill" as const,
          key: `skill:${item.id}`,
          indices: match.indices,
          skill: item,
        })),
    },
  ].filter((group) => group.hits.length > 0);
  return { groups, count: groups.reduce((total, group) => total + group.hits.length, 0) };
};

const sessionHit =
  (indices: ReadonlyArray<number>) =>
  (row: InboxRow): SearchHit => ({
    kind: "session",
    key: `session:${row.session.id}`,
    indices,
    row,
  });

const actionHit =
  (indices: ReadonlyArray<number>) =>
  (action: SearchAction): SearchHit => ({
    kind: "action",
    key: `action:${action.id}`,
    indices,
    action,
  });

/** Every hit in the order the groups list them: Enter on the phone opens the first. */
export const allHits = (results: SearchResults): ReadonlyArray<SearchHit> =>
  results.groups.flatMap((group) => group.hits);

/** "1 result", "4 results", "0 results". */
export const countWords = (count: number): string =>
  count === 1 ? "1 result" : `${count} results`;

/**
 * A session's status as a result shows it: a word, amber when it waits on you, red if failed. A
 * waiting session says what it waits on, as its inbox row does ("Wants to run pnpm test").
 */
export const sessionStatus = (
  row: InboxRow,
): { readonly word: string; readonly tone: "wait" | "bad" | "idle" } => {
  const { status } = row.session;
  return {
    word: status === "waiting" ? askLine(row.ask) : STATUS_WORDS[status],
    tone: status === "waiting" ? "wait" : status === "failed" ? "bad" : "idle",
  };
};
