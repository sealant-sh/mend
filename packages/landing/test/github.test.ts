import { describe, expect, it } from "vitest";

import { githubRepositoryOf, pullRequestAvailability, pullRequestBase } from "../src/github.ts";

describe("githubRepositoryOf", () => {
  it("reads owner and name from every spelling adoption accepts", () => {
    for (const url of [
      "https://github.com/acme/api",
      "https://github.com/acme/api.git",
      "https://github.com/acme/api/",
      "http://github.com/acme/api.git",
      "ssh://git@github.com/acme/api.git",
      "ssh://git@github.com:22/acme/api.git",
      "git@github.com:acme/api.git",
      "git@github.com:acme/api",
      "https://www.github.com/acme/api",
    ]) {
      expect(githubRepositoryOf(url), url).toEqual({
        owner: "acme",
        name: "api",
        slug: "acme/api",
      });
    }
  });

  it("keeps dots, dashes and underscores in names", () => {
    expect(githubRepositoryOf("git@github.com:acme-co/my_repo.js.git")?.slug).toBe(
      "acme-co/my_repo.js",
    );
  });

  it("is null for other hosts and for paths that are not owner/name", () => {
    for (const url of [
      "https://gitlab.com/acme/api.git",
      "git@github.example.com:acme/api.git",
      "https://github.com.evil.example/acme/api",
      "https://github.com/acme",
      "https://github.com/acme/api/tree/main",
      "not a url",
    ]) {
      expect(githubRepositoryOf(url), url).toBeNull();
    }
  });
});

describe("pullRequestAvailability", () => {
  it("is available for a GitHub origin", () => {
    expect(pullRequestAvailability("git@github.com:acme/api.git")).toEqual({
      available: true,
      repository: { owner: "acme", name: "api", slug: "acme/api" },
    });
  });

  it("names the host when origin is elsewhere, and the missing origin", () => {
    expect(pullRequestAvailability("https://gitlab.com/acme/api.git")).toEqual({
      available: false,
      reason: "pull request unavailable · origin is on gitlab.com, not GitHub",
    });
    expect(pullRequestAvailability(null)).toEqual({
      available: false,
      reason: "pull request unavailable · the project has no origin",
    });
  });
});

describe("pullRequestBase", () => {
  it("reduces the recorded base to a branch name", () => {
    expect(pullRequestBase("main", "trunk")).toBe("main");
    expect(pullRequestBase("origin/release/2.0", "main")).toBe("release/2.0");
    expect(pullRequestBase("refs/heads/develop", "main")).toBe("develop");
    expect(pullRequestBase("refs/remotes/origin/develop", "main")).toBe("develop");
  });

  it("falls back to the default branch for a commit, HEAD or no base", () => {
    expect(pullRequestBase(null, "main")).toBe("main");
    expect(pullRequestBase("HEAD", "main")).toBe("main");
    expect(pullRequestBase("3f2a1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49", "main")).toBe("main");
  });
});
