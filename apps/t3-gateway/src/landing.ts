import { pullRequestMediaLine } from "@mend/domain/workbench";
import type {
  GitActionProgressPhase,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusRemoteResult,
} from "@mend/t3-contracts";

import type { CwdLocation } from "./hub.ts";
import type {
  MendChangeLandings,
  MendLandedPullRequest,
  MendLandingReport,
} from "./mend-workbench.ts";

/**
 * t3code's git panel over Mend's landing (ADR 0012, ADR 0007). Push and "create PR" land the
 * thread's change. Mend commits what the agent left uncommitted under its own ref, pushes the
 * change fast-forward to its branch on origin, and opens or updates its pull request. Mend never
 * moves the thread's branch, never commits it alone, and only the change's owner lands.
 */

/** A pull request a landing recorded, as GitHub last reported it, with the branch it is from. */
export interface RecordedPullRequest extends MendLandedPullRequest {
  /** The landing that recorded it, which `POST /api/landings/:id/refresh` asks GitHub about. */
  readonly landingId: string;
  /** The landing's branch on origin, which is the pull request's head. */
  readonly head: string;
}

/** What t3code's git panel needs to know about a thread's change, from Mend's landing record. */
export interface LandingStanding {
  /** The branch on origin the last landing pushed to, if any. */
  readonly pushedBranch: string | null;
  /** The change may hold something no landing pushed. */
  readonly mayLand: boolean;
  /** Mend can open a pull request for the project (origin on GitHub). */
  readonly pullRequestAvailable: boolean;
  /** The pull request on the branch the next landing pushes, as GitHub last reported it. */
  readonly pullRequest: RecordedPullRequest | null;
}

/**
 * The newest pull request recorded on the branch the next landing pushes. Only that one is the
 * current landing's: an open one there is the one the next landing updates, and a merged or closed
 * one leaves Mend to open another.
 */
export const recordedPullRequestOf = (view: MendChangeLandings): RecordedPullRequest | null => {
  const branch =
    view.nextBranch ?? view.landings.find((landing) => landing.pushedSha !== null)?.remoteBranch;
  const recorded = view.landings.find(
    (landing) => landing.pullRequest !== null && landing.remoteBranch === branch,
  );
  return recorded?.pullRequest == null
    ? null
    : { ...recorded.pullRequest, landingId: recorded.id, head: recorded.remoteBranch };
};

/**
 * Before a push, the change's files against its base say whether there is anything to land. After
 * one, Mend's record cannot say there is nothing: it leaves `changed-since-landing` out both when
 * no file moved and when it could not compare, and an agent's commit of the tree a landing already
 * pushed moves no file yet still lands. So the panel keeps offering a landing, and Mend itself
 * answers "nothing new since the last landing" when there is none.
 */
export const standingOf = (view: MendChangeLandings, changeFiles: number): LandingStanding => {
  const lastPush = view.landings.find((landing) => landing.pushedSha !== null);
  return {
    pushedBranch: lastPush?.remoteBranch ?? null,
    mayLand: lastPush !== undefined || changeFiles > 0,
    pullRequestAvailable: view.pullRequest.available,
    pullRequest: recordedPullRequestOf(view),
  };
};

/**
 * Whether the change holds work no landing took, which t3code reads as `hasWorkingTreeChanges`:
 * the change has files, and either nothing has landed or Mend observed files that differ from the
 * last landed checkpoint (`changed-since-landing`). Once everything has landed it is false, so
 * t3code offers no commit and says the worktree is clean. Mend leaves that fact out when it could
 * not compare as well, and this then reads false too; the remote half still offers a landing.
 */
export const hasUnlandedWork = (view: MendChangeLandings, changeFiles: number): boolean => {
  if (changeFiles === 0) return false;
  if (!view.landings.some((landing) => landing.pushedSha !== null)) return true;
  return (view.facts ?? []).some(
    (fact) => fact._tag === "changed-since-landing" && (fact.files ?? 0) > 0,
  );
};

const nonBlank = (value: string | null | undefined): string | undefined =>
  value != null && value.trim().length > 0 ? value : undefined;

const titleOf = (pullRequest: MendLandedPullRequest): string =>
  nonBlank(pullRequest.title) ?? `#${pullRequest.number}`;

/** When GitHub last reported the pull request, as t3code's row and its tooltip show the title. */
const observedTitleOf = (pullRequest: MendLandedPullRequest): string => {
  const at = new Date(pullRequest.observedAt);
  const when = Number.isNaN(at.getTime())
    ? pullRequest.observedAt
    : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${titleOf(pullRequest)} · observed ${when}`;
};

/**
 * The remote half of t3code's status, which drives its git panel's main action and menu. Mend
 * does not fetch origin on a status read, so nothing is ever behind; a push origin refuses comes
 * back as the landing's refusal. t3code reads the ahead counts only as more than zero. Everyone
 * who can see the change reads the same counts: a landing by anyone but its owner is refused in
 * Mend's words. A project whose origin is not on GitHub offers no pull request. t3code hides
 * "Create PR" itself while the pull request is open.
 */
export const remoteStatusOf = (
  standing: LandingStanding,
  location: Pick<CwdLocation, "baseRef" | "defaultBranch">,
): VcsStatusRemoteResult => {
  const { mayLand, pullRequest } = standing;
  const baseRef = nonBlank(location.baseRef) ?? nonBlank(location.defaultBranch);
  const head = nonBlank(pullRequest?.head);
  return {
    hasUpstream: standing.pushedBranch !== null,
    aheadCount: mayLand ? 1 : 0,
    behindCount: 0,
    aheadOfDefaultCount: mayLand && standing.pullRequestAvailable ? 1 : 0,
    pr:
      pullRequest === null || baseRef === undefined || head === undefined
        ? null
        : {
            number: pullRequest.number,
            title: observedTitleOf(pullRequest),
            url: pullRequest.url,
            baseRef,
            headRef: head,
            state: pullRequest.state,
            updatedAt: pullRequest.observedAt,
          },
  };
};

/** Mend's own words when the caller does not own the change (`LandingNotAllowed`). */
export const ONLY_THE_OWNER = "only the change's owner lands it";

/** Why the panel's "Commit" alone is refused. */
export const COMMIT_ALONE =
  "Mend commits a thread's work only when it lands it, and never on the thread's branch. Push commits what is uncommitted and pushes it.";

/** Why committing on a new branch is refused. */
export const FEATURE_BRANCH =
  "Mend keeps every thread on its own branch and never moves it. Landing pushes it to mend/<name> on origin.";

/** Why a commit of chosen files, or with the panel's message, is refused. */
export const WHOLE_CHANGE =
  "Mend lands the whole change with a message of its own. It does not commit a selection of files or a message from here.";

/** What a panel action asks of Mend. It is a landing, or a refusal in Mend's words. */
export type LandingPlan =
  | { readonly _tag: "refused"; readonly text: string }
  | {
      readonly _tag: "land";
      readonly pullRequest: boolean;
      readonly phases: ReadonlyArray<GitActionProgressPhase>;
    };

const PLAN_BY_ACTION: Readonly<Record<GitStackedAction, LandingPlan>> = {
  commit: { _tag: "refused", text: COMMIT_ALONE },
  push: { _tag: "land", pullRequest: false, phases: ["commit", "push"] },
  commit_push: { _tag: "land", pullRequest: false, phases: ["commit", "push"] },
  create_pr: { _tag: "land", pullRequest: true, phases: ["commit", "push", "pr"] },
  commit_push_pr: { _tag: "land", pullRequest: true, phases: ["commit", "push", "pr"] },
};

export const planOf = (
  input: Pick<GitRunStackedActionInput, "action" | "featureBranch" | "filePaths" | "commitMessage">,
): LandingPlan => {
  if (input.featureBranch === true) return { _tag: "refused", text: FEATURE_BRANCH };
  if (input.filePaths !== undefined || input.commitMessage !== undefined) {
    return { _tag: "refused", text: WHOLE_CHANGE };
  }
  return PLAN_BY_ACTION[input.action];
};

/** How a landing came back. It is what t3code's panel shows, or why it did not land. */
export type LandingResult =
  | { readonly _tag: "landed"; readonly result: GitRunStackedActionResult }
  | {
      readonly _tag: "failed";
      /** The step that stopped it: the push, or the pull request after a push went through. */
      readonly phase: Extract<GitActionProgressPhase, "push" | "pr">;
      readonly detail: string;
    };

const shortSha = (sha: string): string => sha.slice(0, 7);

const NO_REASON = "no reason given";

/**
 * A landing report as t3code's action result. Mend never creates or moves a branch here. The
 * toast says what was observed, the push and the pull request as GitHub reported it. A pull
 * request step that failed after the push ends the action failed, saying the push went through.
 * `known` is the pull request the record held before this landing, for the toast's link.
 */
export const landingResultOf = (
  action: GitStackedAction,
  report: MendLandingReport,
  location: Pick<CwdLocation, "baseRef" | "defaultBranch">,
  known: RecordedPullRequest | null,
): LandingResult => {
  const { landing, pullRequest: step } = report;
  if (landing.outcome === "refused") {
    return {
      _tag: "failed",
      phase: "push",
      detail: `push refused · ${landing.remoteBranch} · ${landing.message ?? NO_REASON}`,
    };
  }
  if (landing.pushedSha === null) {
    return {
      _tag: "failed",
      phase: "push",
      detail: `landing failed · ${landing.message ?? NO_REASON}`,
    };
  }
  const branch = landing.remoteBranch;
  const pushed = `pushed ${shortSha(landing.pushedSha)}`;
  if (step._tag === "failed") {
    return {
      _tag: "failed",
      phase: "pr",
      detail: `${pushed} to ${branch} · pull request step failed · ${step.message}`,
    };
  }
  const commitSha = nonBlank(landing.commitSha);
  const baseBranch = nonBlank(location.baseRef) ?? nonBlank(location.defaultBranch);
  const opened = step._tag === "opened" || step._tag === "updated" ? step.pullRequest : null;
  const stepLine =
    opened !== null
      ? `pull request #${opened.number} · ${opened.state} · observed`
      : step._tag === "unavailable"
        ? step.reason
        : null;
  const link = opened?.url ?? (known?.state === "open" ? known.url : null);
  return {
    _tag: "landed",
    result: {
      action,
      branch: { status: "skipped_not_requested" },
      commit:
        commitSha === undefined
          ? { status: "skipped_no_changes" }
          : { status: "created", commitSha },
      push: { status: "pushed", branch, upstreamBranch: `origin/${branch}` },
      pr:
        opened === null
          ? { status: "skipped_not_requested" }
          : {
              status: step._tag === "opened" ? "created" : "opened_existing",
              url: opened.url,
              number: opened.number,
              headBranch: branch,
              title: titleOf(opened),
              ...(baseBranch === undefined ? {} : { baseBranch }),
            },
      toast: {
        title:
          step._tag === "opened"
            ? `Opened pull request #${step.pullRequest.number}`
            : `Pushed to ${branch}`,
        description: [
          pushed,
          stepLine,
          step._tag === "opened" || step._tag === "updated"
            ? pullRequestMediaLine(step.media)
            : null,
        ]
          .filter((part) => nonBlank(part) !== undefined)
          .join(" · "),
        cta: link === null ? { kind: "none" } : { kind: "open_pr", label: "View PR", url: link },
      },
    },
  };
};
