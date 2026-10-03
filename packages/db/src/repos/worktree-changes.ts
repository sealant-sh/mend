import { PgClient } from "@effect/sql-pg";
import { ChangeId, type ProjectId, type SessionId, type Sha, type WorktreeId } from "@mend/domain";
import { Change, type ChangePullRequest } from "@mend/domain/workbench";
import { and, asc, count, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentSessions,
  changeLandings,
  followUps,
  reviewComments,
  worktreeChanges,
} from "../schema/workbench.ts";

export class SessionChangeNotFoundError extends Schema.TaggedErrorClass<SessionChangeNotFoundError>()(
  "SessionChangeNotFoundError",
  {
    id: Schema.String,
  },
) {}

/**
 * The DB-cheap facts a session list can carry without touching git: whether
 * the worktree's change row exists, how the review stands, whether a follow-up
 * waits. Still keyed per session — every session of a worktree carries the
 * same change annotation.
 */
export interface SessionAnnotationRow {
  readonly sessionId: string;
  readonly changeId: ChangeId | null;
  readonly openComments: number;
  readonly totalComments: number;
  readonly pendingFollowUp: boolean;
  /** The change's newest recorded pull request (docs/adr/0007-landing.md); null when none. */
  readonly pullRequest: ChangePullRequest | null;
}

/**
 * The reviewable object's identity row (plan §5.6) — one per worktree, table
 * `worktree_changes`. Git owns the diff; `head_sha` is an opportunistic cache
 * for display, refreshed by whoever looked last.
 */
export class WorktreeChangesRepo extends Context.Service<
  WorktreeChangesRepo,
  {
    /** Idempotent: the worktree's change row, created on first ask. */
    readonly ensureForWorktree: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      branch: string,
      baseSha: Sha,
    ) => Effect.Effect<Change>;
    readonly byId: (id: ChangeId) => Effect.Effect<Change, SessionChangeNotFoundError>;
    readonly byWorktree: (worktreeId: WorktreeId) => Effect.Effect<Change | null>;
    /** Phase-A compat: resolve through the session's worktree membership. */
    readonly bySession: (sessionId: SessionId) => Effect.Effect<Change | null>;
    /** Stamps the contributing session as the change's session mirror. */
    readonly refreshHead: (
      id: ChangeId,
      headSha: Sha,
      viaSessionId: SessionId | null,
    ) => Effect.Effect<void>;
    /** One row per session of the project — list decoration, no git involved. */
    readonly annotationsForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<SessionAnnotationRow>>;
  }
>()("@mend/db/WorktreeChangesRepo") {}

const toChange = (row: typeof worktreeChanges.$inferSelect): Change => new Change(row);

export const WorktreeChangesRepoLive: Layer.Layer<
  WorktreeChangesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  WorktreeChangesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const ensureForWorktree = Effect.fn("WorktreeChangesRepo.ensureForWorktree")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      branch: string,
      baseSha: Sha,
    ) {
      const [row] = yield* db
        .insert(worktreeChanges)
        .values({
          id: ChangeId.make(crypto.randomUUID()),
          projectId,
          worktreeId,
          branch,
          baseSha,
        })
        .onConflictDoUpdate({
          target: worktreeChanges.worktreeId,
          set: { updatedAt: new Date() },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("worktree change upsert returned no row");
      return toChange(row);
    });

    const byId = Effect.fn("WorktreeChangesRepo.byId")(function* (id: ChangeId) {
      const [row] = yield* db
        .select()
        .from(worktreeChanges)
        .where(eq(worktreeChanges.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new SessionChangeNotFoundError({ id });
      return toChange(row);
    });

    const byWorktree = Effect.fn("WorktreeChangesRepo.byWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select()
        .from(worktreeChanges)
        .where(eq(worktreeChanges.worktreeId, worktreeId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toChange(row);
    });

    const bySession = Effect.fn("WorktreeChangesRepo.bySession")(function* (sessionId: SessionId) {
      const [row] = yield* db
        .select({ change: worktreeChanges })
        .from(worktreeChanges)
        .innerJoin(agentSessions, eq(agentSessions.worktreeId, worktreeChanges.worktreeId))
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toChange(row.change);
    });

    const refreshHead = Effect.fn("WorktreeChangesRepo.refreshHead")(function* (
      id: ChangeId,
      headSha: Sha,
      viaSessionId: SessionId | null,
    ) {
      const [row] = yield* db
        .update(worktreeChanges)
        .set({
          headSha,
          updatedAt: new Date(),
          ...(viaSessionId === null ? {} : { sessionId: viaSessionId }),
        })
        .where(
          and(
            eq(worktreeChanges.id, id),
            or(isNull(worktreeChanges.headSha), ne(worktreeChanges.headSha, headSha)),
          ),
        )
        .returning({
          sessionId: worktreeChanges.sessionId,
          worktreeId: worktreeChanges.worktreeId,
          projectId: worktreeChanges.projectId,
        })
        .pipe(Effect.orDie);
      if (row !== undefined && row.sessionId !== null) {
        yield* notifyEvent(sql, {
          type: "session-change",
          changeId: id,
          worktreeId: row.worktreeId,
          sessionId: row.sessionId,
          projectId: row.projectId,
        });
      }
    });

    const annotationsForProject = Effect.fn("WorktreeChangesRepo.annotationsForProject")(function* (
      projectId: ProjectId,
    ) {
      const openCommentCounts = db
        .select({
          changeId: reviewComments.changeId,
          value: count().as("open_comments"),
        })
        .from(reviewComments)
        .where(eq(reviewComments.state, "open"))
        .groupBy(reviewComments.changeId)
        .as("open_comment_counts");
      const totalCommentCounts = db
        .select({
          changeId: reviewComments.changeId,
          value: count().as("total_comments"),
        })
        .from(reviewComments)
        .groupBy(reviewComments.changeId)
        .as("total_comment_counts");
      const sessionsWithPendingFollowUps = db
        .select({ sessionId: followUps.sessionId })
        .from(followUps)
        .where(eq(followUps.status, "pending"))
        .groupBy(followUps.sessionId)
        .as("sessions_with_pending_follow_ups");
      // Each change's newest landing that recorded a pull request, by the partial index (0104).
      const latestPullRequests = db
        .selectDistinctOn([changeLandings.changeId], {
          changeId: changeLandings.changeId,
          number: changeLandings.pullRequestNumber,
          url: changeLandings.pullRequestUrl,
          state: changeLandings.pullRequestState,
          title: changeLandings.pullRequestTitle,
          observedAt: changeLandings.prObservedAt,
          trigger: changeLandings.trigger,
        })
        .from(changeLandings)
        .where(
          and(eq(changeLandings.projectId, projectId), isNotNull(changeLandings.pullRequestNumber)),
        )
        .orderBy(asc(changeLandings.changeId), desc(changeLandings.createdAt))
        .as("latest_pull_requests");

      const rows = yield* db
        .select({
          sessionId: agentSessions.id,
          changeId: worktreeChanges.id,
          openComments: openCommentCounts.value,
          totalComments: totalCommentCounts.value,
          pendingSessionId: sessionsWithPendingFollowUps.sessionId,
          pullRequestNumber: latestPullRequests.number,
          pullRequestUrl: latestPullRequests.url,
          pullRequestState: latestPullRequests.state,
          pullRequestTitle: latestPullRequests.title,
          pullRequestObservedAt: latestPullRequests.observedAt,
          pullRequestTrigger: latestPullRequests.trigger,
        })
        .from(agentSessions)
        .leftJoin(worktreeChanges, eq(worktreeChanges.worktreeId, agentSessions.worktreeId))
        .leftJoin(openCommentCounts, eq(openCommentCounts.changeId, worktreeChanges.id))
        .leftJoin(totalCommentCounts, eq(totalCommentCounts.changeId, worktreeChanges.id))
        .leftJoin(
          sessionsWithPendingFollowUps,
          eq(sessionsWithPendingFollowUps.sessionId, agentSessions.id),
        )
        .leftJoin(latestPullRequests, eq(latestPullRequests.changeId, worktreeChanges.id))
        .where(eq(agentSessions.projectId, projectId))
        .pipe(Effect.orDie);

      return rows.map(
        (row): SessionAnnotationRow => ({
          sessionId: row.sessionId,
          changeId: row.changeId,
          openComments: row.openComments ?? 0,
          totalComments: row.totalComments ?? 0,
          pendingFollowUp: row.pendingSessionId !== null,
          pullRequest:
            row.pullRequestNumber === null ||
            row.pullRequestUrl === null ||
            row.pullRequestState === null ||
            row.pullRequestObservedAt === null
              ? null
              : {
                  number: row.pullRequestNumber,
                  url: row.pullRequestUrl,
                  state: row.pullRequestState,
                  title: row.pullRequestTitle,
                  observedAt: row.pullRequestObservedAt,
                  adopted: row.pullRequestTrigger === "adopted",
                },
        }),
      );
    });

    return { ensureForWorktree, byId, byWorktree, bySession, refreshHead, annotationsForProject };
  }),
);
