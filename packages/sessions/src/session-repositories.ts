import type { ProjectId } from "@mend/domain";
import {
  NESTED_REPOSITORIES_EXCLUDE,
  nestedRepositoryPath,
  repositoryPath,
} from "@mend/domain/workbench";

import { shellQuote } from "./workspace-files.ts";

/** A project a session may add as a repository (docs/adr/0010), as `mend repo projects` lists it. */
export interface AddableProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly defaultBranch: string;
  /** Where its files would come from today; null means it cannot be added yet. */
  readonly originUrl: string | null;
}

/**
 * The shell that brings a repository into a session's workspace and keeps it there
 * (docs/adr/0010-repositories-in-a-session.md, "How the worktree arrives" and "How it is saved",
 * the shipped interim): the files live at `/workspace/repo/.mend/repos/<name>`, a nested
 * repository the main worktree's captures carry, and `/workspace/repos/<name>` is a symlink to
 * it. Pure builders, so the exact commands are testable without a workspace.
 */

/**
 * `.mend/` is kept out of the main repository's `git status`, whichever git dir it has: a
 * directory of its own in a captured workspace, a file pointing at the store's bare repository
 * in a co-located one. The path is asked absolute, so it holds wherever the shell runs from.
 */
const excludeNested =
  `exclude="$(git -C /workspace/repo rev-parse --path-format=absolute --git-path info/exclude)" && ` +
  `mkdir -p "$(dirname "$exclude")" && ` +
  `{ grep -qxF -- ${shellQuote(NESTED_REPOSITORIES_EXCLUDE)} "$exclude" 2>/dev/null || ` +
  `printf '%s\\n' ${shellQuote(NESTED_REPOSITORIES_EXCLUDE)} >> "$exclude"; }`;

/** The exit code of a clone that found the directory already there. */
export const REPOSITORY_EXISTS_EXIT = 65;

/**
 * Clone the project's origin into the nested place, check out the session's branch at Mend's
 * recorded base, and link `/workspace/repos/<name>` to it. The clone runs through the
 * workspace's own git transport, so it signs as the session's owner like every `git` there.
 */
export const repositoryCloneScript = (input: {
  readonly originUrl: string;
  readonly name: string;
  readonly branch: string;
  readonly baseSha: string;
}): string => {
  const nested = shellQuote(nestedRepositoryPath(input.name));
  const link = shellQuote(repositoryPath(input.name));
  return [
    "set -eu",
    excludeNested,
    "mkdir -p /workspace/repo/.mend/repos /workspace/repos",
    `if [ -e ${nested} ]; then echo "mend: ${nestedRepositoryPath(input.name)} already exists" >&2; exit ${REPOSITORY_EXISTS_EXIT}; fi`,
    `git clone --quiet --no-checkout -- ${shellQuote(input.originUrl)} ${nested}`,
    `git -C ${nested} checkout --quiet -B ${shellQuote(input.branch)} ${shellQuote(input.baseSha)}`,
    `ln -sfn ${nested} ${link}`,
  ].join("\n");
};

/**
 * After a restore: the nested directories came back with the main worktree, the symlinks did not.
 * Relink every repository whose directory is there and name the ones that are not, one line each
 * (`ready <name>` or `missing <name>`), so the engine records what it observed.
 */
export const repositoryRelinkScript = (names: ReadonlyArray<string>): string =>
  [
    "set -u",
    `${excludeNested} || true`,
    "mkdir -p /workspace/repos",
    `for name in ${names.map(shellQuote).join(" ")}; do`,
    `  nested="/workspace/repo/.mend/repos/$name"`,
    `  if [ -d "$nested/.git" ]; then ln -sfn "$nested" "/workspace/repos/$name" && echo "ready $name"; else echo "missing $name"; fi`,
    "done",
  ].join("\n");

/** What the relink script reported, per repository name. */
export const parseRelinkReport = (stdout: string): ReadonlyMap<string, "ready" | "missing"> => {
  const report = new Map<string, "ready" | "missing">();
  for (const line of stdout.split("\n")) {
    const match = /^(ready|missing) (.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      report.set(match[2], match[1] === "ready" ? "ready" : "missing");
    }
  }
  return report;
};

/** The last lines of a failed command, as the row's reason: short, never the whole log. */
export const failureReason = (stderr: string, fallback: string): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return fallback;
  return lines.slice(-3).join(" · ").slice(0, 500);
};
