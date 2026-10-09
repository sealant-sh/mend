import { describe, expect, it, vi } from "vitest";

import {
  browserSignIn,
  groupCode,
  normalizeServerUrl,
  plainHttpWarning,
  SignInError,
  type SignInDeps,
} from "./sign-in.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const opened = {
  deviceCode: "device-secret",
  code: "abcd2345",
  verifyPath: "/authorize?code=abcd2345",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  intervalSeconds: 1,
};

const approved = {
  status: "approved",
  token: "mdt_token",
  user: { id: "user-1", name: "Owner", email: "owner@example.test" },
  device: { id: "device-1", name: "VS Code on macbook" },
};

const deps = (fetchMock: typeof fetch, overrides: Partial<SignInDeps> = {}) => {
  const opens: Array<string> = [];
  const codes: Array<string> = [];
  const value: SignInDeps = {
    fetch: fetchMock,
    openExternal: async (url) => {
      opens.push(url);
      return true;
    },
    onCode: (code) => codes.push(code),
    sleep: async () => undefined,
    deviceName: "VS Code on macbook",
    cancelled: () => false,
    ...overrides,
  };
  return { value, opens, codes };
};

describe("browserSignIn", () => {
  it("opens the approve page on the server it was pointed at and returns the device token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, opened))
      .mockResolvedValueOnce(json(200, { status: "pending" }))
      .mockResolvedValueOnce(json(200, approved));
    const { value, opens, codes } = deps(fetchMock);

    await expect(browserSignIn("http://mend-mini.local:3105", value)).resolves.toEqual({
      url: "http://mend-mini.local:3105",
      token: "mdt_token",
      deviceId: "device-1",
      email: "owner@example.test",
    });
    expect(opens).toEqual(["http://mend-mini.local:3105/authorize?code=abcd2345"]);
    expect(codes).toEqual(["ABCD-2345"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://mend-mini.local:3105/api/cli/auth",
      "http://mend-mini.local:3105/api/cli/auth/token",
      "http://mend-mini.local:3105/api/cli/auth/token",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "VS Code on macbook",
    });
    // No Origin and no credential: the authorize surface is unauthenticated by design.
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
  });

  it("says the server is not Mend, and that a denial grants nothing", async () => {
    const notMend = deps(vi.fn<typeof fetch>().mockResolvedValue(json(200, { hello: "portal" })));
    await expect(browserSignIn("http://router.local", notMend.value)).rejects.toThrow(
      "did not answer like a Mend server",
    );
    expect(notMend.opens).toEqual([]);

    const denied = deps(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(200, opened))
        .mockResolvedValueOnce(json(403, {})),
    );
    await expect(browserSignIn("http://mend-mini.local:3105", denied.value)).rejects.toThrow(
      new SignInError("Denied in the browser. Nothing was granted."),
    );
  });

  it("names the network failure, and stops quietly when cancelled", async () => {
    const refused = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 192.168.1.20:3105"),
    });
    const unreachable = deps(vi.fn<typeof fetch>().mockRejectedValue(refused));
    await expect(browserSignIn("http://192.168.1.20:3105", unreachable.value)).rejects.toThrow(
      "Cannot reach Mend at http://192.168.1.20:3105. fetch failed",
    );

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(200, opened));
    const cancelled = deps(fetchMock, { cancelled: () => true });
    await expect(browserSignIn("http://mend-mini.local:3105", cancelled.value)).resolves.toBe(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("server URL", () => {
  it("normalizes what a person types", () => {
    expect(normalizeServerUrl("mend-mini.local:3105")).toBe("http://mend-mini.local:3105");
    expect(normalizeServerUrl("https://mend.example.com/")).toBe("https://mend.example.com");
    expect(normalizeServerUrl("ssh://mend-mini.local")).toBe(null);
    expect(normalizeServerUrl("  ")).toBe(null);
  });

  it("warns about plain http to another machine only", () => {
    expect(plainHttpWarning("http://192.168.1.20:3105")).toContain("unencrypted");
    expect(plainHttpWarning("http://mend-mini.local:3105")).toContain("mend-mini.local:3105");
    expect(plainHttpWarning("https://mend.example.com")).toBe(null);
    expect(plainHttpWarning("http://localhost:3105")).toBe(null);
    expect(plainHttpWarning("http://127.0.0.1:3105")).toBe(null);
  });

  it("groups the code as the browser shows it", () => {
    expect(groupCode("abcd2345")).toBe("ABCD-2345");
  });
});
