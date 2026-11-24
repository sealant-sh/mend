import { describe, expect, it } from "vitest";

import type { GitTransportCeiling } from "../src/access-policy.ts";
import { canonicalRepositoryPath, decideGitTransport } from "../src/git-policy.ts";

/**
 * Mend's Git signer (agent-home workspace-isolation-architecture.md §7.4): fetches bound to the
 * origin's host, pushes to its repository, all of it under the worktree's `gitTransport` cap.
 */

const ORIGIN = "git@github.com:acme/api.git";

const decide = (
  kind: "fetch" | "push" | "archive",
  repository: string,
  options: {
    readonly ceiling?: GitTransportCeiling;
    readonly originUrl?: string | null;
    readonly host?: string;
    readonly port?: number | null;
    readonly bindToOrigin?: boolean;
    readonly repositoryOrigins?: ReadonlyArray<string>;
  } = {},
) =>
  decideGitTransport({
    ceiling: options.ceiling ?? "read-write",
    kind,
    repository,
    target: { host: options.host ?? "git@github.com", port: options.port ?? null },
    originUrl: options.originUrl === undefined ? ORIGIN : options.originUrl,
    repositoryOrigins: options.repositoryOrigins ?? [],
    bindToOrigin: options.bindToOrigin ?? true,
  });

describe("decideGitTransport", () => {
  it("fetches another repository on the origin's host: submodules and dependencies", () => {
    expect(decide("fetch", "acme/shared-lib.git")).toEqual({ ok: true });
    expect(decide("archive", "other-org/tool.git")).toEqual({ ok: true });
  });

  it("pushes to the origin's repository however git spells it", () => {
    for (const repository of ["acme/api.git", "/acme/api.git", "acme/api", "ACME/Api.git/"]) {
      expect(decide("push", repository), repository).toEqual({ ok: true });
    }
    expect(
      decide("push", "/acme/api.git", {
        originUrl: "ssh://git@git.acme.dev:2222/acme/api.git",
        host: "git@git.acme.dev",
        port: 2222,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a push to another repository on the same host", () => {
    for (const repository of [
      "acme/other.git",
      "acme/api-fork.git",
      "acme/api/../other.git",
      "acme/api.git/../../other/x",
      "acme//api.git",
      "acme/api%2F..%2F..%2Fother",
      "acme/%2561pi.git",
    ]) {
      const decision = decide("push", repository);
      expect(decision.ok, repository).toBe(false);
    }
    expect(decide("push", "acme/other.git")).toMatchObject({
      message: expect.stringContaining("pushes only to this project's own repository (acme/api)"),
    });
  });

  it("pushes to another repository the session holds on the origin's host (ADR 0011)", () => {
    const repositoryOrigins = ["git@github.com:acme/web.git", "git@gitlab.com:acme/infra.git"];
    expect(decide("push", "acme/web.git", { repositoryOrigins })).toEqual({ ok: true });
    // A held repository on another host is not the target's: the target is still refused.
    expect(decide("push", "acme/infra.git", { repositoryOrigins }).ok).toBe(false);
  });

  it("refuses a push when the origin is missing or names no one repository", () => {
    expect(decide("push", "acme/api.git", { originUrl: null })).toMatchObject({
      ok: false,
      message: expect.stringContaining("has no origin"),
    });
    expect(
      decide("push", "acme/api.git", {
        originUrl: "https://github.com/acme//api.git",
        host: "github.com",
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("cannot read one repository") });
    // A fetch without an origin is not bound to one, as before.
    expect(decide("fetch", "acme/api.git", { originUrl: null })).toEqual({ ok: true });
  });

  it("refuses both kinds on another host", () => {
    expect(decide("fetch", "acme/api.git", { host: "git@gitlab.com" }).ok).toBe(false);
    expect(decide("push", "acme/api.git", { host: "git@gitlab.com" }).ok).toBe(false);
  });

  it("caps the signer by the worktree's gitTransport", () => {
    expect(decide("fetch", "acme/api.git", { ceiling: "read-only" })).toEqual({ ok: true });
    expect(decide("archive", "acme/api.git", { ceiling: "read-only" })).toEqual({ ok: true });
    expect(decide("push", "acme/api.git", { ceiling: "read-only" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("gitTransport: read-only"),
    });
    for (const kind of ["fetch", "push", "archive"] as const) {
      expect(decide(kind, "acme/api.git", { ceiling: "disabled" })).toMatchObject({
        ok: false,
        message: expect.stringContaining("gitTransport: disabled"),
      });
    }
  });

  it("keeps the cap when the operator unbinds the signer from the origin", () => {
    expect(decide("push", "someone/fork.git", { bindToOrigin: false })).toEqual({ ok: true });
    expect(
      decide("push", "someone/fork.git", { bindToOrigin: false, ceiling: "read-only" }).ok,
    ).toBe(false);
  });
});

describe("canonicalRepositoryPath", () => {
  it("reads one spelling per repository", () => {
    expect(canonicalRepositoryPath("/Acme/API.git")).toBe("acme/api");
    expect(canonicalRepositoryPath("acme/my%20repo.git")).toBe("acme/my repo");
    expect(canonicalRepositoryPath("~user/repo.git")).toBe("~user/repo");
  });

  it("refuses a path that reads more than one way", () => {
    for (const path of [
      "",
      "/",
      ".git",
      "a/../b",
      "a/./b",
      "a//b",
      "a\\b",
      "a/%zz",
      "a/%252e%252e/b",
      "a/\u0000b",
    ]) {
      expect(canonicalRepositoryPath(path), JSON.stringify(path)).toBeNull();
    }
  });
});
