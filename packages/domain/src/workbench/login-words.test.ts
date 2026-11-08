import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { keyDisconnectWords, keySpendWords, LoginClass, loginWords } from "./login-words.ts";

describe("loginWords", () => {
  it("names a subscription as it always has", () => {
    expect(loginWords("claude", { kind: "subscription" }, "added-it")).toBe(
      "Claude · subscription",
    );
  });

  it("names a key by its last four characters and how it bills", () => {
    expect(loginWords("codex", { kind: "api-key", suffix: "a1b2" }, "added-it")).toBe(
      "Codex · API key ····a1b2 · billed per token",
    );
  });

  it("adds the endpoint's host for the person who added the login", () => {
    expect(
      loginWords(
        "claude",
        { kind: "api-key", suffix: "a1b2", endpointHost: "gateway.example.com" },
        "added-it",
      ),
    ).toBe("Claude · API key ····a1b2 · billed per token · endpoint gateway.example.com");
  });

  it("keeps the endpoint's host from everyone else", () => {
    expect(
      loginWords(
        "claude",
        { kind: "api-key", suffix: "a1b2", endpointHost: "gateway.example.com" },
        "someone-else",
      ),
    ).toBe("Claude · API key ····a1b2 · billed per token");
  });

  it("decodes the login class the platform reports", () => {
    expect(Schema.decodeUnknownSync(LoginClass)({ kind: "api-key", suffix: "a1b2" })).toEqual({
      kind: "api-key",
      suffix: "a1b2",
    });
    expect(() => Schema.decodeUnknownSync(LoginClass)({ kind: "oauth" })).toThrow();
  });
});

describe("the words a key form carries", () => {
  it("says disconnecting leaves the key valid where it was issued", () => {
    expect(keyDisconnectWords("claude")).toBe(
      "The key stays valid at Anthropic until you revoke it in the Anthropic Console.",
    );
    expect(keyDisconnectWords("codex")).toBe(
      "The key stays valid at OpenAI until you revoke it in the OpenAI platform.",
    );
  });

  it("recommends a spend limit where the provider sets one", () => {
    expect(keySpendWords("claude")).toContain("spend limit on the key's workspace");
    expect(keySpendWords("codex")).toContain("budget on the key's project");
  });
});
