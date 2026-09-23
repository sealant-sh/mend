import { Schema } from "effect";

import { ChangeId, ChangeLandingId, CheckpointId, ProjectId, SessionId, Sha } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { type AutomationChoice, resolveAutomation } from "./project.ts";
import type { SessionOrigin } from "./session.ts";

/**
 * Landing (docs/adr/0007-landing.md): Mend commits what the worktree holds, pushes the session's
 * branch to origin, and opens or updates the pull request. Merging stays on GitHub. What Mend
 * keeps is the record of each landing and the facts it observed since, never a verdict.
 */

/** What started a landing: the owner's button or command, or a completed turn. */
export const LandingTrigger = Schema.Literals(["manual", "automatic"]);
export type LandingTrigger = typeof LandingTrigger.Type;

/**
 * How a landing ended.
 *
 * - `pushed`: the branch reached origin, and no pull request step ran (turned off, or origin is
 *   not on GitHub).
 * - `pull-request`: pushed, and the pull request was opened or updated.
 * - `refused`: origin refused the push (it moved, branch protection, no write access). Nothing
 *   was pushed.
 * - `failed`: another step failed. `pushedSha` says whether the push had already happened.
 */
export const LandingOutcome = Schema.Literals(["pushed", "pull-request", "refused", "failed"]);
export type LandingOutcome = typeof LandingOutcome.Type;

/** A pull request's state as `gh` reports it. */
export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

/** The pull request a landing opened or updated, as `gh` last reported it, and when. */
export const LandedPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  state: PullRequestState,
  observedAt: Timestamp,
});
export type LandedPullRequest = typeof LandedPullRequest.Type;

/**
 * One landing of a change ("What Mend records and shows"). The checkpoint is what was landed; a
 * landing that failed before its checkpoint existed has none. The row is written once, and only
 * the pull request's observed state moves afterwards.
 */
export class ChangeLanding extends Schema.Class<ChangeLanding>("ChangeLanding")({
  id: ChangeLandingId,
  changeId: ChangeId,
  /** The session that landed; null once that session is deleted. */
  sessionId: Schema.NullOr(SessionId),
  projectId: ProjectId,
  /** The landed checkpoint; null when it was since removed, or never taken. */
  checkpointId: Schema.NullOr(CheckpointId),
  checkpointRef: Schema.NullOr(Schema.String),
  checkpointSha: Schema.NullOr(Sha),
  /** The commit Mend wrote for work the agent left uncommitted; null when it wrote none. */
  commitSha: Schema.NullOr(Sha),
  /** The branch on origin, `mend/<name>` unless the owner named another. */
  remoteBranch: Schema.String,
  /** What origin's branch was moved to; null when nothing was pushed. */
  pushedSha: Schema.NullOr(Sha),
  trigger: LandingTrigger,
  pullRequest: Schema.NullOr(LandedPullRequest),
  outcome: LandingOutcome,
  /** The remote's or `gh`'s own words for a refusal or a failure; null otherwise. */
  message: Schema.NullOr(Schema.String),
  /** The session's owner, whose key pushed and who speaks on GitHub. */
  userId: Schema.String,
  createdAt: Timestamp,
}) {}

// ─── Request intent ─────────────────────────────────────────────────────────

/**
 * What a turn's request asked for ("Questions do not open pull requests"): a `change`, or a
 * `question` that an answer settles.
 */
export const RequestIntent = Schema.Literals(["change", "question"]);
export type RequestIntent = typeof RequestIntent.Type;

/**
 * Where a turn's intent came from: `read` by inference, an `option` in the request
 * (`autopr=true` reads as a change, `autopr=false` as a question), or `unread` when inference was
 * off or over its budget, which leaves the intent null.
 */
export const RequestIntentSource = Schema.Literals(["read", "option", "unread"]);
export type RequestIntentSource = typeof RequestIntentSource.Type;

/** A turn's intent as it is recorded: an intent and its source, or the fact that none was read. */
export const RequestIntentReading = Schema.Union([
  Schema.Struct({ intent: RequestIntent, source: Schema.Literals(["read", "option"]) }),
  Schema.Struct({ intent: Schema.Null, source: Schema.Literals(["unread"]) }),
]);
export type RequestIntentReading = typeof RequestIntentReading.Type;

/**
 * Whether a turn's request lets a completed turn land. Only a request that read as a question
 * holds it back: an unread one is treated as a change, and the prompt and the empty-change check
 * guard it instead.
 */
export const intentAllowsLanding = (turn: { readonly intent: RequestIntent | null }): boolean =>
  turn.intent !== "question";

// ─── When a session lands by itself ─────────────────────────────────────────

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

// ─── Observed facts ─────────────────────────────────────────────────────────

/** Why a change that a completed turn left behind was not landed. */
export const NotLandedReason = Schema.Literals([
  /** The request read as a question. */
  "question",
  /** The request said `autopr=false`. */
  "option",
  /** Automatic landing is off for the session. */
  "off",
  /** Someone other than the owner sent the turn under shared control. */
  "not-owner",
]);
export type NotLandedReason = typeof NotLandedReason.Type;

/**
 * One observed fact about a change's landing, as the review page, the session page and a Slack
 * thread state it. Each is what Mend saw, with where it saw it; none says what to do next.
 */
export const LandingFact = Schema.Union([
  /** A landing moved origin's branch to this sha. */
  Schema.TaggedStruct("pushed", { branch: Schema.String, sha: Sha }),
  /** The landing's pull request, as `gh` last reported it. */
  Schema.TaggedStruct("pull-request", {
    number: Schema.Int,
    state: PullRequestState,
    observedAt: Timestamp,
  }),
  /** A fetch found commits on origin's branch that Mend's branch does not have. */
  Schema.TaggedStruct("origin-moved", { branch: Schema.String, commits: Schema.Int }),
  /** The worktree moved past the landed checkpoint. */
  Schema.TaggedStruct("changed-since-landing", { files: Schema.Int }),
  /** The latest landing's push was refused, in the remote's words. */
  Schema.TaggedStruct("refused", { branch: Schema.String, message: Schema.String }),
  /** The latest landing failed before it pushed. */
  Schema.TaggedStruct("failed", { message: Schema.String }),
  /** The latest landing pushed, and its pull request step failed. */
  Schema.TaggedStruct("pull-request-failed", { message: Schema.String }),
  /** A push the agent made itself, through the workspace's git transport. Not a landing. */
  Schema.TaggedStruct("agent-push", { ref: Schema.String, sha: Schema.NullOr(Sha) }),
  /** A completed turn left changes that did not land. */
  Schema.TaggedStruct("not-landed", { reason: NotLandedReason }),
  /** The request's intent could not be read, so it was treated as a change. */
  Schema.TaggedStruct("intent-not-read", {}),
]);
export type LandingFact = typeof LandingFact.Type;

/** What the landing facts are derived from: the record, and what the last looks observed. */
export interface LandingObservations {
  /** The change's landings, newest first. */
  readonly landings: ReadonlyArray<ChangeLanding>;
  /** Commits on origin's branch that Mend's branch lacks, from the last fetch; null when none ran. */
  readonly originCommitsUnseen: number | null;
  /** Files that differ between the landed checkpoint and the latest one; null when not compared. */
  readonly filesChangedSinceLanding: number | null;
  /** `session_git_ops.ref_updates` of the agent's own pushes: `<old-sha> <new-sha> <ref>`. */
  readonly agentRefUpdates: ReadonlyArray<string>;
}

const ZERO_SHA = /^0+$/;

/** One ref command a push sent, as the transport recorded it; null for a line it cannot read. */
export const parseRefUpdate = (
  line: string,
): { readonly ref: string; readonly sha: Sha | null } | null => {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
  if (match === null) return null;
  const [, , next = "", ref = ""] = match;
  return { ref, sha: ZERO_SHA.test(next) ? null : Sha.make(next) };
};

/**
 * The facts to show for a change, in the order they read: the last push, its pull request, what
 * moved since, how the latest landing ended when it did not push, and the agent's own pushes.
 */
export const landingFacts = (observed: LandingObservations): ReadonlyArray<LandingFact> => {
  const facts: Array<LandingFact> = [];
  const latest = observed.landings[0];
  const lastPush = observed.landings.find((landing) => landing.pushedSha !== null);
  if (lastPush !== undefined && lastPush.pushedSha !== null) {
    facts.push({ _tag: "pushed", branch: lastPush.remoteBranch, sha: lastPush.pushedSha });
  }
  const lastPullRequest = observed.landings.find((landing) => landing.pullRequest !== null);
  if (lastPullRequest !== undefined && lastPullRequest.pullRequest !== null) {
    const { number, state, observedAt } = lastPullRequest.pullRequest;
    facts.push({ _tag: "pull-request", number, state, observedAt });
  }
  if (lastPush !== undefined && (observed.originCommitsUnseen ?? 0) > 0) {
    facts.push({
      _tag: "origin-moved",
      branch: lastPush.remoteBranch,
      commits: observed.originCommitsUnseen ?? 0,
    });
  }
  if (lastPush !== undefined && (observed.filesChangedSinceLanding ?? 0) > 0) {
    facts.push({ _tag: "changed-since-landing", files: observed.filesChangedSinceLanding ?? 0 });
  }
  if (latest !== undefined) {
    const message = latest.message ?? "no reason given";
    if (latest.outcome === "refused") {
      facts.push({ _tag: "refused", branch: latest.remoteBranch, message });
    } else if (latest.outcome === "failed") {
      facts.push(
        latest.pushedSha === null
          ? { _tag: "failed", message }
          : { _tag: "pull-request-failed", message },
      );
    }
  }
  for (const line of observed.agentRefUpdates) {
    const update = parseRefUpdate(line);
    if (update !== null) facts.push({ _tag: "agent-push", ...update });
  }
  return facts;
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
  question: "the request read as a question",
  option: "the request said autopr=false",
  off: "automatic landing is off",
  "not-owner": "the turn was not sent by the owner",
};

/** One fact as its status line: terse, observed, and never a verdict. */
export const landingFactLine = (fact: LandingFact, now: Date): string => {
  switch (fact._tag) {
    case "pushed":
      return `pushed · ${fact.branch} · ${shortSha(fact.sha)} · observed`;
    case "pull-request":
      return `pull request #${fact.number} · ${fact.state} · observed ${observedAgo(fact.observedAt, now)}`;
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
      return `changes not landed · ${NOT_LANDED[fact.reason]}`;
    case "intent-not-read":
      return "intent not read";
  }
};
