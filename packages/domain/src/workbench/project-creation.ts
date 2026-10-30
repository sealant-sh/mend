import { Schema } from "effect";

import { gitAuthorIssue, normalizeGitAuthor } from "./git-author.ts";

/** The stored name rule shared with adoption. */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(PROJECT_NAME_PATTERN)),
  Schema.brand("ProjectName"),
);
export type ProjectName = typeof ProjectName.Type;

const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");

/** Matches t3code v0.1.2's newProjectFolderName, including reserved Windows names. */
export const projectNameFrom = (text: string): ProjectName => {
  const name = slug(text) || "project";
  return ProjectName.make(
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name) ? `${name}-project` : name,
  );
};

/** `base`, then `base-2` through `base-100`, the stem shortened only as far as the suffix needs. */
export const projectNameCandidates = (base: ProjectName): ReadonlyArray<ProjectName> =>
  Array.from({ length: 100 }, (_, index) => {
    if (index === 0) return base;
    const suffix = `-${index + 1}`;
    return ProjectName.make(`${base.slice(0, 64 - suffix.length)}${suffix}`);
  });

/** Derived once on first use; account renaming never changes scratch identity. */
export const scratchProjectName = (account: {
  readonly name: string;
  readonly email: string;
}): ProjectName => {
  const handle = slug(account.name) || slug(account.email.split("@")[0] ?? "") || "person";
  return ProjectName.make(`scratch-${handle.slice(0, 56).replace(/-+$/, "")}`);
};

/** The sole README commit a new repository must hold before publication. */
export interface FirstCommit {
  readonly readme: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly at: Date;
}

/**
 * Author of a first commit: the person's Git author, or the email's local part for a name git
 * would refuse or rewrite (empty, `<`, `>`, a line break, too long).
 */
export const firstCommitAuthor = (author: {
  readonly name: string;
  readonly email: string;
}): FirstCommit["author"] => {
  const { name, email } = normalizeGitAuthor(author);
  return {
    name: gitAuthorIssue({ name, email }) === null ? name : (email.split("@")[0] ?? ""),
    email,
  };
};
