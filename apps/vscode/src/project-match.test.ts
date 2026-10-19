import { describe, expect, it } from "vitest";

import { matchProject, originKey, originProjectName, redactOrigin } from "./project-match.js";
import type { Project, RepositoryFacts } from "./types.js";

const project = (id: string, name: string, originUrl: string | null): Project => ({
  id,
  name,
  originUrl,
  storePath: `/var/lib/mend/store/${name}/repo`,
  defaultBranch: "main",
});

const clone = (folder: string, originUrl: string | null): RepositoryFacts => ({
  path: `/home/dana/src/${folder}`,
  folder,
  originUrl,
  originUnknown: false,
});

/** A window on a folder under Mend's store, whose origin no project has. */
const worktree = (path: string): RepositoryFacts => ({
  path,
  folder: path.split("/").at(-1) ?? "",
  originUrl: "/var/lib/mend/store/mend/repo",
  originUnknown: false,
});

describe("originKey", () => {
  it("reads https, ssh and scp forms of one repository as one key", () => {
    const forms = [
      "https://github.com/sealant-sh/mend.git",
      "https://github.com/sealant-sh/mend",
      "https://dana:ghp_token@github.com/sealant-sh/mend.git/",
      "ssh://git@github.com/sealant-sh/mend.git",
      "ssh://git@github.com:22/sealant-sh/mend",
      "git+ssh://git@GitHub.com/sealant-sh/mend.git",
      "git@github.com:sealant-sh/mend.git",
      "github.com:sealant-sh/mend",
      "git@github.com:/sealant-sh/mend.git",
    ];
    expect(new Set(forms.map(originKey))).toEqual(new Set(["github.com/sealant-sh/mend"]));
  });

  it("keeps a port that is not its scheme's default", () => {
    expect(originKey("ssh://git@git.example.com:2222/team/api.git")).toBe(
      "git.example.com:2222/team/api",
    );
    expect(originKey("ssh://git@git.example.com:2222/team/api.git")).not.toBe(
      originKey("ssh://git@git.example.com:2223/team/api.git"),
    );
    expect(originKey("https://git.example.com:8443/team/api")).toBe(
      "git.example.com:8443/team/api",
    );
    expect(originKey("https://git.example.com:443/team/api")).toBe("git.example.com/team/api");
  });

  it("compares the host without case and the path exactly", () => {
    expect(originKey("https://GIT.Example.com/team/api")).toBe(
      originKey("git@git.example.com:team/api.git"),
    );
    expect(originKey("git@git.example.com:team/Repo.git")).not.toBe(
      originKey("git@git.example.com:team/repo.git"),
    );
    expect(originKey("https://git.example.com/team/Repo")).not.toBe(
      originKey("https://git.example.com/team/repo"),
    );
  });

  it("keeps an IPv6 host's brackets, and reads local paths as file paths", () => {
    expect(originKey("ssh://git@[fd00::1]:2222/team/api.git")).toBe("[fd00::1]:2222/team/api");
    expect(originKey("git@[fd00::1]:team/api.git")).toBe("[fd00::1]/team/api");
    expect(originKey("/srv/git/api.git/")).toBe("file:/srv/git/api.git");
    expect(originKey("file:///srv/git/api.git")).toBe("file:/srv/git/api.git");
    expect(originKey("/srv/git/api")).not.toBe(originKey("/srv/git/api.git"));
    expect(originKey(null)).toBeNull();
    expect(originKey("  ")).toBeNull();
  });
});

describe("redactOrigin", () => {
  it("drops a URL's userinfo and leaves everything else as git has it", () => {
    expect(redactOrigin("https://dana:ghp_token@github.com/sealant-sh/mend.git")).toBe(
      "https://github.com/sealant-sh/mend.git",
    );
    expect(redactOrigin("https://x-access-token@github.com/a/b")).toBe("https://github.com/a/b");
    expect(redactOrigin("ssh://git@git.example.com:2222/team/api.git")).toBe(
      "ssh://git.example.com:2222/team/api.git",
    );
    expect(redactOrigin("git@github.com:sealant-sh/mend.git")).toBe(
      "git@github.com:sealant-sh/mend.git",
    );
  });
});

describe("originProjectName", () => {
  it("names the project after the origin's last segment", () => {
    expect(originProjectName("https://dana:t@github.com/sealant-sh/Newsroom-Web.git")).toBe(
      "newsroom-web",
    );
    expect(originProjectName("git@github.com:sealant-sh/mend.git")).toBe("mend");
  });
});

describe("matchProject", () => {
  const server = project("p1", "newsroom-api", "git@github.com:org/server.git");
  const mend = project("p2", "mend", "https://github.com/sealant-sh/mend.git");

  it("never takes a project by folder name once the window has an origin", () => {
    expect(
      matchProject([server, mend], clone("newsroom-api", "git@github.com:other/newsroom-api.git")),
    ).toEqual({ status: "not-found" });
  });

  it("takes the folder name only when the window has no origin", () => {
    expect(matchProject([server, mend], clone("newsroom-api", null))).toEqual({
      status: "matched",
      project: server,
      matchedBy: "folder-name",
    });
  });

  it("takes no folder name when git did not answer for the origin", () => {
    expect(
      matchProject([server, mend], { ...clone("newsroom-api", null), originUnknown: true }),
    ).toEqual({ status: "not-found" });
  });

  it("matches the origin in any of git's forms", () => {
    expect(matchProject([server, mend], clone("work", "ssh://git@github.com/org/server"))).toEqual({
      status: "matched",
      project: server,
      matchedBy: "origin",
    });
  });

  it("tells repositories apart by port and by path case", () => {
    const left = project("p3", "api", "ssh://git@git.example.com:2222/team/api.git");
    const right = project("p4", "api-b", "ssh://git@git.example.com:2223/team/api.git");
    const upper = project("p5", "repo-upper", "git@git.example.com:team/Repo.git");
    const projects = [left, right, upper];
    expect(
      matchProject(projects, clone("api", "ssh://git@git.example.com:2223/team/api")),
    ).toMatchObject({ status: "matched", project: right });
    expect(matchProject(projects, clone("repo", "git@git.example.com:team/repo.git"))).toEqual({
      status: "not-found",
    });
  });

  it("asks when several adopted projects share the window's origin", () => {
    const twin = project("p3", "server-2", "https://github.com/org/server");
    expect(
      matchProject([server, mend, twin], clone("server", "git@github.com:org/server.git")),
    ).toEqual({ status: "ambiguous", candidates: [server, twin], matchedBy: "origin" });
  });

  it("matches a folder that is the adopted source itself, whatever its origin", () => {
    const local = project("p3", "tool", "/home/dana/src/tool");
    expect(
      matchProject([server, local], clone("tool", "git@github.com:dana/tool.git")),
    ).toMatchObject({ status: "matched", project: local, matchedBy: "path" });
  });

  it("does not take a separate repository nested inside an adopted source", () => {
    const parent = project("p3", "parent", "/home/dana/src/parent");
    expect(
      matchProject([server, parent], clone("parent/vendor/other", "git@host:other/repo.git")),
    ).toEqual({ status: "not-found" });
    expect(matchProject([server, parent], clone("parent/vendor/other", null))).toEqual({
      status: "not-found",
    });
  });

  it("matches one of the project's worktrees in the store, and nothing nested inside one", () => {
    expect(
      matchProject([server, mend], worktree("/var/lib/mend/store/mend/worktrees/fix-login")),
    ).toEqual({ status: "matched", project: mend, matchedBy: "path" });
    expect(
      matchProject(
        [server, mend],
        worktree("/var/lib/mend/store/mend/worktrees/fix-login/vendor/other"),
      ),
    ).toEqual({ status: "not-found" });
    expect(matchProject([server, mend], worktree("/var/lib/mend/store/mend/worktrees/"))).toEqual({
      status: "not-found",
    });
  });
});
