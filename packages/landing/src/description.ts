import type { DescribedFile } from "@mend/domain/workbench";
import type { DiffFileFact } from "@mend/store";

/**
 * The pull request's description, title and commit message are pure and live in
 * `@mend/domain/workbench` (landing-description.ts), so the web renders the same preview the
 * landing sends. This module keeps the one piece that reads the store's diff facts.
 */
export {
  DESCRIPTION_END,
  DESCRIPTION_FILE_LIMIT,
  DESCRIPTION_START,
  GITHUB_BODY_LIMIT,
  describePullRequest,
  landingCommitMessage,
  mergeDescription,
  ownerDescription,
  pullRequestTitle,
  type DescribedCheck,
  type DescribedFile,
  type DescribedFileStatus,
  type DescriptionInput,
} from "@mend/domain/workbench";

/** A file of the landed range, as git's diff facts name it. */
export const describedFileOf = (fact: DiffFileFact): DescribedFile => ({
  path: fact.newPath ?? fact.oldPath ?? "",
  oldPath: fact.status === "renamed" || fact.status === "copied" ? fact.oldPath : null,
  status: fact.status,
  additions: fact.additions,
  deletions: fact.deletions,
  binary: fact.binary,
});
