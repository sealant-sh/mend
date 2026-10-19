import type { Project, ProjectResolution, RepositoryFacts } from "./types.js";

/**
 * Which adopted project a window's folder is a clone of. Pure: `git.ts` reads the facts and the
 * store keeps the answer.
 *
 * Two origins name the same repository when their keys are equal:
 * - `https://`, `ssh://`, `git://` URLs and scp-style `[user@]host:path` all read as `host/path`,
 *   so the scheme and the userinfo never count;
 * - the host is compared case-insensitively, and an IPv6 host keeps its brackets;
 * - a port counts unless it is its scheme's default (ssh 22, git 9418, http 80, https 443);
 * - the path counts exactly, case included, once its leading and trailing slashes and one trailing
 *   `.git` are dropped;
 * - a local path or `file://` URL reads as `file:<path>`, exact but for a trailing slash.
 */

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  git: "9418",
  http: "80",
  https: "443",
};

const URL_FORM =
  /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]/]+\]|[^/:]+)(?::(\d*))?(?:\/(.*))?$/i;
const SCP_FORM = /^(?:[^@/\s]+@)?(\[[^\]/]+\]|[^/:\s]+):(?!\/\/)(.+)$/;
const LOCAL_FORM = /^(?:\/|\.{1,2}\/|~\/|[a-z]:[\\/]|\\\\)/i;

const remotePath = (raw: string): string =>
  raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/** The key two origins share when they name the same repository; null for none. */
export const originKey = (raw: string | null): string | null => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return null;
  if (/^file:\/\//i.test(trimmed)) return `file:${trimmed.slice(7).replace(/\/+$/, "")}`;
  if (LOCAL_FORM.test(trimmed)) return `file:${trimmed.replace(/[\\/]+$/, "")}`;
  const url = URL_FORM.exec(trimmed);
  if (url !== null) {
    const [, scheme = "", host = "", port = "", rest = ""] = url;
    const path = remotePath(rest);
    if (path === "") return null;
    const kept = port === "" || DEFAULT_PORTS[scheme.toLowerCase()] === port ? "" : `:${port}`;
    return `${host.toLowerCase()}${kept}/${path}`;
  }
  const scp = SCP_FORM.exec(trimmed);
  if (scp !== null) {
    const [, host = "", rest = ""] = scp;
    const path = remotePath(rest);
    return path === "" ? null : `${host.toLowerCase()}/${path}`;
  }
  return null;
};

/** The origin as it can be shown: a URL's userinfo (`user:token@`) is dropped. */
export const redactOrigin = (raw: string): string =>
  raw.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

export const normalizeProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug === "" ? "project" : slug.slice(0, 64);
};

/** The project name Adopt this repository proposes: the origin's last path segment. */
export const originProjectName = (raw: string): string => {
  const key = originKey(raw) ?? raw;
  const last =
    key
      .split(/[\\/:]/)
      .filter((part) => part !== "")
      .at(-1) ?? "";
  return normalizeProjectName(last.replace(/\.git$/, ""));
};

const normalizePath = (value: string): string | null => {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return trimmed === "" || trimmed.includes("://") ? null : trimmed;
};

/**
 * The window's git root is the adopted source itself, or one of the project's worktrees in Mend's
 * store. Only the root counts: a separate repository nested inside the source has a root of its
 * own, and its own origin decides.
 */
const isProjectRoot = (project: Project, root: string): boolean => {
  const folder = normalizePath(root);
  if (folder === null) return false;
  if (project.originUrl !== null && normalizePath(project.originUrl) === folder) return true;
  const store = normalizePath(project.storePath);
  const separator = store?.lastIndexOf("/") ?? -1;
  if (store === null || separator <= 0) return false;
  const worktrees = `${store.slice(0, separator)}/worktrees/`;
  const name = folder.startsWith(worktrees) ? folder.slice(worktrees.length) : "";
  return name !== "" && !name.includes("/");
};

const resolved = (
  candidates: ReadonlyArray<Project>,
  matchedBy: string,
): ProjectResolution | null => {
  const [only, ...more] = candidates;
  if (only === undefined) return null;
  return more.length === 0
    ? { status: "matched", project: only, matchedBy }
    : { status: "ambiguous", candidates, matchedBy };
};

/**
 * Its origin, then whether its git root is the project's source or one of its worktrees, and its
 * folder name only when it has no origin: a clone of another repository that shares an adopted
 * project's name, or sits inside its source, is not that project.
 */
export const matchProject = (
  projects: ReadonlyArray<Project>,
  facts: RepositoryFacts,
): ProjectResolution => {
  const origin = originKey(facts.originUrl);
  return (
    (origin === null
      ? null
      : resolved(
          projects.filter((project) => originKey(project.originUrl) === origin),
          "origin",
        )) ??
    resolved(
      projects.filter((project) => isProjectRoot(project, facts.path)),
      "path",
    ) ??
    (facts.originUrl === null && !facts.originUnknown
      ? resolved(
          projects.filter((project) => project.name === normalizeProjectName(facts.folder)),
          "folder-name",
        )
      : null) ?? { status: "not-found" }
  );
};
