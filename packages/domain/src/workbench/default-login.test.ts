import { describe, expect, it } from "vitest";

import { isChosenDefault, loginChoiceOf, unchosenLoginSummary } from "./default-login.ts";

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

describe("isChosenDefault", () => {
  it("takes the flag when it is sent, false included", () => {
    expect(isChosenDefault({ name: "work", isDefault: true })).toBe(true);
    expect(isChosenDefault({ name: "default", isDefault: false })).toBe(false);
  });

  it("takes the account named default when the flag is absent", () => {
    expect(isChosenDefault({ name: "default" })).toBe(true);
    expect(isChosenDefault({ name: "work" })).toBe(false);
  });
});

describe("unchosenLoginSummary", () => {
  it("asks for the only account to be connected again", () => {
    expect(unchosenLoginSummary("github", 1)).toEqual({
      words: "No GitHub login chosen",
      count: 1,
      reason:
        "No GitHub login chosen: Mend holds 1 of yours, and sessions use only the chosen one.",
      remedy:
        "Connect GitHub again to choose it: run mend connect github, or Connect in Settings → Connected accounts.",
      command: "mend connect github",
    });
  });

  it("asks for the others to be removed when several are held", () => {
    expect(unchosenLoginSummary("claude", 2).remedy).toBe(
      "Remove the others with mend connect claude --remove <name>, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.",
    );
  });
});
