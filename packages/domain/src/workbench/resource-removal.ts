import { Schema } from "effect";

import { OrganizationId, ProjectId, ResourceDefinitionId, WorktreeId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** A volume kept after removal. Null bytes means its size could not be measured. */
export const ArchivedResourceVolume = Schema.Struct({
  instanceKey: Schema.String,
  resourceName: Schema.String,
  name: Schema.String,
  dockerName: Schema.String,
  bytes: Schema.NullOr(Schema.Number),
});
export type ArchivedResourceVolume = typeof ArchivedResourceVolume.Type;

/** An inventory kept independently of the project and its store, including across a retried purge. */
export const ResourceArchive = Schema.Struct({
  organizationId: OrganizationId,
  projectId: ProjectId,
  projectName: Schema.String,
  createdByUserId: Schema.NullOr(Schema.String),
  archivedAt: Timestamp,
  volumes: Schema.Array(ArchivedResourceVolume),
});
export type ResourceArchive = typeof ResourceArchive.Type;

/** Durable progress for one own database. A reserved dump path survives every retry. */
export interface OwnDatabaseRemoval {
  readonly worktreeId: WorktreeId;
  readonly definitionId: ResourceDefinitionId;
  readonly purpose: "own" | "base";
  readonly dumpName: string | null;
  readonly dumpAt: Date | null;
  readonly checkedAt: Date | null;
  readonly removedAt: Date | null;
}

/** Completed measurements replace the inventory's unknown sizes without losing earlier volumes. */
export const mergeArchivedVolumes = (
  inventory: ReadonlyArray<ArchivedResourceVolume>,
  measured: ReadonlyArray<ArchivedResourceVolume>,
): ReadonlyArray<ArchivedResourceVolume> => {
  const byName = new Map(inventory.map((volume) => [volume.dockerName, volume]));
  for (const volume of measured) {
    const previous = byName.get(volume.dockerName);
    byName.set(volume.dockerName, { ...volume, bytes: volume.bytes ?? previous?.bytes ?? null });
  }
  return [...byName.values()].toSorted((a, b) => a.dockerName.localeCompare(b.dockerName));
};
