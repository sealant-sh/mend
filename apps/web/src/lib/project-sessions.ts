import type { LumpPr, LumpStatus } from "@mend/ui/components/lump";
import type { StatusTone } from "@mend/ui/components/status";

import type { ProjectDetailDto } from "./api.ts";
import { type InboxRow, rowLump, rowPr, SESSION_WORDS, statusTone, statusWord } from "./inbox.ts";
import type { ProjectSessionsSearch } from "./project-sessions-search.ts";

/**
 * A project's Sessions tab: every session in the project, from the project's own read (which
 * lists ended sessions the inbox no longer carries), with what the inbox read says of the ones it
 * carries (the title, what the agent is doing, why it failed, how many files its change has).
 * Filters live in the address (`project-sessions-search.ts`).
 */

type DetailSession = ProjectDetailDto["sessions"][number];

/** One session as the tab lists it. */
export interface ProjectSessionRow {
  readonly id: string;
  readonly title: string;
  /** The word, its tone and the session glyph, as the sidebar row says and draws them. */
  readonly status: {
    readonly word: string;
    readonly tone: StatusTone;
    readonly lump: LumpStatus;
    readonly pr: LumpPr;
  };
  /** Open: running, waiting, or ended with a change to review. Stopped: the rest. */
  readonly open: boolean;
  readonly worktreeId: string;
  /** The worktree's name, as `mend` names it. */
  readonly worktree: string;
  readonly branch: string;
  readonly agent: string;
  /** The model it was started with; null when none was recorded. */
  readonly model: string | null;
  readonly ownerUserId: string | null;
  readonly updatedAt: Date;
  readonly changeId: string | null;
  /** How many files its change has, as the server last counted; null when not counted. */
  readonly fileCount: number | null;
  /** The machine its worktree was handed off from (`mend handoff`), else null. */
  readonly handedOffFrom: string | null;
}

const ENDED: ReadonlySet<DetailSession["status"]> = new Set(["completed", "failed", "stopped"]);

/**
 * The glyph of a session the inbox doesn't carry (it ended a while ago, or the read failed), from
 * its status alone, as the inbox would draw it with nothing asking.
 */
const LONE_LUMPS: Readonly<Record<DetailSession["status"], LumpStatus>> = {
  starting: "run",
  running: "run",
  waiting: "wait",
  idle: "idle",
  stopping: "run",
  completed: "done",
  failed: "fail",
  stopped: "stop",
};

/** What a session is called when nothing names it: its agent and short id. */
const fallbackTitle = (session: Pick<DetailSession, "id" | "label" | "harness">): string =>
  session.label ?? `${session.harness} session ${session.id.slice(0, 8)}`;

/**
 * The tab's rows, newest activity first. `inbox` is the inbox read placed with no marks (a
 * person's snoozes and Done marks are their inbox's, not the project's), so a session is open
 * when the inbox would show it anywhere but Done.
 */
export const projectSessionRows = (
  detail: {
    readonly sessions: ReadonlyArray<
      Pick<
        DetailSession,
        | "id"
        | "label"
        | "harness"
        | "status"
        | "worktreeId"
        | "branch"
        | "model"
        | "ownerUserId"
        | "updatedAt"
      >
    >;
    readonly worktrees: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly handoff: { readonly machine: string } | null;
    }>;
    readonly annotations: ReadonlyArray<{
      readonly sessionId: string;
      readonly changeId: string | null;
    }>;
  },
  inbox: ReadonlyArray<InboxRow>,
): ReadonlyArray<ProjectSessionRow> => {
  const inboxOf = new Map(inbox.map((row) => [row.session.id, row]));
  const worktreeOf = new Map(detail.worktrees.map((worktree) => [worktree.id, worktree]));
  const annotationOf = new Map(detail.annotations.map((note) => [note.sessionId, note]));
  return detail.sessions
    .map((session): ProjectSessionRow => {
      const row = inboxOf.get(session.id);
      const worktree = worktreeOf.get(session.worktreeId);
      // One word per session: the sidebar's row reads the same function (`statusWord`).
      const lump = row === undefined ? LONE_LUMPS[session.status] : rowLump(row);
      const status = {
        word: row === undefined ? SESSION_WORDS[session.status] : statusWord(row).word,
        tone: statusTone(lump),
        lump,
        pr: row === undefined ? ("none" as const) : rowPr(row),
      };
      return {
        id: session.id,
        title: row?.title ?? fallbackTitle(session),
        status,
        open: row === undefined ? !ENDED.has(session.status) : row.group !== "done",
        worktreeId: session.worktreeId,
        worktree: row?.worktreeName ?? worktree?.name ?? session.branch,
        branch: session.branch,
        agent: session.harness,
        model: session.model,
        ownerUserId: session.ownerUserId,
        updatedAt: row?.session.updatedAt ?? session.updatedAt,
        changeId: row?.annotation?.changeId ?? annotationOf.get(session.id)?.changeId ?? null,
        fileCount: row?.annotation?.fileCount ?? null,
        handedOffFrom: worktree?.handoff?.machine ?? null,
      };
    })
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
};

/** Whether a row holds every word of the search, in its title, worktree or branch. */
export const matchesSessionQuery = (
  row: Pick<ProjectSessionRow, "title" | "worktree" | "branch">,
  query: string,
): boolean => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${row.title}\n${row.worktree}\n${row.branch}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/** The rows the filters let through, Open or Stopped aside: who, agent, branch and words. */
export const matchesSessionFilters = (
  row: ProjectSessionRow,
  search: ProjectSessionsSearch,
  viewerId: string,
): boolean =>
  (search.who !== "mine" || row.ownerUserId === viewerId) &&
  (search.agent === undefined || row.agent === search.agent) &&
  (search.branch === undefined || row.branch === search.branch) &&
  (search.q === undefined || matchesSessionQuery(row, search.q));

/** The agents and branches the Filter menu offers: those the project's sessions used. */
export const filterChoices = (
  rows: ReadonlyArray<Pick<ProjectSessionRow, "agent" | "branch">>,
): { readonly agents: ReadonlyArray<string>; readonly branches: ReadonlyArray<string> } => ({
  agents: [...new Set(rows.map((row) => row.agent))].toSorted(),
  branches: [...new Set(rows.map((row) => row.branch))].toSorted(),
});

/** "Any agent · Any branch", or what is picked. */
export const filterWords = (search: Pick<ProjectSessionsSearch, "agent" | "branch">): string =>
  `${search.agent ?? "Any agent"} · ${search.branch ?? "Any branch"}`;

/**
 * The line over a filtered list: `3 of 6 open sessions match "retry".` Null when nothing narrows
 * the list but Open or Stopped.
 */
export const matchLine = (
  shown: number,
  of: number,
  search: ProjectSessionsSearch,
): string | null => {
  const narrowed =
    search.q !== undefined ||
    search.who === "mine" ||
    search.agent !== undefined ||
    search.branch !== undefined;
  if (!narrowed) return null;
  const which = search.show === "stopped" ? "stopped" : "open";
  const noun = of === 1 ? "session" : "sessions";
  const verb = shown === 1 ? "matches" : "match";
  const what = search.q === undefined ? "these filters" : `"${search.q.trim()}"`;
  return `${shown} of ${of} ${which} ${noun} ${verb} ${what}.`;
};

/**
 * A title split around the search's words, for the list to set the matches in bold. Each part
 * says whether it matched.
 */
export const highlightParts = (
  value: string,
  query: string | undefined,
): ReadonlyArray<{ readonly text: string; readonly match: boolean }> => {
  const words = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [{ text: value, match: false }];
  const lower = value.toLowerCase();
  const marked: boolean[] = Array.from({ length: value.length }, () => false);
  for (const word of words) {
    let from = lower.indexOf(word);
    while (from !== -1) {
      for (let i = from; i < from + word.length; i += 1) marked[i] = true;
      from = lower.indexOf(word, from + word.length);
    }
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const match = marked[i] === true;
    const last = parts.at(-1);
    if (last !== undefined && last.match === match) last.text += value[i];
    else parts.push({ text: value[i] ?? "", match });
  }
  return parts;
};

/** Live states: a session whose agent or command can still run or answer. */
export const LIVE_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** "2 sessions" while any run in a worktree, "stopped" when none does. */
export const worktreeLiveWords = (live: number): string =>
  live === 0 ? "Stopped" : `${live} ${live === 1 ? "session" : "sessions"}`;

/**
 * The worktrees a shell or a session can start in, newest first, each with how many of its
 * sessions are live.
 */
export const worktreeChoices = (detail: {
  readonly sessions: ReadonlyArray<{ readonly worktreeId: string; readonly status: string }>;
  readonly worktrees: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly updatedAt: Date;
  }>;
}): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly live: number;
}> =>
  detail.worktrees
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((worktree) => ({
      id: worktree.id,
      name: worktree.name,
      branch: worktree.branch,
      live: detail.sessions.filter(
        (session) => session.worktreeId === worktree.id && LIVE_STATES.has(session.status),
      ).length,
    }));
