import { posix } from "node:path";

import {
  notChangeOwnerWords,
  projectRefusalWords,
  worktreeRefusalWords,
} from "@mend/domain/workbench";
import * as Schema from "effect/Schema";

import type { MendRemoval } from "./mend-client.ts";
import type { MendProject } from "./mend-workbench.ts";

/**
 * Removing a worktree or a project from t3code (decision 11): t3code's own confirm dialogs, then
 * Mend's removal, never forced. Mend decides; a refusal reaches the person in Mend's words for a
 * client outside Mend (`@mend/domain/workbench`), which send them to Mend and never offer force.
 */

/** A removal the gateway cannot report as made, in the words t3code shows. */
export class RemovalKept extends Schema.TaggedError<RemovalKept>()("RemovalKept", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Mend could not be reached before the removal was asked for: nothing was asked, nothing went. */
export const WORKTREE_UNREACHABLE =
  "Mend could not be reached, so the worktree is kept. Remove it from Mend.";
export const PROJECT_UNREACHABLE =
  "Mend could not be reached, so the project is kept. Remove it from Mend.";

/**
 * Mend was asked to remove it and gave no answer the gateway could read (no response, a timeout,
 * a 5xx): what it removed is not known, so the words say only what was observed.
 */
export const removalUnansweredWords = (
  what: "worktree" | "project",
  status: number | null,
): string =>
  `${status === null ? "Mend did not answer" : `Mend answered ${status}`}, so whether this ${what} was removed is not known. Check it in Mend.`;
export const NOT_A_PROJECT = "This is not one of your projects in Mend, so nothing was removed.";
export const NOT_A_WORKTREE =
  "This path is not one of the project's worktrees in Mend, so nothing was removed.";
export const AMBIGUOUS_WORKTREE =
  "More than one of the project's worktrees in Mend is at this path, so nothing was removed. Remove it from Mend.";
export const PROJECT_NOT_LISTED =
  "Mend does not list this project for you now, so nothing was removed.";
/** Mend's 404 to a project removal: the project is not visible, or the caller may not remove it. */
export const PROJECT_NOT_REMOVABLE =
  "Mend keeps this project. Only an organization owner, or the creator of a private project, can remove it.";

/**
 * The directory of the worktree `path` names in the project's store, the inverse of
 * `worktreePathOf`: one name directly under `worktrees/`, else null.
 */
export const worktreeDirectoryAt = (project: MendProject, path: string): string | null => {
  const parent = posix.join(posix.dirname(project.storePath), "worktrees");
  if (!path.startsWith(`${parent}/`)) return null;
  const directory = path.slice(parent.length + 1);
  return directory === "" || directory === "." || directory === ".." || directory.includes("/")
    ? null
    : directory;
};

/** A refusal Mend gave that the gateway cannot read: a 4xx, so Mend did not act on it. */
const unreadable = (what: "worktree" | "project", status: number, tag: string | null) =>
  `Mend did not remove this ${what} (${status}${tag === null ? "" : ` ${tag}`}). Check it in Mend.`;

/** What t3code shows for Mend's answer to a worktree removal; null when the worktree is gone. */
export const worktreeRemovalWords = (answer: MendRemoval): string | null => {
  switch (answer._tag) {
    case "Removed":
    case "NotFound":
      return null;
    case "Refused":
      return worktreeRefusalWords(answer, "outside-mend");
    case "NotChangeOwner":
      return notChangeOwnerWords(answer.owner, "outside-mend");
    case "Unreadable":
      return unreadable("worktree", answer.status, answer.tag);
  }
};

/** What t3code shows for Mend's answer to a project removal; null when the project is gone. */
export const projectRemovalWords = (answer: MendRemoval): string | null => {
  switch (answer._tag) {
    case "Removed":
      return null;
    case "Refused":
      return projectRefusalWords(answer.blockers, "outside-mend");
    case "NotFound":
      return PROJECT_NOT_REMOVABLE;
    case "NotChangeOwner":
      return unreadable("project", 403, "RemovalForbidden");
    case "Unreadable":
      return unreadable("project", answer.status, answer.tag);
  }
};
