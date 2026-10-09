import {
  retirementStopLines,
  sharedControlConfirm,
  sharedControlLine,
  sharedWorkspaceLine,
  workspaceRetirementLine,
} from "@mend/domain/workbench";
import { queryOptions } from "@tanstack/react-query";

import {
  sessionWaiting,
  sessionWorkspaceRetirement,
  type LivePersonDto,
  type SessionDto,
  type WorkspaceRetirementDto,
} from "#/lib/api";

/**
 * What the cockpit says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 6, 13 and 14), in the domain's own words: the shared-workspace line on a session, the
 * waiting line where its turns show, and the retirement line of an executor started before
 * per-person homes. The words live in `@mend/domain/workbench` and are never reworded here.
 */

/**
 * The session view's `control.turnsOnSendersLogin` (docs/adr/0016, decision 13), or null until
 * `GET /api/sessions/:id` has answered: a project list's row cannot say whose login a steered
 * turn runs on, and neither wording is assumed in its place.
 */
export type TurnsOnSendersLogin = boolean | null;

/** Beside the Shared control switch while turning it on waits for the session view. */
export const SHARED_CONTROL_UNREAD = "session view not read yet";

/**
 * Beside the Shared control switch: what turning it on lets others do, with the domain's line on
 * whose login a steered turn runs (docs/adr/0016, decision 13): its sender's where the worktree
 * runs each person as themselves (`turnsOnSendersLogin`), the owner's otherwise. Before the
 * session view answers it says neither.
 */
export const sharedControlSwitchTitle = (turnsOnSendersLogin: TurnsOnSendersLogin): string =>
  turnsOnSendersLogin === null
    ? "On lets everyone who can see this project send turns, answer approvals and interrupt. It is offered once the session view says whose login a steered turn runs on."
    : `On lets everyone who can see this project send turns, answer approvals and interrupt. ${sharedControlLine(turnsOnSendersLogin)} They can read the terminal; only you type in it. Every action is recorded with who sent it.`;

/**
 * What pressing On or Off on the Shared control switch does: nothing on the side already chosen;
 * turning it on asks first, in both layouts (`sharedControlConfirm`), and waits (offers nothing)
 * until the session view has said which layout it is; turning it off never asks.
 */
export const sharedControlPress = (
  shared: boolean,
  enabled: boolean,
  turnsOnSendersLogin: TurnsOnSendersLogin,
): "nothing" | "wait" | "ask" | "set" =>
  shared === enabled ? "nothing" : !enabled ? "set" : turnsOnSendersLogin === null ? "wait" : "ask";

/**
 * The confirmation for turning Shared control on, in the domain's words for the session's layout;
 * null until the session view has answered, so neither wording is shown in its place.
 */
export const sharedControlConfirmOf = (
  turnsOnSendersLogin: TurnsOnSendersLogin,
): ReturnType<typeof sharedControlConfirm> | null =>
  turnsOnSendersLogin === null ? null : sharedControlConfirm(turnsOnSendersLogin);

/**
 * Whether the session's waiting line is worth reading (docs/adr/0016, decision 6): someone is live
 * in its executor and its owner shares control. Otherwise nobody else's turn can wait, and nothing
 * is read (with `MEND_HARNESS_LAYOUT=shared`, `livePeople` is always empty: no extra work at all).
 */
export const readsWaiting = (
  session: Pick<SessionDto, "livePeople" | "sharedControlEnabledAt"> | null | undefined,
): boolean =>
  session !== null &&
  session !== undefined &&
  session.livePeople.length > 0 &&
  session.sharedControlEnabledAt !== null;

/** Whether the session's executor waits to be replaced, as the session's own view says. */
export const readsRetirement = (
  session: Pick<SessionDto, "workspaceRetirement"> | null | undefined,
): boolean => session !== null && session !== undefined && session.workspaceRetirement !== null;

/**
 * Under the conversation's key, so the stream's `agent-conversation` pointer re-reads it with the
 * turns (`refreshConversation`), and a `session` pointer with the session: no timer of its own.
 * Read only while `readsWaiting`. A server from before shared steering answers 404: no line.
 */
export const sessionWaitingQuery = (sessionId: string, enabled: boolean) =>
  queryOptions({
    queryKey: ["session", sessionId, "conversation", "waiting"] as const,
    queryFn: () => sessionWaiting(sessionId),
    enabled,
    retry: false,
  });

/**
 * Under the session's key, so a `session` pointer re-reads it. Read only while `readsRetirement`.
 * A server from before per-person homes answers 404: no line.
 */
export const workspaceRetirementQuery = (sessionId: string, enabled: boolean) =>
  queryOptions({
    queryKey: ["session", sessionId, "workspace-retirement"] as const,
    queryFn: () => sessionWorkspaceRetirement(sessionId),
    enabled,
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
  /**
   * The `fingerprint` of the read these lines came from: "Replace this workspace now" sends it
   * (`seen`), so Mend ends nothing that was not listed here.
   */
  readonly seen: string;
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
    stops: retirement.canReplace
      ? retirementStopLines({
          stops: retirement.stops,
          checkedAt: retirement.checkedAt === null ? null : new Date(retirement.checkedAt),
        })
      : [],
    canReplace: retirement.canReplace,
    seen: retirement.fingerprint,
  };
};

/**
 * Lines with keys that stay unique when two lines read alike (two processes whose names are not
 * the viewer's both read "process Mend did not start").
 */
export const keyedLines = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<{ readonly key: string; readonly line: string }> => {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return { key: `${line}#${count}`, line };
  });
};
