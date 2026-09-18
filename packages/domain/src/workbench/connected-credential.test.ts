import { describe, expect, it } from "vitest";

import { claudeGrantFacts, narrowCredential, sameGrant } from "./connected-credential.ts";

/** The document Claude Code writes, as a developer machine holds it. */
const document = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: 1_789_000_000_000,
      refreshTokenExpiresAt: 1_791_000_000_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    },
    mcpOAuth: {
      "figma:https://figma.com": { refreshToken: "figma-refresh" },
      "linear:https://linear.app": { refreshToken: "linear-refresh" },
    },
    ...overrides,
  });

describe("narrowCredential", () => {
  /**
   * The finding this exists for: the whole document used to travel, so a person's Figma, Atlassian
   * and Linear refresh tokens reached the platform's database and every workspace.
   */
  it("sends the Claude grant and leaves the MCP tokens on the machine that authorized them", () => {
    const result = narrowCredential("claude", document());
    if (result.kind !== "narrowed") throw new Error(`expected narrowed, got ${result.kind}`);
    expect(result.dropped).toEqual(["mcpOAuth"]);
    expect(result.secret).not.toContain("figma-refresh");
    expect(result.secret).not.toContain("linear-refresh");
    // The grant itself is untouched, tokens included: the CLI in the workspace needs all of it.
    const sent: unknown = JSON.parse(result.secret);
    expect(sent).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-access",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAt: 1_789_000_000_000,
        refreshTokenExpiresAt: 1_791_000_000_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_max_20x",
      },
    });
    expect(result.secret.endsWith("\n")).toBe(true);
  });

  it("names every section it dropped, so a person can be told what stayed behind", () => {
    const result = narrowCredential("claude", document({ someLaterSection: { token: "x" } }));
    expect(result.kind === "narrowed" ? result.dropped : []).toEqual([
      "mcpOAuth",
      "someLaterSection",
    ]);
  });

  /** Narrowing must never mangle a payload whose shape it does not know. */
  it("leaves anything that is not a Claude credential document alone", () => {
    // A setup token: a bare string, not a document.
    expect(narrowCredential("claude", "sk-ant-oat01-setup-token")).toEqual({
      kind: "unchanged",
      secret: "sk-ant-oat01-setup-token",
    });
    // A document without the grant section.
    const other = JSON.stringify({ mcpOAuth: {} });
    expect(narrowCredential("claude", other)).toEqual({ kind: "unchanged", secret: other });
    // Malformed, an array, and another provider's file.
    expect(narrowCredential("claude", "{not json").kind).toBe("unchanged");
    expect(narrowCredential("claude", "[1,2]").kind).toBe("unchanged");
    const codex = document();
    expect(narrowCredential("codex", codex)).toEqual({ kind: "unchanged", secret: codex });
  });
});

describe("claudeGrantFacts", () => {
  it("reads the expiries and the subscription, and never a token", () => {
    const facts = claudeGrantFacts(document());
    expect(facts?.accessExpiresAt?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
    expect(facts?.refreshExpiresAt?.toISOString()).toBe(new Date(1_791_000_000_000).toISOString());
    expect(facts?.subscriptionType).toBe("max");
    expect(facts?.hasRefreshToken).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("sk-ant");
  });

  /** A grant the CLI cleared after `invalid_grant` keeps its shape and loses its tokens. */
  it("reports a cleared grant as having no refresh token", () => {
    const cleared = JSON.stringify({
      claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
    });
    const facts = claudeGrantFacts(cleared);
    expect(facts).not.toBeNull();
    expect(facts?.hasRefreshToken).toBe(false);
    expect(facts?.accessExpiresAt).toBeNull();
  });

  it("answers null for a setup token or nonsense, so freshness is reported as unknown", () => {
    expect(claudeGrantFacts("sk-ant-oat01-setup-token")).toBeNull();
    expect(claudeGrantFacts("{")).toBeNull();
  });
});

describe("sameGrant", () => {
  /**
   * Two copies of one grant race on refresh and the second one is logged out, so Mend refuses to
   * connect the credential it already shares with the person's own login.
   */
  it("is true for one grant in two places and false for two grants", () => {
    expect(sameGrant(document(), document({ mcpOAuth: {} }))).toBe(true);
    const other = JSON.stringify({
      claudeAiOauth: { refreshToken: "sk-ant-ort01-other" },
    });
    expect(sameGrant(document(), other)).toBe(false);
  });

  it("is false when either side carries no refresh token to compare", () => {
    expect(sameGrant(document(), "sk-ant-oat01-setup-token")).toBe(false);
    expect(sameGrant("{}", "{}")).toBe(false);
  });
});
