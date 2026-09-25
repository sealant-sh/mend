import { Schema } from "effect";

/**
 * Who a workspace's commits name as their author (docs/GIT-ACCESS.md, "Git author"). An account
 * setting: `setting` when the account saved one, else `account`, the name and email the account
 * registered with. Workspaces receive it as system-level git config, so a `~/.gitconfig` from
 * dotfiles and a repository's own config still decide over it.
 */
export const GitAuthorSource = Schema.Literals(["setting", "account"]);
export type GitAuthorSource = typeof GitAuthorSource.Type;

export class GitAuthor extends Schema.Class<GitAuthor>("GitAuthor")({
  name: Schema.String,
  email: Schema.String,
}) {}

export class ResolvedGitAuthor extends Schema.Class<ResolvedGitAuthor>("ResolvedGitAuthor")({
  name: Schema.String,
  email: Schema.String,
  source: GitAuthorSource,
}) {}

/** Longest name or email Mend keeps; git itself has no limit, a commit header should. */
export const GIT_AUTHOR_MAX_LENGTH = 200;

/** The value as git will store it: surrounding whitespace dropped. */
export const normalizeGitAuthor = (author: {
  readonly name: string;
  readonly email: string;
}): GitAuthor => new GitAuthor({ name: author.name.trim(), email: author.email.trim() });

/**
 * Why a git author cannot be saved, in a sentence a client shows as it is; null when it can.
 * Git drops `<`, `>` and line breaks from an ident, so a value carrying them would not be the
 * value committed.
 */
export const gitAuthorIssue = (author: {
  readonly name: string;
  readonly email: string;
}): string | null => {
  const { name, email } = normalizeGitAuthor(author);
  if (name === "") return "the name is empty";
  if (email === "") return "the email is empty";
  if (name.length > GIT_AUTHOR_MAX_LENGTH) {
    return `the name is longer than ${GIT_AUTHOR_MAX_LENGTH} characters`;
  }
  if (email.length > GIT_AUTHOR_MAX_LENGTH) {
    return `the email is longer than ${GIT_AUTHOR_MAX_LENGTH} characters`;
  }
  if (/[<>\r\n]/.test(name)) return "the name contains <, > or a line break";
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email))
    return "the email is not an address like you@example.com";
  return null;
};
