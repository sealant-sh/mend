import {
  retirementStopLines,
  sharedControlLine,
  sharedWorkspaceLine,
  workspaceRetirementLine,
} from "@mend/domain/workbench";
import { queryOptions } from "@tanstack/react-query";

import {
  sessionWaiting,
  sessionWorkspaceRetirement,
  type LivePersonDto,
  type WorkspaceRetirementDto,
} from "#/lib/api";

/**
 * What the cockpit says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 6, 13 and 14), in the domain's own words: the shared-workspace line on a session, the
 * waiting line where its turns show, and the retirement line of an executor started before
 * per-person homes. The words live in `@mend/domain/workbench` and are never reworded here.
 */

/**
 * Beside the Shared control switch: what turning it on lets others do, with the domain's line on
 * whose login a steered turn runs (docs/adr/0016, decision 13): its sender's where the worktree
 * runs each person as themselves (`turnsOnSendersLogin`), the owner's otherwise.
 */
export const sharedControlSwitchTitle = (turnsOnSendersLogin: boolean): string =>
  `On lets everyone who can see this project send turns, answer approvals and interrupt. ${sharedControlLine(turnsOnSendersLogin)} They can read the terminal; only you type in it. Every action is recorded with who sent it.`;

/** How often a live conversation re-reads what holds its next turn, between stream pointers. */
const WAITING_POLL_MS = 4_000;

/**
 * Under the conversation's key, so the stream's `agent-conversation` pointer re-reads it with the
 * turns (`refreshConversation`). A server from before shared steering answers 404: no line.
 */
export const sessionWaitingQuery = (sessionId: string, live: boolean) =>
  queryOptions({
    queryKey: ["session", sessionId, "conversation", "waiting"] as const,
    queryFn: () => sessionWaiting(sessionId),
    refetchInterval: live ? WAITING_POLL_MS : false,
    retry: false,
  });

/**
 * Under the session's key, so a `session` pointer re-reads it. A server from before per-person
 * homes answers 404: no line.
 */
export const workspaceRetirementQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["session", sessionId, "workspace-retirement"] as const,
    queryFn: () => sessionWorkspaceRetirement(sessionId),
    retry: false,
  });

/**
 * The shared-workspace line for whoever reads it; null when nobody else is live in the executor.
 * `livePeople` comes from the session's own view (`GET /api/sessions/:id`); a project list's
 * session row, and an older server, carry none.
 */
export const sharedWorkspaceLineOf = (
  livePeople: ReadonlyArray<LivePersonDto> | undefined,
  viewerId: string | null,
): string | null => sharedWorkspaceLine(livePeople ?? [], viewerId);

/** An executor waiting to be replaced, as the session view says it. */
export interface RetirementView {
  readonly line: string;
  /**
   * What would stop if it were replaced now, one line each, beside "Replace this workspace now";
   * empty when the viewer may not replace it.
   */
  readonly stops: ReadonlyArray<string>;
  /** The viewer owns the change and no agent turn is in flight. */
  readonly canReplace: boolean;
}

/**
 * The retirement line and, for the change's owner, what would stop. `names` maps account ids to
 * names (the organization's roster); a launcher the roster does not know reads "its launcher".
 */
export const retirementViewOf = (
  retirement: WorkspaceRetirementDto | null | undefined,
  names: ReadonlyMap<string, string>,
): RetirementView | null => {
  if (retirement === null || retirement === undefined) return null;
  const launcher = retirement.launcher === null ? null : (names.get(retirement.launcher) ?? null);
  return {
    line: workspaceRetirementLine(retirement, launcher ?? "its launcher"),
    stops: retirement.canReplace ? retirementStopLines(retirement) : [],
    canReplace: retirement.canReplace,
  };
};
