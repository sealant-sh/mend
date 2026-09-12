import { PgClient } from "@effect/sql-pg";
import type { ProjectId, Sha } from "@mend/domain";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * Project refs in capture mode (docs/adr/0002-session-capture-store.md): `refs/heads/*`,
 * `refs/remotes/origin/*`, `refs/mend/base/*`, written only by Mend. Every move is a versioned
 * compare-and-swap in one statement; executors hold no statement and no URL that can move one.
 */

export interface StoreRef {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly sha: Sha;
  readonly version: number;
  readonly updatedAt: Date;
}

/** The ref moved (or appeared) since `seenVersion`; re-read and decide again. */
export class StoreRefConflictError extends Schema.TaggedErrorClass<StoreRefConflictError>()(
  "StoreRefConflictError",
  { projectId: Schema.String, name: Schema.String, seenVersion: Schema.NullOr(Schema.Int) },
) {}

export class StoreRefsRepo extends Context.Service<
  StoreRefsRepo,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<StoreRef>>;
    readonly get: (projectId: ProjectId, name: string) => Effect.Effect<StoreRef | null>;
    /**
     * Move `name` to `sha` if it still stands at `seenVersion` (null = must not exist yet).
     * Returns the new row; fails `StoreRefConflictError` when the version does not match.
     */
    readonly set: (
      projectId: ProjectId,
      name: string,
      sha: Sha,
      seenVersion: number | null,
    ) => Effect.Effect<StoreRef, StoreRefConflictError>;
    /** Delete `name` if it still stands at `seenVersion`. */
    readonly remove: (
      projectId: ProjectId,
      name: string,
      seenVersion: number,
    ) => Effect.Effect<void, StoreRefConflictError>;
    /** The refs as a `{ name: sha }` map — what the runner writes into `packed-refs`. */
    readonly refsMap: (projectId: ProjectId) => Effect.Effect<Readonly<Record<string, string>>>;
  }
>()("@mend/db/StoreRefsRepo") {}

interface StoreRefRecord {
  readonly project_id: ProjectId;
  readonly name: string;
  readonly sha: Sha;
  readonly version: number;
  readonly updated_at: Date;
}

const toStoreRef = (row: StoreRefRecord): StoreRef => ({
  projectId: row.project_id,
  name: row.name,
  sha: row.sha,
  version: Number(row.version),
  updatedAt: row.updated_at,
});

export const StoreRefsRepoLive: Layer.Layer<StoreRefsRepo, never, PgClient.PgClient> = Layer.effect(
  StoreRefsRepo,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const list = Effect.fn("StoreRefsRepo.list")(function* (projectId: ProjectId) {
      const rows = yield* sql<StoreRefRecord>`
          SELECT project_id, name, sha, version, updated_at
            FROM store_refs WHERE project_id = ${projectId}
           ORDER BY name`.pipe(Effect.orDie);
      return rows.map(toStoreRef);
    });

    const get = Effect.fn("StoreRefsRepo.get")(function* (projectId: ProjectId, name: string) {
      const [row] = yield* sql<StoreRefRecord>`
          SELECT project_id, name, sha, version, updated_at
            FROM store_refs WHERE project_id = ${projectId} AND name = ${name}`.pipe(Effect.orDie);
      return row === undefined ? null : toStoreRef(row);
    });

    const set = Effect.fn("StoreRefsRepo.set")(function* (
      projectId: ProjectId,
      name: string,
      sha: Sha,
      seenVersion: number | null,
    ) {
      const rows =
        seenVersion === null
          ? yield* sql<StoreRefRecord>`
                INSERT INTO store_refs (project_id, name, sha)
                VALUES (${projectId}, ${name}, ${sha})
                ON CONFLICT (project_id, name) DO NOTHING
                RETURNING project_id, name, sha, version, updated_at`.pipe(Effect.orDie)
          : yield* sql<StoreRefRecord>`
                UPDATE store_refs
                   SET sha = ${sha}, version = version + 1, updated_at = now()
                 WHERE project_id = ${projectId} AND name = ${name} AND version = ${seenVersion}
                 RETURNING project_id, name, sha, version, updated_at`.pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) {
        return yield* new StoreRefConflictError({ projectId, name, seenVersion });
      }
      return toStoreRef(row);
    });

    const remove = Effect.fn("StoreRefsRepo.remove")(function* (
      projectId: ProjectId,
      name: string,
      seenVersion: number,
    ) {
      const rows = yield* sql<{ readonly name: string }>`
          DELETE FROM store_refs
           WHERE project_id = ${projectId} AND name = ${name} AND version = ${seenVersion}
           RETURNING name`.pipe(Effect.orDie);
      if (rows.length === 0) {
        return yield* new StoreRefConflictError({ projectId, name, seenVersion });
      }
    });

    const refsMap = Effect.fn("StoreRefsRepo.refsMap")(function* (projectId: ProjectId) {
      const refs = yield* list(projectId);
      return Object.fromEntries(refs.map((ref) => [ref.name, ref.sha]));
    });

    return { list, get, set, remove, refsMap };
  }),
);
