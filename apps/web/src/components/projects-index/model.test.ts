import { ProjectId, TeamId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ProjectDto } from "#/lib/api";

import {
  matchesQuery,
  projectEntries,
  scopeLabel,
  shortOrigin,
  sourceLabel,
  tailPath,
} from "./model";

const project: ProjectDto = {
  id: ProjectId.make("project-layout-test"),
  name: "Mend",
  originUrl: "git@github.com:sealant-sh/mend.git",
  storePath: "/home/developer/.local/share/mend/store/mend/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  teamId: null,
  ownerUserId: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "ambient",
  workspaceImage: null,
  applyDotfiles: false,
  inheritUserSkills: true,
  hotSessions: 0,
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
    expect(entries).toEqual([{ project, live: 4, scope: "everyone" }]);
  });

  it("prints where a project is visible: you, the team's name, or everyone", () => {
    const teams = [{ team: { id: "team-1", name: "Platform" } }];
    expect(scopeLabel({ teamId: null, ownerUserId: "me" }, teams)).toBe("you");
    expect(scopeLabel({ teamId: null, ownerUserId: null }, teams)).toBe("everyone");
    expect(scopeLabel({ teamId: TeamId.make("team-1"), ownerUserId: null }, teams)).toBe(
      "Platform",
    );
    // Between a roster change and the refetch the team may be unknown; never invent a name.
    expect(scopeLabel({ teamId: TeamId.make("team-9"), ownerUserId: null }, undefined)).toBe(
      "team",
    );
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
