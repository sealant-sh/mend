import { Effect, Schema } from "effect";

import { ChangeId, ChangeLandingId, CheckpointId, ProjectId, SessionId, Sha } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { openedOutsideMend } from "./landing-rules.ts";

export * from "./landing-rules.ts";

/**
 * Landing (docs/adr/0007-landing.md): Mend commits what the worktree holds, pushes the session's
 * branch to origin, and opens or updates the pull request. Merging stays on GitHub. What Mend
 * keeps is the record of each landing and the facts it observed since, never a verdict.
 */

/**
 * What started a landing: the owner's button or command, a completed turn, or `adopted`: Mend
 * found a pull request opened outside it (by the agent, or by hand) for the change's branch and
 * recorded it ("The agent opens its own pull request").
 */
export const LandingTrigger = Schema.Literals(["manual", "automatic", "adopted"]);
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
 * - `adopted`: nothing was pushed or opened by Mend; a pull request opened outside Mend was found
 *   for the change and recorded, so the next landing updates it instead of opening a second one.
 */
export const LandingOutcome = Schema.Literals([
  "pushed",
  "pull-request",
  "refused",
  "failed",
  "adopted",
]);
export type LandingOutcome = typeof LandingOutcome.Type;

/** A pull request's state as `gh` reports it. */
export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

/** The pull request a landing opened or updated, as `gh` last reported it, and when. */
export const LandedPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  state: PullRequestState,
  /** Its title as `gh` last reported it; null when recorded before Mend kept it. */
  title: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  observedAt: Timestamp,
});
export type LandedPullRequest = typeof LandedPullRequest.Type;

/**
 * The pull request a list row shows for a change: the newest one any landing recorded, as `gh`
 * last reported it. `adopted` when it was opened outside Mend (by the agent, or by hand).
 */
export const ChangePullRequest = Schema.Struct({
  ...LandedPullRequest.fields,
  adopted: Schema.Boolean,
});
export type ChangePullRequest = typeof ChangePullRequest.Type;

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
  /**
   * The pull request's head is in another repository (a fork): Mend pushes to origin only, so it
   * never updates such a pull request. Older servers omit it.
   */
  pullRequestCrossRepository: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /** Who owns the repository the pull request's head is in, as `gh` reported it; null unknown. */
  pullRequestHeadOwner: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  outcome: LandingOutcome,
  /** The remote's or `gh`'s own words for a refusal or a failure; null otherwise. */
  message: Schema.NullOr(Schema.String),
  /** The change's owner (`Worktree.changeOwnerUserId`), whose key pushed and who speaks on GitHub. */
  userId: Schema.String,
  createdAt: Timestamp,
}) {}

// ─── Request intent ─────────────────────────────────────────────────────────

/**
 * What a turn's request asked for ("Questions do not open pull requests"): a `change`, a
 * `question` that an answer settles, or `land`: publish the change as it stands ("land it", "open
 * a PR", "push it"), which lands it for the change's owner even when the turn changed nothing.
 */
export const RequestIntent = Schema.Literals(["change", "question", "land"]);
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

// ─── The prompt guard ───────────────────────────────────────────────────────

/**
 * What the opening turn Mend composes tells the agent when Mend publishes its work: every Slack
 * request, and any session with automatic landing on ("Questions do not open pull requests").
 * It rides after the request, so the request still reads first.
 */
export const LANDING_GUARD = [
  "--- How this work is published ---",
  "Mend publishes this session's change, not you: after a turn that asked for a change, Mend pushes the branch and opens or updates the pull request.",
  "- If the request is a question, answer it and change no files.",
  "- Change code only when the request asks for a change.",
  "- If the user asks you to land, push, publish or open a pull request, run `mend land` and report the lines it prints as they are. It lands as the change's owner, or says why it did not.",
  "- Never push and never open a pull request yourself. Committing is fine.",
  "--- End of how this work is published ---",
].join("\n");

/** Guards earlier releases appended, so their turns still read as what the requester wrote. */
const EARLIER_LANDING_GUARDS: ReadonlyArray<string> = [
  [
    "--- How this work is published ---",
    "Mend publishes the changes this session makes: it pushes the branch and opens or updates the pull request.",
    "- If the request is a question, answer it and change no files.",
    "- Change code only when the request asks for a change.",
    "- Never push and never open a pull request. Committing is fine.",
    "--- End of how this work is published ---",
  ].join("\n"),
];

/** The opening turn with the guard after it; an empty prompt stays empty. */
export const withLandingGuard = (prompt: string): string =>
  prompt.trim() === "" ? prompt : `${prompt.trimEnd()}\n\n${LANDING_GUARD}`;

/** A turn's request without the guard Mend added to it: what the requester wrote. */
export const requestOfTurn = (input: string): string => {
  const guard = [LANDING_GUARD, ...EARLIER_LANDING_GUARDS].find((text) => input.endsWith(text));
  return guard === undefined ? input : input.slice(0, -guard.length).trimEnd();
};

// ─── When a session lands by itself ─────────────────────────────────────────

// ─── Observed facts ─────────────────────────────────────────────────────────

/** Why a completed turn did not land the change. */
export const NotLandedReason = Schema.Literals([
  /** The request read as a question. */
  "question",
  /** The request said `autopr=false`. */
  "option",
  /** Automatic landing is off for the session. */
  "off",
  /** Someone other than the owner sent the turn under shared control. */
  "not-owner",
  /** The request asked for a change or a landing, and the change is empty. */
  "no-change",
  /** The request asked for a change or a landing, and the last landing already pushed it all. */
  "nothing-new",
  /**
   * The executor's captures never caught up with the turn (`capture.flush` refused, timed out
   * or partial however often Mend asked), so the change Mend can read may be stale. Mend does not
   * land it, and does not call it empty either.
   */
  "not-captured",
]);
export type NotLandedReason = typeof NotLandedReason.Type;

/**
 * Whether a reason leaves a change the owner can still land by hand, so the thread offers "Push
 * and open pull request". An empty change, or one the last landing already pushed, has nothing
 * to push.
 */
export const offersLanding = (reason: NotLandedReason): boolean =>
  reason !== "no-change" && reason !== "nothing-new";

/**
 * What Mend decided about a turn once it ended ("When a completed turn lands"), recorded on the
 * turn so a second worker never decides it again:
 *
 * - `attempted`: a landing ran; how it ended is on its `change_landings` row.
 * - a `NotLandedReason`: the turn did not land the change, for that reason.
 * - `skipped`: nothing to say. The turn did not complete, the agent is waiting on the owner,
 *   another turn follows it, a question left nothing to land, or automatic landing is off for a
 *   session whose owner watches it.
 */
export const TurnLanding = Schema.Literals([
  "attempted",
  "question",
  "option",
  "off",
  "not-owner",
  "no-change",
  "nothing-new",
  "not-captured",
  "skipped",
]);
export type TurnLanding = typeof TurnLanding.Type;

/** The reason a turn's decision names, when it is one; null for `attempted` and `skipped`. */
export const notLandedReasonOf = (landing: TurnLanding | null): NotLandedReason | null => {
  switch (landing) {
    case "question":
    case "option":
    case "off":
    case "not-owner":
    case "no-change":
    case "nothing-new":
    case "not-captured":
      return landing;
    default:
      return null;
  }
};

/**
 * The latest turn automatic landing decided about, by when it ended: the one whose decision the
 * facts state ("changes not landed · …", "intent not read").
 */
export const latestDecidedTurn = <
  T extends {
    readonly landing: TurnLanding | null;
    readonly endedAt: Date | null;
    readonly createdAt: Date;
  },
>(
  turns: ReadonlyArray<T>,
): T | null =>
  turns
    .filter((turn) => turn.landing !== null)
    .reduce<T | null>(
      (latest, turn) => (latest === null || turnEnd(turn) > turnEnd(latest) ? turn : latest),
      null,
    );

const turnEnd = (turn: { readonly endedAt: Date | null; readonly createdAt: Date }): number =>
  (turn.endedAt ?? turn.createdAt).getTime();

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
    /** Opened outside Mend and adopted. Older servers omit it. */
    outside: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    /** The fork's owner when its head is in another repository; null for origin's own. */
    fork: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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

const decodeWireFacts = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(LandingFact)));

/**
 * Landing facts as a client reads them off the JSON wire, for clients that render with
 * `landingFactLine` and keep no schema of their own (the CLI). Throws on a shape it cannot read.
 */
export const landingFactsFromWire = (wire: unknown): ReadonlyArray<LandingFact> =>
  decodeWireFacts(wire);

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
  /**
   * The latest turn Mend decided about, in the change's worktree: what it decided, how the
   * request's intent was read, and when the turn ended. Absent or null says nothing.
   */
  readonly latestTurn?: DecidedTurn | null;
}

/** A turn as the landing facts read it. */
export interface DecidedTurn {
  readonly landing: TurnLanding | null;
  readonly intentSource: RequestIntentSource | null;
  readonly endedAt: Date | null;
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
    facts.push({
      _tag: "pull-request",
      number,
      state,
      observedAt,
      outside: openedOutsideMend(observed.landings, number),
      fork: lastPullRequest.pullRequestCrossRepository
        ? (lastPullRequest.pullRequestHeadOwner ?? "")
        : null,
    });
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
  const turn = observed.latestTurn ?? null;
  if (turn !== null) {
    const reason = notLandedReasonOf(turn.landing);
    // A landing made since the turn ended (the owner's button) answers it.
    const answered = observed.landings.some(
      (landing) => turn.endedAt !== null && landing.createdAt >= turn.endedAt,
    );
    if (reason !== null && !answered) facts.push({ _tag: "not-landed", reason });
    if (turn.landing === "attempted" && turn.intentSource === "unread") {
      facts.push({ _tag: "intent-not-read" });
    }
  }
  for (const line of observed.agentRefUpdates) {
    const update = parseRefUpdate(line);
    if (update !== null) facts.push({ _tag: "agent-push", ...update });
  }
  return facts;
};

/**
 * The branches a pushed change may be under on origin, newest first: every `refs/heads/*` the
 * agent's own pushes created or moved (`session_git_ops.ref_updates`, lines already newest first).
 * Deletions and other refs are left out.
 */
export const agentPushedBranches = (refUpdates: ReadonlyArray<string>): ReadonlyArray<string> => {
  const branches: Array<string> = [];
  for (const line of refUpdates) {
    const update = parseRefUpdate(line);
    if (update === null || update.sha === null || !update.ref.startsWith("refs/heads/")) continue;
    const branch = update.ref.slice("refs/heads/".length);
    if (!branches.includes(branch)) branches.push(branch);
  }
  return branches;
};
