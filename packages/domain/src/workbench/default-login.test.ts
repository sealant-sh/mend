import { describe, expect, it } from "vitest";

import { loginChoiceOf, noLoginChosenWords } from "./default-login.ts";

const account = (
  id: string,
  provider: string,
  isDefault: boolean,
  status: "active" | "invalid" | "archived" = "active",
) => ({ id, provider, isDefault, status, name: id });

describe("loginChoiceOf", () => {
  it("finds the default by isDefault when its name is not default", () => {
    const accounts = [
      account("default", "claude", false),
      account("work", "claude", true),
      account("default", "codex", true),
    ];
    expect(loginChoiceOf(accounts, "claude")).toEqual({ _tag: "chosen", account: accounts[1] });
  });

  it("reports every account of the provider when none is the default", () => {
    const accounts = [
      account("work", "claude", false),
      account("home", "claude", false),
      account("default", "codex", true),
    ];
    expect(loginChoiceOf(accounts, "claude")).toEqual({
      _tag: "unchosen",
      accounts: [accounts[0], accounts[1]],
    });
  });

  it("chooses an invalid default rather than another active account", () => {
    const accounts = [account("work", "codex", true, "invalid"), account("home", "codex", false)];
    expect(loginChoiceOf(accounts, "codex")).toEqual({ _tag: "chosen", account: accounts[0] });
  });

  it("never counts an archived account", () => {
    expect(loginChoiceOf([account("default", "github", true, "archived")], "github")).toEqual({
      _tag: "none",
    });
  });

  it("is none for a provider the person never connected", () => {
    expect(loginChoiceOf([account("default", "claude", true)], "codex")).toEqual({ _tag: "none" });
  });
});

describe("noLoginChosenWords", () => {
  it("names the provider as people write it", () => {
    expect(noLoginChosenWords("github")).toBe("No GitHub login chosen");
  });
});
