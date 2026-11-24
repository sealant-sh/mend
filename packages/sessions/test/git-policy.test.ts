import { describe, expect, it } from "vitest";

import type { GitTransportCeiling } from "../src/access-policy.ts";
import { decideGitTransport, repositoryKey } from "../src/git-policy.ts";

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

  it("pushes to the origin's repository on a forge however git spells it", () => {
    for (const repository of ["acme/api.git", "/acme/api.git", "acme/api", "ACME/Api.git/"]) {
      expect(decide("push", repository), repository).toEqual({ ok: true });
    }
    // An HTTPS origin and an SSH push name one repository on a forge.
    expect(
      decide("push", "acme/api.git", { originUrl: "https://github.com/acme/api.git" }),
    ).toEqual({ ok: true });
  });

  it("keeps a plain SSH server's leading slash and case", () => {
    const plain = {
      originUrl: "ssh://git@git.acme.dev:2222/srv/git/api.git",
      host: "git@git.acme.dev",
      port: 2222,
    };
    expect(decide("push", "/srv/git/api.git", plain)).toEqual({ ok: true });
    expect(decide("push", "/srv/git/api", plain)).toEqual({ ok: true });
    expect(decide("push", "srv/git/api.git", plain).ok).toBe(false);
    expect(decide("push", "/srv/git/API.git", plain).ok).toBe(false);
    const scp = { originUrl: "git@git.acme.dev:acme/api.git", host: "git@git.acme.dev" };
    expect(decide("push", "acme/api.git", scp)).toEqual({ ok: true });
    expect(decide("push", "acme/API.git", scp).ok).toBe(false);
    expect(decide("push", "/acme/api.git", scp).ok).toBe(false);
  });

  it("refuses a push to another repository on the same host", () => {
    for (const repository of [
      "acme/other.git",
      "acme/api-fork.git",
      "acme/api/../other.git",
      "acme/api.git/../../other/x",
      "acme//api.git",
      "acme%2Fapi.git",
      "acme/api%2F..%2F..%2Fother",
      "acme/%2561pi.git",
      // Kelvin sign: a Unicode fold would read it as `k`.
      "acme/\u212Api.git",
    ]) {
      const decision = decide("push", repository, { originUrl: "git@github.com:acme/kpi.git" });
      expect(decision.ok, repository).toBe(false);
    }
    expect(decide("push", "acme/other.git")).toMatchObject({
      message: expect.stringContaining(
        "pushes only to this project's own repository (acme/api.git)",
      ),
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
    for (const originUrl of [
      "https://github.com/acme//api.git",
      // A URL parser would collapse this to `/org/other.git` before anything could see the `..`.
      "https://github.com/org/allowed/../other.git",
      "https://github.com/acme/%2561pi.git",
    ]) {
      expect(decide("push", "org/other.git", { originUrl }), originUrl).toMatchObject({
        ok: false,
        message: expect.stringContaining("cannot read one repository"),
      });
    }
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

describe("repositoryKey", () => {
  it("folds ASCII case and the leading slash on a forge only", () => {
    expect(repositoryKey("/Acme/API.git", "github.com")).toBe("acme/api");
    expect(repositoryKey("/Acme/API.git", "git.acme.dev")).toBe("/Acme/API");
    expect(repositoryKey("~user/repo.git/", "git.acme.dev")).toBe("~user/repo");
    expect(repositoryKey("acme/\u212Api", "github.com")).toBe("acme/\u212Api");
  });

  it("refuses a path that reads more than one way", () => {
    for (const path of [
      "",
      "/",
      ".git",
      "a/.git",
      "//a",
      "a/../b",
      "a/./b",
      "a//b",
      "a\\b",
      "a/\u0000b",
    ]) {
      expect(repositoryKey(path, "github.com"), JSON.stringify(path)).toBeNull();
    }
  });
});
