import type { OrganizationId, ProjectId, QueuedSessionId, SessionId } from "@mend/domain";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { queuedSessions } from "../schema/workbench.ts";

export type QueuedSessionState = "waiting" | "starting" | "started" | "failed";

/** Which step failed: the project's clone, or starting the session once it was cloned. */
export type QueuedSessionFailureStep = "clone" | "start";

/** A session started while its project still clones, as stored. */
export interface QueuedSessionRow {
  readonly id: QueuedSessionId;
  readonly ownerUserId: string;
  readonly organizationId: OrganizationId;
  /** The adoption it waits on: the latest one, after a start again with a new clone. */
  readonly adoptionId: string;
  readonly projectName: string;
  /** The project's id, chosen before its row exists. */
  readonly projectId: ProjectId;
  /** The create and launch requests, as the API encoded them; the API decodes them. */
  readonly request: unknown;
  readonly state: QueuedSessionState;
  readonly failureStep: QueuedSessionFailureStep | null;
  readonly failure: string | null;
  /** Set exactly when `state` is `started`. */
  readonly sessionId: SessionId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewQueuedSession {
  readonly id: QueuedSessionId;
  readonly ownerUserId: string;
  readonly organizationId: OrganizationId;
  readonly adoptionId: string;
  readonly projectName: string;
  readonly projectId: ProjectId;
  readonly request: unknown;
}

/** Where a change moves a queued session to. */
export type QueuedSessionChange =
  /** Waiting on an adoption: the first one, or a new clone after the last one failed. */
  | {
      readonly _tag: "Waiting";
      readonly adoptionId: string;
      readonly projectName: string;
      readonly projectId: ProjectId;
    }
  /** Its project is cloned and this writer starts it: no other writer may. */
  | { readonly _tag: "Starting"; readonly projectId: ProjectId }
  | { readonly _tag: "Started"; readonly sessionId: SessionId }
  | {
      readonly _tag: "Failed";
      readonly step: QueuedSessionFailureStep;
      readonly failure: string;
    };

/**
 * Sessions started while their project still clones (SLNT-1099). Every change is conditional on
 * the state the writer saw, so of two writers (the clone's end, a cancel, a start again, the
 * sweep after a restart) exactly one moves a row; the other reads null and leaves it.
 */
export class QueuedSessionsRepo extends Context.Service<
  QueuedSessionsRepo,
  {
    /**
     * Record one waiting. The id is the client's: a second request with an id already stored
     * writes nothing (`inserted: false`) and answers the stored row.
     */
    readonly insert: (
      session: NewQueuedSession,
    ) => Effect.Effect<{ readonly row: QueuedSessionRow; readonly inserted: boolean }>;
    readonly byId: (id: QueuedSessionId) => Effect.Effect<QueuedSessionRow | null>;
    /** One person's in one organization that have not started yet, oldest first. */
    readonly listUnstarted: (
      ownerUserId: string,
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<QueuedSessionRow>>;
    /** Every row in one of `states` last changed before `before`: what a restart left behind. */
    readonly listLeftBehind: (
      states: ReadonlyArray<QueuedSessionState>,
      before: Date,
    ) => Effect.Effect<ReadonlyArray<QueuedSessionRow>>;
    /** Move the row if it is still in one of `from`; null when it is not (or is gone). */
    readonly change: (
      id: QueuedSessionId,
      from: ReadonlyArray<QueuedSessionState>,
      to: QueuedSessionChange,
    ) => Effect.Effect<QueuedSessionRow | null>;
    /** Delete the row if it is still in one of `from`; the deleted row, or null. */
    readonly remove: (
      id: QueuedSessionId,
      from: ReadonlyArray<QueuedSessionState>,
    ) => Effect.Effect<QueuedSessionRow | null>;
    /** Forget started rows last changed before `before`: their session carries on alone. */
    readonly forgetStarted: (before: Date) => Effect.Effect<number>;
  }
>()("@mend/db/QueuedSessionsRepo") {}

const columnsOf = (change: QueuedSessionChange) => {
  switch (change._tag) {
    case "Waiting":
      return {
        state: "waiting" as const,
        adoptionId: change.adoptionId,
        projectName: change.projectName,
        projectId: change.projectId,
        failureStep: null,
        failure: null,
      };
    case "Starting":
      return {
        state: "starting" as const,
        projectId: change.projectId,
        failureStep: null,
        failure: null,
      };
    case "Started":
      return { state: "started" as const, sessionId: change.sessionId };
    case "Failed":
      return { state: "failed" as const, failureStep: change.step, failure: change.failure };
  }
};

export const QueuedSessionsRepoLive: Layer.Layer<QueuedSessionsRepo, never, MendDB> = Layer.effect(
  QueuedSessionsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const byId = Effect.fn("QueuedSessionsRepo.byId")(function* (id: QueuedSessionId) {
      const [row] = yield* db
        .select()
        .from(queuedSessions)
        .where(eq(queuedSessions.id, id))
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const insert = Effect.fn("QueuedSessionsRepo.insert")(function* (session: NewQueuedSession) {
      const [row] = yield* db
        .insert(queuedSessions)
        .values({ ...session, state: "waiting" })
        .onConflictDoNothing({ target: queuedSessions.id })
        .returning()
        .pipe(Effect.orDie);
      if (row !== undefined) return { row, inserted: true };
      const stored = yield* byId(session.id);
      if (stored === null) return yield* Effect.die("queued session vanished after its insert");
      return { row: stored, inserted: false };
    });

    const listUnstarted = Effect.fn("QueuedSessionsRepo.listUnstarted")(function* (
      ownerUserId: string,
      organizationId: OrganizationId,
    ) {
      return yield* db
        .select()
        .from(queuedSessions)
        .where(
          and(
            eq(queuedSessions.ownerUserId, ownerUserId),
            eq(queuedSessions.organizationId, organizationId),
            ne(queuedSessions.state, "started"),
          ),
        )
        .orderBy(queuedSessions.createdAt)
        .pipe(Effect.orDie);
    });

    const listLeftBehind = Effect.fn("QueuedSessionsRepo.listLeftBehind")(function* (
      states: ReadonlyArray<QueuedSessionState>,
      before: Date,
    ) {
      return yield* db
        .select()
        .from(queuedSessions)
        .where(
          and(inArray(queuedSessions.state, [...states]), lt(queuedSessions.updatedAt, before)),
        )
        .orderBy(queuedSessions.createdAt)
        .pipe(Effect.orDie);
    });

    const change = Effect.fn("QueuedSessionsRepo.change")(function* (
      id: QueuedSessionId,
      from: ReadonlyArray<QueuedSessionState>,
      to: QueuedSessionChange,
    ) {
      const [row] = yield* db
        .update(queuedSessions)
        .set({ ...columnsOf(to), updatedAt: yield* DateTime.nowAsDate })
        .where(and(eq(queuedSessions.id, id), inArray(queuedSessions.state, [...from])))
        .returning()
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const remove = Effect.fn("QueuedSessionsRepo.remove")(function* (
      id: QueuedSessionId,
      from: ReadonlyArray<QueuedSessionState>,
    ) {
      const [row] = yield* db
        .delete(queuedSessions)
        .where(and(eq(queuedSessions.id, id), inArray(queuedSessions.state, [...from])))
        .returning()
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const forgetStarted = Effect.fn("QueuedSessionsRepo.forgetStarted")(function* (before: Date) {
      const rows = yield* db
        .delete(queuedSessions)
        .where(and(eq(queuedSessions.state, "started"), lt(queuedSessions.updatedAt, before)))
        .returning({ id: queuedSessions.id })
        .pipe(Effect.orDie);
      return rows.length;
    });

    return { insert, byId, listUnstarted, listLeftBehind, change, remove, forgetStarted };
  }),
);
