import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { adoptedGitAuth, deriveAdoptOffer, submitDashboardAdoption } from "./dashboard-adoption.ts";
import { cwdFacts, matchProjectByCwd } from "./shared.ts";

const project = {
  id: "project-1",
  name: "repo",
  originUrl: "https://host/repo",
  storePath: "/store/repo/repo.git",
  defaultBranch: "main",
};

const rejected = [
  "/srv/repo",
  "../repo",
  "file:///srv/repo",
  "C:/repo",
  "C:repo",
  "--upload-pack=foo@host:repo",
  "ext::/bin/false",
];

describe("dashboard adoption", () => {
  it.each(rejected)("does not offer an inbound origin %s", (originUrl) => {
    expect(deriveAdoptOffer({ cwd: "/checkout", repoRoot: "/checkout", originUrl })).toBeNull();
  });

  it.each(rejected)("refuses selected source %s before sending an API request", async (source) => {
    const requests: unknown[] = [];
    const result = await submitDashboardAdoption(
      async (...args) => {
        requests.push(args);
        return project;
      },
      { name: "repo", source, gitAuthMode: "ambient" },
    );
    expect(result).toEqual({
      kind: "invalid-source",
      message: expect.stringContaining("Local paths and file:// URLs are not supported"),
    });
    expect(requests).toEqual([]);
  });

  it("never offers or sends a checkout origin that carries a token", async () => {
    const originUrl = "https://oauth2:TOKEN@github.com/org/repo.git";
    expect(deriveAdoptOffer({ cwd: "/checkout", repoRoot: "/checkout", originUrl })).toBeNull();
    const requests: unknown[] = [];
    const result = await submitDashboardAdoption(
      async (...args) => {
        requests.push(args);
        return project;
      },
      { name: "repo", source: originUrl, gitAuthMode: "mend-key" },
    );
    expect(result).toEqual({
      kind: "invalid-source",
      message: expect.stringContaining("mend keys"),
    });
    expect(requests).toEqual([]);
  });

  it.each([
    "https://host/team/repo.git",
    "ssh://git@host:2222/team/repo.git",
    "git@host:team/repo.git",
    "git://host/team/repo.git",
  ])("offers and submits %s unchanged", async (source) => {
    const offer = deriveAdoptOffer({
      cwd: "/checkout/Repo/src",
      repoRoot: "/checkout/Repo",
      originUrl: source,
    });
    expect(offer).toEqual({ source, name: "repo", modeIndex: 0 });
    if (offer === null) throw new Error("Expected a network adoption offer");
    const requests: unknown[] = [];
    const result = await submitDashboardAdoption(
      async (...args) => {
        requests.push(args);
        return { ...project, originUrl: source };
      },
      { ...offer, gitAuthMode: "bridge" },
    );
    expect(requests).toEqual([
      ["POST", "/projects", { name: "repo", source, gitAuthMode: "bridge" }],
    ]);
    expect(result).toEqual({ kind: "adopted", project: { ...project, originUrl: source } });
  });

  it("preserves API errors for the mutation's error handler", async () => {
    const error = new Error("Clone failed on the server");
    await expect(
      submitDashboardAdoption(
        async () => {
          throw error;
        },
        {
          name: "repo",
          source: "git@host:repo",
          gitAuthMode: "ambient",
        },
      ),
    ).rejects.toBe(error);
  });

  it("does not offer a checkout without a network origin or a repository root", () => {
    expect(
      deriveAdoptOffer({ cwd: "/checkout", repoRoot: "/checkout", originUrl: null }),
    ).toBeNull();
    expect(
      deriveAdoptOffer({ cwd: "/checkout", repoRoot: null, originUrl: "https://host/repo" }),
    ).toBeNull();
  });

  it("reads real Git origins without treating local origins as adoption candidates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dashboard-adopt-"));
    try {
      execFileSync("git", ["init", "-b", "main", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", "/srv/repo"]);
      const local = cwdFacts(root);
      expect(local.originUrl).toBe("/srv/repo");
      expect(deriveAdoptOffer(local)).toBeNull();
      // Legacy path-based project selection remains independent of adoption.
      const legacy = { ...project, originUrl: root };
      expect(matchProjectByCwd([legacy], local)).toBe(legacy);

      execFileSync("git", ["-C", root, "remote", "set-url", "origin", "git@host:repo"]);
      const remote = cwdFacts(root);
      expect(deriveAdoptOffer(remote)?.source).toBe("git@host:repo");
      expect(matchProjectByCwd([project], remote)).toBe(project);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what adopt says signed the clone", () => {
  it("names the Mend key only for an ssh clone, which it signed", () => {
    for (const source of ["git@github.com:octocat/Hello-World.git", "ssh://git@host/repo.git"]) {
      expect(adoptedGitAuth(source, "mend-key")).toEqual({
        value: "mend key",
        note: "your Mend key signed this clone",
      });
    }
  });

  it("says an https or git:// clone went without the key, whatever the project's mode", () => {
    expect(adoptedGitAuth("https://github.com/octocat/Hello-World", "mend-key")).toEqual({
      value: "https",
      note: "cloned over https, which your Mend key does not sign; it signs ssh remotes",
    });
    expect(adoptedGitAuth("git://host/repo.git", "bridge")).toEqual({
      value: "git",
      note: "cloned over git, which the connected `mend keys share` does not sign; it signs ssh remotes",
    });
    expect(adoptedGitAuth("https://host/repo.git", "ambient")).toBeNull();
  });
});
