import { PgClient } from "@effect/sql-pg";
import {
  FailureBrief,
  Run,
  RunId,
  type ChangeId,
  type IssueId,
  type RunKind,
  type RunOutcome,
  type RunStatus,
  type SealantRunId,
  type SealantWorkspaceId,
} from "@mend/domain";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { runs } from "../schema/workbench.ts";

export class RunNotFoundError extends Schema.TaggedError<RunNotFoundError>()("RunNotFoundError", {
  runId: Schema.String,
}) {}

const decodeRun = Schema.decodeUnknownEffect(Run);

/**
 * The index of harness executions (ARCHITECTURE.md §3): status, outcome, and
 * the last-seen record sequence for crash-resume. The recording itself stays
 * in Sealant, addressed by `(sealantRunId, sequence)`.
 */
export class RunsRepo extends Context.Service<
  RunsRepo,
  {
    readonly create: (issueId: IssueId, kind: RunKind) => Effect.Effect<Run>;
    readonly byId: (id: RunId) => Effect.Effect<Run, RunNotFoundError>;
    readonly listForIssue: (issueId: IssueId) => Effect.Effect<ReadonlyArray<Run>>;
    /** Runs to re-attach to after a crash/restart. */
    readonly listUnsettled: () => Effect.Effect<ReadonlyArray<Run>>;
    readonly setSealantIds: (
      id: RunId,
      sealantRunId: SealantRunId,
      workspaceId: SealantWorkspaceId,
    ) => Effect.Effect<void>;
    readonly setStatus: (id: RunId, status: RunStatus) => Effect.Effect<void>;
    /** Ties a settled run to the change its recording is evidence for. */
    readonly linkChange: (id: RunId, changeId: ChangeId) => Effect.Effect<void>;
    readonly saveLastSeenSequence: (id: RunId, sequence: bigint) => Effect.Effect<void>;
    readonly settle: (
      id: RunId,
      outcome: RunOutcome,
      summary: string | null,
    ) => Effect.Effect<void>;
    /** The failure mini-brief, summed from the recording after a failed settle. */
    readonly saveFailureBrief: (id: RunId, brief: FailureBrief) => Effect.Effect<void>;
  }
>()("@mend/db/RunsRepo") {}

const decodeRow = (row: typeof runs.$inferSelect) =>
  decodeRun(row).pipe(
    Effect.map((decoded) => new Run(decoded)),
    Effect.orDie,
  );

export const RunsRepoLive: Layer.Layer<RunsRepo, never, MendDB | PgClient.PgClient> = Layer.effect(
  RunsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const issueIdOf = Effect.fn("RunsRepo.issueIdOf")(function* (id: RunId) {
      const [row] = yield* db
        .select({ issueId: runs.issueId })
        .from(runs)
        .where(eq(runs.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row?.issueId ?? "";
    });

    const create = Effect.fn("RunsRepo.create")(function* (issueId: IssueId, kind: RunKind) {
      const [row] = yield* db
        .insert(runs)
        .values({ id: RunId.make(crypto.randomUUID()), issueId, kind })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("run insert returned no row");
      const run = yield* decodeRow(row);
      yield* notifyEvent(sql, { type: "run", runId: run.id, issueId });
      return run;
    });

    const byId = Effect.fn("RunsRepo.byId")(function* (id: RunId) {
      const [row] = yield* db
        .select()
        .from(runs)
        .where(eq(runs.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new RunNotFoundError({ runId: id });
      return yield* decodeRow(row);
    });

    const listForIssue = Effect.fn("RunsRepo.listForIssue")(function* (issueId: IssueId) {
      const rows = yield* db
        .select()
        .from(runs)
        .where(eq(runs.issueId, issueId))
        .orderBy(desc(runs.createdAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, decodeRow);
    });

    const listUnsettled = Effect.fn("RunsRepo.listUnsettled")(function* () {
      const rows = yield* db
        .select()
        .from(runs)
        .where(inArray(runs.status, ["queued", "running"]))
        .orderBy(asc(runs.createdAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, decodeRow);
    });

    const setSealantIds = Effect.fn("RunsRepo.setSealantIds")(function* (
      id: RunId,
      sealantRunId: SealantRunId,
      workspaceId: SealantWorkspaceId,
    ) {
      yield* db
        .update(runs)
        .set({
          sealantRunId,
          sealantWorkspaceId: workspaceId,
          updatedAt: yield* DateTime.nowAsDate,
        })
        .where(eq(runs.id, id))
        .pipe(Effect.orDie);
    });

    const setStatus = Effect.fn("RunsRepo.setStatus")(function* (id: RunId, status: RunStatus) {
      yield* db
        .update(runs)
        .set({
          status,
          updatedAt: yield* DateTime.nowAsDate,
          ...(status === "running" ? { startedAt: yield* DateTime.nowAsDate } : {}),
        })
        .where(eq(runs.id, id))
        .pipe(Effect.orDie);
      const issueId = yield* issueIdOf(id);
      yield* notifyEvent(sql, { type: "run", runId: id, issueId });
    });

    const linkChange = Effect.fn("RunsRepo.linkChange")(function* (id: RunId, changeId: ChangeId) {
      yield* db
        .update(runs)
        .set({ changeId, updatedAt: yield* DateTime.nowAsDate })
        .where(eq(runs.id, id))
        .pipe(Effect.orDie);
    });

    const saveLastSeenSequence = Effect.fn("RunsRepo.saveLastSeenSequence")(function* (
      id: RunId,
      sequence: bigint,
    ) {
      yield* db
        .update(runs)
        .set({ lastSeenSequence: sequence, updatedAt: yield* DateTime.nowAsDate })
        .where(and(eq(runs.id, id), lt(runs.lastSeenSequence, sequence)))
        .pipe(Effect.orDie);
    });

    const settle = Effect.fn("RunsRepo.settle")(function* (
      id: RunId,
      outcome: RunOutcome,
      summary: string | null,
    ) {
      const now = yield* DateTime.nowAsDate;
      yield* db
        .update(runs)
        .set({ status: outcome, outcome, summary, settledAt: now, updatedAt: now })
        .where(eq(runs.id, id))
        .pipe(Effect.orDie);
      const issueId = yield* issueIdOf(id);
      yield* notifyEvent(sql, { type: "run", runId: id, issueId });
    });

    const saveFailureBrief = Effect.fn("RunsRepo.saveFailureBrief")(function* (
      id: RunId,
      brief: FailureBrief,
    ) {
      const encoded = yield* Schema.encodeEffect(FailureBrief)(brief).pipe(Effect.orDie);
      yield* db
        .update(runs)
        .set({ failureBrief: encoded, updatedAt: yield* DateTime.nowAsDate })
        .where(eq(runs.id, id))
        .pipe(Effect.orDie);
      const issueId = yield* issueIdOf(id);
      yield* notifyEvent(sql, { type: "run", runId: id, issueId });
    });

    return {
      create,
      byId,
      listForIssue,
      listUnsettled,
      setSealantIds,
      setStatus,
      linkChange,
      saveLastSeenSequence,
      settle,
      saveFailureBrief,
    };
  }),
);
