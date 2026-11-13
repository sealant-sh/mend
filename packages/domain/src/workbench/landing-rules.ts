import type { ChangeLanding, LandingFact, NotLandedReason } from "./landing.ts";
import { resolveAutomation } from "./project-rules.ts";
import type { AutomationChoice } from "./project.ts";
import type { SessionOrigin } from "./session.ts";

// Whether a session lands, and how a landing reads: plain rules, free of Effect, so a client that
// reads them loads no Schema (`./landing.ts` holds the Schemas and re-exports these).

/** Everything that decides whether a session lands when a turn completes ("When it is on"). */
export interface AutoLandInputs {
  readonly origin: SessionOrigin;
  /** The project's "Land when a turn completes". */
  readonly project: AutomationChoice;
  /** The Settings default a project's `inherit` follows. */
  readonly settings: boolean;
  /**
   * The session's own override: the composer's or `mend`'s `--land` / `--no-land`, or the
   * `autopr=` of the request that started a Slack session. Null follows the rest.
   */
  readonly session: boolean | null;
  /** The Slack app's "Land automatically"; read only for a session started from Slack. */
  readonly slack: boolean;
}

/**
 * Whether automatic landing is on for a session. A project set to `off` wins over everything,
 * Slack included. A Slack session follows its request's `autopr=`, then the Slack app's setting.
 * Any other session follows its own override, then the project, then Settings.
 */
export const resolveAutoLand = (inputs: AutoLandInputs): boolean => {
  if (inputs.project === "off") return false;
  if (inputs.origin === "slack") return inputs.session ?? inputs.slack;
  return inputs.session ?? resolveAutomation(inputs.project, inputs.settings);
};

// ─── Pull requests opened outside Mend ──────────────────────────────────────

type RecordedLanding = Pick<
  ChangeLanding,
  | "trigger"
  | "remoteBranch"
  | "pushedSha"
  | "pullRequest"
  | "pullRequestCrossRepository"
  | "pullRequestHeadOwner"
>;

/** The pull request was first recorded by an adoption: someone opened it outside Mend. */
export const openedOutsideMend = (
  landings: ReadonlyArray<RecordedLanding>,
  number: number,
): boolean =>
  landings.findLast((landing) => landing.pullRequest?.number === number)?.trigger === "adopted";

/**
 * The pull request the next landing updates: the newest one recorded, while it is open and its
 * head is on origin. A closed or merged one leads to a new pull request; one from a fork is never
 * updated, because Mend pushes to origin only.
 */
export const pullRequestToUpdate = <L extends RecordedLanding>(
  landings: ReadonlyArray<L>,
): NonNullable<L["pullRequest"]> | null => {
  const recorded = landings.find((landing) => landing.pullRequest !== null);
  if (recorded === undefined || recorded.pullRequest === null) return null;
  return recorded.pullRequest.state === "open" && !recorded.pullRequestCrossRepository
    ? recorded.pullRequest
    : null;
};

/**
 * The newest recorded pull request when it is open and from a fork: the change is already under
 * review there, and a landing from Mend would push to origin and open a second one. Null otherwise.
 */
export const openForkPullRequest = (
  landings: ReadonlyArray<RecordedLanding>,
): { readonly number: number; readonly owner: string | null } | null => {
  const recorded = landings.find((landing) => landing.pullRequest !== null);
  if (recorded === undefined || recorded.pullRequest === null) return null;
  return recorded.pullRequest.state === "open" && recorded.pullRequestCrossRepository
    ? { number: recorded.pullRequest.number, owner: recorded.pullRequestHeadOwner }
    : null;
};

/** Why a landing's pull request step does not run for an open pull request from a fork. */
export const forkPullRequestReason = (fork: {
  readonly number: number;
  readonly owner: string | null;
}): string =>
  `pull request #${fork.number} is from ${fork.owner === null ? "a fork" : `${fork.owner}'s fork`} · Mend pushes to origin only`;

/**
 * The branch the next landing pushes, in order: the one the owner names; the one the change's
 * last landing pushed; the one the agent last pushed itself; the head of an adopted pull request
 * on origin; the worktree's own. Never the project's default branch or the pull request's base
 * (an owner who names one of those is refused, and Mend never picks one).
 */
export const nextLandingBranch = (input: {
  readonly requested: string | null;
  /** The change's landings, newest first. */
  readonly landings: ReadonlyArray<RecordedLanding>;
  /** From `agentPushedBranches`. */
  readonly agentBranches: ReadonlyArray<string>;
  readonly worktreeBranch: string;
  /** The project's default branch and the pull request's base. */
  readonly protectedBranches: ReadonlyArray<string>;
}): string => {
  if (input.requested !== null) return input.requested;
  const usable = (branch: string | undefined): branch is string =>
    branch !== undefined && branch !== "" && !input.protectedBranches.includes(branch);
  const lastPush = input.landings.find((landing) => landing.pushedSha !== null)?.remoteBranch;
  if (usable(lastPush)) return lastPush;
  const agentBranch = input.agentBranches.find(usable);
  if (agentBranch !== undefined) return agentBranch;
  const adopted = input.landings.find(
    (landing) =>
      landing.trigger === "adopted" &&
      landing.pullRequest !== null &&
      !landing.pullRequestCrossRepository,
  )?.remoteBranch;
  if (usable(adopted)) return adopted;
  return input.worktreeBranch;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** How long ago, in the review page's units: `40 s ago`, `2 min ago`, `3 h ago`, `2 d ago`. */
export const observedAgo = (at: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
};

const NOT_LANDED: Record<NotLandedReason, string> = {
  question: "changes not landed · the request read as a question",
  option: "changes not landed · the request said autopr=false",
  off: "changes not landed · automatic landing is off",
  "not-owner": "changes not landed · the turn was not sent by the owner",
  "no-change": "not landed · the change is empty",
  "nothing-new": "not landed · nothing new since the last landing",
  "not-captured": "not landed · the change was not captured",
};

/** Why a turn did not land, as its status line: terse, observed, and never a verdict. */
export const notLandedLine = (reason: NotLandedReason): string => NOT_LANDED[reason];

/** One fact as its status line: terse, observed, and never a verdict. */
export const landingFactLine = (fact: LandingFact, now: Date): string => {
  switch (fact._tag) {
    case "pushed":
      return `pushed · ${fact.branch} · ${shortSha(fact.sha)} · observed`;
    case "pull-request":
      return (
        `pull request #${fact.number} · ${fact.state} · observed ${observedAgo(fact.observedAt, now)}` +
        (fact.outside ? " · opened outside Mend" : "") +
        (fact.fork === null ? "" : ` · from ${fact.fork === "" ? "a fork" : `${fact.fork}'s fork`}`)
      );
    case "origin-moved":
      return `origin has moved · ${fact.branch} has ${plural(fact.commits, "commit", "commits")} Mend has not seen`;
    case "changed-since-landing":
      return `changed since landing · ${plural(fact.files, "file", "files")}`;
    case "refused":
      return `push refused · ${fact.branch} · ${fact.message}`;
    case "failed":
      return `landing failed · ${fact.message}`;
    case "pull-request-failed":
      return `pull request step failed · ${fact.message}`;
    case "agent-push":
      return fact.sha === null
        ? `deleted by the agent · ${fact.ref}`
        : `pushed by the agent · ${fact.ref} · ${shortSha(fact.sha)}`;
    case "not-landed":
      return notLandedLine(fact.reason);
    case "intent-not-read":
      return "intent not read";
  }
};
