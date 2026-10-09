import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  retirementStopLines,
  workspaceRetirementLine,
} from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";

import type { SessionDto, WorkspaceRetirementDto } from "./api.ts";
import { useTRPC } from "./trpc.ts";
import { useViewer } from "./viewer.ts";
import { LIVE_STATES } from "./workbench-menus.ts";

/**
 * What the web app says where people share a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 13 and 14). The words are the domain's (`@mend/domain/workbench`), never reworded here;
 * this file only picks the people and names they speak of.
 */

type Names = ReadonlyMap<string, string>;

/**
 * The organization's roster as id → name; empty while loading or for an account in none. Only the
 * session page reads it (it holds the roster already); the join line never does.
 */
export const useMemberNames = (): Names => {
  const trpc = useTRPC();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  return new Map((members.data ?? []).map((member) => [member.userId, member.name]));
};

type JoinFacts = Pick<SessionDto, "worktreeId" | "ownerUserId" | "status" | "livePeople">;

/**
 * Who the viewer would meet in a worktree, as the executor actually runs (decisions 13 and 14):
 * - `per-person`: the live sessions list people in their executor (`livePeople`, only ever filled
 *   where per-person homes are possible), so each runs as themselves; `names` are the listed
 *   people other than the viewer, empty when another person's session is live but not listed.
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
    const owner = session.ownerUserId;
    if (owner !== null && owner !== viewerId) otherOwner = true;
    for (const person of session.livePeople) {
      listed = true;
      if (person.accountId !== viewerId && !listedOthers.has(person.accountId)) {
        listedOthers.set(person.accountId, person.name);
      }
    }
  }
  if (listedOthers.size > 0) return { kind: "per-person", names: [...listedOthers.values()] };
  if (!otherOwner) return { kind: "none" };
  return listed ? { kind: "per-person", names: [] } : { kind: "shared-home" };
};

/**
 * What the viewer reads before starting a session where someone else's runs: "Anna's session is
 * running in this worktree. You share its workspace: …" in a per-person executor, the shared-home
 * line where it runs everyone on one home; null when nobody else's runs there, or the viewer is not
 * known yet (a solo person would otherwise read their own sessions as someone else's).
 */
export const worktreeJoinLine = (
  sessions: ReadonlyArray<JoinFacts>,
  worktreeId: string,
  viewerId: string | null,
): string | null => {
  if (viewerId === null) return null;
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

/**
 * The join line for one worktree, for the viewer, from the sessions the page already holds. The
 * viewer is the page's own (`organization.current`, cached); names come from `livePeople`, so
 * nothing more is asked.
 */
export const useWorktreeJoinLine = (
  worktreeId: string | null,
  sessions: ReadonlyArray<JoinFacts>,
): string | null => {
  const viewer = useViewer();
  return worktreeId === null
    ? null
    : worktreeJoinLine(sessions, worktreeId, viewer?.userId ?? null);
};

// ─── What the session page reads, and only where it can matter ─────────────────

/** How often the waiting line is re-read while it can show: background work ends without an event. */
export const WAIT_POLL_MS = 5_000;

type WaitFacts = Pick<SessionDto, "livePeople" | "sharedControlEnabledAt">;

/**
 * Whether the waiting line (decision 6) can show at all: another sender's turn waits only where
 * people run in the executor (`livePeople`, empty for a shared executor and with
 * `MEND_HARNESS_LAYOUT=shared`) and the owner shares control. Otherwise the page asks nothing.
 */
export const waitingLineRelevant = (session: WaitFacts): boolean =>
  session.livePeople.length > 0 && session.sharedControlEnabledAt !== null;

/**
 * How the waiting line is read: not at all where it cannot show; while it can, re-read on a short
 * poll as long as the session is live (nothing announces background work ending), once otherwise.
 * Turns and the session's own changes refresh it through the event stream either way.
 */
export const waitingLineQuery = (
  session: WaitFacts,
  live: boolean,
): { readonly enabled: boolean; readonly refetchInterval: number | false } => {
  const enabled = waitingLineRelevant(session);
  return { enabled, refetchInterval: enabled && live ? WAIT_POLL_MS : false };
};

/**
 * Who may end the work a turn waits for: the session's owner, or the person the conversation's
 * process runs as while they can still steer (shared control turned off takes that from them).
 */
export const canEndWaitingWork = (facts: {
  readonly viewerId: string | null;
  readonly ownerUserId: string | null;
  readonly runsAs: string | null;
  readonly steer: boolean;
}): boolean =>
  facts.viewerId !== null &&
  (facts.viewerId === facts.ownerUserId || (facts.viewerId === facts.runsAs && facts.steer));

/**
 * Whether the page asks for the executor's retirement (decision 14): only when the session says
 * one is under way. The session's own events refresh it; nothing polls.
 */
export const retirementRelevant = (session: Pick<SessionDto, "workspaceRetirement">): boolean =>
  session.workspaceRetirement !== null;

/**
 * "Replace this workspace now" names what the owner was shown, so Mend ends nothing that was not
 * listed: the retirement's `fingerprint`, as the API asks.
 */
export const replaceWorkspaceBody = (
  retirement: Pick<WorkspaceRetirementDto, "fingerprint">,
): { readonly seen: string } => ({ seen: retirement.fingerprint });

/** What the session page draws for an executor waiting to be replaced (decision 14). */
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
  names: Names,
  livePeople: SessionDto["livePeople"],
): RetirementView => {
  const launcher = retirement.launcher;
  const launcherName =
    launcher === null
      ? "its launcher"
      : (names.get(launcher) ??
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
 * A failed "Replace this workspace now", as the page shows it: a `WorkspaceReplaceRefused` in the
 * server's own words, which the web tier prefixes with the tag (server/api/errors.ts); anything
 * else as it came.
 */
export const replaceRefusalWords = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const prefix = "WorkspaceReplaceRefused: ";
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  return raw === "" ? "The workspace was not replaced." : raw;
};

/**
 * What a click on the Shared control switch does: turning it on asks first, in both layouts, in
 * words true to each (`sharedControlConfirm`); turning it off acts at once.
 */
export const sharedControlClick = (enabled: boolean): "confirm" | "toggle" =>
  enabled ? "confirm" : "toggle";
