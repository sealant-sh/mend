import type { ProjectDto, SessionDto } from "#/lib/api";
import { LIVE_STATES } from "#/lib/workbench-menus";

/** A repository and its observed live-session count for the directory. */
export interface ProjectEntry {
  readonly project: ProjectDto;
  /** Sessions in this project the server currently reports live. */
  readonly live: number | null;
}

/** Missing session data stays unknown, never an observed zero. */
export const projectEntries = (
  projects: ReadonlyArray<ProjectDto>,
  activeSessions: ReadonlyArray<Pick<SessionDto, "projectId" | "status">> | undefined,
): ReadonlyArray<ProjectEntry> =>
  projects.map((project) => ({
    project,
    live:
      activeSessions?.filter(
        (session) => session.projectId === project.id && LIVE_STATES.has(session.status),
      ).length ?? null,
  }));

/** Search on whatever you remember: the name, the origin, or the store path. */
export const matchesQuery = (project: ProjectDto, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [project.name, project.originUrl ?? "", project.storePath].some((field) =>
    field.toLowerCase().includes(needle),
  );
};

const SCP_ORIGIN = /^[\w.-]+@([^:/]+):(.+)$/;
const URL_ORIGIN = /^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?(.+)$/i;

/**
 * The origin with transport noise removed — `github.com/owner/repo` for both
 * `git@github.com:owner/repo.git` and `https://github.com/owner/repo`. A local
 * path is returned unchanged; nothing is invented when the shape is unknown.
 */
export const shortOrigin = (originUrl: string): string => {
  const bare = originUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = SCP_ORIGIN.exec(bare);
  const [, scpHost, scpPath] = scp ?? [];
  if (scpHost !== undefined && scpPath !== undefined) return `${scpHost}/${scpPath}`;
  const [, urlRest] = URL_ORIGIN.exec(bare) ?? [];
  return urlRest ?? bare;
};

/** What a project was adopted from: its origin, or the store copy when it has none. */
export const sourceLabel = (project: ProjectDto): string =>
  project.originUrl === null ? tailPath(project.storePath, 3) : shortOrigin(project.originUrl);

/** The last `segments` path segments, elided in front — full path stays in `title`. */
export const tailPath = (path: string, segments: number): string => {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
};

/** Adoption date in the browser's locale; the year only when it is not this one. */
export const adoptedLabel = (project: ProjectDto, now: Date = new Date()): string =>
  project.createdAt.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(project.createdAt.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
