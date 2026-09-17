import { describe, expect, it } from "vitest";

import { githubAuthority, NO_GITHUB_IDENTITY } from "./github-identity.ts";

describe("GitHub API identity (docs/adr/0003)", () => {
  it("lets the operator of a single-organization install use the host's gh login", () => {
    expect(githubAuthority("single", true)).toEqual({ kind: "host-gh" });
  });

  it("gives everyone else no identity, with the reason", () => {
    expect(githubAuthority("single", false)).toEqual({ kind: "none", detail: NO_GITHUB_IDENTITY });
    expect(githubAuthority("multi", true)).toEqual({ kind: "none", detail: NO_GITHUB_IDENTITY });
  });
});
