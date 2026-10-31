import type { OrganizationId, ProjectId } from "@mend/domain";
import { ArchivedResourceVolume, ResourceArchive } from "@mend/domain/workbench";
import { and, desc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { resourceArchives } from "../schema/workbench.ts";

/** A saved inventory and whether Sealant's archive has finished. */
export interface StoredResourceArchive {
  readonly archive: ResourceArchive;
  readonly complete: boolean;
}

/** Durable archive inventory. Project ids are natural keys; these rows never cascade with a project. */
export class ResourceArchivesRepo extends Context.Service<
  ResourceArchivesRepo,
  {
    readonly byProject: (projectId: ProjectId) => Effect.Effect<StoredResourceArchive | null>;
    /** Writes the inventory once, before any container is archived. */
    readonly begin: (archive: ResourceArchive) => Effect.Effect<void>;
    /** Saves the kept volumes before the store purge is allowed to proceed. */
    readonly finish: (
      projectId: ProjectId,
      volumes: ReadonlyArray<ArchivedResourceVolume>,
    ) => Effect.Effect<void>;
    readonly list: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<ResourceArchive>>;
  }
>()("@mend/db/ResourceArchivesRepo") {}

const decode = Schema.decodeUnknownEffect(ResourceArchive);
const encodeVolumes = Schema.encodeEffect(Schema.Array(ArchivedResourceVolume));

/** PostgreSQL archive inventory, with no transaction held across platform calls. */
export const ResourceArchivesRepoLive: Layer.Layer<ResourceArchivesRepo, never, MendDB> =
  Layer.effect(
    ResourceArchivesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const byProject = Effect.fn("ResourceArchivesRepo.byProject")(function* (
        projectId: ProjectId,
      ) {
        const [row] = yield* db
          .select()
          .from(resourceArchives)
          .where(eq(resourceArchives.projectId, projectId))
          .pipe(Effect.orDie);
        return row === undefined
          ? null
          : { archive: yield* decode(row).pipe(Effect.orDie), complete: row.complete };
      });
      const begin = Effect.fn("ResourceArchivesRepo.begin")(function* (archive: ResourceArchive) {
        const volumes = yield* encodeVolumes(archive.volumes).pipe(Effect.orDie);
        yield* db
          .insert(resourceArchives)
          .values({ ...archive, volumes, complete: false })
          .onConflictDoNothing()
          .pipe(Effect.orDie);
      });
      const finish = Effect.fn("ResourceArchivesRepo.finish")(function* (
        projectId: ProjectId,
        volumes: ReadonlyArray<ArchivedResourceVolume>,
      ) {
        const encoded = yield* encodeVolumes(volumes).pipe(Effect.orDie);
        yield* db
          .update(resourceArchives)
          .set({ volumes: encoded, complete: true })
          .where(eq(resourceArchives.projectId, projectId))
          .pipe(Effect.orDie);
      });
      const list = Effect.fn("ResourceArchivesRepo.list")(function* (
        organizationId: OrganizationId,
      ) {
        const rows = yield* db
          .select()
          .from(resourceArchives)
          .where(
            and(
              eq(resourceArchives.organizationId, organizationId),
              eq(resourceArchives.complete, true),
            ),
          )
          .orderBy(desc(resourceArchives.archivedAt), desc(resourceArchives.projectId))
          .pipe(Effect.orDie);
        return yield* Effect.forEach(rows, (row) => decode(row).pipe(Effect.orDie));
      });
      return { byProject, begin, finish, list };
    }),
  );
