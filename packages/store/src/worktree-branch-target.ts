import { Sha } from "@mend/domain";
import type { WorktreeBranchTarget } from "@mend/domain/workbench";
import { Effect } from "effect";

import { git, GitError } from "./git.ts";

/** A named branch selection, resolved before any ref or worktree is written. */
export interface ResolvedWorktreeBranchTarget {
  readonly branch: string;
  readonly sha: Sha;
  readonly source: string;
  readonly create: boolean;
  readonly upstream: string | null;
}

/** Resolve native local/remote checkout rules against the project authority's known refs. */
export const resolveWorktreeBranchTarget = (
  directory: string,
  target: WorktreeBranchTarget,
  retainedRefs: Readonly<Record<string, string>> = {},
): Effect.Effect<ResolvedWorktreeBranchTarget, GitError> =>
  Effect.gen(function* () {
    const refuse = (stderr: string) =>
      new GitError({ args: ["worktree", "add"], cwd: directory, exitCode: null, stderr });
    const validate = (name: string, branch = true) =>
      Effect.gen(function* () {
        if (!name || name.startsWith("-") || name.includes("\0") || name.length > 1024)
          return yield* refuse("Choose a valid named Git branch.");
        if (branch) yield* git(["check-ref-format", "--branch", name], directory);
      });
    yield* validate(target.refName, false);
    if (target.newRefName !== undefined) yield* validate(target.newRefName);
    const at = (ref: string) =>
      retainedRefs[ref] !== undefined
        ? Effect.succeed(retainedRefs[ref] ?? "")
        : git(["rev-parse", "--verify", "--quiet", ref], directory, undefined, [0, 1]);
    const local = yield* at(`refs/heads/${target.refName}`);
    const remote = local ? "" : yield* at(`refs/remotes/${target.refName}`);
    const head = local || remote;
    if (!head && target.newRefName === undefined)
      return yield* refuse(
        "Choose an existing named branch. This worktree cannot start at a detached ref.",
      );
    const source = `${local ? "refs/heads/" : "refs/remotes/"}${target.refName}`;
    const commit =
      head || (yield* git(["rev-parse", "--verify", `${target.refName}^{commit}`], directory));
    // Ref rows without retained objects cannot be made into a recoverable capture 0.
    yield* git(["cat-file", "-e", `${commit}^{commit}`], directory);
    if (target.newRefName !== undefined) {
      if (yield* at(`refs/heads/${target.newRefName}`))
        return yield* refuse(`Branch "${target.newRefName}" already exists. Choose another name.`);
      return {
        branch: target.newRefName,
        sha: Sha.make(commit),
        source,
        create: true,
        upstream: null,
      };
    }
    if (local)
      return { branch: target.refName, sha: Sha.make(head), source, create: false, upstream: null };
    const tracking = (yield* git(
      ["for-each-ref", "--format=%(refname:short)%09%(upstream)", "refs/heads/"],
      directory,
    ))
      .split("\n")
      .map((row) => row.split("\t"))
      .find((row) => row[1] === source)?.[0];
    if (tracking)
      return {
        branch: tracking,
        sha: Sha.make(yield* at(`refs/heads/${tracking}`)),
        source,
        create: false,
        upstream: null,
      };
    const branch = target.refName.slice(target.refName.indexOf("/") + 1);
    yield* validate(branch);
    if (yield* at(`refs/heads/${branch}`))
      return yield* refuse(
        "A local branch with that name already exists. Choose it or rename it before selecting this remote branch.",
      );
    return { branch, sha: Sha.make(head), source, create: true, upstream: source };
  });
