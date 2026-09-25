import {
  sessionServicesHold,
  type SessionAnnotationDto,
  type SessionDto,
  type WorktreeAnnotationDto,
  type WorktreeDto,
} from "#/lib/api";
import { LIVE_STATES } from "#/lib/workbench-menus";

/**
 * The container tier the project page renders: one worktree with the sessions
 * that inhabit it and its DB-cheap review facts. Every value here is read from
 * the project detail payload — nothing is derived that git would have to answer.
 */
export interface WorktreeGroup {
  readonly worktree: WorktreeDto;
  readonly members: ReadonlyArray<SessionDto>;
  readonly annotation: WorktreeAnnotationDto | undefined;
  /**
   * Per member session, what it reads while its agent is no longer live and its Services keep
   * the workspace up (`agent stopped · 3 services keep the workspace up`). Absent otherwise.
   */
  readonly holds: ReadonlyMap<string, string>;
  /** Conversations with a live process behind them, or Services that keep their workspace up. */
  readonly live: number;
  readonly newest: SessionDto | null;
}

/**
 * Group sessions under their worktree, live worktrees first, then newest
 * activity first. Live is a worktree-level fact: any live conversation makes
 * the container live.
 */
export const worktreeGroups = (
  worktrees: ReadonlyArray<WorktreeDto>,
  sessions: ReadonlyArray<SessionDto>,
  worktreeAnnotations: ReadonlyArray<WorktreeAnnotationDto>,
  sessionAnnotations: ReadonlyArray<SessionAnnotationDto> = [],
): ReadonlyArray<WorktreeGroup> =>
  worktrees
    .map((worktree): WorktreeGroup => {
      const members = sessions.filter((session) => session.worktreeId === worktree.id);
      const holds = new Map<string, string>();
      for (const session of members) {
        const facts = sessionAnnotations.find((row) => row.sessionId === session.id);
        if (facts === undefined) continue;
        const hold = sessionServicesHold(session, facts.currentAgent, facts.liveServices);
        if (hold !== null) holds.set(session.id, hold);
      }
      return {
        worktree,
        members,
        annotation: worktreeAnnotations.find((row) => row.worktreeId === worktree.id),
        holds,
        live: members.filter((session) => LIVE_STATES.has(session.status) || holds.has(session.id))
          .length,
        newest: members[0] ?? null,
      };
    })
    .toSorted((a, b) => {
      if (a.live > 0 !== b.live > 0) return a.live > 0 ? -1 : 1;
      const aAt = a.newest?.createdAt ?? a.worktree.createdAt;
      const bAt = b.newest?.createdAt ?? b.worktree.createdAt;
      return bAt.getTime() - aAt.getTime();
    });

/** Worktrees with no live conversation — what "Clear settled" would remove. */
export const settledGroups = (groups: ReadonlyArray<WorktreeGroup>): ReadonlyArray<WorktreeGroup> =>
  groups.filter((group) => group.live === 0);

/** The worktree's base as it was named, falling back to the recorded sha. */
export const baseLabel = (worktree: WorktreeDto): string =>
  worktree.baseRef ?? worktree.baseSha.slice(0, 12);
