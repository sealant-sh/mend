import { describe, expect, it } from "vitest";

import { gitRemoteLocation, isSameGitRemote } from "./project.ts";

describe("gitRemoteLocation", () => {
  it("reads the host and port git dials, for URLs and SCP-style remotes", () => {
    expect(gitRemoteLocation("git@GitHub.com:acme/api.git")).toEqual({
      scheme: "ssh",
      host: "github.com",
      port: null,
    });
    expect(gitRemoteLocation("ssh://git@git.acme.dev:2222/acme/api.git")).toEqual({
      scheme: "ssh",
      host: "git.acme.dev",
      port: 2222,
    });
    expect(gitRemoteLocation("https://[::1]:8443/acme/api.git")).toEqual({
      scheme: "https",
      host: "::1",
      port: 8443,
    });
    expect(gitRemoteLocation("git@[fd00::5]:acme/api.git")).toEqual({
      scheme: "ssh",
      host: "fd00::5",
      port: null,
    });
    expect(gitRemoteLocation("/tmp/repo")).toBeNull();
    expect(gitRemoteLocation("file:///tmp/repo")).toBeNull();
  });
});

describe("isSameGitRemote", () => {
  const origin = { scheme: "ssh" as const, host: "github.com", port: null };

  it("matches the origin's host and ssh port, and nothing else", () => {
    expect(isSameGitRemote(origin, { host: "GitHub.com", port: null })).toBe(true);
    expect(isSameGitRemote(origin, { host: "github.com", port: 22 })).toBe(true);
    expect(isSameGitRemote(origin, { host: "github.com", port: 2222 })).toBe(false);
    expect(isSameGitRemote(origin, { host: "gitlab.com", port: null })).toBe(false);
  });
});
