import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  SlackStatusKey,
  type SessionStatus,
  type SlackProjectSource,
  type SlackSessionState,
  type SlackStatusShown,
} from "@mend/domain/workbench";
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect, Layer, Schema } from "effect";
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
  readonly shown: SlackStatusShown;
  readonly createdAt: Date;
}

export interface SlackReportedStatus {
  readonly state: SlackSessionState;
  readonly key: SlackStatusKey;
}

const isStatusKey = Schema.is(SlackStatusKey);

/** `reported_status` holds a key, or the line a release before keys wrote there. */
const shownOf = (stored: string | null): SlackStatusShown =>
  stored === null
    ? { _tag: "Unknown" }
    : isStatusKey(stored)
      ? { _tag: "Rendered", key: stored }
      : { _tag: "Legacy", text: stored };

const storedIs = (shown: SlackStatusShown): SQL | undefined => {
  switch (shown._tag) {
    case "Unknown":
      return isNull(slackThreads.reportedStatus);
    case "Legacy":
      return eq(slackThreads.reportedStatus, shown.text);
    case "Rendered":
      return eq(slackThreads.reportedStatus, shown.key);
  }
};

const threadOf = <Row extends typeof slackThreads.$inferSelect>({
  reportedStatus,
  ...row
}: Row): Omit<Row, "reportedStatus"> & { readonly shown: SlackStatusShown } => ({
  ...row,
  shown: shownOf(reportedStatus),
});

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
     * Move the status message from what it showed (`from`) to `to`: true for exactly one caller,
     * who then edits the message. False when another worker moved it first, or when the message
     * has not been posted.
     */
    readonly claimStatus: (
      sessionId: SessionId,
      from: SlackStatusShown,
      to: SlackReportedStatus,
    ) => Effect.Effect<boolean>;
    /**
     * Slack refused the edit a claim of `key` made: the message does not show it, so the next look
     * edits again. A later claim is left alone. The state stays: the reaction follows the session.
     */
    readonly releaseStatus: (sessionId: SessionId, key: SlackStatusKey) => Effect.Effect<boolean>;
    /**
     * Whether the session is the latest to start from its request (the same workspace, channel
     * and message): the one whose reaction the request carries. A switch reuses the request.
     */
    readonly ownsRequestReaction: (sessionId: SessionId) => Effect.Effect<boolean>;
    /**
     * The sessions with a thread that a change reaches, settled ones included: every session of a
     * worktree (its previews are the worktree's, and a Service can run in a sibling session), of
     * the worktree a session is in, or of a project.
     */
    readonly sessionsReached: (
      by:
        | { readonly worktreeId: WorktreeId }
        | { readonly worktreeOf: SessionId }
        | { readonly projectId: ProjectId },
    ) => Effect.Effect<ReadonlyArray<SessionId>>;
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
      return threadOf(row);
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
      return row === undefined ? null : threadOf(row);
    });

    const forSession = Effect.fn("SlackThreadsRepo.forSession")(function* (sessionId: SessionId) {
      const [row] = yield* db
        .select()
        .from(slackThreads)
        .where(eq(slackThreads.sessionId, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : threadOf(row);
    });

    const setStatusTs = Effect.fn("SlackThreadsRepo.setStatusTs")(function* (
      sessionId: SessionId,
      statusTs: string,
      reported: SlackReportedStatus,
    ) {
      yield* db
        .update(slackThreads)
        .set({ statusTs, reportedState: reported.state, reportedStatus: reported.key })
        .where(eq(slackThreads.sessionId, sessionId))
        .pipe(Effect.orDie);
    });

    const claimStatus = Effect.fn("SlackThreadsRepo.claimStatus")(function* (
      sessionId: SessionId,
      from: SlackStatusShown,
      to: SlackReportedStatus,
    ) {
      const moved = yield* db
        .update(slackThreads)
        .set({ reportedState: to.state, reportedStatus: to.key })
        .where(
          and(
            eq(slackThreads.sessionId, sessionId),
            isNotNull(slackThreads.statusTs),
            storedIs(from),
          ),
        )
        .returning({ sessionId: slackThreads.sessionId })
        .pipe(Effect.orDie);
      return moved.length === 1;
    });

    const releaseStatus = Effect.fn("SlackThreadsRepo.releaseStatus")(function* (
      sessionId: SessionId,
      key: SlackStatusKey,
    ) {
      const released = yield* db
        .update(slackThreads)
        .set({ reportedStatus: null })
        .where(and(eq(slackThreads.sessionId, sessionId), eq(slackThreads.reportedStatus, key)))
        .returning({ sessionId: slackThreads.sessionId })
        .pipe(Effect.orDie);
      return released.length === 1;
    });

    const ownsRequestReaction = Effect.fn("SlackThreadsRepo.ownsRequestReaction")(function* (
      sessionId: SessionId,
    ) {
      const [own] = yield* db
        .select({
          teamId: slackThreads.teamId,
          channelId: slackThreads.channelId,
          requestTs: slackThreads.requestTs,
        })
        .from(slackThreads)
        .where(eq(slackThreads.sessionId, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      if (own === undefined) return false;
      const [latest] = yield* db
        .select({ sessionId: slackThreads.sessionId })
        .from(slackThreads)
        .where(
          and(
            eq(slackThreads.teamId, own.teamId),
            eq(slackThreads.channelId, own.channelId),
            eq(slackThreads.requestTs, own.requestTs),
          ),
        )
        .orderBy(desc(slackThreads.createdAt), desc(slackThreads.sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return latest?.sessionId === sessionId;
    });

    const source = alias(agentSessions, "source");
    const sessionsReached = Effect.fn("SlackThreadsRepo.sessionsReached")(function* (
      by:
        | { readonly worktreeId: WorktreeId }
        | { readonly worktreeOf: SessionId }
        | { readonly projectId: ProjectId },
    ) {
      const reached =
        "worktreeId" in by
          ? eq(agentSessions.worktreeId, by.worktreeId)
          : "worktreeOf" in by
            ? inArray(
                agentSessions.worktreeId,
                db
                  .select({ worktreeId: source.worktreeId })
                  .from(source)
                  .where(eq(source.id, by.worktreeOf)),
              )
            : eq(agentSessions.projectId, by.projectId);
      const rows = yield* db
        .select({ sessionId: slackThreads.sessionId })
        .from(slackThreads)
        .innerJoin(agentSessions, eq(agentSessions.id, slackThreads.sessionId))
        .where(reached)
        .orderBy(slackThreads.sessionId)
        .pipe(Effect.orDie);
      return rows.map((row) => row.sessionId);
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
      const rows = yield* db
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
      return rows.map(threadOf);
    });

    return {
      record,
      latestInThread,
      forSession,
      setStatusTs,
      claimStatus,
      releaseStatus,
      ownsRequestReaction,
      sessionsReached,
      claimPost,
      listForOwner,
    };
  }),
);
