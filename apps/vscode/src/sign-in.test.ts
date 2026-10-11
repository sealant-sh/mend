import { describe, expect, it, vi } from "vitest";

import {
  browserSignIn,
  groupCode,
  normalizeServerUrl,
  plainHttpWarning,
  pollDeadline,
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
      client: "vscode",
    });
    // No Origin and no credential: the authorize surface is unauthenticated by design.
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
  });

  it("polls while VS Code's open-website dialog is still unanswered", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, opened))
      .mockResolvedValueOnce(json(200, approved));
    // The dialog sits behind other windows: openExternal never settles.
    const { value } = deps(fetchMock, { openExternal: () => new Promise<boolean>(() => {}) });
    await expect(browserSignIn("http://mend-mini.local:3105", value)).resolves.toMatchObject({
      token: "mdt_token",
    });
  });

  it("signs in when the server's clock runs two hours behind this one", async () => {
    const now = Date.parse("2026-10-11T02:00:00Z");
    const serverNow = now - 116 * 60_000;
    const fromSkewedServer = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", date: new Date(serverNow).toUTCString() },
      });
    // An older server: only its own clock's expiresAt, long past on this machine's clock.
    const older = { ...opened, expiresAt: new Date(serverNow + 600_000).toISOString() };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fromSkewedServer(older))
      .mockResolvedValueOnce(fromSkewedServer(approved));
    const { value } = deps(fetchMock, { now: () => now });
    await expect(browserSignIn("http://mend-mini.local:3105", value)).resolves.toMatchObject({
      token: "mdt_token",
    });
  });

  it("counts down from receipt: expiresIn, else expiresAt against the server's Date", () => {
    const received = Date.parse("2026-10-11T02:00:00Z");
    const expiresAt = "2026-10-11T00:14:00.000Z";
    expect(pollDeadline({ expiresAt, expiresIn: 600 }, received, null)).toBe(received + 600_000);
    expect(pollDeadline({ expiresAt }, received, "Sun, 11 Oct 2026 00:04:00 GMT")).toBe(
      received + 600_000,
    );
    expect(pollDeadline({ expiresAt }, received, null)).toBe(received + 10 * 60_000);
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
    // The reason that helps on another network is the cause, not Node's "fetch failed".
    await expect(browserSignIn("http://192.168.1.20:3105", unreachable.value)).rejects.toThrow(
      "Cannot reach Mend at http://192.168.1.20:3105. connect ECONNREFUSED 192.168.1.20:3105",
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

  it("warns about plain http to another machine only, in words that fit the picker", () => {
    expect(plainHttpWarning("http://192.168.1.20:3105")).toBe(
      "Plain http: anyone on this local network can read the token.",
    );
    expect(plainHttpWarning("http://mend-mini.local:3105")).toContain("local network");
    expect(plainHttpWarning("http://10.0.0.40:3105")).toContain("local network");
    expect(plainHttpWarning("http://mend.example.com:3105")).toBe(
      "Plain http: the token crosses the network unencrypted.",
    );
    expect(plainHttpWarning("http://203.0.113.9:3105")).toContain("unencrypted");
    // Tailscale encrypts the connection itself: by address, IPv6 address, or MagicDNS name.
    expect(plainHttpWarning("http://100.64.135.118:3105")).toBe(null);
    expect(plainHttpWarning("http://[fd7a:115c:a1e0::1]:3105")).toBe(null);
    expect(plainHttpWarning("http://yianniss-macbook-pro.tailc79e49.ts.net:3105")).toBe(null);
    // Just outside 100.64.0.0/10 is not a tailnet.
    expect(plainHttpWarning("http://100.128.0.1:3105")).toContain("unencrypted");
    expect(plainHttpWarning("https://mend.example.com")).toBe(null);
    expect(plainHttpWarning("http://localhost:3105")).toBe(null);
    expect(plainHttpWarning("http://127.0.0.1:3105")).toBe(null);
    expect(plainHttpWarning("http://[::1]:3105")).toBe(null);
    // A DNS name that begins with 127. is not this machine.
    expect(plainHttpWarning("http://127.remote.example:3105")).toContain("unencrypted");
    for (const url of ["http://192.168.1.20:3105", "http://mend.example.com:3105"]) {
      expect(plainHttpWarning(url)?.length ?? 0).toBeLessThan(70);
    }
  });

  it("groups the code as the browser shows it", () => {
    expect(groupCode("abcd2345")).toBe("ABCD-2345");
  });
});
