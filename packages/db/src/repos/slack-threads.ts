import type { SessionId } from "@mend/domain";
import type { SlackProjectSource } from "@mend/domain/workbench";
import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { slackThreads } from "../schema/workbench.ts";

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
  readonly createdAt: Date;
}

/**
 * The Slack threads sessions report to (docs/adr/0006-slack.md, "Follow-ups in a thread"). A
 * thread holds many sessions and a session belongs to at most one thread. A mention in the thread
 * follows up its most recent session.
 */
export class SlackThreadsRepo extends Context.Service<
  SlackThreadsRepo,
  {
    /** Record a session started from a thread. A session already recorded is a defect. */
    readonly record: (input: {
      readonly sessionId: SessionId;
      readonly teamId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly requestTs: string;
      readonly slackUserId: string;
      readonly projectSource: SlackProjectSource;
    }) => Effect.Effect<SlackThreadSession>;
    /** The thread's most recent session, or null when no session has reported to it. */
    readonly latestInThread: (thread: SlackThreadRef) => Effect.Effect<SlackThreadSession | null>;
    /** The thread a session reports to, or null when it was not started from Slack. */
    readonly forSession: (sessionId: SessionId) => Effect.Effect<SlackThreadSession | null>;
    readonly setStatusTs: (sessionId: SessionId, statusTs: string) => Effect.Effect<void>;
  }
>()("@mend/db/SlackThreadsRepo") {}

export const SlackThreadsRepoLive: Layer.Layer<SlackThreadsRepo, never, MendDB> = Layer.effect(
  SlackThreadsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const record = Effect.fn("SlackThreadsRepo.record")(function* (input: {
      readonly sessionId: SessionId;
      readonly teamId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly requestTs: string;
      readonly slackUserId: string;
      readonly projectSource: SlackProjectSource;
    }) {
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
    ) {
      yield* db
        .update(slackThreads)
        .set({ statusTs })
        .where(eq(slackThreads.sessionId, sessionId))
        .pipe(Effect.orDie);
    });

    return { record, latestInThread, forSession, setStatusTs };
  }),
);
