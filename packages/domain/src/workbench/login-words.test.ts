import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { LoginClass, loginWords } from "./login-words.ts";

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
