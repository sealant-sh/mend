import type { WorktreeId, ProjectId } from "@mend/domain";
import type { CaptureRuntimeShape } from "@mend/sessions";
import { keysOfSections, treePrefixesOfSections, packIdxKeyOf } from "@mend/store";
import { Data, Effect } from "effect";

/** An object of the project could not be listed or deleted: purge again to finish. */
export class PurgeBlobFailure extends Data.TaggedError("PurgeBlobFailure")<{
  readonly key: string;
}> {}

export const purgeKeys = (
  keys: ReadonlyArray<string>,
  referenced: ReadonlySet<string>,
  trees: ReadonlySet<string>,
): ReadonlyArray<string> =>
  keys.filter(
    (key) => !referenced.has(key) && ![...trees].some((prefix) => key.startsWith(prefix)),
  );

/** `step` runs before every deletion and fails once the purge no longer holds its mark. */
export const purgeProjectBlobs = <E>(
  capture: CaptureRuntimeShape,
  projectId: ProjectId,
  worktrees: ReadonlyArray<WorktreeId>,
  foreignHandoffPacks: ReadonlyArray<string>,
  step: Effect.Effect<void, E>,
): Effect.Effect<void, E | PurgeBlobFailure> =>
  Effect.gen(function* () {
    if (!capture.enabled) return;
    const own = new Set(worktrees);
    const referenced = new Set(foreignHandoffPacks.flatMap((key) => [key, packIdxKeyOf(key)]));
    const trees = new Set<string>();
    // The purge mark fences new references before this inventory. Include removed projects too.
    for (const chain of yield* capture.repo.listChains()) {
      if (own.has(chain.worktreeId)) continue;
      for (const row of yield* capture.repo.listChain(chain.worktreeId)) {
        referenced.add(row.manifestKey);
        for (const key of keysOfSections(row.sections)) referenced.add(key);
        for (const prefix of treePrefixesOfSections(row.sections)) trees.add(prefix);
        const summary = yield* capture.repo.summaryOf(row.id);
        if (summary !== null) referenced.add(summary.key);
      }
    }
    for (const prefix of [
      `projects/${projectId}/`,
      ...worktrees.flatMap((id) => [`captures/${id}/`, `changes/${id}/`]),
    ]) {
      const failed = (key: string) => () => new PurgeBlobFailure({ key });
      const entries = yield* capture.blobs.list(prefix).pipe(Effect.mapError(failed(prefix)));
      const keys = purgeKeys(
        entries.map((entry) => entry.key),
        referenced,
        trees,
      );
      for (const key of keys) {
        yield* step;
        yield* capture.blobs.remove(key).pipe(Effect.mapError(failed(key)));
      }
      for (const upload of yield* capture.blobs
        .listMultipart(prefix)
        .pipe(Effect.mapError(failed(prefix)))) {
        if (purgeKeys([upload.key], referenced, trees).length === 0) continue;
        yield* step;
        yield* capture.blobs
          .abortMultipart(upload.key, upload.uploadId)
          .pipe(Effect.mapError(failed(upload.key)));
      }
    }
  });
