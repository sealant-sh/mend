import { PgClient } from "@effect/sql-pg";
import type { OrganizationId } from "@mend/domain";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { MendDB } from "../client.ts";
import { executorInstances } from "../schema/workbench.ts";

/** Private retained-service state; never sent to a browser or workspace. */
export type ExecutorInstanceRow = typeof executorInstances.$inferSelect;

/** Lifecycle serialization uses a session lock, keeping each state write committed before I/O. */
export class ExecutorInstancesRepo extends Context.Service<
  ExecutorInstancesRepo,
  {
    readonly get: (organizationId: OrganizationId) => Effect.Effect<ExecutorInstanceRow | null>;
    readonly save: (row: ExecutorInstanceRow) => Effect.Effect<void>;
    readonly remove: (organizationId: OrganizationId) => Effect.Effect<void>;
    readonly withLock: <A, E, R>(
      organizationId: OrganizationId,
      body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@mend/db/ExecutorInstancesRepo") {}

/** Database-backed lifecycle state and a cross-process, automatically released advisory lock. */
export const ExecutorInstancesRepoLive: Layer.Layer<
  ExecutorInstancesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ExecutorInstancesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;
    return ExecutorInstancesRepo.of({
      get: (organizationId) =>
        db
          .select()
          .from(executorInstances)
          .where(eq(executorInstances.organizationId, organizationId))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows[0] ?? null),
          ),
      save: (row) =>
        db
          .insert(executorInstances)
          .values(row)
          .onConflictDoUpdate({ target: executorInstances.organizationId, set: row })
          .pipe(Effect.orDie, Effect.asVoid),
      remove: (organizationId) =>
        db
          .delete(executorInstances)
          .where(eq(executorInstances.organizationId, organizationId))
          .pipe(Effect.orDie, Effect.asVoid),
      withLock: (organizationId, body) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* pg.reserve.pipe(Effect.orDie);
            const key = `mend:Executor:organization:${organizationId}`;
            yield* Effect.acquireRelease(
              connection
                .executeRaw("select pg_advisory_lock(hashtextextended($1, 0))", [key])
                .pipe(Effect.orDie),
              () =>
                connection
                  .executeRaw("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
                  .pipe(Effect.orDie),
            );
            return yield* body;
          }),
        ),
    });
  }),
);
