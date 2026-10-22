import { describe, expect, it } from "vitest";

import { originMatches, sameRepository } from "./origin.ts";

describe("originMatches", () => {
  it("matches https, ssh and scp spellings of one repository", () => {
    for (const remote of [
      "https://github.com/acme/api.git",
      "ssh://git@github.com/acme/api",
      "git@github.com:acme/api.git",
      "  git@github.com:acme/api.git\n",
    ]) {
      expect(originMatches(remote, "git@github.com:acme/api.git", "/work"), remote).toBe(true);
    }
    expect(originMatches("https://github.com/other/api.git", "git@github.com:acme/api", "/w")).toBe(
      false,
    );
  });

  it("compares a path's case except on GitHub, and a host's never", () => {
    expect(originMatches("https://GitHub.com/Acme/API.git", "git@github.com:acme/api", "/w")).toBe(
      true,
    );
    expect(
      originMatches("https://Git.Example.com/team/repo", "https://git.example.com/team/repo", "/w"),
    ).toBe(true);
    expect(
      originMatches("https://git.example.com/Team/Repo", "https://git.example.com/team/repo", "/w"),
    ).toBe(false);
  });

  it("matches a port only to the same port, a scheme's default written or not", () => {
    expect(
      originMatches(
        "ssh://git@git.example.com:22/acme/api.git",
        "git@git.example.com:acme/api",
        "/w",
      ),
    ).toBe(true);
    expect(
      originMatches(
        "ssh://git@git.example.com:2222/acme/api.git",
        "git@git.example.com:acme/api.git",
        "/w",
      ),
    ).toBe(false);
    expect(
      originMatches(
        "https://git.example.com:8443/acme/api.git",
        "https://git.example.com:8443/acme/api",
        "/w",
      ),
    ).toBe(true);
  });

  it("matches an origin on this machine by its directory", () => {
    expect(originMatches("file:///srv/api.git", "/srv/api.git", "/work")).toBe(true);
    expect(originMatches("/srv/api.git", "file:///srv/api.git", "/work")).toBe(true);
    expect(originMatches("../srv/api.git", "/home/me/srv/api.git", "/home/me/work")).toBe(true);
    expect(originMatches("../srv/api.git", "/srv/api.git", "/home/me/work")).toBe(false);
  });

  it("never matches a local path to a URL origin", () => {
    expect(originMatches("/srv/api.git", "https://github.com/acme/api.git", "/work")).toBe(false);
  });

  it("matches nothing when the project has no origin", () => {
    expect(originMatches("https://github.com/acme/api.git", null, "/work")).toBe(false);
  });
});

describe("sameRepository", () => {
  it("is false for two local paths, which name no remote repository", () => {
    expect(sameRepository("/srv/api.git", "/srv/api.git")).toBe(false);
    expect(sameRepository("", "")).toBe(false);
  });
});
