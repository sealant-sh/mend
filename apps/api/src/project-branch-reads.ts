import { WorktreesRepo } from "@mend/db";
import type { Project } from "@mend/domain/workbench";
import { WorktreeReads } from "@mend/sessions";
import { Store } from "@mend/store";
import { Effect } from "effect";

/** Project refs plus named workspace branches, observed from the same authority as creation. */
export const listProjectBranches = Effect.fn("listProjectBranches")(function* (project: Project) {
  const store = yield* Store;
  const branches = yield* store.listBranches(project.storePath);
  const worktrees = yield* (yield* WorktreesRepo).listForProject(project.id);
  const reads = yield* WorktreeReads;
  const byName = new Map(branches.map((branch) => [branch.name, branch]));
  for (const worktree of worktrees) {
    // The shared default branch belongs to the project authority. A workspace's checkout may
    // predate a project refresh; it must not replace that newer default in the picker.
    if (worktree.branch === project.defaultBranch) continue;
    const saved = yield* reads.listBranches(project.id, worktree.id).pipe(
      Effect.map((result) => result.value),
      // A newly provisioned worktree may have no capture yet. A stale verified capture is never
      // substituted for a failed newest capture by the reader's exact-head policy.
      Effect.catchTag("WorktreeNotCapturedError", () => Effect.succeed([])),
    );
    const branch = saved.find((row) => row.name === worktree.branch);
    if (branch !== undefined) byName.set(branch.name, { ...branch, isDefault: false });
  }
  return [...byName.values()].toSorted((a, b) => b.committedAt.localeCompare(a.committedAt));
});
