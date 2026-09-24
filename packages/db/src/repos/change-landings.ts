import { PgClient } from "@effect/sql-pg";
import {
  ChangeLandingId,
  type ChangeId,
  type CheckpointId,
  type ProjectId,
  type SessionId,
  type Sha,
} from "@mend/domain";
import { ChangeLanding, type LandedPullRequest, type LandingTrigger } from "@mend/domain/workbench";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { changeLandings, worktreeChanges } from "../schema/workbench.ts";

/**
 * How a landing ended, with exactly the facts that outcome has (docs/adr/0007-landing.md, "One
 * action: land"). A refusal pushed nothing; a failure after the push keeps the pushed sha.
 */
export type LandingResult =
  | { readonly outcome: "pushed"; readonly pushedSha: Sha }
  | {
      readonly outcome: "pull-request";
      readonly pushedSha: Sha;
      readonly pullRequest: LandedPullRequest;
    }
  | { readonly outcome: "refused"; readonly message: string }
  | { readonly outcome: "failed"; readonly pushedSha: Sha | null; readonly message: string };

export interface NewChangeLanding {
  readonly changeId: ChangeId;
  readonly sessionId: SessionId | null;
  readonly projectId: ProjectId;
  /** The checkpoint taken for this landing; null when taking it failed. */
  readonly checkpoint: {
    readonly id: CheckpointId;
    readonly ref: string;
    readonly sha: Sha;
  } | null;
  /** The commit Mend wrote for uncommitted work; null when the agent had committed it all. */
  readonly commitSha: Sha | null;
  readonly remoteBranch: string;
  readonly trigger: LandingTrigger;
  /** The session's owner: only they land. */
  readonly userId: string;
  readonly result: LandingResult;
}

/**
 * The record of a change's landings (docs/adr/0007-landing.md, "What Mend records and shows").
 * Rows are written once; only the pull request's observed state moves afterwards.
 */
export class ChangeLandingsRepo extends Context.Service<
  ChangeLandingsRepo,
  {
    readonly record: (landing: NewChangeLanding) => Effect.Effect<ChangeLanding>;
    readonly byId: (id: ChangeLandingId) => Effect.Effect<ChangeLanding | null>;
    /** Every landing of the change, newest first. */
    readonly listForChange: (changeId: ChangeId) => Effect.Effect<ReadonlyArray<ChangeLanding>>;
    readonly latestForChange: (changeId: ChangeId) => Effect.Effect<ChangeLanding | null>;
    /**
     * What `gh` reported about the landing's pull request when Mend last asked (a refresh, or the
     * next landing's pull request step). Null when there is no such landing.
     */
    readonly observePullRequest: (
      id: ChangeLandingId,
      pullRequest: LandedPullRequest,
    ) => Effect.Effect<ChangeLanding | null>;
    /**
     * Claim writing `tourId`'s summary into the landing's pull request ("What the thread sees").
     * True for the one caller that moved the claim to this tour; false when it already was, or
     * there is no such landing, so each tour updates a pull request once.
     */
    readonly claimTourDescription: (id: ChangeLandingId, tourId: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/ChangeLandingsRepo") {}

const toLanding = (row: typeof changeLandings.$inferSelect): ChangeLanding =>
  new ChangeLanding({
    id: row.id,
    changeId: row.changeId,
    sessionId: row.sessionId,
    projectId: row.projectId,
    checkpointId: row.checkpointId,
    checkpointRef: row.checkpointRef,
    checkpointSha: row.checkpointSha,
    commitSha: row.commitSha,
    remoteBranch: row.remoteBranch,
    pushedSha: row.pushedSha,
    trigger: row.trigger,
    pullRequest:
      row.pullRequestNumber === null ||
      row.pullRequestUrl === null ||
      row.pullRequestState === null ||
      row.prObservedAt === null
        ? null
        : {
            number: row.pullRequestNumber,
            url: row.pullRequestUrl,
            state: row.pullRequestState,
            observedAt: row.prObservedAt,
          },
    outcome: row.outcome,
    message: row.message,
    userId: row.userId,
    createdAt: row.createdAt,
  });

const pullRequestColumns = (pullRequest: LandedPullRequest | null) => ({
  pullRequestNumber: pullRequest?.number ?? null,
  pullRequestUrl: pullRequest?.url ?? null,
  pullRequestState: pullRequest?.state ?? null,
  prObservedAt: pullRequest?.observedAt ?? null,
});

const resultColumns = (result: LandingResult) => {
  switch (result.outcome) {
    case "pushed":
      return { pushedSha: result.pushedSha, message: null, ...pullRequestColumns(null) };
    case "pull-request":
      return {
        pushedSha: result.pushedSha,
        message: null,
        ...pullRequestColumns(result.pullRequest),
      };
    case "refused":
      return { pushedSha: null, message: result.message, ...pullRequestColumns(null) };
    case "failed":
      return { pushedSha: result.pushedSha, message: result.message, ...pullRequestColumns(null) };
  }
};

export const ChangeLandingsRepoLive: Layer.Layer<
  ChangeLandingsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ChangeLandingsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    // The review page and the session page re-read the change on this pointer.
    const notify = Effect.fn("ChangeLandingsRepo.notify")(function* (landing: ChangeLanding) {
      const [row] = yield* db
        .select({ worktreeId: worktreeChanges.worktreeId, sessionId: worktreeChanges.sessionId })
        .from(worktreeChanges)
        .where(eq(worktreeChanges.id, landing.changeId))
        .limit(1)
        .pipe(Effect.orDie);
      yield* notifyEvent(sql, {
        type: "session-change",
        changeId: landing.changeId,
        worktreeId: row?.worktreeId ?? "",
        sessionId: landing.sessionId ?? row?.sessionId ?? "",
        projectId: landing.projectId,
      });
    });

    const record = Effect.fn("ChangeLandingsRepo.record")(function* (landing: NewChangeLanding) {
      const [row] = yield* db
        .insert(changeLandings)
        .values({
          id: ChangeLandingId.make(crypto.randomUUID()),
          changeId: landing.changeId,
          sessionId: landing.sessionId,
          projectId: landing.projectId,
          checkpointId: landing.checkpoint?.id ?? null,
          checkpointRef: landing.checkpoint?.ref ?? null,
          checkpointSha: landing.checkpoint?.sha ?? null,
          commitSha: landing.commitSha,
          remoteBranch: landing.remoteBranch,
          trigger: landing.trigger,
          outcome: landing.result.outcome,
          userId: landing.userId,
          ...resultColumns(landing.result),
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("change landing insert returned no row");
      const recorded = toLanding(row);
      yield* notify(recorded);
      return recorded;
    });

    const byId = Effect.fn("ChangeLandingsRepo.byId")(function* (id: ChangeLandingId) {
      const [row] = yield* db
        .select()
        .from(changeLandings)
        .where(eq(changeLandings.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toLanding(row);
    });

    const listForChange = Effect.fn("ChangeLandingsRepo.listForChange")(function* (
      changeId: ChangeId,
    ) {
      const rows = yield* db
        .select()
        .from(changeLandings)
        .where(eq(changeLandings.changeId, changeId))
        .orderBy(desc(changeLandings.createdAt), desc(changeLandings.id))
        .pipe(Effect.orDie);
      return rows.map(toLanding);
    });

    const latestForChange = Effect.fn("ChangeLandingsRepo.latestForChange")(function* (
      changeId: ChangeId,
    ) {
      const [row] = yield* db
        .select()
        .from(changeLandings)
        .where(eq(changeLandings.changeId, changeId))
        .orderBy(desc(changeLandings.createdAt), desc(changeLandings.id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toLanding(row);
    });

    const observePullRequest = Effect.fn("ChangeLandingsRepo.observePullRequest")(function* (
      id: ChangeLandingId,
      pullRequest: LandedPullRequest,
    ) {
      const [row] = yield* db
        .update(changeLandings)
        .set(pullRequestColumns(pullRequest))
        .where(eq(changeLandings.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return null;
      const observed = toLanding(row);
      yield* notify(observed);
      return observed;
    });

    const claimTourDescription = Effect.fn("ChangeLandingsRepo.claimTourDescription")(function* (
      id: ChangeLandingId,
      tourId: string,
    ) {
      const rows = yield* db
        .update(changeLandings)
        .set({ describedTourId: tourId })
        .where(
          and(
            eq(changeLandings.id, id),
            or(isNull(changeLandings.describedTourId), ne(changeLandings.describedTourId, tourId)),
          ),
        )
        .returning({ id: changeLandings.id })
        .pipe(Effect.orDie);
      return rows.length > 0;
    });

    return {
      record,
      byId,
      listForChange,
      latestForChange,
      observePullRequest,
      claimTourDescription,
    };
  }),
);
