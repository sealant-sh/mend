import { gitRemoteLocation, redactUrlCredentials, type GitAuthMode } from "@mend/domain/workbench";
import {
  describeGitRemoteFailure,
  sshUrlOfHttpsRemote,
  type GitError,
  type InvalidBranchError,
} from "@mend/store";

/**
 * How the git half of a landing words a failure, for both store kinds: a remote failure in the
 * readable line `describeGitRemoteFailure` knows for the project's auth mode, else git's own
 * stderr, verbatim.
 */

export const shortSha = (sha: string | null) => (sha === null ? "none" : sha.slice(0, 7));

/** Preserve GitHub's rejection of a landing's SSH rewrite and name both ways to configure access. */
export const landingPushWords = (
  message: string,
  origin: string | null,
  pushRemote?: string,
): string => {
  const words = redactUrlCredentials(message).trim();
  if (
    origin === null ||
    gitRemoteLocation(origin)?.host !== "github.com" ||
    pushRemote !== sshUrlOfHttpsRemote(origin) ||
    !/permission.*denied|access denied|repository not found|write access.*not granted|authentication failed/i.test(
      words,
    )
  )
    return words;
  return `${words}\nAdd your Mend key to your GitHub account's SSH keys (mend keys shows it), or adopt ${pushRemote}. Check that the account has write access to this repository.`;
};

/**
 * A git failure in the remote's words when a known shape matched, verbatim otherwise. `remote` is
 * the origin URL, so an HTTPS refusal can name the ssh URL that would work; a failed `git push`
 * says a push needs the credential a public clone did not.
 */
export const gitWords = (
  error: GitError,
  mode: GitAuthMode | null,
  remote: string | null = null,
  pushRemote?: string,
): string => {
  const stderr = redactUrlCredentials(error.stderr);
  const pushWords = landingPushWords(stderr, remote, pushRemote);
  if (pushWords !== stderr.trim()) return pushWords;
  const described =
    mode === null
      ? null
      : describeGitRemoteFailure(stderr, mode, {
          remote: pushRemote ?? remote,
          push: error.args[0] === "push",
        });
  if (described !== null) return described;
  if (stderr.trim() !== "") return stderr.trim();
  return `git ${error.args[0] ?? ""} exited ${error.exitCode ?? "without a code"}`;
};

export const branchWords = (error: InvalidBranchError): string =>
  `${error.branch} is not a branch name git accepts`;

/**
 * What a missing record means to the person landing, by its error's tag. The tag names a table
 * row; the person needs the thing. The tag itself goes to the log, never into these words.
 */
export const missingWords = (tag: string): string => {
  switch (tag) {
    case "SessionNotFoundError":
      return "the session no longer exists";
    case "ProjectNotFoundError":
      return "the project no longer exists";
    case "WorktreeNotFoundError":
      return "the worktree no longer exists";
    default:
      return "something the landing needs no longer exists";
  }
};

/** The landing commit was made but Mend could not keep it in its store (a blob write failed). */
export const COMMIT_NOT_KEPT =
  "Mend could not save the landing commit in its store · nothing was pushed";

/** The copy a capture-backed landing commits in could not be prepared. */
export const CACHE_NOT_READY =
  "Mend could not prepare the copy it lands from · nothing was pushed · try again";
