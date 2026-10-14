import { PgClient } from "@effect/sql-pg";
import { NewIssue, QueueMove } from "@mend/api-contracts";
import { Issue, IssueId, type IssueStage, type RunId } from "@mend/domain";
import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { DateTime, Effect, Layer, Option } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { IssueNotFoundError } from "../errors.ts";
import { notifyEvent } from "../events.ts";
import { issues } from "../schema/workbench.ts";

// Intake shapes are contract data now; re-exported so repo callers keep working.
export { NewIssue, QueueMove };

export class IssuesRepo extends Context.Service<
  IssuesRepo,
  {
    /** New issues land in triage. Mend does nothing with an issue sitting there. */
    readonly create: (input: NewIssue) => Effect.Effect<Issue>;
    readonly list: () => Effect.Effect<ReadonlyArray<Issue>>;
    readonly byId: (id: IssueId) => Effect.Effect<Issue, IssueNotFoundError>;
    /** Gate 1: the human drag — into the queue, out of it, or reordering it. */
    readonly move: (id: IssueId, move: QueueMove) => Effect.Effect<Issue, IssueNotFoundError>;
    /** The dispatcher takes the top of the queue into mending. */
    readonly markMending: (id: IssueId) => Effect.Effect<Issue, IssueNotFoundError>;
    /** A successful run puts the card in review. */
    readonly markReview: (id: IssueId) => Effect.Effect<Issue, IssueNotFoundError>;
    /** A failed run returns the card to triage carrying the failure. */
    readonly returnToTriage: (
      id: IssueId,
      failureRunId: RunId,
    ) => Effect.Effect<Issue, IssueNotFoundError>;
    /** The user-visible queue is domain state: `stage = queued` ordered by `position`. */
    readonly topOfQueued: () => Effect.Effect<Option.Option<Issue>>;
    readonly countByStage: (stage: IssueStage) => Effect.Effect<number>;
  }
>()("@mend/db/IssuesRepo") {}

const toIssue = (row: typeof issues.$inferSelect): Issue => new Issue(row);

export const IssuesRepoLive: Layer.Layer<IssuesRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    IssuesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sql = yield* PgClient.PgClient;

      const updateStage = Effect.fn("IssuesRepo.updateStage")(function* (
        id: IssueId,
        stage: IssueStage,
        options?: { readonly failureRunId?: RunId },
      ) {
        const failureRunId = options?.failureRunId;
        const [row] = yield* db
          .update(issues)
          .set({
            stage,
            position: null,
            updatedAt: yield* DateTime.nowAsDate,
            ...(failureRunId === undefined ? {} : { lastFailureRunId: failureRunId }),
          })
          .where(eq(issues.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new IssueNotFoundError({ issueId: id });
        const issue = toIssue(row);
        yield* notifyEvent(sql, { type: "issue", issueId: id });
        return issue;
      });

      /** Renumbers the queue with `id` at `index` (appends when null). */
      const placeInQueue = Effect.fn("IssuesRepo.placeInQueue")(function* (
        id: IssueId,
        index: number | null,
      ) {
        const issue = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const exists = yield* tx
                .select({ id: issues.id })
                .from(issues)
                .where(eq(issues.id, id))
                .for("update");
              if (exists.length === 0) return yield* new IssueNotFoundError({ issueId: id });

              const rows = yield* tx
                .select({ id: issues.id })
                .from(issues)
                .where(and(eq(issues.stage, "queued"), ne(issues.id, id)))
                .orderBy(asc(issues.position), asc(issues.updatedAt))
                .for("update");
              const others = rows.map((row) => row.id);
              const at =
                index === null ? others.length : Math.max(0, Math.min(index, others.length));
              const ordered = [...others.slice(0, at), id, ...others.slice(at)];

              for (const [position, issueId] of ordered.entries()) {
                yield* tx
                  .update(issues)
                  .set({ stage: "queued", position, updatedAt: yield* DateTime.nowAsDate })
                  .where(eq(issues.id, issueId));
              }

              const [updated] = yield* tx.select().from(issues).where(eq(issues.id, id)).limit(1);
              if (updated === undefined) return yield* Effect.die("queued issue disappeared");
              return toIssue(updated);
            }),
          )
          .pipe(
            Effect.catchTags({
              EffectDrizzleQueryError: (error) => Effect.die(error),
              SqlError: (error) => Effect.die(error),
            }),
          );
        yield* notifyEvent(sql, { type: "issue", issueId: id });
        return issue;
      });

      const create = Effect.fn("IssuesRepo.create")(function* (input: NewIssue) {
        const [row] = yield* db
          .insert(issues)
          .values({ id: IssueId.make(crypto.randomUUID()), ...input })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("issue insert returned no row");
        const issue = toIssue(row);
        yield* notifyEvent(sql, { type: "issue", issueId: issue.id });
        return issue;
      });

      const list = Effect.fn("IssuesRepo.list")(function* () {
        const rows = yield* db
          .select()
          .from(issues)
          .orderBy(asc(issues.position), desc(issues.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toIssue);
      });

      const byId = Effect.fn("IssuesRepo.byId")(function* (id: IssueId) {
        const [row] = yield* db
          .select()
          .from(issues)
          .where(eq(issues.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new IssueNotFoundError({ issueId: id });
        return toIssue(row);
      });

      const move = Effect.fn("IssuesRepo.move")(function* (id: IssueId, queueMove: QueueMove) {
        if (queueMove.stage === "queued") return yield* placeInQueue(id, queueMove.position);
        return yield* updateStage(id, "triage");
      });

      const markMending = Effect.fn("IssuesRepo.markMending")((id: IssueId) =>
        updateStage(id, "mending"),
      );

      const markReview = Effect.fn("IssuesRepo.markReview")((id: IssueId) =>
        updateStage(id, "review"),
      );

      const returnToTriage = Effect.fn("IssuesRepo.returnToTriage")(
        (id: IssueId, failureRunId: RunId) => updateStage(id, "triage", { failureRunId }),
      );

      const topOfQueued = Effect.fn("IssuesRepo.topOfQueued")(function* () {
        const [row] = yield* db
          .select()
          .from(issues)
          .where(eq(issues.stage, "queued"))
          .orderBy(asc(issues.position), asc(issues.createdAt))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return Option.none<Issue>();
        return Option.some(toIssue(row));
      });

      const countByStage = Effect.fn("IssuesRepo.countByStage")(function* (stage: IssueStage) {
        const [row] = yield* db
          .select({ count: count() })
          .from(issues)
          .where(eq(issues.stage, stage))
          .pipe(Effect.orDie);
        return row?.count ?? 0;
      });

      return {
        create,
        list,
        byId,
        move,
        markMending,
        markReview,
        returnToTriage,
        topOfQueued,
        countByStage,
      };
    }),
  );
