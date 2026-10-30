import {
  AgentConversationRepo,
  ChangeLandingsRepo,
  ChangePassesRepo,
  ChangeToursRepo,
  ProjectsRepo,
  ReviewCommentsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import type { SessionId } from "@mend/domain";
import {
  agentWaitLine,
  captureStatusLine,
  currentAgentProcess,
  latestDecidedTurn,
  liveAgentsReading,
  type AgentItem,
  type AgentRequest,
  type AgentTurn,
  showsRendering,
  type AgentWaitLine,
  type Change,
  type ChangeLanding,
  type ChangePass,
  type Session,
  type SlackStatusKey,
} from "@mend/domain/workbench";
import { WorktreeReads } from "@mend/sessions";
import {
  agentMessage,
  approvalMessage,
  changeUrl,
  diffMessages,
  disclosureFor,
  isSettledState,
  landingStatusLines,
  landOfferMessage,
  landOfferOf,
  planText,
  privateProjectStatusMessage,
  questionMessage,
  reactionFor,
  reviewMessage,
  sessionUrl,
  slackSessionState,
  splitDiff,
  statusMayMove,
  statusKey,
  statusMessage,
  switchOffered,
  threadShowsReplies,
  type ChangeCounts,
  type LandOffer,
  type SlackMessage,
  type SlackSessionState,
} from "@mend/slack";
import { SlackApi, SlackApiError, updateRefusalOf } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Cause, Clock, Effect, Layer, Queue } from "effect";
import * as Context from "effect/Context";

/**
 * The Slack thread reporter (docs/adr/0006-slack.md, "What Mend posts, and where"): the sibling of
 * `SessionNotifierLive` whose sink is the Slack thread a session was started from. Asked to report
 * (`SlackReports`, fed from the process's events bus), it re-reads the sessions that have a Slack
 * thread, and keeps the thread in step:
 *
 * - the one status message, edited in place, and the reaction on the request (⏳ → ✅ / ❌);
 * - the agent's first message when it is a plan, and each turn's closing message;
 * - a question the agent asks, naming the owner, and an approval as a status line with a link;
 * - once Mend's passes over the change have run, one reply: the review tour's summary and
 *   approach, what the review pass drafted, and "Review in Mend";
 * - on completion, the change's line counts in the status line; and when the owner turned diffs
 *   on, each file's diff, once, the first time the session settles with a change;
 * - the change's landing under the status line (docs/adr/0007-landing.md, "What the thread sees"):
 *   `pushed · mend/fix-login · pull request #412 · opened`, edited in place by each landing, or a
 *   refusal or failure in the remote's words; and when a completed turn's change did not land (a
 *   question, `autopr=false`, automatic landing off, a follow-up from someone other than the
 *   owner), the offer to land it: "Push and open pull request", on the end-of-session reply when
 *   that reply goes out in the same look, and as a reply of its own otherwise.
 *
 * The install's display settings decide how much: with agent messages off, or in a Slack Connect
 * channel the owner did not open, the thread gets status, reactions and links only.
 *
 * Disclosure is checked again on every look. A channel thread whose project is no longer `shared`
 * gets its status message edited to a line that names nothing, and no reply; a direct message
 * with the bot is the requester's own. A thread is written only through the install of the
 * organization that owns the session's project.
 *
 * The notifier's guards apply to every reply: a session first seen mid-flight is recorded without
 * posting, and nothing older than two minutes is announced. The status message is not a reply: it
 * converges on the observed state whenever the reporter looks, so a restart never leaves a thread
 * reading `running`.
 *
 * What was posted lives in Postgres, not in memory, so a restart or a second worker never posts
 * twice: the status message moves only by compare-and-set over the key of its whole rendering
 * (`claimStatus`, `statusKey`), and each reply is claimed by key (`claimPost`) before it is posted.
 * A claimed reply
 * whose post fails is logged, not retried, as a claimed Slack event is. After launch the reporter
 * is the status message's one writer: the runner asks it to report.
 *
 * While the session runs, its status line moves at most once every `STATUS_EDIT_EVERY_MS`: a loop
 * that flips it between `running` and `waiting` would otherwise edit the message on every flip. A
 * change to the previews alone moves at most once every `STATUS_PREVIEW_EVERY_MS`. A move
 * held back looks again when the window ends, so the message still lands on the latest state. A
 * move into a settled state, and the first move out of one, is edited at once.
 */

const REPORT_FRESHNESS_MS = 2 * 60_000;
export const STATUS_EDIT_EVERY_MS = 30_000;
/** A change to a status message's previews alone edits it at most this often. */
export const STATUS_PREVIEW_EVERY_MS = 10_000;
/** How long one status edit may take, the Slack client's own retries and waits included. */
export const STATUS_EDIT_DEADLINE_MS = 15_000;

/** A settled session not looked at for this long is forgotten: its next look is a baseline. */
const SEEN_SETTLED_TTL_MS = 60 * 60_000;
/** Anything not looked at for a day is forgotten, settled or not. */
const SEEN_TTL_MS = 24 * 60 * 60_000;
/** How often the memory of what was seen is swept. */
const SEEN_SWEEP_MS = 60_000;

/** The machine passes whose drafts the thread hears about: the read and the suggestions. */
const DRAFT_PASSES: ReadonlySet<string> = new Set(["read", "suggest"]);

/**
 * The end-of-session reply's moment: Mend's passes over the change since the thread began, once
 * none of them is running. Its key names the change and when the latest finished, so a later pass
 * is news again. `tourAt` is when the tour finished, when it completed in that time; `drafted`
 * says a read or suggestion pass did. A failed pass is not waited for and adds nothing: the thread
 * keeps the agent's closing message.
 */
export interface ReviewMoment {
  readonly key: string;
  readonly finishedAt: Date;
  readonly tourAt: Date | null;
  readonly drafted: boolean;
}

export const reviewMoment = (
  change: Pick<Change, "id"> | null,
  passes: ReadonlyArray<Pick<ChangePass, "kind" | "status" | "finishedAt">>,
  since: Date,
): ReviewMoment | null => {
  if (change === null) return null;
  if (passes.some((pass) => pass.status === "running")) return null;
  const completed = passes.flatMap((pass) =>
    pass.status === "completed" && pass.finishedAt !== null && pass.finishedAt >= since
      ? [{ kind: pass.kind, finishedAt: pass.finishedAt }]
      : [],
  );
  const latest = completed
    .map((pass) => pass.finishedAt)
    .toSorted((a, b) => b.getTime() - a.getTime())[0];
  if (latest === undefined) return null;
  return {
    key: `review:${change.id}:${latest.getTime()}`,
    finishedAt: latest,
    tourAt: completed.find((pass) => pass.kind === "tour")?.finishedAt ?? null,
    drafted: completed.some((pass) => DRAFT_PASSES.has(pass.kind)),
  };
};

/**
 * The first thing the agent said, when that is decided: the session's first turn's first message
 * or plan. Undefined while nothing is said yet, or while a plan is still being written.
 */
export const openingOf = (messages: ReadonlyArray<AgentItem>): AgentItem | null | undefined => {
  const [first] = messages;
  if (first === undefined) return undefined;
  if (first.kind === "plan" && first.status === "in-progress") return undefined;
  return first;
};

/** The message a turn closed on: its last message with text. */
export const closingOf = (messages: ReadonlyArray<AgentItem>): AgentItem | null =>
  messages.findLast(
    (item) => item.kind === "assistant-message" && item.text !== null && item.text.trim() !== "",
  ) ?? null;

/** What this process has seen of a session: the baseline replies are measured against. */
interface Seen {
  readonly endedTurns: ReadonlySet<string>;
  readonly requests: ReadonlySet<string>;
  /** The opening message is decided (a plan, or anything else). */
  readonly opening: boolean;
  readonly review: string | null;
  /** The thread's state was settled (completed, failed, stopped): its diff moment has passed. */
  readonly settled: boolean;
  /** When this process last looked, for forgetting sessions nobody looks at any more. */
  readonly at: number;
}

/** Everything one look at a session reads. */
interface Look {
  readonly thread: SlackThreadSession;
  readonly session: Session;
  readonly state: SlackSessionState;
  /** What the live terminal agents' hooks say together (`agentWaitLine`); null for none. */
  readonly agent: AgentWaitLine | null;
  readonly turns: ReadonlyArray<AgentTurn>;
  readonly pending: ReadonlyArray<AgentRequest>;
  readonly opening: AgentItem | null | undefined;
  readonly change: Change | null;
  readonly review: ReviewMoment | null;
  /** The change's landings since the thread began, newest first. */
  readonly landings: ReadonlyArray<ChangeLanding>;
  /** The latest turn automatic landing decided about. */
  readonly decided: AgentTurn | null;
}

/** Nothing seen yet: every reply is news. */
const NOTHING_SEEN: Seen = {
  endedTurns: new Set(),
  requests: new Set(),
  opening: false,
  review: null,
  settled: false,
  at: 0,
};

const seenOf = (look: Look, at: number): Seen => ({
  endedTurns: new Set(
    look.turns.flatMap((turn) =>
      turn.status === "queued" || turn.status === "running" ? [] : [turn.id],
    ),
  ),
  requests: new Set(look.pending.map((request) => request.id)),
  opening: look.opening !== undefined,
  review: look.review?.key ?? null,
  settled: isSettledState(look.state),
  at,
});

/** The key an offer to land a turn's change is posted under, once. */
const offerKey = (offer: LandOffer) => `land-offer:${offer.turnId}`;

/** A Slack write whose failure is logged, never raised: the thread is not the session. */
const quietly = <A>(what: string, effect: Effect.Effect<A, SlackApiError>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning(`slack reporter: ${what} failed`).pipe(
        Effect.annotateLogs({ method: error.method, code: error.code }),
      ),
    ),
  );

export interface SlackReporterOptions {
  readonly now?: () => number;
}

export const makeSlackReporter = (options: SlackReporterOptions = {}) =>
  Effect.gen(function* () {
    const threads = yield* SlackThreadsRepo;
    const installs = yield* SlackInstallsRepo;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const projects = yield* ProjectsRepo;
    const conversations = yield* AgentConversationRepo;
    const changes = yield* WorktreeChangesRepo;
    const passes = yield* ChangePassesRepo;
    const tours = yield* ChangeToursRepo;
    const comments = yield* ReviewCommentsRepo;
    const landingsRepo = yield* ChangeLandingsRepo;
    const reads = yield* WorktreeReads;
    const cipher = yield* SecretCipher;
    const slack = yield* SlackApi;
    const clock = yield* Clock.Clock;
    const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
    const scope = yield* Effect.scope;

    const seen = new Map<string, Seen>();
    const editedAt = new Map<
      string,
      {
        readonly at: number;
        readonly settled: boolean;
        readonly keyWithoutPreviews: SlackStatusKey;
      }
    >();
    const heldBack = new Set<string>();
    let sweptAt = 0;

    /** Forget settled sessions nobody has looked at in an hour, and anything after a day. */
    const sweep = () => {
      const at = now();
      if (at - sweptAt < SEEN_SWEEP_MS) return;
      sweptAt = at;
      for (const [sessionId, entry] of seen) {
        const idle = at - entry.at;
        if (idle > SEEN_TTL_MS || (entry.settled && idle > SEEN_SETTLED_TTL_MS)) {
          seen.delete(sessionId);
          editedAt.delete(sessionId);
        }
      }
    };

    const fresh = (at: Date | null): boolean =>
      at !== null && now() - at.getTime() <= REPORT_FRESHNESS_MS;

    const botTokenOf = (install: SealedSlackInstall) =>
      cipher
        .decrypt(install.sealedBotToken)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("slack reporter: bot token not unsealed").pipe(
              Effect.annotateLogs({ organizationId: install.organizationId, cause: error.message }),
              Effect.as(null),
            ),
          ),
        );

    /** Read everything the thread could show about a session, or null for one it does not. */
    const lookAt = Effect.fn("SlackReporter.lookAt")(function* (sessionId: SessionId) {
      // The thread first, then the session: a status line read here is never newer than the
      // state read after it, so a compare-and-set against it cannot move the message backwards.
      const thread = yield* threads.forSession(sessionId);
      if (thread === null) return null;
      const session = yield* sessions
        .byId(sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null) return null;
      const turns = yield* conversations.listTurns(session.id);
      const rows = yield* processes.listForSession(session.id);
      const currentAgent = currentAgentProcess(rows);
      const pending = yield* conversations.listRequests(session.id, true);
      const firstTurn = turns.reduce<AgentTurn | null>(
        (first, turn) => (first === null || turn.ordinal < first.ordinal ? turn : first),
        null,
      );
      const opening =
        firstTurn === null ? undefined : openingOf(yield* conversations.turnMessages(firstTurn.id));
      const change = yield* changes.byWorktree(session.worktreeId);
      const review =
        change === null
          ? null
          : reviewMoment(change, yield* passes.listForChange(change.id), thread.createdAt);
      const state = slackSessionState({
        status: session.status,
        currentAgent,
        turns,
        idleStoppedAt: session.idleStoppedAt,
      });
      // Only what this thread asked for: a landing from before it is someone else's news.
      const landings =
        change === null
          ? []
          : (yield* landingsRepo.listForChange(change.id)).filter(
              (landing) => landing.createdAt >= thread.createdAt,
            );
      const decided = latestDecidedTurn(turns);
      return {
        thread,
        session,
        state,
        agent: agentWaitLine(liveAgentsReading(rows, pending.length > 0)),
        turns,
        pending,
        opening,
        change,
        review,
        landings,
        decided,
      } satisfies Look;
    });

    /** Files, additions and deletions of the change against its base; null when unreadable. */
    const countsOf = (session: Session, change: Change) =>
      reads.changedFiles(session.projectId, session.worktreeId, change.baseSha).pipe(
        Effect.map(
          ({ value }): ChangeCounts => ({
            files: value.length,
            additions: value.reduce((total, file) => total + file.additions, 0),
            deletions: value.reduce((total, file) => total + file.deletions, 0),
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("slack reporter: the change could not be read").pipe(
            Effect.annotateLogs({ sessionId: session.id, cause: error._tag }),
            Effect.as(null),
          ),
        ),
      );

    const lookAgainIn = (sessionId: SessionId, delayMs: number) =>
      Effect.suspend(() => {
        if (heldBack.has(sessionId)) return Effect.void;
        heldBack.add(sessionId);
        return Effect.sleep(delayMs).pipe(
          Effect.andThen(
            Effect.suspend((): Effect.Effect<void> => {
              heldBack.delete(sessionId);
              return observe(sessionId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("slack reporter: held-back session report failed").pipe(
                    Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
                  ),
                ),
              );
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    /**
     * Bounded in time, the Slack client's own retries included. A refused edit releases its claim,
     * since the message does not show it; a transient refusal looks again after Slack's
     * Retry-After.
     */
    const sendStatus = (
      token: string,
      thread: SlackThreadSession,
      statusTs: string,
      message: SlackMessage,
      key: SlackStatusKey,
    ) =>
      slack.update(token, { channel: thread.channelId, ts: statusTs, ...message }).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: STATUS_EDIT_DEADLINE_MS,
          orElse: () =>
            Effect.fail(
              new SlackApiError({
                method: "chat.update",
                code: "timeout",
                message: "Slack did not answer in time",
              }),
            ),
        }),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const refusal = updateRefusalOf(error);
            yield* Effect.logWarning("slack reporter: chat.update failed").pipe(
              Effect.annotateLogs({
                method: error.method,
                code: error.code,
                sessionId: thread.sessionId,
                refusal: refusal._tag,
              }),
            );
            if (refusal._tag === "MessageGone") return false;
            yield* threads.releaseStatus(thread.sessionId, key);
            if (refusal._tag === "Transient") {
              yield* lookAgainIn(thread.sessionId, refusal.retryInMs);
            }
            return false;
          }),
        ),
      );

    /**
     * Edit the status message and move the reaction, once across workers. Only the session the
     * request last started takes its reaction: a switch reuses the request. Previews can move
     * several times a minute while one prepares, so a change to them alone waits
     * `STATUS_PREVIEW_EVERY_MS`.
     */
    const moveStatus = Effect.fn("SlackReporter.moveStatus")(function* (
      token: string,
      look: Look,
      message: SlackMessage,
      withoutPreviews: SlackMessage = message,
    ) {
      const { thread, session, state } = look;
      if (thread.statusTs === null) return;
      const key = statusKey(message);
      const keyWithoutPreviews = statusKey(withoutPreviews);
      const edit = !showsRendering(thread.shown, key, message.text);
      if (!edit && state === thread.reportedState) return;
      const last = editedAt.get(session.id);
      if (edit && last !== undefined) {
        const wait = Math.max(
          !isSettledState(state) && !last.settled ? last.at + STATUS_EDIT_EVERY_MS - now() : 0,
          state === thread.reportedState && keyWithoutPreviews === last.keyWithoutPreviews
            ? last.at + STATUS_PREVIEW_EVERY_MS - now()
            : 0,
        );
        if (wait > 0) return yield* lookAgainIn(session.id, wait);
      }
      const moved = yield* threads.claimStatus(session.id, thread.shown, { state, key });
      if (!moved) return;
      if (edit && (yield* sendStatus(token, thread, thread.statusTs, message, key))) {
        editedAt.set(session.id, {
          at: now(),
          settled: isSettledState(state),
          keyWithoutPreviews,
        });
      }
      const was = reactionFor(thread.reportedState ?? "starting");
      const is = reactionFor(state);
      if (was === is) return;
      if (!(yield* threads.ownsRequestReaction(session.id))) return;
      const at = { channel: thread.channelId, timestamp: thread.requestTs };
      if (is !== null)
        yield* quietly("reactions.add", slack.reactionsAdd(token, { ...at, name: is }));
      if (was !== null) {
        yield* quietly("reactions.remove", slack.reactionsRemove(token, { ...at, name: was }));
      }
    });

    /**
     * Keep the status message and the reaction on the observed state. A null `projectName` is a
     * channel thread whose project is private now: the message says so and names nothing. Nothing
     * moves the state back to `starting` (`statusMayMove`): a launch that failed keeps `failed`,
     * and the rest of the message still follows what changes.
     */
    const reportStatus = Effect.fn("SlackReporter.reportStatus")(function* (
      install: SealedSlackInstall,
      token: string,
      observed: Look,
      projectName: string | null,
    ) {
      const { thread } = observed;
      if (thread.statusTs === null) return;
      const look: Look = {
        ...observed,
        state:
          thread.reportedState === null || statusMayMove(thread.reportedState, observed.state)
            ? observed.state
            : thread.reportedState,
      };
      const { session, state } = look;
      if (projectName === null) {
        return yield* moveStatus(token, look, privateProjectStatusMessage());
      }
      const change =
        look.change !== null && isSettledState(state)
          ? yield* countsOf(session, look.change)
          : null;
      const message = statusMessage({
        project: projectName,
        source: thread.projectSource,
        harness: session.harness,
        branch: session.branch,
        state,
        recorded: session.sealantRunId !== null,
        agent: look.agent,
        change,
        url: sessionUrl(install.webOrigin, session.id),
        // Offered until the first turn completes, which also moves the line, so the button
        // leaves with the edit that says so. The runner checks again on a click.
        switchSession: switchOffered(state, look.turns) ? session.id : null,
        landing: landingStatusLines({ landings: look.landings, latestTurn: look.decided }),
        summary: session.summary,
        capture: captureStatusLine(session),
      });
      yield* moveStatus(token, look, message);
    });

    /** Post a reply once, whichever worker gets there first. */
    const postOnce = (
      token: string,
      thread: SlackThreadSession,
      key: string,
      messages: Effect.Effect<ReadonlyArray<SlackMessage>>,
    ) =>
      Effect.gen(function* () {
        if (!(yield* threads.claimPost(thread.sessionId, key))) return;
        for (const message of yield* messages) {
          yield* quietly(
            "chat.postMessage",
            slack.postMessage(token, {
              channel: thread.channelId,
              threadTs: thread.threadTs,
              text: message.text,
              blocks: message.blocks,
            }),
          );
        }
      });

    /** Each file's diff against the base, for a thread that shows diffs. */
    const diffsOf = (session: Session, change: Change, url: string) =>
      Effect.gen(function* () {
        const files = yield* reads.changedFiles(
          session.projectId,
          session.worktreeId,
          change.baseSha,
        );
        if (files.value.length === 0) return [];
        const diff = yield* reads.diffWorktree(
          session.projectId,
          session.worktreeId,
          change.baseSha,
        );
        const byPath = splitDiff(diff.value);
        return diffMessages(
          files.value.map((file) => ({ ...file, diff: byPath.get(file.path) ?? null })),
          url,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("slack reporter: the diff could not be read").pipe(
            Effect.annotateLogs({ sessionId: session.id, cause: error._tag }),
            Effect.as([]),
          ),
        ),
      );

    /**
     * The end-of-session reply: the tour's summary where agent messages are shown, then what the
     * review pass drafted. A summary is posted once per composed tour (its id and when its pass
     * finished), so a reply for a pass that finished after it does not repeat it.
     */
    const reviewReply = (
      thread: SlackThreadSession,
      change: Change,
      review: ReviewMoment,
      showSummary: boolean,
      webOrigin: string,
      offer: LandOffer | null,
    ) =>
      Effect.gen(function* () {
        const tour =
          showSummary && review.tourAt !== null ? yield* tours.byChange(change.id) : null;
        const summary =
          tour !== null &&
          review.tourAt !== null &&
          tour.createdAt >= thread.createdAt &&
          (yield* threads.claimPost(
            thread.sessionId,
            `summary:${tour.id}:${review.tourAt.getTime()}`,
          ))
            ? { summary: tour.summary, approach: tour.approach }
            : null;
        const drafts = review.drafted
          ? yield* comments.listForChange(change.id).pipe(
              Effect.map((list) => {
                const drafted = list.filter(
                  (comment) => comment.authorKind === "mend" && comment.state === "draft",
                );
                return {
                  drafts: drafted.length,
                  suggestions: drafted.filter((comment) => comment.kind === "suggestion").length,
                };
              }),
            )
          : null;
        // The offer rides this reply when it is due now; claimed like a reply of its own.
        const offered =
          offer !== null && (yield* threads.claimPost(thread.sessionId, offerKey(offer)))
            ? { offer, ownerSlackUserId: thread.slackUserId }
            : null;
        const message = reviewMessage({
          summary,
          drafts,
          url: changeUrl(webOrigin, change.id),
          offer: offered,
        });
        return message === null ? [] : [message];
      });

    /** The replies this look has that the last one did not: what is news. */
    const reportReplies = Effect.fn("SlackReporter.reportReplies")(function* (
      install: SealedSlackInstall,
      token: string,
      look: Look,
      before: Seen,
    ) {
      const { thread, session } = look;
      const shown = disclosureFor(install.settings, thread.external);
      const url = sessionUrl(install.webOrigin, session.id);

      // The agent's first message, when it is a plan: its text, or its todo list as a checklist.
      const opening = look.opening;
      if (
        !before.opening &&
        opening !== undefined &&
        opening !== null &&
        opening.kind === "plan" &&
        shown.agentMessages &&
        fresh(opening.updatedAt)
      ) {
        const plan = planText(opening);
        if (plan !== null) {
          yield* postOnce(token, thread, "plan", Effect.succeed([agentMessage(plan, url)]));
        }
      }

      // Each turn that ended since the last look: its closing message.
      for (const turn of look.turns) {
        if (turn.status !== "completed" || before.endedTurns.has(turn.id)) continue;
        if (!fresh(turn.endedAt)) continue;
        if (shown.agentMessages) {
          const closing = closingOf(yield* conversations.turnMessages(turn.id));
          if (closing !== null && closing.text !== null) {
            yield* postOnce(
              token,
              thread,
              `turn:${turn.id}`,
              Effect.succeed([agentMessage(closing.text, url)]),
            );
          }
        }
      }

      // The diff, once: the first time the session settles with a change, not on every turn.
      if (shown.diffs && look.change !== null && isSettledState(look.state) && !before.settled) {
        const diffs = yield* diffsOf(session, look.change, url);
        if (diffs.length > 0) yield* postOnce(token, thread, "diff", Effect.succeed(diffs));
      }

      // Questions and approvals opened since the last look.
      for (const request of look.pending) {
        if (before.requests.has(request.id) || !fresh(request.createdAt)) continue;
        const message =
          request.kind === "user-input"
            ? questionMessage({
                ownerSlackUserId: thread.slackUserId,
                questions: request.questions ?? [],
                showText: shown.agentMessages,
                url,
              })
            : approvalMessage({
                kind: request.kind,
                title: request.title,
                showText: shown.agentMessages,
                url,
              });
        yield* postOnce(token, thread, `request:${request.id}`, Effect.succeed([message]));
      }

      // A completed turn whose change did not land: the owner may land it from the thread. The
      // turn is decided moments after it ends; an offer for an older one is history.
      const offerable = landOfferOf({
        sessionId: session.id,
        turn: look.decided,
        landings: look.landings,
      });
      const offer =
        offerable !== null && look.change !== null && fresh(look.decided?.endedAt ?? null)
          ? offerable
          : null;

      // Mend's passes over the change, once they have run: one reply, which carries the offer
      // when both are due now.
      const review = look.review;
      const change = look.change;
      if (
        review !== null &&
        change !== null &&
        review.key !== before.review &&
        fresh(review.finishedAt)
      ) {
        yield* postOnce(
          token,
          thread,
          review.key,
          reviewReply(thread, change, review, shown.agentMessages, install.webOrigin, offer),
        );
      }
      // Otherwise the offer is a reply of its own: the end-of-session reply may come much later,
      // or not at all when no pass completes.
      if (offer !== null) {
        yield* postOnce(
          token,
          thread,
          offerKey(offer),
          Effect.succeed([landOfferMessage(offer, thread.slackUserId)]),
        );
      }
    });

    /** Look at a session again and bring its thread up to date. */
    const observe = Effect.fn("SlackReporter.observe")(function* (sessionId: SessionId) {
      sweep();
      const look = yield* lookAt(sessionId);
      if (look === null) {
        seen.delete(sessionId);
        editedAt.delete(sessionId);
        return;
      }
      // A thread started in the last two minutes has no history to replay: everything in it is
      // news, even to a process that has not looked at it yet.
      const before =
        seen.get(sessionId) ?? (fresh(look.thread.createdAt) ? NOTHING_SEEN : undefined);
      seen.set(sessionId, seenOf(look, now()));
      const install = yield* installs.byTeam(look.thread.teamId);
      // The app was removed: the thread stays, and nothing can be written to it.
      if (install === null) return;
      const project = yield* projects
        .byId(look.session.projectId)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
      if (project === null) return;
      // The workspace now belongs to another organization than the project's: write nothing.
      if (project.organizationId !== install.organizationId) {
        return yield* Effect.logWarning(
          "slack reporter: the thread's install is not the project's organization's, not posted",
        ).pipe(Effect.annotateLogs({ sessionId, organizationId: install.organizationId }));
      }
      const token = yield* botTokenOf(install);
      if (token === null) return;
      // Everyone in a channel reads the thread: a project made private since is not shown there.
      if (!threadShowsReplies(look.thread.channelId, project.visibility)) {
        return yield* reportStatus(install, token, look, null);
      }
      yield* reportStatus(install, token, look, project.name);
      if (before === undefined) return; // unknown baseline: record, never post
      yield* reportReplies(install, token, look, before);
    });

    /**
     * Whatever is live right now was live before this process listened: record it silently. A
     * thread started in the last two minutes is left unrecorded, so its first look posts.
     */
    const baseline = Effect.fn("SlackReporter.baseline")(function* () {
      for (const session of yield* sessions.listActive()) {
        const look = yield* lookAt(session.id);
        if (look !== null && !fresh(look.thread.createdAt)) {
          seen.set(session.id, seenOf(look, now()));
        }
      }
    });

    /** How many sessions this process remembers having seen: for tests. */
    const remembered = () => seen.size;

    return { observe, baseline, remembered };
  });

/**
 * What the reporter is asked to look at again: domain ids, never event payloads. A caller says
 * what changed; the reporter works out which threads that reaches. `Resync` follows a gap in what
 * was heard (the events connection was lost): every active session is looked at again.
 */
export type SlackReportTarget =
  | { readonly _tag: "Session"; readonly id: SessionId }
  | { readonly _tag: "Resync" };

/**
 * The Slack thread reporter as a service: ask it to report, and it brings the threads that
 * reaches up to date in the background. A request returns at once; it never waits on Slack.
 */
export class SlackReports extends Context.Service<
  SlackReports,
  { readonly request: (target: SlackReportTarget) => Effect.Effect<void> }
>()("@mend/jobs/SlackReports") {}

const targetKey = (target: SlackReportTarget): string =>
  target._tag === "Resync" ? "resync" : `${target._tag}:${target.id}`;

export const SlackReportsLive: Layer.Layer<
  SlackReports,
  never,
  | AgentConversationRepo
  | ChangeLandingsRepo
  | ChangePassesRepo
  | ChangeToursRepo
  | ProjectsRepo
  | ReviewCommentsRepo
  | SecretCipher
  | SessionProcessesRepo
  | SessionsRepo
  | SlackApi
  | SlackInstallsRepo
  | SlackThreadsRepo
  | WorktreeChangesRepo
  | WorktreeReads
> = Layer.effect(
  SlackReports,
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    const reporter = yield* makeSlackReporter();
    yield* reporter.baseline();

    // A burst of requests for one session (every streamed item notifies) is one look: a session
    // is queued once until the look at it starts, and a request during the look queues it again.
    const queued = new Set<string>();
    const work = yield* Queue.unbounded<SessionId>();
    const enqueue = (sessionId: SessionId) =>
      Effect.suspend(() => {
        if (queued.has(sessionId)) return Effect.void;
        queued.add(sessionId);
        return Queue.offer(work, sessionId);
      });
    yield* Effect.gen(function* () {
      while (true) {
        const sessionId = yield* Queue.take(work);
        queued.delete(sessionId);
        yield* reporter
          .observe(sessionId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("slack reporter: session report failed").pipe(
                Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
              ),
            ),
          );
      }
    }).pipe(Effect.forkScoped);

    const pending = new Set<string>();
    const requests = yield* Queue.unbounded<SlackReportTarget>();
    const sessionsOf = (target: SlackReportTarget): Effect.Effect<ReadonlyArray<SessionId>> => {
      switch (target._tag) {
        case "Session":
          return Effect.succeed([target.id]);
        case "Resync":
          return Effect.map(sessions.listActive(), (active) => active.map((session) => session.id));
      }
    };
    yield* Effect.gen(function* () {
      while (true) {
        const target = yield* Queue.take(requests);
        pending.delete(targetKey(target));
        yield* sessionsOf(target).pipe(
          Effect.flatMap((ids) => Effect.forEach(ids, enqueue, { discard: true })),
          Effect.catchCause((cause) =>
            Effect.logWarning("slack reporter: report request failed").pipe(
              Effect.annotateLogs({ target: targetKey(target), cause: Cause.pretty(cause) }),
            ),
          ),
        );
      }
    }).pipe(Effect.forkScoped);

    return {
      request: (target) =>
        Effect.suspend(() => {
          const key = targetKey(target);
          if (pending.has(key)) return Effect.void;
          pending.add(key);
          return Queue.offer(requests, target).pipe(Effect.asVoid);
        }),
    };
  }),
);
