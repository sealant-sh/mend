/**
 * Repository references (docs/adr/0006-slack.md, "Which project a mention runs in"): a GitHub or
 * GitLab link in a thread names a repository, and Mend matches it against each project's
 * `originUrl`. Matching is exact on the normalised host and path, so a link either names a project
 * or it does not; nothing here guesses.
 */

/**
 * A repository, normalised: host without `www.`, port or credentials, and the path without `.git`
 * or a trailing slash, both lower case. `host` is null for a bare `owner/name`, which matches that
 * path on any host.
 */
export interface RepositoryRef {
  readonly host: string | null;
  readonly path: string;
}

/** Hosts whose links Mend reads out of prose. Other hosts are read only from a project's origin. */
export const KNOWN_REPOSITORY_HOSTS: ReadonlyArray<string> = ["github.com", "gitlab.com"];

/**
 * The first path segments on github.com that are GitHub's own pages and not an owner, so that
 * `https://github.com/orgs/acme/…` or `https://github.com/settings/…` names no repository.
 */
const GITHUB_RESERVED_OWNERS: ReadonlySet<string> = new Set([
  "about",
  "apps",
  "collections",
  "codespaces",
  "contact",
  "customer-stories",
  "enterprise",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

/**
 * Pages that come straight after a repository's path on a host other than github.com: GitLab's
 * older links, which lack the `/-/` separator it now writes (`group/project/merge_requests/4`),
 * and a GitHub Enterprise host's (`owner/name/pull/12`).
 */
const REPOSITORY_PAGES: ReadonlySet<string> = new Set([
  "actions",
  "blob",
  "branches",
  "commit",
  "commits",
  "compare",
  "issues",
  "merge_requests",
  "pipelines",
  "pull",
  "pulls",
  "raw",
  "releases",
  "tags",
  "tree",
  "wiki",
  "wikis",
]);

const SEGMENT = /^[a-z0-9_.-]+$/;

const normaliseHost = (host: string): string => {
  const lower = host.toLowerCase();
  const withoutPort = lower.replace(/:\d+$/, "");
  return withoutPort.startsWith("www.") ? withoutPort.slice(4) : withoutPort;
};

const stripGit = (segment: string): string =>
  segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment;

/** The repository path in a URL's path segments, by the host's own URL layout. */
const repositoryPath = (host: string, segments: ReadonlyArray<string>): string | null => {
  const clean = segments.map((segment) => segment.toLowerCase());
  let repository: ReadonlyArray<string>;
  if (host === "github.com") {
    // github.com/<owner>/<name>/<page>/…: the repository is always the first two segments.
    if (clean.length < 2 || GITHUB_RESERVED_OWNERS.has(clean[0] ?? "")) return null;
    repository = clean.slice(0, 2);
  } else {
    // GitLab and the rest: groups nest, and `/-/` starts the project's own pages.
    const separator = clean.indexOf("-");
    const upTo = separator === -1 ? clean.length : separator;
    const page = clean.findIndex((segment, index) => index >= 2 && REPOSITORY_PAGES.has(segment));
    repository = clean.slice(0, page === -1 || page > upTo ? upTo : page);
    if (repository.length < 2) return null;
  }
  const named = repository.map((segment, index) =>
    index === repository.length - 1 ? stripGit(segment) : segment,
  );
  return named.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
    ? named.join("/")
    : null;
};

const segmentsOf = (path: string): ReadonlyArray<string> =>
  path
    .split(/[?#]/)[0]
    ?.split("/")
    .filter((segment) => segment !== "") ?? [];

/**
 * The repository a URL names: a web URL of a repository or of anything in it (a pull or merge
 * request, an issue, a commit, a file or a tree), or a clone URL (`https://`, `ssh://`, `git://`
 * or scp-like `git@host:owner/name.git`). Null for anything else, including local paths.
 */
export const parseRepositoryUrl = (url: string): RepositoryRef | null => {
  const text = url.trim();
  // scp-like: [user@]host:path, where the path does not start with `//`.
  const scp = /^(?:[^@\s/:]+@)?([a-z0-9.-]+\.[a-z]{2,}):(?!\/\/)(?!\d+\/)([^\s]+)$/i.exec(text);
  if (scp !== null) {
    const host = normaliseHost(scp[1] ?? "");
    const path = repositoryPath(host, segmentsOf(scp[2] ?? ""));
    return path === null ? null : { host, path };
  }
  const scheme =
    /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@\s/]+@)?([^/\s?#]+)(\/[^\s]*)?$/i.exec(text);
  if (scheme === null) return null;
  const host = normaliseHost(scheme[1] ?? "");
  if (!host.includes(".")) return null;
  const path = repositoryPath(host, segmentsOf(scheme[2] ?? ""));
  return path === null ? null : { host, path };
};

/**
 * A repository given as an option value (`project=acme/api`, `in acme/api`): a URL, or a bare
 * `owner/name` (or `group/sub/name`), which matches that path on any host.
 */
export const parseRepositoryOption = (value: string): RepositoryRef | null => {
  const url = parseRepositoryUrl(value);
  if (url !== null) return url;
  const bare = value.trim().toLowerCase().replace(/\/+$/, "");
  const segments = bare.split("/");
  if (segments.length < 2) return null;
  const named = segments.map((segment, index) =>
    index === segments.length - 1 ? stripGit(segment) : segment,
  );
  return named.every((segment) => segment !== "" && SEGMENT.test(segment) && !/^\.+$/.test(segment))
    ? { host: null, path: named.join("/") }
    : null;
};

/** Whether two references name the same repository; a null host matches any host. */
export const sameRepository = (a: RepositoryRef, b: RepositoryRef): boolean =>
  a.path === b.path && (a.host === null || b.host === null || a.host === b.host);

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`*_~>]+$/;

/**
 * Every repository a text links to, in the order it first appears, without repeats. Only links
 * on `hosts` count (GitHub and GitLab, plus whatever self-hosted hosts the caller adds, such as
 * the hosts of its projects' origins), so a link to anything else names nothing. A bare
 * `owner/name` in prose is not read: it is as likely to be a file path.
 */
export const repositoryReferences = (
  text: string,
  hosts: ReadonlyArray<string> = KNOWN_REPOSITORY_HOSTS,
): ReadonlyArray<RepositoryRef> => {
  const allowed = new Set(hosts.map(normaliseHost));
  const found: Array<RepositoryRef> = [];
  const candidates = text.match(
    /(?:(?:https?|ssh|git):\/\/[^\s<>|"'`]+|[a-z0-9_.-]+@[a-z0-9.-]+\.[a-z]{2,}:[^\s<>|"'`]+|(?<![\w./@-])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>|"'`]+)/gi,
  );
  for (const candidate of candidates ?? []) {
    const trimmed = candidate.replace(TRAILING_PUNCTUATION, "");
    const withScheme = /^[a-z0-9_.-]+@|^[a-z+]+:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const ref = parseRepositoryUrl(withScheme);
    if (ref === null || ref.host === null || !allowed.has(ref.host)) continue;
    if (!found.some((seen) => sameRepository(seen, ref))) found.push(ref);
  }
  return found;
};

/** A project as repository matching needs it. */
export interface RepositoryProject {
  readonly name: string;
  readonly originUrl: string | null;
}

/** The projects whose origin is the repository `ref` names. */
export const projectsForRepository = <P extends RepositoryProject>(
  ref: RepositoryRef,
  projects: ReadonlyArray<P>,
): ReadonlyArray<P> =>
  projects.filter((project) => {
    const origin = project.originUrl === null ? null : parseRepositoryUrl(project.originUrl);
    return origin !== null && sameRepository(ref, origin);
  });

/** The hosts of the projects' origins, with GitHub and GitLab: what a thread's links can name. */
export const repositoryHostsOf = (
  projects: ReadonlyArray<RepositoryProject>,
): ReadonlyArray<string> => {
  const hosts = new Set(KNOWN_REPOSITORY_HOSTS);
  for (const project of projects) {
    const origin = project.originUrl === null ? null : parseRepositoryUrl(project.originUrl);
    if (origin !== null && origin.host !== null) hosts.add(origin.host);
  }
  return [...hosts];
};

/**
 * The projects a text links to, in the order their repositories first appear, without repeats.
 * The caller takes the answer when exactly one project comes back.
 */
export const projectsLinkedIn = <P extends RepositoryProject>(
  text: string,
  projects: ReadonlyArray<P>,
): ReadonlyArray<P> => {
  const matched: Array<P> = [];
  for (const ref of repositoryReferences(text, repositoryHostsOf(projects))) {
    for (const project of projectsForRepository(ref, projects)) {
      if (!matched.includes(project)) matched.push(project);
    }
  }
  return matched;
};

const looseName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/g, "-");

/**
 * The projects a `project=` or `in <project>` value names: by name (exactly, ignoring case), then
 * by name ignoring spaces, dashes and underscores (`"billing api"` for `billing-api`), then by
 * repository against each origin. The first rule that matches anything answers.
 */
export const projectsNamedBy = <P extends RepositoryProject>(
  value: string,
  projects: ReadonlyArray<P>,
): ReadonlyArray<P> => {
  const wanted = value.trim().toLowerCase();
  if (wanted === "") return [];
  const exact = projects.filter((project) => project.name.toLowerCase() === wanted);
  if (exact.length > 0) return exact;
  const loose = projects.filter((project) => looseName(project.name) === looseName(wanted));
  if (loose.length > 0) return loose;
  const ref = parseRepositoryOption(value);
  return ref === null ? [] : projectsForRepository(ref, projects);
};
