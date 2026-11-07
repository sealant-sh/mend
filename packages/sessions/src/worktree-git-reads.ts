import { WorktreeGitRefused, type Worktree, type WorktreeBranchRef } from "@mend/domain/workbench";
import { bytesOfKey, git, type RunnerCache } from "@mend/store";
import { Effect } from "effect";

import { SessionRepository } from "./session-repository.ts";
import { ensureCaptureCache } from "./worktree-reads.ts";

/** Decode local/remote heads without hiding session branches or exposing internal checkpoint refs. */
const refsOf = (
  rows: ReadonlyArray<{ readonly ref: string; readonly upstreamRef: string | null }>,
  head: string,
): ReadonlyArray<WorktreeBranchRef> =>
  rows.flatMap((row) => {
    const isRemote = row.ref.startsWith("refs/remotes/");
    if (!isRemote && !row.ref.startsWith("refs/heads/")) return [];
    const name = row.ref.slice(isRemote ? "refs/remotes/".length : "refs/heads/".length);
    if (name.length === 0 || (isRemote && name.endsWith("/HEAD"))) return [];
    return [{ name, isRemote, current: row.ref === head, upstreamRef: row.upstreamRef }];
  });

/** A capture handle carries its own immutable ref view even if a later capture reused the cache. */
export const capturedBranchRefs = (
  cache: Pick<RunnerCache, "refs" | "head">,
): ReadonlyArray<WorktreeBranchRef> =>
  refsOf(
    Object.keys(cache.refs).map((key) => ({
      ref: bytesOfKey(key).toString("utf8"),
      upstreamRef: null,
    })),
    bytesOfKey(cache.head).toString("utf8"),
  );

/** Read Git beside the files, with the same trust configuration as ordinary change/diff reads. */
export const localBranchRefs = (
  directory: string,
): Effect.Effect<ReadonlyArray<WorktreeBranchRef>, import("@mend/store").GitError> =>
  Effect.gen(function* () {
    const output = yield* git(
      ["for-each-ref", "--format=%(refname)%09%(upstream)", "refs/heads/", "refs/remotes/"],
      directory,
    );
    const head = (yield* git(
      ["symbolic-ref", "--quiet", "HEAD"],
      directory,
      undefined,
      [0, 1],
    )).trim();
    return refsOf(
      output
        .trim()
        .split("\n")
        .flatMap((line) => {
          const [ref, upstream] = line.split("\t");
          return ref === undefined || ref === "" ? [] : [{ ref, upstreamRef: upstream || null }];
        }),
      head,
    );
  });

/** Read a worktree's own refs without launching a workspace or an agent turn. */
export const readWorktreeBranchRefs = Effect.fn("readWorktreeBranchRefs")(
  function* (worktree: Worktree) {
    const authority = yield* SessionRepository;
    const mount = yield* authority.worktreeMount(worktree.projectId, worktree.directory);
    if (mount !== undefined) return yield* localBranchRefs(mount);
    return capturedBranchRefs((yield* ensureCaptureCache(worktree.projectId, worktree.id)).cache);
  },
  Effect.mapError(
    () =>
      new WorktreeGitRefused({
        code: "unavailable",
        message: "Mend could not read this worktree's saved branches. Refresh and try again.",
      }),
  ),
);
