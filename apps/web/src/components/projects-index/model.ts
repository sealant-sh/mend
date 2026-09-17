import { projectScope } from "@mend/domain/workbench";
import type { MouseEvent } from "react";

import type { ProjectDto, SessionDto, TeamViewDto } from "#/lib/api";
import { LIVE_STATES } from "#/lib/workbench-menus";

/** A repository and its observed live-session count for the directory. */
export interface ProjectEntry {
  readonly project: ProjectDto;
  /** Sessions in this project the server currently reports live. */
  readonly live: number | null;
  /** Where the project is visible, as the directory prints it. */
  readonly scope: string;
}

/**
 * The scope column: "you" for a personal project, the team's name, or "everyone" for an
 * instance project. A team the caller is not in cannot appear (the list is already filtered),
 * so an unknown team id only happens between a roster change and the refetch.
 */
export const scopeLabel = (
  project: Pick<ProjectDto, "teamId" | "ownerUserId">,
  teams: ReadonlyArray<Pick<TeamViewDto, "team">> | undefined,
): string => {
  const scope = projectScope(project);
  switch (scope.kind) {
    case "personal":
      return "you";
    case "instance":
      return "everyone";
    case "team":
      return teams?.find((entry) => entry.team.id === scope.teamId)?.team.name ?? "team";
  }
};

/** The directory delegates project actions to the page's context menu. */
export type ProjectMenuHandler = (event: MouseEvent<HTMLElement>, project: ProjectDto) => void;

/** Filtered entries and the page-owned project menu. */
export interface ProjectsDirectoryProps {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly onProjectMenu: ProjectMenuHandler;
}

/** Missing session data stays unknown, never an observed zero. */
export const projectEntries = (
  projects: ReadonlyArray<ProjectDto>,
  activeSessions: ReadonlyArray<Pick<SessionDto, "projectId" | "status">> | undefined,
  teams?: ReadonlyArray<Pick<TeamViewDto, "team">>,
): ReadonlyArray<ProjectEntry> =>
  projects.map((project) => ({
    project,
    live:
      activeSessions?.filter(
        (session) => session.projectId === project.id && LIVE_STATES.has(session.status),
      ).length ?? null,
    scope: scopeLabel(project, teams),
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

/** Adoption date in the browser's locale. */
export const adoptedLabel = (project: ProjectDto): string =>
  project.createdAt.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
