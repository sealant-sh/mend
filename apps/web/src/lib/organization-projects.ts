import { sizeWords } from "./byte-size.ts";

/**
 * Settings → the organization → Projects (owners only; the owner's ruling of 18 Nov 2026): the
 * projects whose creator left the organization, which an owner takes over, and the resource
 * volumes Mend kept from removed projects, which have no actions. What each row says, from what the
 * server answers.
 */

/** `14 Sep`, with the year when it isn't this year's. */
export const dayWords = (at: Date, now: Date): string =>
  at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

/** What a project without a creator is, by its visibility. */
export const orphanLine = (visibility: "private" | "shared", organization: string): string =>
  visibility === "private"
    ? "Private. Only its creator could open it."
    : `Shared with everyone in ${organization}.`;

/** What taking a project over leaves it as, said in its confirmation. */
export const takeOverNote = (
  project: { readonly name: string; readonly visibility: "private" | "shared" },
  organization: string,
): string =>
  project.visibility === "private"
    ? `${project.name} stays private, so only you can open it until you share it with ${organization}.`
    : `${project.name} stays shared with everyone in ${organization}.`;

/** The toast once a project is taken over. */
export const takenOverWords = (name: string): string =>
  `You're now the creator of ${name}. It's in your projects.`;

interface ArchivedVolume {
  readonly resourceName: string;
  readonly name: string;
  readonly dockerName: string;
  readonly bytes: number | null;
}

interface ResourceArchive {
  readonly projectId: string;
  readonly projectName: string;
  readonly archivedAt: Date;
  readonly volumes: ReadonlyArray<ArchivedVolume>;
}

/** One row of Kept resources: a volume, or a removed project that declared none. */
export interface KeptRow {
  readonly key: string;
  readonly project: string;
  /** `@db · pgdata`, or null when the project declared no volumes. */
  readonly volume: string | null;
  readonly dockerName: string | null;
  /** `1.2 GB`, `Not measured`, or null when there is no volume to measure. */
  readonly size: string | null;
  readonly keptSince: Date;
}

/** One row per kept volume, newest removal first; a project that declared none gets one row. */
export const keptRows = (archives: ReadonlyArray<ResourceArchive>): ReadonlyArray<KeptRow> =>
  archives
    .toSorted((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime())
    .flatMap(
      (archive): ReadonlyArray<KeptRow> =>
        archive.volumes.length === 0
          ? [
              {
                key: archive.projectId,
                project: archive.projectName,
                volume: null,
                dockerName: null,
                size: null,
                keptSince: archive.archivedAt,
              },
            ]
          : archive.volumes.map((volume) => ({
              key: `${archive.projectId}:${volume.dockerName}`,
              project: archive.projectName,
              volume: `@${volume.resourceName} · ${volume.name}`,
              dockerName: volume.dockerName,
              size: volume.bytes === null ? "Not measured" : sizeWords(volume.bytes),
              keptSince: archive.archivedAt,
            })),
    );
