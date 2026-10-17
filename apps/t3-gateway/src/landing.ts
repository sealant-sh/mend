import type { VcsStatusRemoteResult } from "@mend/t3-contracts";

import type { CwdLocation } from "./hub.ts";
import type { MendChangeLandings, MendLandedPullRequest } from "./mend-workbench.ts";

/**
 * t3code's git panel over Mend's landing (ADR 0012, ADR 0007). Push and "create PR" land the
 * thread's change: Mend commits what the agent left uncommitted under its own ref, pushes the
 * change fast-forward to its branch on origin, and opens or updates its pull request. Mend never
 * moves the thread's branch, never commits it alone, and only the change's owner lands.
 */

/** A pull request a landing recorded, as GitHub last reported it, with the branch it is from. */
export interface RecordedPullRequest extends MendLandedPullRequest {
  /** The landing's branch on origin: the pull request's head. */
  readonly head: string;
}

/** What t3code's git panel needs to know about a thread's change, from Mend's landing record. */
export interface LandingStanding {
  /** The caller may land it: they own the change (Mend's `land`). */
  readonly owner: boolean;
  /** The last landing that pushed, if any: its branch on origin. */
  readonly pushedBranch: string | null;
  /** Something is in the change that no landing pushed yet. */
  readonly unlanded: boolean;
  /** Mend can open a pull request for the project (origin on GitHub). */
  readonly pullRequestAvailable: boolean;
  /** The newest pull request any landing recorded, as GitHub last reported it. */
  readonly pullRequest: RecordedPullRequest | null;
}

export const standingOf = (view: MendChangeLandings, changeFiles: number): LandingStanding => {
  const lastPush = view.landings.find((landing) => landing.pushedSha !== null);
  const sinceLanding = view.facts.find((fact) => fact._tag === "changed-since-landing")?.files ?? 0;
  const withPullRequest = view.landings.find((landing) => landing.pullRequest !== null);
  return {
    owner: view.land,
    pushedBranch: lastPush?.remoteBranch ?? null,
    unlanded: lastPush === undefined ? changeFiles > 0 : sinceLanding > 0,
    pullRequestAvailable: view.pullRequest.available,
    pullRequest:
      withPullRequest?.pullRequest == null
        ? null
        : { ...withPullRequest.pullRequest, head: withPullRequest.remoteBranch },
  };
};

const nonBlank = (value: string | null | undefined): string | undefined =>
  value != null && value.trim().length > 0 ? value : undefined;

const titleOf = (pullRequest: MendLandedPullRequest): string =>
  nonBlank(pullRequest.title) ?? `#${pullRequest.number}`;

/**
 * The remote half of t3code's status, which drives its git panel's main action and menu. Mend
 * does not fetch origin on a status read, so nothing is ever behind; a push origin refuses comes
 * back as the landing's refusal. t3code reads the ahead counts only as more than zero: 1 says a
 * landing has something to push, or a pull request to open for a change pushed without one. A
 * caller who does not own the change sees nothing to push and the pull request as GitHub last
 * reported it, so no write control is live for them.
 */
export const remoteStatusOf = (
  standing: LandingStanding,
  location: Pick<CwdLocation, "baseRef" | "defaultBranch">,
): VcsStatusRemoteResult => {
  const { owner, unlanded, pullRequest } = standing;
  const hasUpstream = standing.pushedBranch !== null;
  const opensPullRequest = hasUpstream && pullRequest === null && standing.pullRequestAvailable;
  const baseRef = nonBlank(location.baseRef) ?? nonBlank(location.defaultBranch);
  const head = nonBlank(pullRequest?.head);
  return {
    hasUpstream,
    aheadCount: owner && unlanded ? 1 : 0,
    behindCount: 0,
    aheadOfDefaultCount: owner && (unlanded || opensPullRequest) ? 1 : 0,
    pr:
      pullRequest === null || baseRef === undefined || head === undefined
        ? null
        : {
            number: pullRequest.number,
            title: titleOf(pullRequest),
            url: pullRequest.url,
            baseRef,
            headRef: head,
            state: pullRequest.state,
            updatedAt: pullRequest.observedAt,
          },
  };
};
