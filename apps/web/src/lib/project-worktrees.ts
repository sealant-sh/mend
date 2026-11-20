import type { StatusTone } from "@mend/ui/components/status";

import {
  type ProjectDetailDto,
  sessionCaptureLine,
  sessionServicesHold,
  type WorktreeDto,
} from "./api.ts";
import { age } from "./inbox.ts";
import { LIVE_STATES, type ProjectSessionRow } from "./project-sessions.ts";

/** One session inside a worktree's row: its title, its status word, and whose it is. */
export interface WorktreeSession {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectSessionRow["status"];
  /** The owner's name when the session isn't the viewer's; null for the viewer's or unknown. */
  readonly owner: string | null;
}

/** What landing has done with the worktree's change, as the "Change" column says it. */
export interface WorktreeChange {
  /** "Pull request #412 open", or "Not landed". */
  readonly words: string;
  /** The pull request, when there is one. */
  readonly url: string | null;
  /** An open pull request reads in the ink colour; everything else is muted. */
  readonly open: boolean;
}

/** One worktree as the Worktrees tab lists it (Doop "Project · Worktrees"). */
export interface WorktreeRow {
  readonly worktree: WorktreeFacts;
  readonly name: string;
  readonly branch: string;
  /** The base as it was named, else its commit. */
  readonly base: string;
  readonly handedOffFrom: string | null;
  /** Newest first. */
  readonly sessions: ReadonlyArray<WorktreeSession>;
  readonly change: WorktreeChange;
  readonly changeId: string | null;
  readonly lastActive: Date;
  /** The most pressing status among its sessions (Waiting on you first); null with none. */
  readonly status: WorktreeSession["status"] | null;
  /**
   * No session in it is running, starting, stopping or saving, and nothing keeps its workspace
   * up: what Clear finished removes. The server still refuses one whose change isn't landed.
   */
  readonly finished: boolean;
}

/** Waiting on you first, then running, then failed, then the rest. */
const URGENCY: Readonly<Record<StatusTone, number>> = { wait: 0, run: 1, bad: 2, idle: 3, ok: 3 };

const changeOf = (
  pullRequest: ProjectDetailDto["worktreeAnnotations"][number]["pullRequest"] | undefined,
): WorktreeChange =>
  pullRequest === null || pullRequest === undefined
    ? { words: "Not landed", url: null, open: false }
    : {
        words: `Pull request #${pullRequest.number} ${pullRequest.state}`,
        url: pullRequest.url,
        open: pullRequest.state === "open",
      };

/**
 * The sessions that still hold their worktree: a live agent, a stop under way, a save, or a
 * Service keeping the workspace up. A worktree with none of them is finished.
 */
export const holdingSessions = (
  detail: Pick<ProjectDetailDto, "sessions" | "annotations">,
): ReadonlySet<string> => {
  const annotationOf = new Map(detail.annotations.map((note) => [note.sessionId, note]));
  return new Set(
    detail.sessions
      .filter((session) => {
        const annotation = annotationOf.get(session.id);
        return (
          LIVE_STATES.has(session.status) ||
          session.status === "stopping" ||
          sessionCaptureLine(session) !== null ||
          (annotation !== undefined &&
            sessionServicesHold(session, annotation.currentAgent, annotation.liveServices) !== null)
        );
      })
      .map((session) => session.id),
  );
};

/** What a row reads of a worktree. */
type WorktreeFacts = Pick<
  WorktreeDto,
  "id" | "name" | "branch" | "directory" | "baseRef" | "baseSha" | "handoff" | "updatedAt"
>;

/**
 * The project's worktrees with the sessions in each, most recently active first. `sessionRows`
 * are the Sessions tab's rows (`projectSessionRows`), so a session reads the same word on both
 * tabs; `held` is `holdingSessions`; `names` gives each member's name by user id.
 */
export const worktreeRows = (
  detail: {
    readonly worktrees: ReadonlyArray<WorktreeFacts>;
    readonly sessions: ReadonlyArray<{ readonly id: string; readonly worktreeId: string }>;
    readonly worktreeAnnotations: ReadonlyArray<
      Pick<
        ProjectDetailDto["worktreeAnnotations"][number],
        "worktreeId" | "changeId" | "pullRequest"
      >
    >;
  },
  sessionRows: ReadonlyArray<ProjectSessionRow>,
  held: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
  viewerId: string,
): ReadonlyArray<WorktreeRow> =>
  detail.worktrees
    .map((worktree): WorktreeRow => {
      const rows = sessionRows.filter((row) => row.worktreeId === worktree.id);
      const members = detail.sessions.filter((session) => session.worktreeId === worktree.id);
      const sessions = rows.map(
        (row): WorktreeSession => ({
          id: row.id,
          title: row.title,
          status: row.status,
          owner:
            row.ownerUserId === null || row.ownerUserId === viewerId
              ? null
              : (names.get(row.ownerUserId) ?? null),
        }),
      );
      const annotation = detail.worktreeAnnotations.find((note) => note.worktreeId === worktree.id);
      const newest = rows[0]?.updatedAt.getTime() ?? 0;
      const status = sessions.reduce<WorktreeSession["status"] | null>(
        (best, session) =>
          best === null || URGENCY[session.status.tone] < URGENCY[best.tone]
            ? session.status
            : best,
        null,
      );
      return {
        worktree,
        name: worktree.name,
        branch: worktree.branch,
        base: worktree.baseRef ?? worktree.baseSha.slice(0, 12),
        handedOffFrom: worktree.handoff?.machine ?? null,
        sessions,
        change: changeOf(annotation?.pullRequest),
        changeId: annotation?.changeId ?? null,
        lastActive: new Date(Math.max(newest, worktree.updatedAt.getTime())),
        status,
        finished: !members.some((session) => held.has(session.id)),
      };
    })
    .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime());

/** "Just now", "4m ago", "3h ago", "2 days ago": the desktop's Last active column. */
export const lastActiveWords = (date: Date, now: Date): string => {
  const short = age(date, now);
  if (short === "now") return "Just now";
  const days = /^(\d+)d$/.exec(short)?.[1];
  if (days === undefined) return `${short} ago`;
  return days === "1" ? "1 day ago" : `${days} days ago`;
};

/**
 * The phone row's second line (Doop "Phone · Project · Worktrees"): how many sessions, or whose
 * session when it is someone else's only one, then the change and how long ago. A worktree with
 * no sessions says where it starts from when that isn't the default branch.
 */
export const phoneLine = (row: WorktreeRow, defaultBranch: string, now: Date): string => {
  const [only] = row.sessions;
  const who =
    row.sessions.length === 0
      ? "No sessions yet"
      : row.sessions.length === 1 && only !== undefined && only.owner !== null
        ? only.owner
        : `${row.sessions.length} ${row.sessions.length === 1 ? "session" : "sessions"}`;
  const from = row.sessions.length === 0 && row.base !== defaultBranch ? `from ${row.base}` : null;
  return [who, from ?? row.change.words, age(row.lastActive, now)].join(" · ");
};
