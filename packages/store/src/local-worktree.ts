import * as path from "node:path";

import { Sha } from "@mend/domain";
import { Effect } from "effect";

import { git, GitError } from "./git.ts";
import type { SessionWorktree } from "./store.ts";

/**
 * Check out the existing default branch without moving its ref. Retrying after creation keeps
 * the same checkout and its edits. A different checkout holding the branch is always refused.
 */
export const createLocalWorktree = Effect.fn("Store.createLocalWorktree")(function* (
  storePath: string,
  directory: string,
  branch: string,
): Effect.fn.Return<SessionWorktree, GitError> {
  const target = path.join(path.dirname(storePath), "worktrees", directory);
  const listed = yield* git(["worktree", "list", "--porcelain", "-z"], storePath);
  let checkedOut: string | null = null;
  let here: string | null = null;
  for (const field of listed.split("\0")) {
    if (field.startsWith("worktree ")) here = field.slice(9);
    if (field === `branch refs/heads/${branch}`) checkedOut = here;
  }
  if (checkedOut !== null && checkedOut !== target) {
    return yield* new GitError({
      args: ["worktree", "add"],
      cwd: storePath,
      exitCode: null,
      stderr: `Local cannot start: branch "${branch}" is already checked out at ${checkedOut}. Switch that checkout to another branch before starting Local. Mend has left it unchanged.`,
    });
  }
  const baseSha = Sha.make(
    yield* git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], storePath),
  );
  if (checkedOut === null) yield* git(["worktree", "add", "--", target, branch], storePath);
  return { path: target, name: directory, branch, baseSha, baseRef: branch };
});
