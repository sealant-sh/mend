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
  SlackProofDeliveriesRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  agentWaitLine,
  captureStatusLine,
  currentAgentProcess,
  latestDecidedTurn,
  liveAgentsReading,
  type AgentItem,
  type AgentRequest,
  type AgentTurn,
  type AgentWaitLine,
  type Change,
  type ChangeLanding,
  type ChangePass,
  type Project,
  type Session,
  type SlackStatusKey,
} from "@mend/domain/workbench";
import { ResourceStatusReads, WorktreeReads } from "@mend/sessions";
import {
  agentMessage,
  approvalMessage,
  changeUrl,
  diffMessages,
  disclosureFor,
  editedReceipt,
  isSettledState,
  landingStatusLines,
  landOfferOf,
  NO_PREVIEWS,
  previewUrl,
  planText,
  privateProjectStatusMessage,
  questionMessage,
  reactionFor,
  receiptAfter,
  receiptOf,
  replyWithPreviews,
  SLACK_ACTIONS,
  SlackReplyReceipt,
  reviewMessage,
  sessionUrl,
  showsRendering,
  slackSessionState,
  splitDiff,
  statusMayMove,
  statusKey,
  statusMessage,
  storedReceipt,
  switchOffered,
  threadShowsReplies,
  type ChangeCounts,
  type EditFailure,
  type LandOffer,
  type SlackMessage,
  type SlackSessionState,
  type SlackStatusReceipt,
  type StatusRendering,
  type WorktreePreviews,
} from "@mend/slack";
import { SlackApi, type SlackApiError, updateRefusalOf } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Cause, Clock, Deferred, Effect, Layer, Queue, Schema } from "effect";
import * as Context from "effect/Context";

import { SlackPreviewReads } from "./slack-preview-reads.ts";

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
 * - after a turn's closing reply, release its captures and quiet controls to the durable worker;
 * - the change's latest published landing stays in the status message. A turn's Push and preview
 *   controls belong to its capture message, never another landing-offer reply.
 *
 * The install's display settings decide how much: with agent messages off, or in a Slack Connect
 * channel the owner did not open, the thread gets status, reactions and links only. A change to
 * those settings reaches a thread at its next look.
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
 * In a process, every look at a session, and every write to its thread, runs on one fiber, one
 * after another; a look that must wait asks for another look later, on that same queue. Across
 * processes, what was posted lives in Postgres, not in memory, so a restart or a second worker
 * never posts twice: the status message moves only by compare-and-set over its receipt
 * (`claimStatus`, `SlackStatusReceipt`), and each reply is claimed by key (`claimPost`) before it
 * is posted. A claimed reply whose post fails is logged, not retried, as a claimed Slack event
 * is. After launch the reporter is the status message's one writer: the runner asks it to report.
 *
 * The receipt holds what every worker must agree on. While the session runs, its status line
 * moves at most once every `STATUS_EDIT_EVERY_MS`: a loop that flips it between `running` and
 * `waiting` would otherwise edit the message on every flip. A change to the previews alone moves
 * at most once every `STATUS_PREVIEW_EVERY_MS`. A move into a settled state, and the first move
 * out of one, is edited at once. A move held back looks again when its wait ends, so the message
 * still lands on the latest state.
 */

const REPORT_FRESHNESS_MS = 2 * 60_000;
export const STATUS_EDIT_EVERY_MS = 30_000;
/** A change to a status message's previews alone edits it at most this often. */
export const STATUS_PREVIEW_EVERY_MS = 10_000;
/** How soon a look whose previews could not be read tries again. */
const PREVIEW_READ_RETRY_MS = 5_000;
const PREVIEW_READ_RETRY_MAX_MS = 5 * 60_000;
/** How long one status edit may take, the Slack client's own retries and waits included. */
export const STATUS_EDIT_DEADLINE_MS = 15_000;
/** How soon a report whose threads could not be read is asked for again. */
export const REQUEST_RETRY_MS = 5_000;

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
    Effect.catch((error) =>
      Effect.logWarning(`slack reporter: ${what} failed`).pipe(
        Effect.annotateLogs({ method: error.method, code: error.code }),
        Effect.as(null),
      ),
    ),
  );

export interface SlackReporterOptions {
  readonly now?: () => number;
}

/**
 * The threads a report reaches, and for each whether its look reads the change's counts again:
 * a session's own look does; a look for what it shares with its worktree or project (previews,
 * the project's name) keeps the counts its message shows.
 */
type Reached = ReadonlyArray<{ readonly sessionId: SessionId; readonly recount: boolean }>;

/**
 * Whether a settled thread's change counts are read again: its own session moved, it is settling
 * now, or none were read yet. A look for its worktree's previews keeps them.
 */
const countsMayHaveMoved = (
  recount: boolean,
  receipt: SlackStatusReceipt,
  reportedState: SlackSessionState | null,
) => recount || receipt.counts === null || reportedState === null || !isSettledState(reportedState);

interface Queued {
  recount: boolean;
  readonly waiters: Array<Deferred.Deferred<void>>;
}

export const makeSlackReporter = (options: SlackReporterOptions = {}) =>
  Effect.gen(function* () {
    const resourceStatus = yield* ResourceStatusReads;
    const threads = yield* SlackThreadsRepo;
    const proofDeliveries = yield* SlackProofDeliveriesRepo;
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
    const previewReads = yield* SlackPreviewReads;
    const clock = yield* Clock.Clock;
    const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
    const scope = yield* Effect.scope;

    const seen = new Map<string, Seen>();
    const previewReadFailures = new Map<string, number>();
    const projectsRead = new Map<
      ProjectId,
      { readonly visibility: Project["visibility"]; readonly name: string }
    >();
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
          previewReadFailures.delete(sessionId);
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

    const queued = new Map<SessionId, Queued>();
    const work = yield* Queue.unbounded<SessionId>();
    const enqueue = (
      sessionId: SessionId,
      recount: boolean,
      waiter: Deferred.Deferred<void> | null,
    ) =>
      Effect.suspend(() => {
        const entry = queued.get(sessionId);
        if (entry !== undefined) {
          entry.recount ||= recount;
          if (waiter !== null) entry.waiters.push(waiter);
          return Effect.void;
        }
        queued.set(sessionId, { recount, waiters: waiter === null ? [] : [waiter] });
        return Queue.offer(work, sessionId);
      });

    const wakes = new Map<SessionId, { readonly at: number; readonly recount: boolean }>();
    const lookAgainIn = (sessionId: SessionId, delayMs: number, recount: boolean) =>
      Effect.suspend(() => {
        const wake = { at: now() + delayMs, recount };
        const set = wakes.get(sessionId);
        if (set !== undefined && set.at <= wake.at && (set.recount || !recount)) return Effect.void;
        wakes.set(sessionId, wake);
        return Effect.sleep(Math.max(delayMs, 0)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (wakes.get(sessionId) === wake) wakes.delete(sessionId);
              return enqueue(sessionId, recount, null);
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

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

    const previewsOf = (session: Session, receipt: SlackStatusReceipt) =>
      previewReads.forWorktree(session.worktreeId).pipe(
        Effect.tap(() => Effect.sync(() => previewReadFailures.delete(session.id))),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failures = (previewReadFailures.get(session.id) ?? 0) + 1;
            previewReadFailures.set(session.id, failures);
            yield* Effect.logWarning("slack reporter: previews not read").pipe(
              Effect.annotateLogs({ sessionId: session.id, cause: error.cause, failures }),
            );
            yield* lookAgainIn(
              session.id,
              Math.min(PREVIEW_READ_RETRY_MS * 2 ** (failures - 1), PREVIEW_READ_RETRY_MAX_MS),
              false,
            );
            return receipt.previews;
          }),
        ),
      );

    const sendEdit = (
      token: string,
      thread: SlackThreadSession,
      statusTs: string,
      message: SlackMessage,
    ): Effect.Effect<EditFailure | null> =>
      slack.update(token, { channel: thread.channelId, ts: statusTs, ...message }).pipe(
        Effect.as(null),
        Effect.catch((error) =>
          Effect.logWarning("slack reporter: chat.update failed").pipe(
            Effect.annotateLogs({
              method: error.method,
              code: error.code,
              sessionId: thread.sessionId,
            }),
            Effect.as(updateRefusalOf(error)),
          ),
        ),
        Effect.timeoutOrElse({
          duration: STATUS_EDIT_DEADLINE_MS,
          orElse: () =>
            Effect.logWarning("slack reporter: chat.update not answered in time").pipe(
              Effect.annotateLogs({ sessionId: thread.sessionId }),
              Effect.as<EditFailure>({ _tag: "Unanswered" }),
            ),
        }),
      );

    const moveReaction = Effect.fn("SlackReporter.moveReaction")(function* (
      token: string,
      thread: SlackThreadSession,
      state: SlackSessionState,
    ) {
      const was = reactionFor(thread.reportedState ?? "starting");
      const is = reactionFor(state);
      if (was === is) return;
      if (!(yield* threads.ownsRequestReaction(thread.sessionId))) return;
      const at = { channel: thread.channelId, timestamp: thread.requestTs };
      if (is !== null) {
        yield* quietly("reactions.add", slack.reactionsAdd(token, { ...at, name: is }));
      }
      if (was !== null) {
        yield* quietly("reactions.remove", slack.reactionsRemove(token, { ...at, name: was }));
      }
    });

    const claim = (
      thread: SlackThreadSession,
      state: SlackSessionState,
      receipt: SlackStatusReceipt,
    ) =>
      threads.claimStatus(
        thread.sessionId,
        { state: thread.reportedState, status: thread.reportedStatus },
        { state, status: storedReceipt(receipt) },
      );

    const editWait = (
      receipt: SlackStatusReceipt,
      from: SlackSessionState | null,
      to: SlackSessionState,
      base: SlackStatusKey,
    ) => {
      const at = now();
      const { editedAt, holdUntil, shown } = receipt;
      const running = from !== null && !isSettledState(from) && !isSettledState(to);
      const previewsOnly = from === to && shown._tag === "Rendered" && shown.base === base;
      return Math.max(
        holdUntil === null ? 0 : holdUntil - at,
        editedAt !== null && running ? editedAt + STATUS_EDIT_EVERY_MS - at : 0,
        editedAt !== null && previewsOnly ? editedAt + STATUS_PREVIEW_EVERY_MS - at : 0,
      );
    };

    /**
     * Edit the status message and move the reaction, once across workers. Only the session the
     * request last started takes its reaction: a switch reuses the request.
     */
    const moveStatus = Effect.fn("SlackReporter.moveStatus")(function* (
      token: string,
      look: Look,
      receipt: SlackStatusReceipt,
      recount: boolean,
      message: SlackMessage,
      rendering: Omit<StatusRendering, "key">,
    ) {
      const { thread, session, state } = look;
      if (thread.statusTs === null) return;
      const key = statusKey(message);
      if (showsRendering(receipt.shown, key, message.text)) {
        if (state === thread.reportedState) return;
        if (yield* claim(thread, state, receipt)) yield* moveReaction(token, thread, state);
        return;
      }
      const wait = editWait(receipt, thread.reportedState, state, rendering.base);
      if (wait > 0) return yield* lookAgainIn(session.id, wait, recount);
      const claimed: SlackStatusReceipt = {
        ...editedReceipt({ ...rendering, key }, now()),
        ...(receipt.reply === undefined ? {} : { reply: receipt.reply }),
      };
      if (!(yield* claim(thread, state, claimed))) return;
      const failure = yield* sendEdit(token, thread, thread.statusTs, message);
      if (failure !== null) {
        const after = receiptAfter(receipt, failure, now());
        yield* threads.claimStatus(
          session.id,
          { state, status: storedReceipt(claimed) },
          { state, status: storedReceipt(after) },
        );
        if (after.holdUntil !== null) {
          yield* lookAgainIn(session.id, after.holdUntil - now(), recount);
        }
      }
      yield* moveReaction(token, thread, state);
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
      recount: boolean,
      projectName: string | null,
      previews: WorktreePreviews,
    ) {
      const { thread } = observed;
      if (thread.statusTs === null) return;
      const receipt = receiptOf(thread.reportedStatus);
      const look: Look = {
        ...observed,
        state:
          thread.reportedState === null || statusMayMove(thread.reportedState, observed.state)
            ? observed.state
            : thread.reportedState,
      };
      const { session, state } = look;
      if (receipt.shown._tag === "Gone") {
        if (state !== thread.reportedState && (yield* claim(thread, state, receipt))) {
          yield* moveReaction(token, thread, state);
        }
        return;
      }
      if (projectName === null) {
        const message = privateProjectStatusMessage();
        return yield* moveStatus(token, look, receipt, recount, message, {
          base: statusKey(message),
          previews: NO_PREVIEWS,
          counts: receipt.counts,
        });
      }
      const change = isSettledState(state) ? look.change : null;
      const counts =
        change !== null && countsMayHaveMoved(recount, receipt, thread.reportedState)
          ? ((yield* countsOf(session, change)) ?? receipt.counts)
          : receipt.counts;
      const status = {
        project: projectName,
        source: thread.projectSource,
        harness: session.harness,
        branch: session.branch,
        state,
        recorded: session.sealantRunId !== null,
        agent: look.agent,
        change: change === null ? null : counts,
        url: sessionUrl(install.webOrigin, session.id),
        // Offered until the first turn completes, which also moves the line, so the button
        // leaves with the edit that says so. The runner checks again on a click.
        switchSession: switchOffered(state, look.turns) ? session.id : null,
        landing: landingStatusLines({ landings: look.landings, latestTurn: null }),
        summary: session.summary,
        capture: captureStatusLine(session),
        resourceStatusLines: (yield* resourceStatus.forWorktree(
          session.projectId,
          session.worktreeId,
        )).map((each) => each.statusLine),
      };
      yield* moveStatus(
        token,
        look,
        receipt,
        recount,
        statusMessage({ ...status, previews: NO_PREVIEWS }),
        {
          base: statusKey(statusMessage({ ...status, previews: NO_PREVIEWS })),
          previews,
          counts,
        },
      );
    });

    /** Post a reply once, whichever worker gets there first. */
    const postOnce = (
      token: string,
      thread: SlackThreadSession,
      key: string,
      messages: Effect.Effect<ReadonlyArray<SlackMessage>>,
      previews: WorktreePreviews = NO_PREVIEWS,
    ) =>
      Effect.gen(function* () {
        if (!(yield* threads.claimPost(thread.sessionId, key))) return;
        for (const message of yield* messages) {
          const carriesOffer = message.blocks.some(
            (block) =>
              block.type === "actions" &&
              block.elements.some((element) => element.action_id === SLACK_ACTIONS.landChange),
          );
          const rendered = carriesOffer ? replyWithPreviews(message, previews) : message;
          const posted = yield* quietly(
            "chat.postMessage",
            slack.postMessage(token, {
              channel: thread.channelId,
              threadTs: thread.threadTs,
              text: rendered.text,
              blocks: rendered.blocks,
            }),
          );
          if (carriesOffer && posted !== null) {
            const current = yield* threads.forSession(thread.sessionId);
            if (current !== null && current.reportedState !== null) {
              const receipt = receiptOf(current.reportedStatus);
              const renderingKey = statusKey(rendered);
              const reply = Schema.decodeUnknownSync(SlackReplyReceipt)({
                ts: posted.ts,
                base: message,
                edit: editedReceipt(
                  { key: renderingKey, base: statusKey(message), previews, counts: null },
                  now(),
                ),
              });
              yield* claim(current, current.reportedState, { ...receipt, reply });
            }
          }
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
      previews: WorktreePreviews,
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
          previews: offered === null ? previews : NO_PREVIEWS,
        });
        return message === null ? [] : [message];
      });

    /** The replies this look has that the last one did not: what is news. */
    const reportReplies = Effect.fn("SlackReporter.reportReplies")(function* (
      install: SealedSlackInstall,
      token: string,
      look: Look,
      before: Seen,
      previews: WorktreePreviews,
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

      // The worker's durable release follows the closing reply, including turns without captures.
      if (shown.agentMessages && !thread.external) {
        for (const turn of look.turns) {
          if (turn.status === "queued" || turn.status === "running" || !fresh(turn.endedAt))
            continue;
          if (turn.status === "completed" && look.change !== null && turn.landing === null) {
            yield* lookAgainIn(session.id, 1_000, true);
            continue;
          }
          const offer =
            look.change === null
              ? null
              : landOfferOf({ sessionId: session.id, turn, landings: look.landings });
          const preview =
            previews._tag === "Shown"
              ? previews.previews.find(
                  (notice) =>
                    notice.openable && !notice.facts.some((fact) => fact._tag === "Stopped"),
                )
              : undefined;
          yield* proofDeliveries.readyTurn(session.id, turn.id, {
            projectId: session.projectId,
            changeId: look.change?.id ?? null,
            url,
            previewUrl:
              previews._tag === "Shown" && preview !== undefined
                ? previewUrl(previews.appUrl, preview.id)
                : null,
            push: offer === null ? null : { sessionId: session.id, updates: offer.updates },
          });
        }
      }

      // Completed review passes remain their own event; turn controls never ride that reply.
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
          reviewReply(
            thread,
            change,
            review,
            shown.agentMessages,
            install.webOrigin,
            null,
            NO_PREVIEWS,
          ),
          previews,
        );
      }
    });

    /** The latest landing reply shares the status writer's queue and compare-and-set receipt. */
    const reportReplyPreview = Effect.fn("SlackReporter.reportReplyPreview")(function* (
      token: string,
      observedThread: SlackThreadSession,
      previews: WorktreePreviews,
    ) {
      if (receiptOf(observedThread.reportedStatus).reply === undefined) return;
      const sessionId = observedThread.sessionId;
      const thread = yield* threads.forSession(sessionId);
      if (thread === null || thread.reportedState === null) return;
      const receipt = receiptOf(thread.reportedStatus);
      const reply = receipt.reply;
      if (reply === undefined || reply.edit.shown._tag === "Gone") return;
      const message = replyWithPreviews(reply.base, previews);
      const key = statusKey(message);
      if (showsRendering(reply.edit.shown, key, message.text)) return;
      const wait = Math.max(
        (reply.edit.holdUntil ?? 0) - now(),
        (reply.edit.editedAt ?? 0) + STATUS_PREVIEW_EVERY_MS - now(),
      );
      if (wait > 0) return yield* lookAgainIn(sessionId, wait, false);
      const edit = editedReceipt(
        { key, base: statusKey(reply.base), previews, counts: null },
        now(),
      );
      const claimed = { ...receipt, reply: { ...reply, edit } };
      if (!(yield* claim(thread, thread.reportedState, claimed))) return;
      const failure = yield* sendEdit(token, thread, reply.ts, message);
      if (failure === null) return;
      const after = receiptAfter(reply.edit, failure, now());
      yield* threads.claimStatus(
        sessionId,
        { state: thread.reportedState, status: storedReceipt(claimed) },
        {
          state: thread.reportedState,
          status: storedReceipt({ ...receipt, reply: { ...reply, edit: after } }),
        },
      );
      if (after.holdUntil !== null) yield* lookAgainIn(sessionId, after.holdUntil - now(), false);
    });

    /** Look at a session again and bring its thread up to date. */
    const look = Effect.fn("SlackReporter.look")(function* (
      sessionId: SessionId,
      recount: boolean,
    ) {
      sweep();
      const observed = yield* lookAt(sessionId);
      if (observed === null) {
        seen.delete(sessionId);
        previewReadFailures.delete(sessionId);
        return;
      }
      // A thread started in the last two minutes has no history to replay: everything in it is
      // news, even to a process that has not looked at it yet.
      const previous = seen.get(sessionId);
      const before = previous ?? (fresh(observed.thread.createdAt) ? NOTHING_SEEN : undefined);
      seen.set(sessionId, seenOf(observed, now()));
      const install = yield* installs.byTeam(observed.thread.teamId);
      // The app was removed: the thread stays, and nothing can be written to it.
      if (install === null) return;
      const project = yield* projects
        .byId(observed.session.projectId)
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
      if (!threadShowsReplies(observed.thread.channelId, project.visibility)) {
        return yield* reportStatus(install, token, observed, recount, null, NO_PREVIEWS);
      }
      const previews = disclosureFor(install.settings, observed.thread.external).previews
        ? yield* previewsOf(observed.session, receiptOf(observed.thread.reportedStatus))
        : NO_PREVIEWS;
      yield* reportStatus(install, token, observed, recount, project.name, previews);
      yield* reportReplyPreview(token, observed.thread, previews);
      if (before !== undefined) yield* reportReplies(install, token, observed, before, previews);
    });

    /**
     * Whatever is live right now was live before this process listened: record it silently. A
     * thread started in the last two minutes is left unrecorded, so its first look posts.
     */
    const baseline = Effect.fn("SlackReporter.baseline")(function* () {
      for (const session of yield* sessions.listActive()) {
        const observed = yield* lookAt(session.id);
        if (observed !== null && !fresh(observed.thread.createdAt)) {
          seen.set(session.id, seenOf(observed, now()));
        }
      }
    });

    yield* Effect.gen(function* () {
      while (true) {
        const sessionId = yield* Queue.take(work);
        const entry = queued.get(sessionId);
        queued.delete(sessionId);
        yield* look(sessionId, entry?.recount ?? true).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("slack reporter: session report failed").pipe(
              Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
            ),
          ),
        );
        for (const waiter of entry?.waiters ?? []) yield* Deferred.succeed(waiter, undefined);
      }
    }).pipe(Effect.forkIn(scope));

    /**
     * The threads a report reaches. A project's threads are looked at again only when its
     * visibility or name moved since the last `Project` report this process read: a project
     * event also follows its secrets, environment and recipes, which no thread shows.
     */
    const reached = (target: SlackReportTarget): Effect.Effect<Reached> => {
      switch (target._tag) {
        case "Session":
          return Effect.succeed([{ sessionId: target.id, recount: true }]);
        case "SessionWorktree":
          return Effect.map(threads.sessionsReached({ worktreeOf: target.id }), (ids) =>
            ids.map((sessionId) => ({ sessionId, recount: sessionId === target.id })),
          );
        case "Worktree":
          return Effect.map(threads.sessionsReached({ worktreeId: target.id }), (ids) =>
            ids.map((sessionId) => ({ sessionId, recount: false })),
          );
        case "Project":
          return Effect.gen(function* () {
            const project = yield* projects
              .byId(target.id)
              .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
            if (project === null) return [];
            const read = projectsRead.get(target.id);
            if (read?.visibility === project.visibility && read.name === project.name) return [];
            const ids = yield* threads.sessionsReached({ projectId: target.id });
            projectsRead.set(target.id, { visibility: project.visibility, name: project.name });
            return ids.map((sessionId) => ({ sessionId, recount: false }));
          });
        case "Resync":
          return Effect.map(sessions.listActive(), (active) =>
            active.map((session) => ({ sessionId: session.id, recount: true })),
          );
      }
    };

    const pending = new Set<string>();
    const requests = yield* Queue.unbounded<SlackReportTarget>();
    const request = (target: SlackReportTarget): Effect.Effect<void> =>
      Effect.suspend(() => {
        const key = targetKey(target);
        if (pending.has(key)) return Effect.void;
        pending.add(key);
        return Queue.offer(requests, target).pipe(Effect.asVoid);
      });
    yield* Effect.gen(function* () {
      while (true) {
        const target = yield* Queue.take(requests);
        pending.delete(targetKey(target));
        yield* reached(target).pipe(
          Effect.flatMap((sessionsReached) =>
            Effect.forEach(
              sessionsReached,
              ({ sessionId, recount }) => enqueue(sessionId, recount, null),
              { discard: true },
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("slack reporter: report request failed").pipe(
              Effect.annotateLogs({ target: targetKey(target), cause: Cause.pretty(cause) }),
              Effect.andThen(
                Effect.sleep(REQUEST_RETRY_MS).pipe(
                  Effect.andThen(request(target)),
                  Effect.forkIn(scope),
                ),
              ),
            ),
          ),
        );
      }
    }).pipe(Effect.forkIn(scope));

    /** Look at a session now, through the writer's queue, and wait for that look to finish. */
    const observe = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* enqueue(sessionId, true, done);
        yield* Deferred.await(done);
      });

    /** How many sessions this process remembers having seen: for tests. */
    const remembered = () => seen.size;

    return { request, observe, baseline, remembered };
  });

/**
 * What the reporter is asked to look at again: domain ids, never event payloads. A caller says
 * what changed; the reporter works out which threads that reaches. `Resync` follows a gap in what
 * was heard (the events connection was lost, or is back): every active session is looked at
 * again.
 */
export type SlackReportTarget =
  /** The session's own thread: its conversation moved. */
  | { readonly _tag: "Session"; readonly id: SessionId }
  /** Every thread of the session's worktree: the session or one of its Services moved. */
  | { readonly _tag: "SessionWorktree"; readonly id: SessionId }
  /** Every thread of the worktree: its previews or their preparation moved. */
  | { readonly _tag: "Worktree"; readonly id: WorktreeId }
  /** Every thread of the project, settled ones included, when its visibility or name moved. */
  | { readonly _tag: "Project"; readonly id: ProjectId }
  | { readonly _tag: "Resync" };

const targetKey = (target: SlackReportTarget): string =>
  target._tag === "Resync" ? "resync" : `${target._tag}:${target.id}`;

/**
 * The Slack thread reporter as a service: ask it to report, and it brings the threads that
 * reaches up to date in the background. A request returns at once; it never waits on Slack.
 */
export class SlackReports extends Context.Service<
  SlackReports,
  { readonly request: (target: SlackReportTarget) => Effect.Effect<void> }
>()("@mend/jobs/SlackReports") {}

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
  | SlackPreviewReads
  | SlackProofDeliveriesRepo
  | SlackThreadsRepo
  | WorktreeChangesRepo
  | WorktreeReads
  | ResourceStatusReads
> = Layer.effect(
  SlackReports,
  Effect.gen(function* () {
    const reporter = yield* makeSlackReporter();
    yield* reporter.baseline();
    return { request: reporter.request };
  }),
);
