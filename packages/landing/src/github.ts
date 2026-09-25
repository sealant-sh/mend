import { gitRemoteLocation } from "@mend/domain/workbench";

/**
 * Where the pull request step can run (docs/adr/0007-landing.md, "One action: land"): only a
 * project whose origin is on GitHub gets step 4. Every other origin still gets steps 1 to 3, and
 * the step reads as unavailable with the reason below.
 */

/** A repository on github.com, as `gh --repo` takes it. */
export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly slug: string;
}

export type PullRequestAvailability =
  | { readonly available: true; readonly repository: GitHubRepository }
  | { readonly available: false; readonly reason: string };

const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);

/** GitHub's own rule for owner and repository names, which `gh` passes through unescaped. */
const NAME = /^[A-Za-z0-9_.-]+$/;

/** The path part of a clone URL: after `host:` for scp-style, the URL path otherwise. */
const pathOf = (originUrl: string): string => {
  if (!originUrl.includes("://")) return originUrl.slice(originUrl.lastIndexOf(":") + 1);
  return new URL(originUrl).pathname;
};

/**
 * The GitHub repository an origin URL names, or null when it is not on github.com. Accepts the
 * spellings adoption accepts: `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r.git` and
 * `git@github.com:o/r.git`.
 */
export const githubRepositoryOf = (originUrl: string): GitHubRepository | null => {
  const location = gitRemoteLocation(originUrl);
  if (location === null || !GITHUB_HOSTS.has(location.host)) return null;
  const segments = pathOf(originUrl)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length !== 2) return null;
  const [owner = "", name = ""] = segments;
  if (!NAME.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name, slug: `${owner}/${name}` };
};

/** Whether step 4 can run for a project, and the reason it cannot. */
export const pullRequestAvailability = (originUrl: string | null): PullRequestAvailability => {
  if (originUrl === null) {
    return { available: false, reason: "pull request unavailable · the project has no origin" };
  }
  const repository = githubRepositoryOf(originUrl);
  if (repository !== null) return { available: true, repository };
  const host = gitRemoteLocation(originUrl)?.host;
  return {
    available: false,
    reason:
      host === undefined
        ? "pull request unavailable · origin is not a GitHub repository"
        : `pull request unavailable · origin is on ${host}, not GitHub`,
  };
};

/** The branch a pull request merges into; pure, so it lives beside the description. */
export { pullRequestBase } from "@mend/domain/workbench";
