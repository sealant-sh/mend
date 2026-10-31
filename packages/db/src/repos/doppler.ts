import type { ProjectId } from "@mend/domain";
import { DopplerMapping, type DopplerSelection } from "@mend/domain/workbench";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userDopplerConnections, userDopplerProjects } from "../schema/workbench.ts";

const Connection = Schema.Struct({ sealedToken: Schema.String, updatedAt: Schema.Date });
export class DopplerRepo extends Context.Service<
  DopplerRepo,
  {
    readonly connection: (userId: string) => Effect.Effect<typeof Connection.Type | null>;
    readonly save: (userId: string, sealedToken: string) => Effect.Effect<void>;
    readonly disconnect: (userId: string) => Effect.Effect<boolean>;
    readonly mappings: (userId: string) => Effect.Effect<ReadonlyArray<DopplerMapping>>;
    readonly use: (
      userId: string,
      projectId: ProjectId,
      selection: DopplerSelection,
    ) => Effect.Effect<void>;
    readonly removeMapping: (userId: string, projectId: ProjectId) => Effect.Effect<boolean>;
  }
>()("@mend/db/DopplerRepo") {}

const makeDopplerRepo: Effect.Effect<DopplerRepo["Service"], never, MendDB> = Effect.gen(
  function* () {
    const db = yield* MendDB;
    return {
      connection: Effect.fn("DopplerRepo.connection")(function* (userId: string) {
        const [row] = yield* db
          .select()
          .from(userDopplerConnections)
          .where(eq(userDopplerConnections.userId, userId))
          .pipe(Effect.orDie);
        return row === undefined
          ? null
          : yield* Schema.decodeUnknownEffect(Connection)(row).pipe(Effect.orDie);
      }),
      save: Effect.fn("DopplerRepo.save")(function* (userId: string, sealedToken: string) {
        yield* db
          .insert(userDopplerConnections)
          .values({ userId, sealedToken })
          .onConflictDoUpdate({
            target: userDopplerConnections.userId,
            set: { sealedToken, updatedAt: new Date() },
          })
          .pipe(Effect.orDie);
      }),
      disconnect: Effect.fn("DopplerRepo.disconnect")(function* (userId: string) {
        const rows = yield* db
          .delete(userDopplerConnections)
          .where(eq(userDopplerConnections.userId, userId))
          .returning()
          .pipe(Effect.orDie);
        return rows.length > 0;
      }),
      mappings: Effect.fn("DopplerRepo.mappings")(function* (userId: string) {
        const rows = yield* db
          .select()
          .from(userDopplerProjects)
          .where(eq(userDopplerProjects.userId, userId))
          .pipe(Effect.orDie);
        return yield* Schema.decodeUnknownEffect(Schema.Array(DopplerMapping))(rows).pipe(
          Effect.orDie,
        );
      }),
      use: Effect.fn("DopplerRepo.use")(function* (
        userId: string,
        projectId: ProjectId,
        selection: DopplerSelection,
      ) {
        yield* db
          .insert(userDopplerProjects)
          .values({ userId, projectId, ...selection })
          .onConflictDoUpdate({
            target: [userDopplerProjects.userId, userDopplerProjects.projectId],
            set: selection,
          })
          .pipe(Effect.orDie);
      }),
      removeMapping: Effect.fn("DopplerRepo.removeMapping")(function* (
        userId: string,
        projectId: ProjectId,
      ) {
        return (
          (yield* db
            .delete(userDopplerProjects)
            .where(
              and(
                eq(userDopplerProjects.userId, userId),
                eq(userDopplerProjects.projectId, projectId),
              ),
            )
            .returning()
            .pipe(Effect.orDie)).length > 0
        );
      }),
    };
  },
);

/** Ciphertext only, with every query constrained to the caller or launch person. */
export const DopplerRepoLive: Layer.Layer<DopplerRepo, never, MendDB> = Layer.effect(
  DopplerRepo,
  makeDopplerRepo,
);
