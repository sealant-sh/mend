import type { ProjectId, SessionId } from "@mend/domain";
import type { SessionStatus, SlackProjectSource, SlackSessionState } from "@mend/domain/workbench";
import { and, desc, eq, getTableColumns, isNotNull, isNull } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { agentSessions, slackThreadPosts, slackThreads } from "../schema/workbench.ts";

/** Where in Slack a thread is: its workspace, its channel and its first message. */
export interface SlackThreadRef {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

/** One session's place in a Slack thread. */
export interface SlackThreadSession extends SlackThreadRef {
  readonly sessionId: SessionId;
  /** The mention that started the session: the message Mend reacts to. */
  readonly requestTs: string;
  /** The status message Mend edits in place; null until it is posted. */
  readonly statusTs: string | null;
  /** Who asked, in Slack. */
  readonly slackUserId: string;
  readonly projectSource: SlackProjectSource;
  /** A Slack Connect channel: only status and links, unless the install says otherwise. */
  readonly external: boolean;
  /** The state the status message last showed; null until it is posted. */
  readonly reportedState: SlackSessionState | null;
  /** The status line the status message last showed; null until it is posted. */
  readonly reportedStatus: string | null;
  readonly createdAt: Date;
}

/** What the status message shows: the state, and the line that words it. */
export interface SlackReportedStatus {
  readonly state: SlackSessionState;
  readonly line: string;
}

/** A session its owner started from Slack, with what `@mend list` shows of it. */
export interface SlackOwnedSession extends SlackThreadSession {
  readonly projectId: ProjectId;
  readonly label: string | null;
  readonly harness: string;
  readonly branch: string;
  readonly status: SessionStatus;
}

export interface NewSlackThreadSession {
  readonly sessionId: SessionId;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly requestTs: string;
  readonly slackUserId: string;
  readonly projectSource: SlackProjectSource;
  readonly external: boolean;
}

/**
 * The Slack threads sessions report to (docs/adr/0006-slack.md, "Follow-ups in a thread"). A
 * thread holds many sessions and a session belongs to at most one thread. A mention in the thread
 * follows up its most recent session.
 *
 * It also holds what the thread has been shown ("What Mend posts, and where"), so a restart or a
 * second worker never posts twice: the status line moves only by compare-and-set, and each reply
 * is claimed by key before it is posted.
 */
export class SlackThreadsRepo extends Context.Service<
  SlackThreadsRepo,
  {
    /** Record a session started from a thread. A session already recorded is a defect. */
    readonly record: (input: NewSlackThreadSession) => Effect.Effect<SlackThreadSession>;
    /** The thread's most recent session, or null when no session has reported to it. */
    readonly latestInThread: (thread: SlackThreadRef) => Effect.Effect<SlackThreadSession | null>;
    /** The thread a session reports to, or null when it was not started from Slack. */
    readonly forSession: (sessionId: SessionId) => Effect.Effect<SlackThreadSession | null>;
    /** The status message was posted, showing `reported`. */
    readonly setStatusTs: (
      sessionId: SessionId,
      statusTs: string,
      reported: SlackReportedStatus,
    ) => Effect.Effect<void>;
    /**
     * Move the status message from the line it showed (`from`) to `to`: true for exactly one
     * caller, who then edits the message. False when another worker moved it first, or when the
     * message has not been posted.
     */
    readonly claimStatus: (
      sessionId: SessionId,
      from: string | null,
      to: SlackReportedStatus,
    ) => Effect.Effect<boolean>;
    /** Claim a reply by key before posting it: true for exactly one caller, ever. */
    readonly claimPost: (sessionId: SessionId, key: string) => Effect.Effect<boolean>;
    /**
     * The sessions an account owns that were started from threads in one Slack workspace, newest
     * first: what `@mend list` shows that person.
     */
    readonly listForOwner: (input: {
      readonly teamId: string;
      readonly ownerUserId: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<SlackOwnedSession>>;
  }
>()("@mend/db/SlackThreadsRepo") {}

export const SlackThreadsRepoLive: Layer.Layer<SlackThreadsRepo, never, MendDB> = Layer.effect(
  SlackThreadsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const record = Effect.fn("SlackThreadsRepo.record")(function* (input: NewSlackThreadSession) {
      const [row] = yield* db.insert(slackThreads).values(input).returning().pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("slack thread insert returned no row");
      return row;
    });

    const latestInThread = Effect.fn("SlackThreadsRepo.latestInThread")(function* (
      thread: SlackThreadRef,
    ) {
      const [row] = yield* db
        .select()
        .from(slackThreads)
        .where(
          and(
            eq(slackThreads.teamId, thread.teamId),
            eq(slackThreads.channelId, thread.channelId),
            eq(slackThreads.threadTs, thread.threadTs),
          ),
        )
        .orderBy(desc(slackThreads.createdAt), desc(slackThreads.sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const forSession = Effect.fn("SlackThreadsRepo.forSession")(function* (sessionId: SessionId) {
      const [row] = yield* db
        .select()
        .from(slackThreads)
        .where(eq(slackThreads.sessionId, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const setStatusTs = Effect.fn("SlackThreadsRepo.setStatusTs")(function* (
      sessionId: SessionId,
      statusTs: string,
      reported: SlackReportedStatus,
    ) {
      yield* db
        .update(slackThreads)
        .set({ statusTs, reportedState: reported.state, reportedStatus: reported.line })
        .where(eq(slackThreads.sessionId, sessionId))
        .pipe(Effect.orDie);
    });

    const claimStatus = Effect.fn("SlackThreadsRepo.claimStatus")(function* (
      sessionId: SessionId,
      from: string | null,
      to: SlackReportedStatus,
    ) {
      const moved = yield* db
        .update(slackThreads)
        .set({ reportedState: to.state, reportedStatus: to.line })
        .where(
          and(
            eq(slackThreads.sessionId, sessionId),
            isNotNull(slackThreads.statusTs),
            from === null
              ? isNull(slackThreads.reportedStatus)
              : eq(slackThreads.reportedStatus, from),
          ),
        )
        .returning({ sessionId: slackThreads.sessionId })
        .pipe(Effect.orDie);
      return moved.length === 1;
    });

    const claimPost = Effect.fn("SlackThreadsRepo.claimPost")(function* (
      sessionId: SessionId,
      key: string,
    ) {
      const inserted = yield* db
        .insert(slackThreadPosts)
        .values({ sessionId, key })
        .onConflictDoNothing()
        .returning({ key: slackThreadPosts.key })
        .pipe(Effect.orDie);
      return inserted.length === 1;
    });

    const listForOwner = Effect.fn("SlackThreadsRepo.listForOwner")(function* (input: {
      readonly teamId: string;
      readonly ownerUserId: string;
      readonly limit: number;
    }) {
      return yield* db
        .select({
          ...getTableColumns(slackThreads),
          projectId: agentSessions.projectId,
          label: agentSessions.label,
          harness: agentSessions.harness,
          branch: agentSessions.branch,
          status: agentSessions.status,
        })
        .from(slackThreads)
        .innerJoin(agentSessions, eq(agentSessions.id, slackThreads.sessionId))
        .where(
          and(
            eq(slackThreads.teamId, input.teamId),
            eq(agentSessions.ownerUserId, input.ownerUserId),
          ),
        )
        .orderBy(desc(slackThreads.createdAt), desc(slackThreads.sessionId))
        .limit(input.limit)
        .pipe(Effect.orDie);
    });

    return {
      record,
      latestInThread,
      forSession,
      setStatusTs,
      claimStatus,
      claimPost,
      listForOwner,
    };
  }),
);
