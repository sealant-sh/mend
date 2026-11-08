import { describe, expect, it } from "vitest";

import { endpointUnreachableWords } from "./endpoint-unreachable.ts";
import { parseEndpointUrl } from "./endpoint-url.ts";
import { keyEndpointWords } from "./login-words.ts";

describe("endpointUnreachableWords", () => {
  it("names the host and where it was tried from for the person who added the login", () => {
    expect(endpointUnreachableWords("connection-refused", "gateway.example.com", "21:40")).toBe(
      "Could not reach gateway.example.com from this session's workspace (connection refused) · observed 21:40",
    );
  });

  it("keeps the host from everyone else", () => {
    expect(endpointUnreachableWords("host-not-found", null, "09:05")).toBe(
      "Could not reach this login's endpoint from the session's workspace (host not found) · observed 09:05",
    );
  });

  it("says what was observed and never judges the endpoint", () => {
    for (const cause of [
      "connection-refused",
      "host-not-found",
      "timed-out",
      "connection-failed",
    ] as const) {
      expect(endpointUnreachableWords(cause, "gw.internal:8443", "21:40")).not.toMatch(
        /down|misconfigured|broken|offline/i,
      );
    }
    expect(endpointUnreachableWords("timed-out", null, "21:40")).toContain("(timed out)");
    expect(endpointUnreachableWords("connection-failed", null, "21:40")).toContain(
      "(connection failed)",
    );
  });
});

describe("a key form's endpoint", () => {
  it("says what the endpoint is for, and what leaving it empty does, per provider", () => {
    expect(keyEndpointWords("claude")).toBe(
      "Send this login's requests to a compatible endpoint, such as a company gateway. Leave it empty for Anthropic's API.",
    );
    expect(keyEndpointWords("codex")).toContain("Leave it empty for OpenAI's API.");
  });

  it("reads a pasted endpoint the way the platform does", () => {
    expect(parseEndpointUrl("https://gateway.example.com/v1/")).toEqual({
      valid: true,
      url: "https://gateway.example.com/v1",
    });
    expect(parseEndpointUrl("gateway.example.com")).toEqual({
      valid: false,
      reason: "The endpoint must be an absolute http: or https: URL.",
    });
    expect(parseEndpointUrl("https://me:secret@gateway.example.com")).toMatchObject({
      valid: false,
    });
  });
});
