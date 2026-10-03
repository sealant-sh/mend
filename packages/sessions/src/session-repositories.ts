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
 * in a co-located one. The path is asked absolute, so it holds wherever the shell runs from. An
 * exclude file that ends without a newline gets one first, so the pattern never glues onto the
 * last line already there.
 */
const excludeNested =
  `exclude="$(git -C /workspace/repo rev-parse --path-format=absolute --git-path info/exclude)" && ` +
  `mkdir -p "$(dirname "$exclude")" && ` +
  `{ grep -qxF -- ${shellQuote(NESTED_REPOSITORIES_EXCLUDE)} "$exclude" 2>/dev/null || { ` +
  `[ ! -s "$exclude" ] || [ -z "$(tail -c1 "$exclude")" ] || printf '\\n' >> "$exclude"; ` +
  `printf '%s\\n' ${shellQuote(NESTED_REPOSITORIES_EXCLUDE)} >> "$exclude"; }; }`;

/** The exit code of a clone that found the nested directory already there. */
export const REPOSITORY_EXISTS_EXIT = 65;

/** The exit code of a clone that found a directory, not a link, at the repository's path. */
export const REPOSITORY_PATH_OCCUPIED_EXIT = 66;

/**
 * Written beside the nested directory once the clone, the checkout and the link are all in
 * place: a directory without it is an add that was interrupted, never a repository to relink.
 */
export const repositoryReadyMarker = (name: string): string =>
  `${nestedRepositoryPath(name)}.ready`;

/**
 * Clone the project's origin into the nested place, check out the session's branch at Mend's
 * recorded base, link `/workspace/repos/<name>` to it and leave the ready mark. The clone runs
 * through the workspace's own git transport, so it signs as the session's owner like every `git`
 * there. A directory already at either place is refused before anything is written.
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
    `if [ -e ${link} ] && [ ! -L ${link} ]; then echo "mend: ${repositoryPath(input.name)} exists and is not a link" >&2; exit ${REPOSITORY_PATH_OCCUPIED_EXIT}; fi`,
    `git clone --quiet --no-checkout -- ${shellQuote(input.originUrl)} ${nested}`,
    `git -C ${nested} checkout --quiet -B ${shellQuote(input.branch)} ${shellQuote(input.baseSha)}`,
    `ln -sfn ${nested} ${link}`,
    `: > ${shellQuote(repositoryReadyMarker(input.name))}`,
  ].join("\n");
};

/** What the relink script says about one repository, one line each: `<word> <name>`. */
export type RelinkObservation = "ready" | "missing" | "partial" | "occupied" | "unlinked";

/**
 * After a restore: the nested directories came back with the main worktree, the symlinks did not.
 * Relink every repository whose directory and ready mark are there and name the rest: `missing`
 * when nothing is there, `partial` when a directory without its mark is (an add that was
 * interrupted), `occupied` when a directory that is not a link sits at the repository's path,
 * `unlinked` when the link could not be made. The engine records what it observed and nothing
 * more.
 */
export const repositoryRelinkScript = (names: ReadonlyArray<string>): string =>
  [
    "set -u",
    `${excludeNested} || true`,
    "mkdir -p /workspace/repos",
    `for name in ${names.map(shellQuote).join(" ")}; do`,
    `  nested="/workspace/repo/.mend/repos/$name"`,
    `  link="/workspace/repos/$name"`,
    `  if [ -e "$link" ] && [ ! -L "$link" ]; then echo "occupied $name"`,
    `  elif [ -d "$nested/.git" ] && [ -e "$nested.ready" ]; then ln -sfn "$nested" "$link" && echo "ready $name" || echo "unlinked $name"`,
    `  elif [ -e "$nested" ]; then echo "partial $name"`,
    `  else echo "missing $name"; fi`,
    "done",
  ].join("\n");

/** What the relink script reported, per repository name. */
export const parseRelinkReport = (stdout: string): ReadonlyMap<string, RelinkObservation> => {
  const report = new Map<string, RelinkObservation>();
  for (const line of stdout.split("\n")) {
    const match = /^(ready|missing|partial|occupied|unlinked) (.+)$/.exec(line.trim());
    const word = match?.[1];
    const name = match?.[2];
    if (word === undefined || name === undefined) continue;
    if (
      word === "ready" ||
      word === "missing" ||
      word === "partial" ||
      word === "occupied" ||
      word === "unlinked"
    ) {
      report.set(name, word);
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
