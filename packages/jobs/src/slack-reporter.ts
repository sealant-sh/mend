import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  ChangePassesRepo,
  MEND_EVENTS_CHANNEL,
  MendEvent,
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
import { SessionId } from "@mend/domain";
import {
  currentAgentProcess,
  type AgentItem,
  type AgentRequest,
  type AgentTurn,
  type Change,
  type ChangePass,
  type Session,
} from "@mend/domain/workbench";
import { WorktreeReads } from "@mend/sessions";
import {
  agentMessage,
  approvalMessage,
  changeUrl,
  diffMessages,
  disclosureFor,
  isDirectMessage,
  isSettledState,
  privateProjectStatusMessage,
  questionMessage,
  reactionFor,
  reviewMessage,
  sessionUrl,
  slackSessionState,
  splitDiff,
  statusMayMove,
  statusMessage,
  switchOffered,
  type ChangeCounts,
  type SlackMessage,
  type SlackSessionState,
} from "@mend/slack";
import { SlackApi, type SlackApiError } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Cause, Effect, Layer, Queue, Schema, Stream } from "effect";

/**
 * The Slack thread reporter (docs/adr/0006-slack.md, "What Mend posts, and where"): the sibling of
 * `SessionNotifierLive` whose sink is the Slack thread a session was started from. It listens on
 * `mend_events`, re-reads the sessions that have a Slack thread, and keeps the thread in step:
 *
 * - the one status message, edited in place, and the reaction on the request (⏳ → ✅ / ❌);
 * - the agent's first message when it is a plan, and each turn's closing message;
 * - a question the agent asks, naming the owner, and an approval as a status line with a link;
 * - once the machine review pass has run, what it drafted, with "Review in Mend";
 * - on completion, the change's line counts in the status line; and when the owner turned diffs
 *   on, each file's diff, once, the first time the session settles with a change.
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
 * twice: the status line moves only by compare-and-set (`claimStatus`), and each reply is claimed
 * by key (`claimPost`) before it is posted. A claimed reply whose post fails is logged, not
 * retried, as a claimed Slack event is.
 */

const REPORT_FRESHNESS_MS = 2 * 60_000;

/** A settled session not looked at for this long is forgotten: its next look is a baseline. */
const SEEN_SETTLED_TTL_MS = 60 * 60_000;
/** Anything not looked at for a day is forgotten, settled or not. */
const SEEN_TTL_MS = 24 * 60 * 60_000;
/** How often the memory of what was seen is swept. */
const SEEN_SWEEP_MS = 60_000;

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(MendEvent));

/** The events that can move what a thread shows, each naming its session. */
const sessionOf = (event: MendEvent): string | null => {
  switch (event.type) {
    case "session":
    case "session-process":
    case "agent-conversation":
    case "session-change":
      return event.sessionId;
    default:
      return null;
  }
};

/** The machine passes whose drafts the thread hears about: the read and the suggestions. */
const REVIEW_PASSES: ReadonlySet<string> = new Set(["read", "suggest"]);

/**
 * The review pass the thread would announce: the latest completed read or suggestion pass since
 * the thread began, once no pass over the change is running. Its key names the change and when
 * the pass finished, so a later pass is news again.
 */
export const reviewMoment = (
  change: Pick<Change, "id"> | null,
  passes: ReadonlyArray<Pick<ChangePass, "kind" | "status" | "finishedAt">>,
  since: Date,
): { readonly key: string; readonly finishedAt: Date } | null => {
  if (change === null) return null;
  const review = passes.filter((pass) => REVIEW_PASSES.has(pass.kind));
  if (review.some((pass) => pass.status === "running")) return null;
  const latest = review
    .flatMap((pass) =>
      pass.status === "completed" && pass.finishedAt !== null && pass.finishedAt >= since
        ? [pass.finishedAt]
        : [],
    )
    .toSorted((a, b) => b.getTime() - a.getTime())[0];
  return latest === undefined
    ? null
    : { key: `review:${change.id}:${latest.getTime()}`, finishedAt: latest };
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
  readonly turns: ReadonlyArray<AgentTurn>;
  readonly pending: ReadonlyArray<AgentRequest>;
  readonly opening: AgentItem | null | undefined;
  readonly change: Change | null;
  readonly review: { readonly key: string; readonly finishedAt: Date } | null;
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
    const comments = yield* ReviewCommentsRepo;
    const reads = yield* WorktreeReads;
    const cipher = yield* SecretCipher;
    const slack = yield* SlackApi;
    const now = options.now ?? Date.now;

    const seen = new Map<string, Seen>();
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
      const currentAgent = currentAgentProcess(yield* processes.listForSession(session.id));
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
      const state = slackSessionState({ status: session.status, currentAgent, turns });
      return { thread, session, state, turns, pending, opening, change, review } satisfies Look;
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

    /**
     * Edit the status message to `message` and move the reaction to the state, once, whichever
     * worker gets there first. A line that stays the same (a private project's) still moves the
     * reaction when the state does.
     */
    const moveStatus = Effect.fn("SlackReporter.moveStatus")(function* (
      token: string,
      look: Look,
      message: SlackMessage,
    ) {
      const { thread, session, state } = look;
      if (thread.statusTs === null) return;
      const edit = message.text !== thread.reportedStatus;
      if (!edit && state === thread.reportedState) return;
      const moved = yield* threads.claimStatus(session.id, thread.reportedStatus, {
        state,
        line: message.text,
      });
      if (!moved) return;
      if (edit) {
        yield* quietly(
          "chat.update",
          slack.update(token, { channel: thread.channelId, ts: thread.statusTs, ...message }),
        );
      }
      const was = reactionFor(thread.reportedState ?? "starting");
      const is = reactionFor(state);
      if (was === is) return;
      const at = { channel: thread.channelId, timestamp: thread.requestTs };
      if (is !== null)
        yield* quietly("reactions.add", slack.reactionsAdd(token, { ...at, name: is }));
      if (was !== null) {
        yield* quietly("reactions.remove", slack.reactionsRemove(token, { ...at, name: was }));
      }
    });

    /**
     * Keep the status message and the reaction on the observed state. A null `projectName` is a
     * channel thread whose project is private now: the message says so and names nothing.
     */
    const reportStatus = Effect.fn("SlackReporter.reportStatus")(function* (
      install: SealedSlackInstall,
      token: string,
      look: Look,
      projectName: string | null,
    ) {
      const { thread, session, state } = look;
      if (thread.statusTs === null) return;
      if (!statusMayMove(thread.reportedState, state)) return;
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
        change,
        url: sessionUrl(install.webOrigin, session.id),
        // Offered until the first turn completes, which also moves the line, so the button
        // leaves with the edit that says so. The runner checks again on a click.
        switchSession: switchOffered(state, look.turns) ? session.id : null,
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

      // The agent's first message, when it is a plan.
      const opening = look.opening;
      if (
        !before.opening &&
        opening !== undefined &&
        opening !== null &&
        opening.kind === "plan" &&
        opening.text !== null &&
        opening.text.trim() !== "" &&
        shown.agentMessages &&
        fresh(opening.updatedAt)
      ) {
        yield* postOnce(token, thread, "plan", Effect.succeed([agentMessage(opening.text, url)]));
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

      // The machine review pass, once it has run.
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
          comments.listForChange(change.id).pipe(
            Effect.map((list) => {
              const drafts = list.filter(
                (comment) => comment.authorKind === "mend" && comment.state === "draft",
              );
              return [
                reviewMessage({
                  drafts: drafts.length,
                  suggestions: drafts.filter((comment) => comment.kind === "suggestion").length,
                  url: changeUrl(install.webOrigin, change.id),
                }),
              ];
            }),
          ),
        );
      }
    });

    /** Look at a session again and bring its thread up to date. */
    const observe = Effect.fn("SlackReporter.observe")(function* (sessionId: SessionId) {
      sweep();
      const look = yield* lookAt(sessionId);
      if (look === null) {
        seen.delete(sessionId);
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
      if (!isDirectMessage(look.thread.channelId) && project.visibility !== "shared") {
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

export const SlackReporterLive: Layer.Layer<
  never,
  never,
  | PgClient.PgClient
  | AgentConversationRepo
  | ChangePassesRepo
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
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const reporter = yield* makeSlackReporter();
    yield* reporter.baseline();

    // A burst of events for one session (every streamed item notifies) is one look: a session
    // is queued once until the look at it starts, and events during the look queue it again.
    const queued = new Set<string>();
    const work = yield* Queue.unbounded<string>();
    yield* Effect.gen(function* () {
      while (true) {
        const sessionId = yield* Queue.take(work);
        queued.delete(sessionId);
        yield* reporter
          .observe(SessionId.make(sessionId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("slack reporter: session report failed").pipe(
                Effect.annotateLogs({ sessionId, cause: Cause.pretty(cause) }),
              ),
            ),
          );
      }
    }).pipe(Effect.forkScoped);

    yield* sql.listen(MEND_EVENTS_CHANNEL).pipe(
      Stream.runForEach((payload) =>
        decodeEvent(payload).pipe(
          Effect.flatMap((event) => {
            const sessionId = sessionOf(event);
            if (sessionId === null || queued.has(sessionId)) return Effect.void;
            queued.add(sessionId);
            return Queue.offer(work, sessionId);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("slack reporter: event handling failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("slack reporter: listen stream ended").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
