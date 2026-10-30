import type { WorktreeId, ProjectId } from "@mend/domain";
import type { CaptureRuntimeShape } from "@mend/sessions";
import { keysOfSections, treePrefixesOfSections, packIdxKeyOf } from "@mend/store";
import { Effect } from "effect";

export const purgeKeys = (
  keys: ReadonlyArray<string>,
  referenced: ReadonlySet<string>,
  trees: ReadonlySet<string>,
): ReadonlyArray<string> =>
  keys.filter(
    (key) => !referenced.has(key) && ![...trees].some((prefix) => key.startsWith(prefix)),
  );

export const purgeProjectBlobs = Effect.fn("purgeProjectBlobs")(function* (
  capture: CaptureRuntimeShape,
  projectId: ProjectId,
  worktrees: ReadonlyArray<WorktreeId>,
  foreignHandoffPacks: ReadonlyArray<string>,
) {
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
    const entries = yield* capture.blobs.list(prefix);
    const keys = purgeKeys(
      entries.map((entry) => entry.key),
      referenced,
      trees,
    );
    for (const key of keys) yield* capture.blobs.remove(key);
    for (const upload of yield* capture.blobs.listMultipart(prefix)) {
      if (purgeKeys([upload.key], referenced, trees).length > 0)
        yield* capture.blobs.abortMultipart(upload.key, upload.uploadId);
    }
  }
});
