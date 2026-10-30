import { PgClient } from "@effect/sql-pg";
import type { AgentTurnId, PreviewId, SessionId, WorktreeId } from "@mend/domain";
import {
  OPEN_AGENT_TURN_STATUSES,
  type PreviewPhase,
  type PreviewPreparation,
  type PreviewPreparationDecision,
  type PreviewPreparationLeft,
  type PreviewPreparationNote,
  type PreviewPreparationState,
} from "@mend/domain/workbench";
import { and, desc, eq, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentSessions,
  agentTurns,
  type PreviewPreparationStateColumn,
  previewPreparations,
  worktrees,
} from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

export interface PreviewPreparationClaim {
  readonly turnId: AgentTurnId;
  readonly sessionId: SessionId;
  readonly worktreeId: WorktreeId;
  readonly claimId: string;
}

export interface PreviewPreparationProgress {
  readonly service: string;
  readonly previewId: PreviewId | null;
  readonly startId: string;
  readonly phase: PreviewPhase;
  readonly note: PreviewPreparationNote | null;
}

/** What a progress write found: the claim holds the preview's start, another start does, or the claim is gone. */
export type PreviewPreparationHeld = "Held" | "Taken" | "Lost";

/**
 * Lease times are the database's clock, so two API processes never disagree about one. A turn is
 * claimed once its row is new, or its claim lapsed before it decided; `decide` and `renew` answer
 * false, and `progress` `Lost`, once the caller's claim no longer holds.
 */
export class PreviewPreparationsRepo extends Context.Service<
  PreviewPreparationsRepo,
  {
    /** The session's ended turns no preparation has decided: no row, or one still open. */
    readonly undecided: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<AgentTurnId>>;
    /** The turn for `leaseMs`, or null while another claim holds it or it is decided. */
    readonly claim: (
      turnId: AgentTurnId,
      leaseMs: number,
    ) => Effect.Effect<PreviewPreparationClaim | null>;
    /** What the session's earlier preparations decided, by turn; an undecided turn is absent. */
    readonly left: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyMap<AgentTurnId, PreviewPreparationLeft>>;
    readonly renew: (claim: PreviewPreparationClaim, leaseMs: number) => Effect.Effect<boolean>;
    /**
     * Records the start's phase. The first write takes the preview (worktree and Service name):
     * one `starting` row per preview, whichever session or process wrote it. A holder whose lease
     * lapsed gives it up to the next writer.
     */
    readonly progress: (
      claim: PreviewPreparationClaim,
      progress: PreviewPreparationProgress,
    ) => Effect.Effect<PreviewPreparationHeld>;
    readonly decide: (
      claim: PreviewPreparationClaim,
      decision: PreviewPreparationDecision,
    ) => Effect.Effect<boolean>;
    /**
     * What the worktree's line reads from: a start under way, else the latest decision about the
     * preview, silent ones included. A skip and a superseded turn decided nothing about it.
     */
    readonly latestForWorktree: (
      worktreeId: WorktreeId,
    ) => Effect.Effect<PreviewPreparation | null>;
  }
>()("@mend/db/PreviewPreparationsRepo") {}

const leaseEnd = (leaseMs: number) => sql`now() + ${leaseMs} * interval '1 millisecond'`;

const held = (claim: PreviewPreparationClaim) =>
  and(
    eq(previewPreparations.turnId, claim.turnId),
    eq(previewPreparations.claimId, claim.claimId),
    isNull(previewPreparations.decidedAt),
    sql`${previewPreparations.leaseUntil} > now()`,
  );

type Row = typeof previewPreparations.$inferSelect;

interface Columns {
  readonly state: PreviewPreparationStateColumn;
  readonly reason: string | null;
  readonly note: PreviewPreparationNote | null;
  readonly serviceName: string | null;
  readonly previewId: Row["previewId"];
}

const columnsOf = (decision: PreviewPreparationDecision): Columns => {
  const none = { reason: null, note: null, serviceName: null, previewId: null };
  switch (decision._tag) {
    case "Skipped":
      return { ...none, state: "skipped", reason: decision.why };
    case "Superseded":
      return { ...none, state: "superseded" };
    case "NoChange":
      return { ...none, state: "no-change" };
    case "NotCaptured":
      return { ...none, state: "not-captured" };
    case "NoPreview":
      return { ...none, state: "no-preview" };
    case "SessionEnded":
      return { ...none, state: "session-ended" };
    case "Stopped":
      return {
        ...none,
        state: "stopped",
        serviceName: decision.service,
        previewId: decision.previewId,
      };
    case "NotApproved":
      return {
        ...none,
        state: "not-approved",
        serviceName: decision.service,
        previewId: decision.previewId,
      };
    case "Refused":
      return {
        ...none,
        state: "refused",
        reason: decision.reason,
        serviceName: decision.service,
        previewId: decision.previewId,
      };
    case "Running":
    case "Started":
      return {
        ...none,
        state: decision._tag === "Running" ? "running" : "started",
        note: decision.note,
        serviceName: decision.service,
        previewId: decision.previewId,
      };
  }
};

const present = <A>(row: Row, column: string, value: A | null): Effect.Effect<A> =>
  value === null
    ? Effect.die(
        new Error(`preview_preparations ${row.turnId}: ${column} is null under ${row.state}`),
      )
    : Effect.succeed(value);

const decisionOf = (row: Row): Effect.Effect<PreviewPreparationDecision | null> =>
  Effect.gen(function* () {
    const service = present(row, "service_name", row.serviceName);
    switch (row.state) {
      case "claimed":
      case "starting":
        return null;
      case "skipped":
        return { _tag: "Skipped", why: yield* present(row, "reason", row.reason) };
      case "superseded":
        return { _tag: "Superseded" };
      case "no-change":
        return { _tag: "NoChange" };
      case "not-captured":
        return { _tag: "NotCaptured" };
      case "no-preview":
        return { _tag: "NoPreview" };
      case "session-ended":
        return { _tag: "SessionEnded" };
      case "stopped":
        return { _tag: "Stopped", service: yield* service, previewId: row.previewId };
      case "not-approved":
        return { _tag: "NotApproved", service: yield* service, previewId: row.previewId };
      case "refused":
        return {
          _tag: "Refused",
          service: row.serviceName,
          previewId: row.previewId,
          reason: yield* present(row, "reason", row.reason),
        };
      case "running":
      case "started":
        return {
          _tag: row.state === "running" ? "Running" : "Started",
          service: yield* service,
          previewId: row.previewId,
          note: row.note,
        };
    }
  });

const stateOf = (row: Row): Effect.Effect<PreviewPreparationState> =>
  Effect.gen(function* () {
    if (row.state === "starting") {
      return {
        _tag: "Starting",
        service: yield* present(row, "service_name", row.serviceName),
        previewId: row.previewId,
        phase: yield* present(row, "phase", row.phase),
        note: row.note,
      };
    }
    const decision = yield* decisionOf(row);
    if (decision === null) return { _tag: "Claimed" };
    return {
      _tag: "Decided",
      decision,
      decidedAt: yield* present(row, "decided_at", row.decidedAt),
    };
  });

const toPreparation = (row: Row): Effect.Effect<PreviewPreparation> =>
  Effect.map(stateOf(row), (state) => ({
    turnId: row.turnId,
    sessionId: row.sessionId,
    worktreeId: row.worktreeId,
    claimedAt: row.claimedAt,
    state,
  }));

const claimOf = (row: Row): PreviewPreparationClaim => ({
  turnId: row.turnId,
  sessionId: row.sessionId,
  worktreeId: row.worktreeId,
  claimId: row.claimId,
});

const UNSPOKEN: ReadonlyArray<PreviewPreparationStateColumn> = ["claimed", "skipped", "superseded"];

export const PreviewPreparationsRepoLive: Layer.Layer<
  PreviewPreparationsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  PreviewPreparationsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notifyWorktree = Effect.fn("PreviewPreparationsRepo.notifyWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select({ projectId: worktrees.projectId })
        .from(worktrees)
        .where(eq(worktrees.id, worktreeId))
        .pipe(Effect.orDie);
      if (row !== undefined) {
        yield* notifyEvent(pg, { type: "worktree", worktreeId, projectId: row.projectId });
      }
    });

    const undecided = Effect.fn("PreviewPreparationsRepo.undecided")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select({ id: agentTurns.id })
        .from(agentTurns)
        .leftJoin(previewPreparations, eq(previewPreparations.turnId, agentTurns.id))
        .where(
          and(
            eq(agentTurns.sessionId, sessionId),
            notInArray(agentTurns.status, [...OPEN_AGENT_TURN_STATUSES]),
            or(isNull(previewPreparations.turnId), isNull(previewPreparations.decidedAt)),
          ),
        )
        .orderBy(agentTurns.ordinal);
      return rows.map((row) => row.id);
    }, Effect.orDie);

    const claim = Effect.fn("PreviewPreparationsRepo.claim")(function* (
      turnId: AgentTurnId,
      leaseMs: number,
    ) {
      const [turn] = yield* db
        .select({ sessionId: agentTurns.sessionId, worktreeId: agentSessions.worktreeId })
        .from(agentTurns)
        .innerJoin(agentSessions, eq(agentSessions.id, agentTurns.sessionId))
        .where(
          and(
            eq(agentTurns.id, turnId),
            notInArray(agentTurns.status, [...OPEN_AGENT_TURN_STATUSES]),
          ),
        );
      if (turn === undefined) return null;
      const claimId = crypto.randomUUID();
      const [row] = yield* db
        .insert(previewPreparations)
        .values({
          turnId,
          sessionId: turn.sessionId,
          worktreeId: turn.worktreeId,
          state: "claimed",
          claimId,
          claimedAt: sql`now()`,
          leaseUntil: leaseEnd(leaseMs),
        })
        .onConflictDoUpdate({
          target: previewPreparations.turnId,
          set: {
            state: "claimed",
            note: null,
            serviceName: null,
            previewId: null,
            startId: null,
            phase: null,
            claimId,
            claimedAt: sql`now()`,
            leaseUntil: leaseEnd(leaseMs),
          },
          setWhere: sql`${previewPreparations.decidedAt} IS NULL AND ${previewPreparations.leaseUntil} <= now()`,
        })
        .returning();
      return row === undefined ? null : claimOf(row);
    }, Effect.orDie);

    const renew = Effect.fn("PreviewPreparationsRepo.renew")(function* (
      held_: PreviewPreparationClaim,
      leaseMs: number,
    ) {
      const rows = yield* db
        .update(previewPreparations)
        .set({ leaseUntil: leaseEnd(leaseMs) })
        .where(held(held_))
        .returning({ turnId: previewPreparations.turnId });
      return rows.length === 1;
    }, Effect.orDie);

    const left = Effect.fn("PreviewPreparationsRepo.left")(function* (sessionId: SessionId) {
      const rows = yield* db
        .select({ turnId: previewPreparations.turnId, state: previewPreparations.state })
        .from(previewPreparations)
        .where(
          and(
            eq(previewPreparations.sessionId, sessionId),
            isNotNull(previewPreparations.decidedAt),
          ),
        );
      return new Map(
        rows.map((row): [AgentTurnId, PreviewPreparationLeft] => [
          row.turnId,
          row.state === "superseded" ? "superseded" : "decided",
        ]),
      );
    }, Effect.orDie);

    const progress = Effect.fn("PreviewPreparationsRepo.progress")(function* (
      held_: PreviewPreparationClaim,
      update: PreviewPreparationProgress,
    ) {
      const freed = yield* db
        .update(previewPreparations)
        .set({
          state: "claimed",
          serviceName: null,
          previewId: null,
          startId: null,
          phase: null,
          note: null,
        })
        .where(
          and(
            eq(previewPreparations.worktreeId, held_.worktreeId),
            eq(previewPreparations.serviceName, update.service),
            eq(previewPreparations.state, "starting"),
            lte(previewPreparations.leaseUntil, sql`now()`),
          ),
        )
        .returning({ turnId: previewPreparations.turnId })
        .pipe(Effect.orDie);
      const outcome = yield* db
        .update(previewPreparations)
        .set({
          state: "starting",
          serviceName: update.service,
          previewId: update.previewId,
          startId: update.startId,
          phase: update.phase,
          note: update.note,
        })
        .where(held(held_))
        .returning({ turnId: previewPreparations.turnId })
        .pipe(
          Effect.map((rows): PreviewPreparationHeld => (rows.length === 1 ? "Held" : "Lost")),
          Effect.catchTag("EffectDrizzleQueryError", (error) =>
            isUniqueViolation(error)
              ? Effect.succeed<PreviewPreparationHeld>("Taken")
              : Effect.die(error),
          ),
        );
      if (outcome === "Held" || freed.length > 0) yield* notifyWorktree(held_.worktreeId);
      return outcome;
    });

    const decide = Effect.fn("PreviewPreparationsRepo.decide")(function* (
      held_: PreviewPreparationClaim,
      decision: PreviewPreparationDecision,
    ) {
      const rows = yield* db
        .update(previewPreparations)
        .set({ ...columnsOf(decision), phase: null, decidedAt: sql`now()` })
        .where(held(held_))
        .returning({ turnId: previewPreparations.turnId });
      if (rows.length === 1) yield* notifyWorktree(held_.worktreeId);
      return rows.length === 1;
    }, Effect.orDie);

    const latestForWorktree = Effect.fn("PreviewPreparationsRepo.latestForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select()
        .from(previewPreparations)
        .where(
          and(
            eq(previewPreparations.worktreeId, worktreeId),
            notInArray(previewPreparations.state, [...UNSPOKEN]),
          ),
        )
        .orderBy(
          desc(sql`${previewPreparations.state} = 'starting'`),
          desc(previewPreparations.decidedAt),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : yield* toPreparation(row);
    });

    return { undecided, claim, left, renew, progress, decide, latestForWorktree };
  }),
);
