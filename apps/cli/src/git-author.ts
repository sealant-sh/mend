import { gitAuthorIssue, normalizeGitAuthor } from "@mend/domain/workbench";

/** `GET /api/me/git-author`: the name and email this account's workspaces commit as. */
export interface GitAuthorDto {
  readonly name: string;
  readonly email: string;
  /** `setting` when the account saved one; `account` is its registration name and email. */
  readonly source: "setting" | "account";
}

/** What `mend git-author …` asks for. */
export type GitAuthorRequest =
  | { readonly kind: "show" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly name: string; readonly email: string }
  | { readonly kind: "usage" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * `mend git-author` shows it, `mend git-author "Name" you@example.com` saves it, `--clear` returns
 * it to the account's own name and email. Checked here with the server's own rule, so a refusal
 * never costs a round trip.
 */
export const parseGitAuthorArgs = (args: ReadonlyArray<string>): GitAuthorRequest => {
  const clear = args.includes("--clear");
  const words = args.filter((arg) => !arg.startsWith("--"));
  if (clear) return words.length === 0 ? { kind: "clear" } : { kind: "usage" };
  if (words.length === 0) return { kind: "show" };
  const [name, email] = words;
  if (words.length !== 2 || name === undefined || email === undefined) return { kind: "usage" };
  const issue = gitAuthorIssue({ name, email });
  if (issue !== null) return { kind: "invalid", message: `git author not saved · ${issue}` };
  const author = normalizeGitAuthor({ name, email });
  return { kind: "set", name: author.name, email: author.email };
};

/** One terse line: the ident as git writes it, and where it comes from. */
export const gitAuthorLine = (author: GitAuthorDto): string =>
  `${author.name} <${author.email}> · ${author.source === "setting" ? "your setting" : "your account's name and email"}`;
