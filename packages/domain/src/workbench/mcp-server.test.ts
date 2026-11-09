import { Redacted, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MCP_SERVER_LIMITS,
  McpServerName,
  applySecretEdits,
  mcpSecretsIssue,
  mcpServerNameIssue,
  parseMcpTransport,
} from "./mcp-server.ts";

const set = (value: string) => ({ _tag: "Set" as const, value: Redacted.make(value) });
const keep = { _tag: "Keep" as const };

describe("applySecretEdits", () => {
  const saved = { GITHUB_TOKEN: "ghp-saved", OTHER: "other-saved" };

  it("keeps every saved secret when the write names none", () => {
    expect(applySecretEdits(saved, undefined)).toEqual(Result.succeed(saved));
  });

  it("keeps a Keep, replaces a Set, adds a new Set and removes a name left out", () => {
    expect(applySecretEdits(saved, { GITHUB_TOKEN: keep, NEW: set("new-value") })).toEqual(
      Result.succeed({ GITHUB_TOKEN: "ghp-saved", NEW: "new-value" }),
    );
    expect(applySecretEdits(saved, { OTHER: set("replaced") })).toEqual(
      Result.succeed({ OTHER: "replaced" }),
    );
    expect(applySecretEdits(saved, {})).toEqual(Result.succeed({}));
  });

  it("refuses a Keep of a name with no saved value, inherited names included", () => {
    for (const name of ["MISSING", "constructor", "toString"]) {
      expect(applySecretEdits(saved, { [name]: keep })).toEqual(
        Result.fail("Keep names a secret this server does not have"),
      );
    }
  });
});

describe("server names", () => {
  it("takes lowercase names up to 48 characters", () => {
    for (const name of ["figma", "github", "my-server_2", "a".repeat(48)]) {
      expect(mcpServerNameIssue(name)).toBeNull();
    }
  });

  it("refuses Mend's own names and malformed ones", () => {
    for (const name of ["mend", "executor", "mend-tools"]) {
      expect(mcpServerNameIssue(name)).toBe(
        "mend, executor and names starting with mend- are Mend's own",
      );
    }
    for (const name of ["", "Figma", "1password", "-x", "a".repeat(49), "a b", "a.b"]) {
      expect(mcpServerNameIssue(name)).not.toBeNull();
    }
  });

  it("brands only a valid name", () => {
    expect(Schema.is(McpServerName)("figma")).toBe(true);
    expect(Schema.is(McpServerName)("mend")).toBe(false);
  });
});

describe("parseMcpTransport", () => {
  it("takes an http(s) URL", () => {
    expect(parseMcpTransport({ _tag: "http", url: "https://mcp.figma.com/mcp" })).toEqual(
      Result.succeed({ _tag: "http", url: "https://mcp.figma.com/mcp" }),
    );
    expect(
      Result.isSuccess(parseMcpTransport({ _tag: "sse", url: "http://localhost:3845/sse" })),
    ).toBe(true);
  });

  it("refuses another scheme, userinfo and a non-URL without quoting the URL", () => {
    const refusals = [
      "file:///etc/passwd",
      "ws://example.com",
      "https://alice:hunter2@example.com/mcp",
      "not a url",
    ].map((url) => parseMcpTransport({ _tag: "http", url }));
    expect(refusals.every(Result.isFailure)).toBe(true);
    const messages = refusals.flatMap((refusal) =>
      Result.isFailure(refusal) ? [refusal.failure] : [],
    );
    expect(messages.join("\n")).not.toMatch(/hunter2|alice|passwd|example/);
  });

  it("takes a command with arguments within the limits", () => {
    const stdio = { _tag: "stdio" as const, command: "npx", args: ["-y", "server-github"] };
    expect(parseMcpTransport(stdio)).toEqual(Result.succeed(stdio));
    expect(
      Result.isFailure(
        parseMcpTransport({ ...stdio, args: Array(MCP_SERVER_LIMITS.args + 1).fill("x") }),
      ),
    ).toBe(true);
    expect(Result.isFailure(parseMcpTransport({ ...stdio, command: " " }))).toBe(true);
    expect(
      Result.isFailure(
        parseMcpTransport({ ...stdio, args: ["x".repeat(MCP_SERVER_LIMITS.argBytes + 1)] }),
      ),
    ).toBe(true);
  });
});

describe("mcpSecretsIssue", () => {
  it("takes env names for stdio and HTTP tokens for headers", () => {
    expect(mcpSecretsIssue("env", { GITHUB_TOKEN: "v", _X1: "v" })).toBeNull();
    expect(mcpSecretsIssue("header", { Authorization: "Bearer v", "X-Api-Key": "v" })).toBeNull();
    expect(mcpSecretsIssue("env", { "X-Api-Key": "v" })).not.toBeNull();
    expect(mcpSecretsIssue("env", { "1X": "v" })).not.toBeNull();
    expect(mcpSecretsIssue("header", { "Bad Header": "v" })).not.toBeNull();
    expect(mcpSecretsIssue("header", { Authorization: "a", authorization: "b" })).toBe(
      "two headers differ only in case",
    );
  });

  it("holds the per-server limits and refuses a header value that would split the request", () => {
    const many = Object.fromEntries(
      Array.from({ length: MCP_SERVER_LIMITS.secretsPerServer + 1 }, (_, i) => [`V${i}`, "x"]),
    );
    expect(mcpSecretsIssue("env", many)).not.toBeNull();
    expect(
      mcpSecretsIssue("env", { BIG: "x".repeat(MCP_SERVER_LIMITS.secretValueBytes + 1) }),
    ).not.toBeNull();
    expect(mcpSecretsIssue("env", { EMPTY: "" })).not.toBeNull();
    expect(mcpSecretsIssue("header", { Authorization: "Bearer a\r\nX-Evil: 1" })).not.toBeNull();
  });

  it("never quotes a name or value it refuses", () => {
    const value = "sk-live-0123456789";
    const messages = [
      mcpSecretsIssue("header", { [`Authorization: Bearer ${value}`]: "v" }),
      mcpSecretsIssue("header", { Authorization: `Bearer ${value}\n` }),
      mcpSecretsIssue("env", { TOKEN: `${value}\u0000` }),
    ];
    expect(messages.every((message) => message !== null)).toBe(true);
    expect(messages.join("\n")).not.toContain(value);
  });
});
