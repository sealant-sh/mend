/**
 * The workspace half of the account setting "Git author" (docs/GIT-ACCESS.md): the exec that
 * writes it as SYSTEM git config before the harness starts. System level is the point — a
 * `~/.gitconfig` from the owner's dotfiles and a repository's own config still decide over it,
 * where `GIT_AUTHOR_*` env vars would override both. The values ride as positional parameters,
 * so neither needs shell quoting.
 */
export const gitAuthorConfigArgv = (author: {
  readonly name: string;
  readonly email: string;
}): ReadonlyArray<string> => [
  "sh",
  "-c",
  'git config --system user.name "$1" && git config --system user.email "$2"',
  "mend-git-author",
  author.name,
  author.email,
];
