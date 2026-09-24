import type { GitAuthMode } from "@mend/domain/workbench";
import { describeGitRemoteFailure, type GitError, type InvalidBranchError } from "@mend/store";

/**
 * How the git half of a landing words a failure, for both store kinds: a remote failure in the
 * readable line `describeGitRemoteFailure` knows for the project's auth mode, else git's own
 * stderr, verbatim.
 */

export const shortSha = (sha: string | null) => (sha === null ? "none" : sha.slice(0, 7));

/** A git failure in the remote's words when a known shape matched, verbatim otherwise. */
export const gitWords = (error: GitError, mode: GitAuthMode | null): string => {
  const described = mode === null ? null : describeGitRemoteFailure(error.stderr, mode);
  if (described !== null) return described;
  if (error.stderr.trim() !== "") return error.stderr.trim();
  return `git ${error.args[0] ?? ""} exited ${error.exitCode ?? "without a code"}`;
};

export const branchWords = (error: InvalidBranchError): string =>
  `${error.branch} is not a branch name git accepts`;
