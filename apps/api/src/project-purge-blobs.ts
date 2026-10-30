import { randomUUID } from "node:crypto";

import type { CaptureStoreRepo, RemovalFenceId } from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import { type BlobStore, packIdxKeyOf } from "@mend/store";
import { Clock, Data, Effect } from "effect";

/** An object of the project could not be listed, condemned or deleted: purge again to finish. */
export class PurgeBlobFailure extends Data.TaggedError("PurgeBlobFailure")<{
  readonly key: string;
}> {}

/** An upload URL issued before the removal can still land bytes until `until`. */
export class UploadAuthorityOpen extends Data.TaggedError("UploadAuthorityOpen")<{
  readonly until: Date;
}> {}

interface PurgeStores {
  readonly repo: CaptureStoreRepo["Service"];
  readonly blobs: BlobStore["Service"];
}

/**
 * Fails while an upload URL issued for the worktrees, or the blob store's startup window, could
 * still land bytes. A removed project is issued no new URL, so this only ever moves earlier.
 */
export const uploadsLanded = (capture: PurgeStores, worktrees: ReadonlyArray<WorktreeId>) =>
  Effect.gen(function* () {
    const until = Math.max(
      (yield* capture.repo.putAuthorityUntilFor(worktrees))?.getTime() ?? 0,
      yield* capture.blobs.startupUntil,
    );
    if (until > (yield* Clock.currentTimeMillis))
      return yield* new UploadAuthorityOpen({ until: new Date(until) });
  });

/** Long enough for one group's deletes; renewed before each, like capture retention's. */
const CLAIM_TTL_SECONDS = 60 * 60;

/**
 * Deletes the stored objects only the removed project names (docs/adr/0002, "Retention and
 * compaction"). Nothing goes while an upload URL issued before the removal may still land bytes.
 * Each worktree's objects are tombstoned under its chain's guard, as read before the inventory,
 * so a capture that named one since keeps it, and a later capture naming a deleted one is refused.
 * `step` runs before every deletion and fails once the purge no longer holds its mark.
 */
export const purgeProjectBlobs = <E>(
  capture: PurgeStores,
  purge: { readonly projectId: ProjectId; readonly mark: RemovalFenceId },
  worktrees: ReadonlyArray<WorktreeId>,
  foreignHandoffPacks: ReadonlyArray<string>,
  step: Effect.Effect<void, E>,
): Effect.Effect<void, E | PurgeBlobFailure | UploadAuthorityOpen> =>
  Effect.gen(function* () {
    const { repo, blobs } = capture;
    yield* uploadsLanded(capture, worktrees);

    const failed = (key: string) => () => new PurgeBlobFailure({ key });
    // Guards before references: a capture that names an object after this read moves its guard.
    const chains = yield* repo.listChains();
    const handedOff = new Set(foreignHandoffPacks.flatMap((key) => [key, packIdxKeyOf(key)]));
    /** What no other worktree's capture, summary or handoff still names. */
    const unreferenced = (keys: ReadonlyArray<string>) =>
      Effect.map(
        repo.referencedElsewhere({ projectId: purge.projectId, own: worktrees, keys }),
        (referenced) => keys.filter((key) => !referenced.has(key) && !handedOff.has(key)),
      );

    // The project's own packs have no chain: they are tombstoned under its first worktree's.
    const groups: Array<{
      readonly worktreeId: WorktreeId | null;
      readonly prefixes: ReadonlyArray<string>;
    }> = worktrees.map((worktreeId, index) => ({
      worktreeId,
      prefixes: [
        `captures/${worktreeId}/`,
        `changes/${worktreeId}/`,
        ...(index === 0 ? [`projects/${purge.projectId}/`] : []),
      ],
    }));
    if (groups.length === 0)
      groups.push({ worktreeId: null, prefixes: [`projects/${purge.projectId}/`] });

    for (const group of groups) {
      yield* step;
      const listed = yield* Effect.forEach(group.prefixes, (prefix) =>
        blobs.list(prefix).pipe(Effect.mapError(failed(prefix))),
      );
      const keys = yield* unreferenced(listed.flat().map((entry) => entry.key));
      const guard = chains.find((chain) => chain.worktreeId === group.worktreeId)?.guard;
      const token = `${purge.mark}:${randomUUID()}`;
      const condemned =
        group.worktreeId === null || guard === undefined
          ? true
          : yield* repo.condemnForPurge({
              worktreeId: group.worktreeId,
              guard,
              keys,
              claim: { token, ttlSeconds: CLAIM_TTL_SECONDS },
              projectId: purge.projectId,
              fenceId: purge.mark,
            });
      if (!condemned) return yield* new PurgeBlobFailure({ key: group.prefixes[0] ?? "" });
      const deleted: Array<string> = [];
      yield* Effect.gen(function* () {
        for (const key of keys) {
          yield* step;
          if (guard !== undefined && (yield* repo.renewDeletion(token, CLAIM_TTL_SECONDS)) === 0)
            return yield* new PurgeBlobFailure({ key });
          yield* blobs.remove(key).pipe(Effect.mapError(failed(key)));
          deleted.push(key);
        }
        for (const prefix of group.prefixes) {
          for (const upload of yield* blobs
            .listMultipart(prefix)
            .pipe(Effect.mapError(failed(prefix)))) {
            if ((yield* unreferenced([upload.key])).length === 0) continue;
            yield* step;
            yield* blobs
              .abortMultipart(upload.key, upload.uploadId)
              .pipe(Effect.mapError(failed(upload.key)));
          }
        }
      }).pipe(
        Effect.ensuring(guard === undefined ? Effect.void : repo.finishDeletion(token, deleted)),
      );
    }
  });

/**
 * The bytes of the stored objects under a kept project's prefixes, and of those, the bytes
 * another worktree's captures still name: a purge keeps those. Null when the store cannot list
 * them.
 */
export const keptObjectBytes = (
  capture: PurgeStores,
  projectId: ProjectId,
  worktrees: ReadonlyArray<WorktreeId>,
): Effect.Effect<{ readonly own: number; readonly shared: number } | null> =>
  Effect.gen(function* () {
    const prefixes = [
      `projects/${projectId}/`,
      ...worktrees.flatMap((tree) => [`captures/${tree}/`, `changes/${tree}/`]),
    ];
    const entries = (yield* Effect.forEach(prefixes, (prefix) =>
      capture.blobs.list(prefix),
    )).flat();
    const shared = yield* capture.repo.referencedElsewhere({
      projectId,
      own: worktrees,
      keys: entries.map((entry) => entry.key),
    });
    const bytesOf = (counted: (key: string) => boolean) =>
      entries.reduce((total, entry) => total + (counted(entry.key) ? entry.size : 0), 0);
    return { own: bytesOf(() => true), shared: bytesOf((key) => shared.has(key)) };
  }).pipe(Effect.catchTag("BlobStoreError", () => Effect.succeed(null)));
