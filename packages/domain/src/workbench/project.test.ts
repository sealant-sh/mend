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
    // Shell metacharacters never make it into a host.
    expect(gitRemoteLocation("ssh://a$(id).evil.com/acme/api.git")).toBeNull();
    expect(gitRemoteLocation("ssh://a`hostname`.evil.com/acme/api.git")).toBeNull();
    expect(gitRemoteLocation("ssh://a;id.evil.com/acme/api.git")).toBeNull();
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

  it("reads the destination git hands ssh, which carries the remote's user", () => {
    // `git push` to git@github.com:acme/api.git runs `ssh git@github.com …`: refusing that as
    // "another host" refused every push and fetch to the project's own origin.
    expect(isSameGitRemote(origin, { host: "git@github.com", port: null })).toBe(true);
    expect(isSameGitRemote(origin, { host: "deploy@GitHub.com", port: 22 })).toBe(true);
    expect(isSameGitRemote(origin, { host: "git@gitlab.com", port: null })).toBe(false);
    expect(isSameGitRemote(origin, { host: "git@github.com", port: 2222 })).toBe(false);
  });

  it("takes the host after the last @, as ssh does, so a user cannot pose as the origin", () => {
    expect(isSameGitRemote(origin, { host: "github.com@evil.example", port: null })).toBe(false);
    expect(isSameGitRemote(origin, { host: "git@github.com@evil.example", port: null })).toBe(
      false,
    );
  });
});
