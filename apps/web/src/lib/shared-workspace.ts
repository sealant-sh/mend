import { JOIN_SHARED_HOME_LINE, joinWorktreeLine } from "@mend/domain/workbench";

import { LIVE_STATES } from "./project-sessions.ts";

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
