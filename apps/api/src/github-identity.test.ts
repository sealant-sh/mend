import { ConnectedAccount } from "@mend/api-contracts";
import { describe, expect, it } from "vitest";

import { githubAuthority, NO_GITHUB_IDENTITY } from "./github-identity.ts";

const account = (
  fields: Partial<Pick<ConnectedAccount, "provider" | "status" | "name" | "isDefault">> & {
    readonly login?: string;
  },
) =>
  new ConnectedAccount({
    id: `account-${fields.login ?? fields.name ?? "x"}`,
    provider: fields.provider ?? "github",
    name: fields.name ?? "default",
    kind: "gh-cli-token",
    status: fields.status ?? "active",
    metadata: fields.login === undefined ? {} : { login: fields.login },
    connectedAt: new Date("2026-11-19T10:00:00Z"),
    updatedAt: new Date("2026-11-19T10:00:00Z"),
    lastUsedAt: null,
    isDefault: fields.isDefault ?? false,
  });

describe("GitHub API identity (docs/adr/0003)", () => {
  it("lets the operator of a single-organization install use the host's gh login", () => {
    expect(githubAuthority("single", true, [])).toEqual({ kind: "host-gh" });
  });

  it("gives everyone else without a GitHub login no identity, with the reason", () => {
    expect(githubAuthority("single", false, [])).toEqual({
      kind: "none",
      detail: NO_GITHUB_IDENTITY,
    });
    expect(githubAuthority("multi", true, [])).toEqual({
      kind: "none",
      detail: NO_GITHUB_IDENTITY,
    });
  });

  it("answers with the caller's own connected GitHub login before the host's", () => {
    expect(githubAuthority("single", true, [account({ login: "linus-p" })])).toEqual({
      kind: "caller",
      login: "linus-p",
      hostGh: true,
    });
    expect(githubAuthority("multi", false, [account({ login: "ada" })])).toEqual({
      kind: "caller",
      login: "ada",
      hostGh: false,
    });
  });

  it("uses only a working GitHub login, the chosen one first", () => {
    const refused = account({ login: "old", status: "invalid" });
    const agent = account({ provider: "claude", name: "ada@example.com" });
    expect(githubAuthority("multi", false, [refused, agent])).toEqual({
      kind: "none",
      detail: NO_GITHUB_IDENTITY,
    });
    expect(
      githubAuthority("multi", false, [
        account({ login: "second" }),
        account({ login: "chosen", isDefault: true }),
      ]),
    ).toMatchObject({ kind: "caller", login: "chosen" });
  });
});
