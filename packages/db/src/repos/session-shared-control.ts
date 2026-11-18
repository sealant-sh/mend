import { PgClient } from "@effect/sql-pg";
import { type OrganizationId, type ProjectId, type SessionId } from "@mend/domain";
import { canAskSharedControl } from "@mend/domain/workbench";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { agentSessions, projects, sessionSharedControl } from "../schema/workbench.ts";

/** One person's place in a session's shared control: asking, or holding it. */
export interface SharedControlPerson {
  readonly userId: string;
  readonly state: "asked" | "granted";
  readonly askedAt: Date;
  /** When the owner granted the ask; null while it is only asked. */
  readonly grantedAt: Date | null;
  readonly grantedByUserId: string | null;
}

/**
 * Why a step of shared control for one person did not happen, as the session stood when the
 * step ran (docs/adr/0026, decision 7):
 * - `ended`: the session has settled, so nobody asks for it any more;
 * - `owner`: the asker owns it, or it has no owner to ask;
 * - `steers`: the asker can already steer it (shared with everyone, or already granted);
 * - `not-asked`: the person has no open ask (withdrawn, declined, or granted meanwhile);
 * - `not-granted`: the person holds no grant (taken back already).
 */
export const SharedControlRefusalReason = Schema.Literals([
  "ended",
  "owner",
  "steers",
  "not-asked",
  "not-granted",
]);
export type SharedControlRefusalReason = typeof SharedControlRefusalReason.Type;

export class SharedControlStepRefused extends Schema.TaggedError<SharedControlStepRefused>()(
  "SharedControlStepRefused",
  { sessionId: Schema.String, userId: Schema.String, reason: SharedControlRefusalReason },
) {}

export class SharedControlSessionMissing extends Schema.TaggedError<SharedControlSessionMissing>()(
  "SharedControlSessionMissing",
  { sessionId: Schema.String },
) {}

type StepError = SharedControlStepRefused | SharedControlSessionMissing;

/**
 * Shared control of a session for one person at a time (docs/adr/0026, decision 7): asking,
 * withdrawing, granting, declining and taking back. Each step is one transaction that locks the
 * session's row first, so steps on one session (two asks, a grant and a withdrawal, a take-back and
 * the switch for everyone, a settle) happen one after another, and each reads the session as the
 * one before left it. A granted row is mirrored in `agent_sessions.shared_control_user_ids` in the
 * same transaction. Every step that changed something announces the session.
 */
export class SessionSharedControlRepo extends Context.Service<
  SessionSharedControlRepo,
  {
    /** Everyone asking for and holding shared control of the session, oldest ask first. */
    readonly people: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<SharedControlPerson>>;
    /**
     * The open asks on sessions `ownerUserId` owns, among `sessionIds`, by session, oldest
     * first: what the owner's inbox shows as waiting on them.
     */
    readonly asksOnOwnSessions: (
      ownerUserId: string,
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyMap<SessionId, ReadonlyArray<SharedControlPerson>>>;
    /**
     * `userId` asks for shared control. Asking again while asked changes nothing and answers
     * false. Refused when the session has settled, when they own it, and when they can already
     * steer it.
     */
    readonly ask: (sessionId: SessionId, userId: string) => Effect.Effect<boolean, StepError>;
    /** `userId` withdraws their open ask. */
    readonly withdraw: (sessionId: SessionId, userId: string) => Effect.Effect<boolean, StepError>;
    /** The owner grants `userId`'s open ask: from now on they steer the session. */
    readonly grant: (
      sessionId: SessionId,
      userId: string,
      grantedByUserId: string,
    ) => Effect.Effect<boolean, StepError>;
    /** The owner declines `userId`'s open ask. */
    readonly decline: (sessionId: SessionId, userId: string) => Effect.Effect<boolean, StepError>;
    /**
     * The owner, or an organization owner, takes `userId`'s grant back. While shared control
     * with everyone is off they steer no more, and every process closes the steering connections
     * they hold on the session (`shared-control-off` naming them).
     */
    readonly takeBack: (sessionId: SessionId, userId: string) => Effect.Effect<boolean, StepError>;
  }
>()("@mend/db/SessionSharedControlRepo") {}

const toPerson = (row: typeof sessionSharedControl.$inferSelect): SharedControlPerson => ({
  userId: row.userId,
  state: row.state,
  askedAt: row.askedAt,
  grantedAt: row.grantedAt,
  grantedByUserId: row.grantedByUserId,
});

/** The session's row, locked until the transaction ends; null when it is gone. */
const lockSession = (tx: Pick<MendDatabase, "select">, sessionId: SessionId) =>
  tx
    .select({
      projectId: agentSessions.projectId,
      ownerUserId: agentSessions.ownerUserId,
      settledAt: agentSessions.settledAt,
      sharedControlEnabledAt: agentSessions.sharedControlEnabledAt,
      sharedControlUserIds: agentSessions.sharedControlUserIds,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1)
    .for("update")
    .pipe(Effect.map(([row]) => row ?? null));

/**
 * Delete every open ask of a settled session: an ask does not outlive the session it asks for.
 * A settle takes the session's row before this runs, so an ask that locks it after sees it settled
 * and is refused, and one that locked it before is deleted here.
 */
export const dropAsksOfSettled = (db: Pick<MendDatabase, "delete">, sessionId: SessionId) =>
  db
    .delete(sessionSharedControl)
    .where(
      and(
        eq(sessionSharedControl.sessionId, sessionId),
        eq(sessionSharedControl.state, "asked"),
        sql`EXISTS (SELECT 1 FROM ${agentSessions} WHERE ${agentSessions.id} = ${sessionId} AND ${agentSessions.settledAt} IS NOT NULL)`,
      ),
    )
    .returning({ userId: sessionSharedControl.userId });

/**
 * End every grant of the session, in the caller's transaction: the switch for everyone turned off
 * means only the owner steers. Open asks stay; turning it off answers nobody. Answers who lost it.
 */
export const endGrantsOf = Effect.fn("SessionSharedControl.endGrantsOf")(function* (
  db: Pick<MendDatabase, "delete" | "update">,
  sessionIds: ReadonlyArray<SessionId>,
) {
  if (sessionIds.length === 0) return [];
  const ended = yield* db
    .delete(sessionSharedControl)
    .where(
      and(
        inArray(sessionSharedControl.sessionId, [...sessionIds]),
        eq(sessionSharedControl.state, "granted"),
      ),
    )
    .returning({ sessionId: sessionSharedControl.sessionId, userId: sessionSharedControl.userId })
    .pipe(Effect.orDie);
  yield* db
    .update(agentSessions)
    .set({ sharedControlUserIds: [] })
    .where(inArray(agentSessions.id, [...sessionIds]))
    .pipe(Effect.orDie);
  return ended;
});

/**
 * A member leaves an organization: every ask and grant they hold on its sessions ends, in the
 * caller's transaction. Answers the sessions it touched.
 */
export const endSharedControlOfMember = Effect.fn("SessionSharedControl.endOfMember")(function* (
  db: Pick<MendDatabase, "delete" | "update">,
  userId: string,
  organizationId: OrganizationId,
) {
  const ended = yield* db
    .delete(sessionSharedControl)
    .where(
      and(
        eq(sessionSharedControl.userId, userId),
        sql`${sessionSharedControl.sessionId} IN (SELECT ${agentSessions.id} FROM ${agentSessions} JOIN ${projects} ON ${projects.id} = ${agentSessions.projectId} WHERE ${projects.organizationId} = ${organizationId})`,
      ),
    )
    .returning({ sessionId: sessionSharedControl.sessionId })
    .pipe(Effect.orDie);
  const sessionIds = [...new Set(ended.map((row) => row.sessionId))];
  if (sessionIds.length === 0) return [];
  return yield* db
    .update(agentSessions)
    .set({
      sharedControlUserIds: sql`array_remove(${agentSessions.sharedControlUserIds}, ${userId}::text)`,
    })
    .where(inArray(agentSessions.id, sessionIds))
    .returning({ id: agentSessions.id, projectId: agentSessions.projectId })
    .pipe(Effect.orDie);
});

type Outcome =
  | {
      readonly kind: "done";
      readonly projectId: ProjectId;
      readonly changed: boolean;
      /** The person who steers no more: their steering connections close. */
      readonly revoked?: { readonly userId: string; readonly ownerUserId: string | null };
    }
  | { readonly kind: "refused"; readonly reason: SharedControlRefusalReason }
  | { readonly kind: "missing" };

export const SessionSharedControlRepoLive: Layer.Layer<
  SessionSharedControlRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  SessionSharedControlRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    /** Runs one step against the locked session, then announces the session if it changed. */
    const step = (
      sessionId: SessionId,
      userId: string,
      body: (
        tx: Pick<MendDatabase, "insert" | "update" | "delete">,
        session: NonNullable<Effect.Success<ReturnType<typeof lockSession>>>,
      ) => Effect.Effect<Outcome, unknown>,
    ) =>
      Effect.gen(function* () {
        const outcome = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const session = yield* lockSession(tx, sessionId);
              if (session === null) return { kind: "missing" } satisfies Outcome;
              return yield* body(tx, session);
            }),
          )
          .pipe(Effect.orDie);
        switch (outcome.kind) {
          case "missing":
            return yield* new SharedControlSessionMissing({ sessionId });
          case "refused":
            return yield* new SharedControlStepRefused({ sessionId, userId, reason: outcome.reason });
          case "done":
            if (outcome.changed) {
              yield* notifyEvent(pg, { type: "session", sessionId, projectId: outcome.projectId });
            }
            if (outcome.revoked !== undefined) {
              yield* notifyEvent(pg, {
                type: "shared-control-off",
                sessionId,
                projectId: outcome.projectId,
                ownerUserId: outcome.revoked.ownerUserId,
                userId: outcome.revoked.userId,
              });
            }
            return outcome.changed;
        }
      });

    const people = Effect.fn("SessionSharedControlRepo.people")(function* (sessionId: SessionId) {
      const rows = yield* db
        .select()
        .from(sessionSharedControl)
        .where(eq(sessionSharedControl.sessionId, sessionId))
        .orderBy(asc(sessionSharedControl.askedAt), asc(sessionSharedControl.userId))
        .pipe(Effect.orDie);
      return rows.map(toPerson);
    });

    const asksOnOwnSessions = Effect.fn("SessionSharedControlRepo.asksOnOwnSessions")(function* (
      ownerUserId: string,
      sessionIds: ReadonlyArray<SessionId>,
    ) {
      const asks = new Map<SessionId, Array<SharedControlPerson>>();
      if (sessionIds.length === 0) return asks;
      const rows = yield* db
        .select({ ask: sessionSharedControl })
        .from(sessionSharedControl)
        .innerJoin(agentSessions, eq(agentSessions.id, sessionSharedControl.sessionId))
        .where(
          and(
            inArray(sessionSharedControl.sessionId, [...sessionIds]),
            eq(sessionSharedControl.state, "asked"),
            eq(agentSessions.ownerUserId, ownerUserId),
            isNull(agentSessions.settledAt),
          ),
        )
        .orderBy(asc(sessionSharedControl.askedAt), asc(sessionSharedControl.userId))
        .pipe(Effect.orDie);
      for (const { ask } of rows) {
        const list = asks.get(ask.sessionId) ?? [];
        list.push(toPerson(ask));
        asks.set(ask.sessionId, list);
      }
      return asks;
    });

    const ask = Effect.fn("SessionSharedControlRepo.ask")((sessionId: SessionId, userId: string) =>
      step(sessionId, userId, (tx, session) =>
        Effect.gen(function* () {
          if (session.settledAt !== null) return { kind: "refused", reason: "ended" } as const;
          if (session.ownerUserId === null || session.ownerUserId === userId)
            return { kind: "refused", reason: "owner" } as const;
          if (!canAskSharedControl(session, userId))
            return { kind: "refused", reason: "steers" } as const;
          const inserted = yield* tx
            .insert(sessionSharedControl)
            .values({ sessionId, userId, state: "asked", askedAt: yield* DateTime.nowAsDate })
            .onConflictDoNothing()
            .returning({ userId: sessionSharedControl.userId });
          return { kind: "done", projectId: session.projectId, changed: inserted.length > 0 } as const;
        }),
      ),
    );

    /** Delete `userId`'s row in `state`, or refuse with `missing`. */
    const remove = (
      sessionId: SessionId,
      userId: string,
      state: "asked" | "granted",
      missing: SharedControlRefusalReason,
    ) =>
      step(sessionId, userId, (tx, session) =>
        Effect.gen(function* () {
          const removed = yield* tx
            .delete(sessionSharedControl)
            .where(
              and(
                eq(sessionSharedControl.sessionId, sessionId),
                eq(sessionSharedControl.userId, userId),
                eq(sessionSharedControl.state, state),
              ),
            )
            .returning({ userId: sessionSharedControl.userId });
          if (removed.length === 0) return { kind: "refused", reason: missing } as const;
          if (state === "granted") {
            yield* tx
              .update(agentSessions)
              .set({
                sharedControlUserIds: sql`array_remove(${agentSessions.sharedControlUserIds}, ${userId}::text)`,
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(eq(agentSessions.id, sessionId));
          }
          return {
            kind: "done",
            projectId: session.projectId,
            changed: true,
            ...(state === "granted" && session.sharedControlEnabledAt === null
              ? { revoked: { userId, ownerUserId: session.ownerUserId } }
              : {}),
          } as const;
        }),
      );

    const withdraw = Effect.fn("SessionSharedControlRepo.withdraw")(
      (sessionId: SessionId, userId: string) => remove(sessionId, userId, "asked", "not-asked"),
    );
    const decline = Effect.fn("SessionSharedControlRepo.decline")(
      (sessionId: SessionId, userId: string) => remove(sessionId, userId, "asked", "not-asked"),
    );
    const takeBack = Effect.fn("SessionSharedControlRepo.takeBack")(
      (sessionId: SessionId, userId: string) => remove(sessionId, userId, "granted", "not-granted"),
    );

    const grant = Effect.fn("SessionSharedControlRepo.grant")(
      (sessionId: SessionId, userId: string, grantedByUserId: string) =>
        step(sessionId, userId, (tx, session) =>
          Effect.gen(function* () {
            const now = yield* DateTime.nowAsDate;
            const granted = yield* tx
              .update(sessionSharedControl)
              .set({ state: "granted", grantedAt: now, grantedByUserId })
              .where(
                and(
                  eq(sessionSharedControl.sessionId, sessionId),
                  eq(sessionSharedControl.userId, userId),
                  eq(sessionSharedControl.state, "asked"),
                ),
              )
              .returning({ userId: sessionSharedControl.userId });
            if (granted.length === 0) return { kind: "refused", reason: "not-asked" } as const;
            yield* tx
              .update(agentSessions)
              .set({
                sharedControlUserIds: session.sharedControlUserIds.includes(userId)
                  ? session.sharedControlUserIds
                  : [...session.sharedControlUserIds, userId],
                // Once shared, always so for this session (docs/adr/0016, decision 9).
                sharedControlEverAt: sql`COALESCE(${agentSessions.sharedControlEverAt}, now())`,
                updatedAt: now,
              })
              .where(eq(agentSessions.id, sessionId));
            return { kind: "done", projectId: session.projectId, changed: true } as const;
          }),
        ),
    );

    return SessionSharedControlRepo.of({
      people,
      asksOnOwnSessions,
      ask,
      withdraw,
      grant,
      decline,
      takeBack,
    });
  }),
);
