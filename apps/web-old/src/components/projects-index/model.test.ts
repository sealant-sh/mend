import { OrganizationId, ProjectId } from "@mend/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { ProjectDto } from "#/lib/api";
import { makeTrpcProxy } from "#/lib/trpc";
import { projectMenu } from "#/lib/workbench-menus";

import { matchesQuery, projectEntries, shortOrigin, sourceLabel, tailPath } from "./model";

const project: ProjectDto = {
  id: ProjectId.make("project-layout-test"),
  name: "Mend",
  organizationId: OrganizationId.make("org-test"),
  visibility: "shared",
  createdByUserId: null,
  scratchOwnerUserId: null,
  originUrl: "git@github.com:sealant-sh/mend.git",
  storePath: "/home/developer/.local/share/mend/store/mend/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: false,
  newWorktreesUseProjectResources: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

describe("Projects index facts", () => {
  it("distinguishes missing activity data from an observed zero", () => {
    expect(projectEntries([project], undefined)[0]?.live).toBeNull();
    expect(projectEntries([project], [])[0]?.live).toBe(0);
  });

  it("counts only live sessions belonging to the project", () => {
    const entries = projectEntries(
      [project],
      [
        { projectId: project.id, status: "running" },
        { projectId: project.id, status: "waiting" },
        { projectId: project.id, status: "starting" },
        { projectId: project.id, status: "idle" },
        { projectId: project.id, status: "completed" },
        { projectId: project.id, status: "failed" },
        { projectId: ProjectId.make("another-project"), status: "running" },
      ],
    );
    expect(entries).toEqual([{ project, live: 4 }]);
  });

  it.each(["mend", " MEND ", "SEALANT-SH", "developer", " "])(
    "searches name, origin and store path for %j",
    (query) => expect(matchesQuery(project, query)).toBe(true),
  );

  it("handles a missing origin and unmatched search", () => {
    expect(matchesQuery({ ...project, originUrl: null }, "github")).toBe(false);
    expect(matchesQuery(project, "missing-repository")).toBe(false);
    expect(sourceLabel({ ...project, originUrl: null })).toBe("…/store/mend/repo.git");
  });

  it.each([
    ["git@github.com:sealant-sh/mend.git", "github.com/sealant-sh/mend"],
    ["https://github.com/sealant-sh/mend.git/", "github.com/sealant-sh/mend"],
    ["ssh://git@git.example.com:2222/team/repo.git", "git.example.com:2222/team/repo"],
    ["/home/developer/repo", "/home/developer/repo"],
  ])("shortens %s without losing the host or repository", (input, expected) => {
    expect(shortOrigin(input)).toBe(expected);
  });

  it("keeps short paths and elides only leading segments of long paths", () => {
    expect(tailPath("/mend/repo.git", 2)).toBe("/mend/repo.git");
    expect(tailPath(project.storePath, 2)).toBe("…/mend/repo.git");
  });
});

it("the project menu opens setup consent without starting an agent", () => {
  const queryClient = new QueryClient();
  const navigations: unknown[] = [];
  const menu = projectMenu(
    project,
    async (options: unknown) => {
      navigations.push(options);
    },
    { queryClient, trpc: makeTrpcProxy(queryClient) },
    null,
  );
  const action = menu.entries.find(
    (entry) => entry !== "separator" && entry.label === "Set up this project",
  );
  if (action === undefined || action === "separator") throw new Error("No setup action");
  action.onSelect();
  expect(navigations).toEqual([
    { to: "/projects/$projectId/setup-session", params: { projectId: project.id } },
  ]);
  expect(queryClient.getMutationCache().getAll()).toEqual([]);
  queryClient.clear();
});
