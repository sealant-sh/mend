import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  retirementStopLines,
  workspaceRetirementLine,
} from "@mend/domain/workbench";

import type { WorkspaceRetirementDto } from "./api.ts";
import { LIVE_STATES } from "./project-sessions.ts";
import { failureWords } from "./refusal.ts";

/**
 * What a person reads before they start a session in a worktree where someone else's session runs
 * (docs/adr/0016-per-person-harness-homes.md, decision 13). The words are the domain's
 * (`@mend/domain/workbench`); this file only picks who they name.
 */

/** What the line reads of each session in the project. */
interface JoinFacts {
  readonly worktreeId: string;
  readonly ownerUserId: string | null;
  readonly status: string;
  /** The people live in the session's executor as their own user (per-person homes only). */
  readonly livePeople: ReadonlyArray<{ readonly accountId: string; readonly name: string }>;
}

/**
 * Who the viewer would meet in a worktree, as the executor runs:
 * - `per-person`: the sessions list the people live in their executor (`livePeople`), so each runs
 *   as themselves; `names` are those other than the viewer, empty when another person's session is
 *   live but nobody else is listed.
 * - `shared-home`: another person's session is live and nobody is listed: one home, the launcher's.
 * - `none`: nobody else's session is live there.
 */
export type WorktreeJoin =
  | { readonly kind: "none" }
  | { readonly kind: "per-person"; readonly names: ReadonlyArray<string> }
  | { readonly kind: "shared-home" };

export const worktreeJoin = (
  sessions: ReadonlyArray<JoinFacts>,
  worktreeId: string,
  viewerId: string,
): WorktreeJoin => {
  const listedOthers = new Map<string, string>();
  let listed = false;
  let otherOwner = false;
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId || !LIVE_STATES.has(session.status)) continue;
    if (session.ownerUserId !== null && session.ownerUserId !== viewerId) otherOwner = true;
    for (const person of session.livePeople) {
      listed = true;
      if (person.accountId !== viewerId && !listedOthers.has(person.accountId))
        listedOthers.set(person.accountId, person.name);
    }
  }
  if (listedOthers.size > 0) return { kind: "per-person", names: [...listedOthers.values()] };
  if (!otherOwner) return { kind: "none" };
  return listed ? { kind: "per-person", names: [] } : { kind: "shared-home" };
};

/** The join line for one worktree, or null when nobody else's session runs there. */
export const worktreeJoinLine = (
  sessions: ReadonlyArray<JoinFacts>,
  worktreeId: string,
  viewerId: string,
): string | null => {
  const join = worktreeJoin(sessions, worktreeId, viewerId);
  switch (join.kind) {
    case "none":
      return null;
    case "per-person":
      return joinWorktreeLine(join.names);
    case "shared-home":
      return JOIN_SHARED_HOME_LINE;
  }
};

/** What the session draws for a workspace waiting to be replaced (ADR 0016, decision 14). */
export interface RetirementView {
  readonly line: string;
  /**
   * What was checked and what would stop if it were replaced now, one line each, as evidence;
   * empty once it is being replaced. A process's or container's name is the owner's to read.
   */
  readonly stops: ReadonlyArray<string>;
  readonly canReplace: boolean;
}

export const retirementView = (
  retirement: WorkspaceRetirementDto,
  nameOf: (userId: string) => string | null,
  livePeople: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
): RetirementView => {
  const launcher = retirement.launcher;
  const launcherName =
    launcher === null
      ? "its launcher"
      : (nameOf(launcher) ??
        livePeople.find((person) => person.accountId === launcher)?.name ??
        "its launcher");
  // Everyone reads what would stop; the change's owner also gets the action.
  const marked = retirement.state === "marked";
  return {
    line: workspaceRetirementLine(retirement, launcherName),
    stops: marked ? retirementStopLines(retirement) : [],
    canReplace: marked && retirement.canReplace,
  };
};

/**
 * A refused "Replace this workspace now", as the session shows it: a `WorkspaceReplaceRefused` in
 * the server's own words, anything else in its words too, and a plain sentence when it has none.
 */
export const replaceRefusalWords = (cause: unknown): string =>
  failureWords(cause, "The workspace was not replaced.");
