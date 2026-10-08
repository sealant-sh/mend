// What the phone says about people sharing a workspace (docs/adr/0016-per-person-harness-homes.md,
// decisions 6, 13 and 14), in the domain's own words: the shared-workspace line on a session, the
// waiting line where its turns show, and the retirement line of an executor started before
// per-person homes. The words live in `@mend/domain/workbench` and are never reworded here. Pure,
// so the tests read it without React Native.

import {
  REPLACE_WORKSPACE_ACTION,
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
    readonly kind:
      | "terminal"
      | "shell"
      | "service"
      | "turn"
      | "process"
      | "container"
      | "unchecked";
    /** Empty for a process or a container where the viewer is not the change's owner. */
    readonly label: string;
  }>;
  readonly reason: string | null;
  /** When what runs was checked beyond Mend's own records; null when only those were read. */
  readonly checkedAt: string | null;
  /** What the viewer was shown, as one token: "Replace this workspace now" sends it back. */
  readonly fingerprint: string;
  readonly canReplace: boolean;
}

/** `POST /sessions/:id/workspace-retirement/replace`: the fingerprint of what the owner saw. */
export interface ReplaceWorkspaceBody {
  readonly seen: string;
}

/** The session fields that say whether the lines below are worth reading at all. */
export interface SessionSharing {
  /** Absent on servers from before per-person homes, and in a project's list. */
  readonly livePeople?: ReadonlyArray<LivePersonDto>;
  readonly sharedControlEnabledAt?: string | null;
  readonly workspaceRetirement?: "marked" | "retiring" | null;
}

/**
 * Whether the waiting line is worth reading (docs/adr/0016, decision 6): someone is live in the
 * executor and its owner shares control. Otherwise nobody else's turn can wait and nothing is read
 * (with `MEND_HARNESS_LAYOUT` off, `livePeople` is always empty: no extra work at all).
 */
export const readsWaiting = (session: SessionSharing | undefined): boolean =>
  (session?.livePeople?.length ?? 0) > 0 && (session?.sharedControlEnabledAt ?? null) !== null;

/** Whether the session's executor waits to be replaced, as the session's own view says. */
export const readsRetirement = (session: SessionSharing | undefined): boolean =>
  (session?.workspaceRetirement ?? null) !== null;

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
  /** The fingerprint of the read these lines came from, which the replacement sends. */
  readonly seen: string;
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
 * "Replace this workspace now", asked with what would stop and sent with the fingerprint of the
 * same read: Mend ends nothing that was not listed (it refuses when more would stop now).
 */
export const replaceConfirmationOf = (
  view: RetirementView,
): { readonly title: string; readonly message: string; readonly body: ReplaceWorkspaceBody } => ({
  title: `${REPLACE_WORKSPACE_ACTION}?`,
  message: view.stops.join("\n"),
  body: { seen: view.seen },
});

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
