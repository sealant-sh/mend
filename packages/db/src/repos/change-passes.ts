import { PgClient } from "@effect/sql-pg";
import { type ChangeId } from "@mend/domain";
import { ChangePass, type PassKind } from "@mend/domain/workbench";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { changePasses, worktreeChanges } from "../schema/workbench.ts";

const decodePass = Schema.decodeUnknownEffect(Schema.Struct(ChangePass.fields));

/**
 * Machine-pass outcomes over a change (tour · read · suggest): begin marks a
 * run, complete/fail replace it with what happened. Every write notifies the
 * change's SSE pointer, so the review page re-reads instead of guessing —
 * this table is what lets it say "the pass ran and drafted nothing" rather
 * than showing the same silence as "never ran".
 */
export class ChangePassesRepo extends Context.Service<
  ChangePassesRepo,
  {
    /**
     * Mark a pass queued, before its job is enqueued. A pass already queued or running keeps its
     * row: the job that will run it (or runs it) writes what happens next.
     */
    readonly queue: (changeId: ChangeId, kind: PassKind) => Effect.Effect<void>;
    readonly begin: (changeId: ChangeId, kind: PassKind) => Effect.Effect<void>;
    /** Findings: how many the pass drafted; null where the kind has no count (the tour). */
    readonly complete: (
      changeId: ChangeId,
      kind: PassKind,
      findings: number | null,
    ) => Effect.Effect<void>;
    readonly fail: (changeId: ChangeId, kind: PassKind, detail: string) => Effect.Effect<void>;
    readonly listForChange: (changeId: ChangeId) => Effect.Effect<ReadonlyArray<ChangePass>>;
  }
>()("@mend/db/ChangePassesRepo") {}

const decodeRow = (row: typeof changePasses.$inferSelect) =>
  decodePass(row).pipe(
    Effect.map((decoded) => new ChangePass(decoded)),
    Effect.orDie,
  );

export const ChangePassesRepoLive: Layer.Layer<
  ChangePassesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ChangePassesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const notify = Effect.fn("ChangePassesRepo.notify")(function* (changeId: ChangeId) {
      const [row] = yield* db
        .select({
          sessionId: worktreeChanges.sessionId,
          worktreeId: worktreeChanges.worktreeId,
          projectId: worktreeChanges.projectId,
        })
        .from(worktreeChanges)
        .where(eq(worktreeChanges.id, changeId))
        .limit(1)
        .pipe(Effect.orDie);
      // A change no session ever inhabited has no one listening on the legacy key.
      if (row === undefined || row.sessionId === null) return;
      yield* notifyEvent(sql, {
        type: "session-change",
        changeId,
        worktreeId: row.worktreeId,
        sessionId: row.sessionId,
        projectId: row.projectId,
      });
    });

    const queue = Effect.fn("ChangePassesRepo.queue")(function* (
      changeId: ChangeId,
      kind: PassKind,
    ) {
      yield* db
        .insert(changePasses)
        .values({ changeId, kind, status: "queued", detail: null, findings: null })
        .onConflictDoUpdate({
          target: [changePasses.changeId, changePasses.kind],
          set: {
            status: "queued",
            detail: null,
            findings: null,
            startedAt: new Date(),
            finishedAt: null,
          },
          setWhere: inArray(changePasses.status, ["completed", "failed"]),
        })
        .pipe(Effect.orDie);
      yield* notify(changeId);
    });

    const begin = Effect.fn("ChangePassesRepo.begin")(function* (
      changeId: ChangeId,
      kind: PassKind,
    ) {
      yield* db
        .insert(changePasses)
        .values({ changeId, kind, status: "running", detail: null, findings: null })
        .onConflictDoUpdate({
          target: [changePasses.changeId, changePasses.kind],
          set: {
            status: "running",
            detail: null,
            findings: null,
            startedAt: new Date(),
            finishedAt: null,
          },
        })
        .pipe(Effect.orDie);
      yield* notify(changeId);
    });

    const complete = Effect.fn("ChangePassesRepo.complete")(function* (
      changeId: ChangeId,
      kind: PassKind,
      findings: number | null,
    ) {
      yield* db
        .update(changePasses)
        .set({ status: "completed", findings, detail: null, finishedAt: new Date() })
        .where(and(eq(changePasses.changeId, changeId), eq(changePasses.kind, kind)))
        .pipe(Effect.orDie);
      yield* notify(changeId);
    });

    const fail = Effect.fn("ChangePassesRepo.fail")(function* (
      changeId: ChangeId,
      kind: PassKind,
      detail: string,
    ) {
      yield* db
        .update(changePasses)
        .set({ status: "failed", detail: detail.slice(0, 1000), finishedAt: new Date() })
        .where(and(eq(changePasses.changeId, changeId), eq(changePasses.kind, kind)))
        .pipe(Effect.orDie);
      yield* notify(changeId);
    });

    const listForChange = Effect.fn("ChangePassesRepo.listForChange")(function* (
      changeId: ChangeId,
    ) {
      const rows = yield* db
        .select()
        .from(changePasses)
        .where(eq(changePasses.changeId, changeId))
        .orderBy(asc(changePasses.kind))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, decodeRow);
    });

    return { queue, begin, complete, fail, listForChange };
  }),
);
