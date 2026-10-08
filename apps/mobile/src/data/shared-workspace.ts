// What the phone says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
// decisions 6, 13 and 14), in the domain's own words: the shared-workspace line on a session, the
// waiting line where its turns show, and the retirement line of an executor started before
// per-person homes. The words live in `@mend/domain/workbench` and are never reworded here. Pure,
// so the tests read it without React Native.

import {
  retirementStopLines,
  sharedWorkspaceLine,
  workspaceRetirementLine,
} from "@mend/domain/workbench";

/** A person with a process live in the session's executor, as `GET /sessions/:id` lists them. */
export interface LivePersonDto {
  readonly accountId: string;
  readonly name: string;
}

/** `GET /sessions/:id/waiting`: what holds the next sender's turn; null when nothing waits. */
export interface ConversationWaitDto {
  readonly sessionId: string;
  readonly turnId: string;
  /** The waiting line: "Waits for Alice's 2 background tasks … before Bob's turn starts." */
  readonly line: string;
}

/** `GET /sessions/:id/workspace-retirement`: an executor waiting to be replaced; null otherwise. */
export interface WorkspaceRetirementDto {
  readonly state: "marked" | "retiring";
  readonly preRelease: boolean;
  readonly launcher: string | null;
  readonly stops: ReadonlyArray<{
    readonly kind: "terminal" | "shell" | "service" | "turn" | "process" | "container";
    readonly label: string;
  }>;
  readonly reason: string | null;
  readonly canReplace: boolean;
}

/**
 * The shared-workspace line for whoever reads it; null when nobody else is live in the executor,
 * and from a server that lists nobody (older ones omit the field).
 */
export const sharedWorkspaceLineOf = (
  livePeople: ReadonlyArray<LivePersonDto> | undefined,
  viewerId: string | null,
): string | null => sharedWorkspaceLine(livePeople ?? [], viewerId);

/** An executor waiting to be replaced, as the session screen says it. */
export interface RetirementView {
  readonly line: string;
  /** What would stop if it were replaced now, one line each; empty for anyone who cannot. */
  readonly stops: ReadonlyArray<string>;
  readonly canReplace: boolean;
}

/**
 * The retirement line and, for the change's owner, what would stop. `names` maps account ids to
 * names (the organization's roster); a launcher it does not know reads "its launcher".
 */
export const retirementViewOf = (
  retirement: WorkspaceRetirementDto | null | undefined,
  names: ReadonlyMap<string, string>,
): RetirementView | null => {
  if (retirement === null || retirement === undefined) return null;
  const launcher = retirement.launcher === null ? undefined : names.get(retirement.launcher);
  return {
    line: workspaceRetirementLine(retirement, launcher ?? "its launcher"),
    stops: retirement.canReplace ? retirementStopLines(retirement) : [],
    canReplace: retirement.canReplace,
  };
};
