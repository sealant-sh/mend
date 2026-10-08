import {
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

/** The organization's roster as id → name; empty while loading or for an account in none. */
export const useMemberNames = (): Names => {
  const trpc = useTRPC();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  return new Map((members.data ?? []).map((member) => [member.userId, member.name]));
};

type JoinFacts = Pick<SessionDto, "worktreeId" | "ownerUserId" | "status" | "livePeople">;

/**
 * The people other than the viewer whose sessions run in a worktree: the owners of its live
 * sessions and anyone the session view lists as live in its executor, each once, by name. A name
 * the roster does not know is left out (the line then says "Another person").
 */
export const worktreeOthers = (
  sessions: ReadonlyArray<JoinFacts>,
  worktreeId: string,
  viewerId: string,
  names: Names,
): { readonly count: number; readonly names: ReadonlyArray<string> } => {
  const others = new Map<string, string | null>();
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId || !LIVE_STATES.has(session.status)) continue;
    const owner = session.ownerUserId;
    if (owner !== null && owner !== viewerId && !others.has(owner)) {
      const listed = session.livePeople.find((person) => person.accountId === owner)?.name;
      others.set(owner, names.get(owner) ?? listed ?? null);
    }
    for (const person of session.livePeople) {
      if (person.accountId === viewerId) continue;
      if ((others.get(person.accountId) ?? null) === null) {
        others.set(person.accountId, person.name);
      }
    }
  }
  const named = [...others.values()].filter((name): name is string => name !== null);
  return { count: others.size, names: named };
};

/**
 * "Anna's session is running in this worktree. You share its workspace: …", said before the viewer
 * starts a session where someone else's runs; null when nobody else's does, or the viewer is not
 * known yet (a solo person would otherwise read their own sessions as someone else's).
 */
export const worktreeJoinLine = (
  sessions: ReadonlyArray<JoinFacts>,
  worktreeId: string,
  viewerId: string | null,
  names: Names,
): string | null => {
  if (viewerId === null) return null;
  const others = worktreeOthers(sessions, worktreeId, viewerId, names);
  if (others.count === 0) return null;
  // Everyone named, or nobody: a partial list would undercount the people it speaks of.
  return joinWorktreeLine(others.names.length === others.count ? others.names : []);
};

/** The join line for one worktree, for the viewer, from the sessions the page already holds. */
export const useWorktreeJoinLine = (
  worktreeId: string | null,
  sessions: ReadonlyArray<JoinFacts>,
): string | null => {
  const viewer = useViewer();
  const names = useMemberNames();
  return worktreeId === null
    ? null
    : worktreeJoinLine(sessions, worktreeId, viewer?.userId ?? null, names);
};

// ─── What the session page reads, and only where it can matter ─────────────────

/** How often the waiting line is re-read while it can show: background work ends without an event. */
export const WAIT_POLL_MS = 5_000;

type WaitFacts = Pick<SessionDto, "livePeople" | "sharedControlEnabledAt">;

/**
 * Whether the waiting line (decision 6) can show at all: another sender's turn waits only where
 * people run in the executor (`livePeople`, empty for a shared executor and with
 * `MEND_HARNESS_LAYOUT` off) and the owner shares control. Otherwise the page asks nothing.
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
