import { type SealantRunId, type SealantWorkspaceId, type SessionId } from "@mend/domain";
import { SessionRun } from "@mend/domain/workbench";
import { and, asc, desc, eq, isNotNull, isNull, lt, max } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionRuns } from "../schema/workbench.ts";
import { uniqueViolationConstraint } from "./unique-violation.ts";

/** One open run per session: the partial unique index on `session_id` where `settled_at` is null. */
const ONE_ACTIVE_INDEX = "session_runs_one_active_idx";

/**
 * The one-active-run index (`session_runs_one_active_idx`) refused the insert: a run of the
 * session is still open. It is the one named here, as it stood when the insert was refused.
 */
export class SessionRunActiveError extends Schema.TaggedErrorClass<SessionRunActiveError>()(
  "SessionRunActiveError",
  {
    sessionId: Schema.String,
    /** The run the insert was for. */
    sealantRunId: Schema.String,
    /** The run that holds the index. */
    activeRun: SessionRun,
  },
) {
  override get message(): string {
    return `a run of session ${this.sessionId} is still open (${this.activeRun.sealantRunId}); ${this.sealantRunId} was not recorded`;
  }
}

export interface NewSessionRun {
  readonly sessionId: SessionId;
  readonly harness: string;
  readonly sealantRunId: SealantRunId;
  readonly sealantWorkspaceId: SealantWorkspaceId;
  readonly sealantSessionId: string | null;
  /**
   * SAFE project-environment launch manifest: aggregate revision + name-sorted variable NAMES,
   * never values. Omitted/null = explicit legacy/unknown (e.g. `attachRun`, which never owned
   * workspace creation) — callers must not fabricate one.
   */
  readonly environmentRevision?: number | null;
  readonly environmentVariableNames?: ReadonlyArray<string> | null;
  readonly secretRevision?: number | null;
  readonly secretNames?: ReadonlyArray<string> | null;
  /**
   * Cluster-binding manifest: `kind/objectName` strings + the ServiceAccount NAME, never values.
   * `undefined` admitted explicitly: hot-claim launches spread a stored manifest whose cluster
   * fields are optional (skeletons warmed before the feature) — undefined lands as NULL.
   */
  readonly clusterBindingRevision?: number | null | undefined;
  readonly clusterBindingNames?: ReadonlyArray<string> | null | undefined;
  readonly clusterServiceAccount?: string | null | undefined;
}

export type SessionRunOutcome = "completed" | "failed" | "stopped";

/**
 * Mend's durable membership index over Sealant records. Raw events remain in Sealant; this service
 * owns only which records belong to a logical session and each record's supervision cursor.
 */
export class SessionRunsRepo extends Context.Service<
  SessionRunsRepo,
  {
    /**
     * One open run per session (`session_runs_one_active_idx`): an insert while another run of
     * the session is unsettled answers `SessionRunActiveError` naming it, never a defect.
     */
    readonly create: (input: NewSessionRun) => Effect.Effect<SessionRun, SessionRunActiveError>;
    readonly bySealantRunId: (id: SealantRunId) => Effect.Effect<SessionRun | null>;
    readonly listForSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<SessionRun>>;
    readonly latestForSession: (sessionId: SessionId) => Effect.Effect<SessionRun | null>;
    readonly activeForSession: (sessionId: SessionId) => Effect.Effect<SessionRun | null>;
    readonly listActive: () => Effect.Effect<ReadonlyArray<SessionRun>>;
    readonly saveLastSeenSequence: (id: SealantRunId, sequence: bigint) => Effect.Effect<void>;
    /** First settle wins: a run already settled keeps its words. */
    readonly settle: (
      id: SealantRunId,
      outcome: SessionRunOutcome,
      summary: string | null,
    ) => Effect.Effect<void>;
    /**
     * A settled run's outcome and summary, rewritten from a later observation (the session it
     * settled with was restated). Only while it is settled: a run still open is left to settle.
     */
    readonly restate: (
      id: SealantRunId,
      outcome: SessionRunOutcome,
      summary: string | null,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/SessionRunsRepo") {}

const toSessionRun = (row: typeof sessionRuns.$inferSelect): SessionRun => new SessionRun(row);

export const SessionRunsRepoLive: Layer.Layer<SessionRunsRepo, never, MendDB> = Layer.effect(
  SessionRunsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const activeForSession = Effect.fn("SessionRunsRepo.activeForSession")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select()
        .from(sessionRuns)
        .where(and(eq(sessionRuns.sessionId, sessionId), isNull(sessionRuns.settledAt)))
        .orderBy(desc(sessionRuns.ordinal))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toSessionRun(row);
    });

    const insertRun = (input: NewSessionRun) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const [current] = yield* tx
            .select({ ordinal: max(sessionRuns.ordinal) })
            .from(sessionRuns)
            .where(eq(sessionRuns.sessionId, input.sessionId));
          const [created] = yield* tx
            .insert(sessionRuns)
            .values({
              ...input,
              ordinal: (current?.ordinal ?? -1) + 1,
              status: "running",
            })
            .returning();
          if (created === undefined) return yield* Effect.die("session run insert returned no row");
          return toSessionRun(created);
        }),
      );

    /**
     * The insert, and what its refusal means. Only the one-active index, by its name, is the typed
     * refusal; the primary key and the ordinal colliding are defects, as before. The run that
     * holds the index is read after the refusal: the one open now, which is what a caller acts
     * on. When none is open any more (it settled meanwhile), the insert is asked once more over
     * the freed index.
     */
    const createOnce = (
      input: NewSessionRun,
      retryFreed: boolean,
    ): Effect.Effect<SessionRun, SessionRunActiveError> =>
      insertRun(input).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (uniqueViolationConstraint(error) !== ONE_ACTIVE_INDEX) {
              return yield* Effect.die(error);
            }
            const activeRun = yield* activeForSession(input.sessionId);
            if (activeRun !== null && activeRun.sealantRunId !== input.sealantRunId) {
              return yield* new SessionRunActiveError({
                sessionId: input.sessionId,
                sealantRunId: input.sealantRunId,
                activeRun,
              });
            }
            if (activeRun === null && retryFreed) return yield* createOnce(input, false);
            return yield* Effect.die(error);
          }),
        ),
      );

    const create = Effect.fn("SessionRunsRepo.create")((input: NewSessionRun) =>
      createOnce(input, true),
    );

    const bySealantRunId = Effect.fn("SessionRunsRepo.bySealantRunId")(function* (
      id: SealantRunId,
    ) {
      const [row] = yield* db
        .select()
        .from(sessionRuns)
        .where(eq(sessionRuns.sealantRunId, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toSessionRun(row);
    });

    const listForSession = Effect.fn("SessionRunsRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select()
        .from(sessionRuns)
        .where(eq(sessionRuns.sessionId, sessionId))
        .orderBy(asc(sessionRuns.ordinal))
        .pipe(Effect.orDie);
      return rows.map(toSessionRun);
    });

    const latestForSession = Effect.fn("SessionRunsRepo.latestForSession")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select()
        .from(sessionRuns)
        .where(eq(sessionRuns.sessionId, sessionId))
        .orderBy(desc(sessionRuns.ordinal))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toSessionRun(row);
    });

    const listActive = Effect.fn("SessionRunsRepo.listActive")(function* () {
      const rows = yield* db
        .select()
        .from(sessionRuns)
        .where(isNull(sessionRuns.settledAt))
        .orderBy(asc(sessionRuns.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toSessionRun);
    });

    const saveLastSeenSequence = Effect.fn("SessionRunsRepo.saveLastSeenSequence")(function* (
      id: SealantRunId,
      sequence: bigint,
    ) {
      yield* db
        .update(sessionRuns)
        .set({ lastSeenSequence: sequence, updatedAt: new Date() })
        .where(and(eq(sessionRuns.sealantRunId, id), lt(sessionRuns.lastSeenSequence, sequence)))
        .pipe(Effect.orDie);
    });

    const settle = Effect.fn("SessionRunsRepo.settle")(function* (
      id: SealantRunId,
      outcome: SessionRunOutcome,
      summary: string | null,
    ) {
      const now = new Date();
      yield* db
        .update(sessionRuns)
        .set({ status: outcome, summary, settledAt: now, updatedAt: now })
        .where(and(eq(sessionRuns.sealantRunId, id), isNull(sessionRuns.settledAt)))
        .pipe(Effect.orDie);
    });

    const restate = Effect.fn("SessionRunsRepo.restate")(function* (
      id: SealantRunId,
      outcome: SessionRunOutcome,
      summary: string | null,
    ) {
      yield* db
        .update(sessionRuns)
        .set({ status: outcome, summary, updatedAt: new Date() })
        .where(and(eq(sessionRuns.sealantRunId, id), isNotNull(sessionRuns.settledAt)))
        .pipe(Effect.orDie);
    });

    return {
      create,
      bySealantRunId,
      listForSession,
      latestForSession,
      activeForSession,
      listActive,
      saveLastSeenSequence,
      settle,
      restate,
    };
  }),
);
