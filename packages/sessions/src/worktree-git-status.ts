import { WorktreeGitRefused, type Worktree, type WorktreeGitStatus } from "@mend/domain/workbench";
import { git, GitOpsRunner, indexTreeOf, type GitError } from "@mend/store";
import { Effect } from "effect";

import { SessionRepository } from "./session-repository.ts";
import { ensureCaptureCache } from "./worktree-reads.ts";

const statusOf = (files: WorktreeGitStatus["files"]): WorktreeGitStatus => ({
  dirty: files.length > 0,
  files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
  insertions: files.reduce((total, file) => total + file.insertions, 0),
  deletions: files.reduce((total, file) => total + file.deletions, 0),
});

/** Pinned T3's porcelain-v2 paths and diff-index counts; no filters, staging or index writes. */
export const localWorktreeGitStatus = (
  directory: string,
): Effect.Effect<WorktreeGitStatus, GitError> =>
  Effect.gen(function* () {
    const env = { GIT_OPTIONAL_LOCKS: "0" };
    const raw = yield* git(["status", "--porcelain=2", "-z", "--no-ahead-behind"], directory, env);
    const hasHead =
      (yield* git(["rev-parse", "--verify", "--quiet", "HEAD"], directory, env, [0, 1])).length > 0;
    const counts = hasHead
      ? yield* git(["diff-index", "-M", "--numstat", "-z", "HEAD", "--"], directory, env)
      : (yield* git(["diff-files", "--numstat", "-z"], directory, env)) +
        "\0" +
        (yield* git(["diff", "--cached", "--numstat", "-z"], directory, env));
    const files = new Map<string, { path: string; insertions: number; deletions: number }>();
    const fields = counts.split("\0");
    for (let index = 0; index < fields.length; index++) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index] ?? "");
      if (!match) continue;
      let path = match[3];
      if (path === "") {
        index++;
        path = fields[++index];
      }
      if (path === undefined) continue;
      const previous = files.get(path);
      files.set(path, {
        path,
        insertions: (previous?.insertions ?? 0) + (match[1] === "-" ? 0 : Number(match[1])),
        deletions: (previous?.deletions ?? 0) + (match[2] === "-" ? 0 : Number(match[2])),
      });
    }
    const positions: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10, "?": 1 };
    const records = raw.split("\0");
    const include = (path: string) => {
      if (path.length > 0 && !files.has(path))
        files.set(path, { path, insertions: 0, deletions: 0 });
    };
    for (let index = 0; index < records.length; index++) {
      const record = records[index] ?? "";
      const position = positions[record[0] ?? ""];
      if (position === undefined) continue;
      include(record.split(" ").slice(position).join(" "));
      if (record.startsWith("2 ")) include(records[++index] ?? "");
    }
    return statusOf([...files.values()]);
  });

/** Read uncommitted paths from the authoritative mount or the capture's immutable Git trees. */
export const readWorktreeGitStatus = Effect.fn("readWorktreeGitStatus")(
  function* (worktree: Worktree) {
    const mount = yield* (yield* SessionRepository).worktreeMount(
      worktree.projectId,
      worktree.directory,
    );
    if (mount !== undefined) return yield* localWorktreeGitStatus(mount);
    const ready = yield* ensureCaptureCache(worktree.projectId, worktree.id);
    const runner = yield* GitOpsRunner;
    const section = ready.manifest.sections.git;
    const head = section.refs[section.head] ?? section.head;
    const index = indexTreeOf(section);
    if (index === undefined)
      return yield* new WorktreeGitRefused({
        code: "unavailable",
        message: "This saved capture does not include staging. Refresh after the next capture.",
      });
    const [net, staged, unstaged] = yield* Effect.all(
      [
        runner.diffFileFacts(ready.cache, head, ready.worktreeTree),
        runner.diffFileFacts(ready.cache, head, index),
        runner.diffFileFacts(ready.cache, index, ready.worktreeTree),
      ],
      { concurrency: 3 },
    );
    const stagedPaths = new Set(
      staged.flatMap((file) => [file.oldPath, file.newPath].filter((path) => path !== null)),
    );
    const untracked = new Set(
      unstaged
        .filter(
          (file) =>
            file.status === "added" && file.newPath !== null && !stagedPaths.has(file.newPath),
        )
        .map((file) => file.newPath),
    );
    const files = new Map<string, { path: string; insertions: number; deletions: number }>();
    for (const file of net) {
      const path = file.newPath ?? file.oldPath;
      if (path !== null)
        files.set(path, {
          path,
          insertions: untracked.has(path) ? 0 : file.additions,
          deletions: untracked.has(path) ? 0 : file.deletions,
        });
    }
    for (const file of [...staged, ...unstaged])
      for (const path of [file.oldPath, file.newPath])
        if (path !== null && !files.has(path))
          files.set(path, { path, insertions: 0, deletions: 0 });
    return statusOf([...files.values()]);
  },
  Effect.mapError(
    () =>
      new WorktreeGitRefused({
        code: "unavailable",
        message: "Mend could not read this worktree's uncommitted files. Refresh and try again.",
      }),
  ),
);
