import { ProjectId, ResourceDefinitionId, ResourceLoadId, WorktreeId } from "@mend/domain";
import { loadCanAdvance, ResourceLoadPhase } from "@mend/domain/workbench";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { resourceLoads } from "../schema/workbench.ts";

/** A durable attempt. Source credentials have no column. Database names derive from its id. */
export const StoredResourceLoad = Schema.Struct({
  id: ResourceLoadId,
  projectId: ProjectId,
  definitionId: ResourceDefinitionId,
  worktreeId: Schema.NullOr(WorktreeId),
  instanceKey: Schema.String,
  database: Schema.String,
  target: Schema.Literals(["shared", "own"]),
  label: Schema.String,
  startedBy: Schema.String,
  phase: ResourceLoadPhase,
  bytesDone: Schema.Number,
  bytesTotal: Schema.NullOr(Schema.Number),
  savedPath: Schema.NullOr(Schema.String),
  savedAt: Schema.NullOr(Schema.Date),
  message: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
});
export type StoredResourceLoad = typeof StoredResourceLoad.Type;

export class ResourceLoadBusy extends Schema.TaggedError<ResourceLoadBusy>()("ResourceLoadBusy", {
  message: Schema.String,
}) {}

/** Persists the load state machine, and arbitrates one live attempt per instance and database. */
export class ResourceLoadsRepo extends Context.Service<
  ResourceLoadsRepo,
  {
    readonly begin: (
      row: StoredResourceLoad,
    ) => Effect.Effect<StoredResourceLoad, ResourceLoadBusy>;
    readonly get: (id: ResourceLoadId) => Effect.Effect<StoredResourceLoad | null>;
    readonly latest: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<StoredResourceLoad>>;
    readonly live: () => Effect.Effect<ReadonlyArray<StoredResourceLoad>>;
    readonly advance: (
      row: StoredResourceLoad,
      phase: ResourceLoadPhase,
      patch?: { readonly message?: string; readonly savedPath?: string; readonly savedAt?: Date },
    ) => Effect.Effect<void>;
    readonly progress: (id: ResourceLoadId, bytes: number) => Effect.Effect<void>;
  }
>()("@mend/db/ResourceLoadsRepo") {}

const decode = Schema.decodeUnknownEffect(StoredResourceLoad);
const LIVE: ReadonlyArray<ResourceLoadPhase> = [
  "receiving",
  "pulling",
  "restoring",
  "installing",
  "saving",
];

export const ResourceLoadsRepoLive: Layer.Layer<ResourceLoadsRepo, never, MendDB> = Layer.effect(
  ResourceLoadsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    return ResourceLoadsRepo.of({
      begin: (row) =>
        Effect.gen(function* () {
          const written = yield* db
            .insert(resourceLoads)
            .values(row)
            .onConflictDoNothing()
            .returning()
            .pipe(Effect.orDie);
          if (written.length === 0)
            return yield* new ResourceLoadBusy({
              message: "a load into this database is already running",
            });
          return row;
        }),
      get: (id) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select()
            .from(resourceLoads)
            .where(eq(resourceLoads.id, id))
            .pipe(Effect.orDie);
          return row === undefined ? null : yield* decode(row).pipe(Effect.orDie);
        }),
      latest: (projectId) =>
        db
          .select()
          .from(resourceLoads)
          .where(eq(resourceLoads.projectId, projectId))
          .orderBy(desc(resourceLoads.createdAt), desc(resourceLoads.id))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row).pipe(Effect.orDie))),
            Effect.map((rows) => {
              const seen = new Set<string>();
              return rows.filter((row) => {
                const key = `${row.instanceKey}:${row.database}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            }),
          ),
      live: () =>
        db
          .select()
          .from(resourceLoads)
          .where(inArray(resourceLoads.phase, LIVE))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row).pipe(Effect.orDie))),
          ),
      advance: (row, phase, patch) => {
        if (!loadCanAdvance(row.phase, phase))
          return Effect.die(new Error(`invalid load transition ${row.phase} to ${phase}`));
        return db
          .update(resourceLoads)
          .set({ phase, ...patch })
          .where(and(eq(resourceLoads.id, row.id), eq(resourceLoads.phase, row.phase)))
          .pipe(Effect.orDie, Effect.asVoid);
      },
      progress: (id, bytesDone) =>
        db
          .update(resourceLoads)
          .set({ bytesDone })
          .where(
            and(eq(resourceLoads.id, id), inArray(resourceLoads.phase, ["receiving", "pulling"])),
          )
          .pipe(Effect.orDie, Effect.asVoid),
    });
  }),
);
