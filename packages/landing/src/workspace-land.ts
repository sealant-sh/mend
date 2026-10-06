import type { AgentTurn, Session } from "@mend/domain/workbench";

import type { LandingReport } from "./landing.ts";

/**
 * `mend land` inside a session's workspace (docs/adr/0007-landing.md, "Surfaces"): the agent asks
 * Mend to land because the person asked it to publish. The request can only come from the
 * session's own workspace (its socket, or its channel token), and it lands only what the change's
 * owner asked for: the session must be theirs, and the turn under way must be one they sent.
 * Mend then lands as the Land panel does, with the owner's credentials, never force-pushing and
 * never moving the session's branch.
 */

/** Why `mend land` does not land for this session, or null when the change's owner is asking. */
export const workspaceLandRefusal = (input: {
  readonly session: Pick<Session, "ownerUserId" | "sharedControlEnabledAt">;
  /** The change's owner (`changeOwnerOf`). */
  readonly changeOwnerUserId: string | null;
  /** The session's turns; the one running is the request the agent is answering. */
  readonly turns: ReadonlyArray<Pick<AgentTurn, "status" | "author">>;
  /**
   * The person whose process asked, in a person-layout executor (docs/adr/0016, decision 4); null
   * when the workspace itself asked (its socket, or its launch's token), as before.
   */
  readonly requestedBy?: string | null;
}): string | null => {
  const owner = input.changeOwnerUserId;
  if (owner === null) return "not landed · the change has no owner";
  if (input.session.ownerUserId !== owner) {
    return "not landed · only the change's owner lands it · this session is not theirs";
  }
  if (
    input.requestedBy !== undefined &&
    input.requestedBy !== null &&
    input.requestedBy !== owner
  ) {
    return "not landed · only the change's owner lands it · this process runs as someone else";
  }
  const running = input.turns.find((turn) => turn.status === "running");
  if (running !== undefined) {
    return running.author === owner
      ? null
      : "not landed · only the change's owner lands it · someone else sent this turn";
  }
  // A terminal session has no turns Mend reads: with shared control on, anyone may be typing.
  return input.session.sharedControlEnabledAt === null
    ? null
    : "not landed · shared control is on · the change's owner lands it from Mend";
};

const short = (sha: string): string => sha.slice(0, 7);

const words = (message: string | null): string => {
  const said = (message ?? "").replace(/\s+/g, " ").trim();
  return said === "" ? "no reason given" : said;
};

/**
 * What `mend land` prints for a landing that ran: the push and the pull request as observed,
 * then the pull request's URL on a line of its own. `landed` is false when the push was refused
 * or a step failed, so the helper exits 1 with the same lines.
 */
export const workspaceLandLines = (
  report: LandingReport,
): { readonly landed: boolean; readonly lines: ReadonlyArray<string> } => {
  const { landing, pullRequest } = report;
  if (landing.outcome === "refused") {
    return {
      landed: false,
      lines: [`push refused · ${landing.remoteBranch} · ${words(landing.message)}`],
    };
  }
  if (landing.pushedSha === null) {
    return { landed: false, lines: [`landing failed · ${words(landing.message)}`] };
  }
  const pushed = `pushed · ${landing.remoteBranch} · ${short(landing.pushedSha)}`;
  switch (pullRequest._tag) {
    case "opened":
    case "updated": {
      const { number, state, url } = pullRequest.pullRequest;
      return {
        landed: true,
        lines: [`${pushed} · pull request #${number} · ${state} · observed`, url],
      };
    }
    case "unavailable":
      return { landed: true, lines: [`${pushed} · ${pullRequest.reason}`] };
    case "failed":
      return {
        landed: false,
        lines: [`${pushed} · pull request step failed · ${words(pullRequest.message)}`],
      };
    case "off":
    case "not-reached":
      return { landed: true, lines: [pushed] };
  }
};
