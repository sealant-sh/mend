import { describe, expect, it } from "vitest";

import { repositoryIdentityOf } from "../src/repository-identity.ts";

describe("repository identity", () => {
  it("groups HTTPS and SSH spelling, strips URL credentials, and ignores local origins", () => {
    const https = repositoryIdentityOf(
      "https://user:password@github.com/Sealant-SH/Mend.git",
      "/project",
    );
    const ssh = repositoryIdentityOf("git@github.com:sealant-sh/mend.git", "/another");
    expect(https?.canonicalKey).toBe(ssh?.canonicalKey);
    expect(https?.locator.remoteUrl).not.toContain("password");
    expect(repositoryIdentityOf("../other", "/project")).toBeNull();
    expect(repositoryIdentityOf("file:///repo", "/project")).toBeNull();
    expect(
      repositoryIdentityOf("ssh://git@ssh.dev.azure.com/v3/Org/Project/Repo", "/project")
        ?.canonicalKey,
    ).toBe("dev.azure.com/org/project/_git/repo");
  });
});
