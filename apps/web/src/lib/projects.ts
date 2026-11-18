import { PROJECT_NAME_PATTERN, repositoryCloneUrlIssue } from "@mend/domain/workbench";

import type { ProjectDto, SessionDto } from "./api.ts";

/** Which projects the list shows: all of them, the shared ones, or the viewer's private ones. */
export type ProjectsFilter = "all" | "shared" | "private";

/** A session the Projects list counts as open: one whose agent can still run or answer. */
const OPEN_STATES: ReadonlySet<string> = new Set<SessionDto["status"]>([
  "starting",
  "running",
  "waiting",
  "idle",
]);

/**
 * Each project's open sessions, by project id. Undefined until the sessions are read, so the list
 * never shows a zero it didn't see.
 */
export const openSessionCounts = (
  sessions: ReadonlyArray<{ readonly projectId: string; readonly status: string }> | undefined,
): ReadonlyMap<string, number> | undefined => {
  if (sessions === undefined) return undefined;
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!OPEN_STATES.has(session.status)) continue;
    counts.set(session.projectId, (counts.get(session.projectId) ?? 0) + 1);
  }
  return counts;
};

/** Search on whatever the person remembers: the name, the repository, or the store path. */
export const matchesQuery = (
  project: Pick<ProjectDto, "name" | "originUrl" | "storePath">,
  query: string,
): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [project.name, project.originUrl ?? "", project.storePath].some((field) =>
    field.toLowerCase().includes(needle),
  );
};

export const matchesFilter = (
  project: Pick<ProjectDto, "visibility">,
  filter: ProjectsFilter,
): boolean => filter === "all" || project.visibility === filter;

const SCP_ORIGIN = /^[\w.-]+@([^:/]+):(.+)$/;
const URL_ORIGIN = /^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?(.+)$/i;

/**
 * The repository address without its transport: `github.com/owner/repo` for both
 * `git@github.com:owner/repo.git` and `https://github.com/owner/repo`. A shape it doesn't know
 * comes back as it was.
 */
export const shortOrigin = (originUrl: string): string => {
  const bare = originUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  const [, scpHost, scpPath] = SCP_ORIGIN.exec(bare) ?? [];
  if (scpHost !== undefined && scpPath !== undefined) return `${scpHost}/${scpPath}`;
  const [, urlRest] = URL_ORIGIN.exec(bare) ?? [];
  return urlRest ?? bare;
};

/** The repository as a project row names it: the short origin, or "No repository" for one made in Mend. */
export const repositoryWords = (project: Pick<ProjectDto, "originUrl">): string =>
  project.originUrl === null ? "No repository" : shortOrigin(project.originUrl);

/** The repository's own name, `owner/repo`, for sentences about a clone. */
export const repositoryName = (source: string): string => {
  const short = shortOrigin(source);
  const parts = short.split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : short;
};

/** Who can see a project, as its row says it. A private project is seen only by its creator. */
export const visibleToWords = (
  visibility: ProjectDto["visibility"],
  organizationName: string,
): string => (visibility === "shared" ? `Everyone in ${organizationName}` : "Only you");

/** "1 open session", "3 open sessions". */
export const openSessionsWords = (count: number): string =>
  `${count} open ${count === 1 ? "session" : "sessions"}`;

/** A repository the Mend server's GitHub login can reach, as `github.repos` lists it. */
export interface GithubRepository {
  readonly nameWithOwner: string;
  readonly visibility: string;
  readonly pushedAt: string | null;
}

/**
 * The address Mend clones a picked repository from. A public one over HTTPS needs no key; a
 * private one over SSH, so the person's Git access (a key either way) can read it.
 */
export const cloneUrlOf = (repository: GithubRepository): string =>
  repository.visibility.toLowerCase() === "public"
    ? `https://github.com/${repository.nameWithOwner}`
    : `git@github.com:${repository.nameWithOwner}.git`;

/** Whether a repository is already a project the person can see, by its address. */
export const alreadyAdded = (
  repository: GithubRepository,
  projects: ReadonlyArray<Pick<ProjectDto, "originUrl">>,
): boolean =>
  projects.some(
    (project) =>
      project.originUrl !== null &&
      shortOrigin(project.originUrl).toLowerCase() ===
        `github.com/${repository.nameWithOwner}`.toLowerCase(),
  );

/**
 * The project name an address suggests: its last path segment, without `.git`, in the letters a
 * project name may use. Empty when nothing usable is left.
 */
export const inferName = (source: string): string => {
  const trimmed = source
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const last = trimmed.split(/[/:]/).at(-1) ?? "";
  return last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
};

/** Why a project name won't be taken, in words, or null when it will. */
export const nameIssue = (
  name: string,
  projects: ReadonlyArray<Pick<ProjectDto, "name">>,
  organizationName: string,
): string | null => {
  if (name === "") return "Give the project a name.";
  if (!PROJECT_NAME_PATTERN.test(name))
    return "Use lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.";
  if (projects.some((project) => project.name === name))
    return `${organizationName} already has a project named ${name}.`;
  return null;
};

/** Why an address can't be cloned, in Mend's words, or null when it can. */
export const sourceIssue = (source: string): string | null =>
  source.trim() === "" ? null : repositoryCloneUrlIssue(source.trim());

/** How many repositories `github.repos` lists at most (`REPO_LIMIT` in the API's GitHub routes). */
export const LISTED_REPOSITORIES = 30;

/**
 * Where a search of the person's repositories looks. A list shorter than the server's limit is all
 * of them, so the page filters it as the person types; a full list may be cut short, so the server
 * searches GitHub instead.
 */
export const searchesOnPage = (listed: number): boolean => listed < LISTED_REPOSITORIES;

/** The listed repositories whose `owner/name` holds the typed words, ignoring case. */
export const repositoriesMatching = (
  repositories: ReadonlyArray<GithubRepository>,
  query: string,
): ReadonlyArray<GithubRepository> => {
  const words = query.trim().toLowerCase();
  return words === ""
    ? repositories
    : repositories.filter((repository) => repository.nameWithOwner.toLowerCase().includes(words));
};

const MINUTE_MS = 60_000;

/** "Pushed 20m ago", "Pushed yesterday", "Pushed 2 weeks ago", from GitHub's last push. */
export const pushedAgo = (pushedAt: string | null, now: Date): string => {
  const at = pushedAt === null ? Number.NaN : Date.parse(pushedAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / MINUTE_MS));
  if (minutes < 1) return "Pushed just now";
  if (minutes < 60) return `Pushed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Pushed ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Pushed yesterday";
  if (days < 14) return `Pushed ${days} days ago`;
  if (days < 60) return `Pushed ${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `Pushed ${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return `Pushed ${years} ${years === 1 ? "year" : "years"} ago`;
};
