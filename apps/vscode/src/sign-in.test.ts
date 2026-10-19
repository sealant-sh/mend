import { describe, expect, it, vi } from "vitest";

import {
  browserSignIn,
  finishBrowserSignIn,
  groupCode,
  normalizeServerUrl,
  plainHttpWarning,
  pollDeadline,
  SignInError,
  urlNotice,
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
  const warnings: Array<string> = [];
  const value: SignInDeps = {
    fetch: fetchMock,
    openExternal: async (url) => {
      opens.push(url);
      return true;
    },
    onCode: (code) => codes.push(code),
    onWarning: (message) => warnings.push(message),
    sleep: async () => undefined,
    deviceName: "VS Code on macbook",
    cancelled: () => false,
    ...overrides,
  };
  return { value, opens, codes, warnings };
};

describe("browserSignIn", () => {
  it("opens the approve page on the server it was pointed at and returns the device token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, opened))
      .mockResolvedValueOnce(json(200, { status: "pending" }))
      .mockResolvedValueOnce(json(200, approved));
    const { value, opens, codes, warnings } = deps(fetchMock);

    await expect(browserSignIn("http://mend-mini.local:3105", value)).resolves.toEqual({
      url: "http://mend-mini.local:3105",
      token: "mdt_token",
      deviceId: "device-1",
      email: "owner@example.test",
    });
    expect(opens).toEqual(["http://mend-mini.local:3105/authorize?code=abcd2345"]);
    expect(codes).toEqual(["ABCD-2345"]);
    expect(warnings).toEqual([]);
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
      new SignInError("Sign-in denied in the browser."),
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

  it("polls again after one request that got no answer, and ends after two in a row", async () => {
    const dropped = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    const once = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, opened))
      .mockRejectedValueOnce(dropped)
      .mockResolvedValueOnce(json(200, approved));
    await expect(
      browserSignIn("http://mend-mini.local:3105", deps(once).value),
    ).resolves.toMatchObject({ token: "mdt_token" });

    const twice = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, opened))
      .mockRejectedValueOnce(dropped)
      .mockRejectedValueOnce(dropped);
    await expect(browserSignIn("http://mend-mini.local:3105", deps(twice).value)).rejects.toThrow(
      "Cannot reach Mend at http://mend-mini.local:3105. read ECONNRESET",
    );
  });

  it("revokes an approval that arrives during a cancelled poll and returns no credential", async () => {
    const pollStarted = Promise.withResolvers<void>();
    const pollResponse = Promise.withResolvers<Response>();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    let cancelled = false;
    const send: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return json(200, opened);
      if (requests.length === 2) {
        pollStarted.resolve();
        return pollResponse.promise;
      }
      return new Response(null, { status: 204 });
    };
    const { value, warnings } = deps(send, { cancelled: () => cancelled });
    const signingIn = browserSignIn("https://mend.example", value);
    await pollStarted.promise;
    cancelled = true;
    pollResponse.resolve(json(200, approved));

    expect(await signingIn).toBeNull();
    expect(requests.map(({ url }) => url)).toEqual([
      "https://mend.example/api/cli/auth",
      "https://mend.example/api/cli/auth/token",
      "https://mend.example/api/me/devices/device-1",
    ]);
    const revoke = requests[2];
    expect(revoke?.init?.method).toBe("DELETE");
    expect(new Headers(revoke?.init?.headers).get("authorization")).toBe("Bearer mdt_token");
    expect(revoke?.init?.body).toBeUndefined();
    expect(revoke?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(warnings).toEqual([]);
  });

  it.each(["refused", "unreachable"])(
    "reports %s cleanup without exposing the late credential or resuming sign-in",
    async (failure) => {
      const pollStarted = Promise.withResolvers<void>();
      const pollResponse = Promise.withResolvers<Response>();
      const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
      let cancelled = false;
      const send: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return json(200, opened);
        if (requests.length === 2) {
          pollStarted.resolve();
          return pollResponse.promise;
        }
        if (failure === "unreachable") throw new Error(`transport echoed ${approved.token}`);
        return json(502, { message: `server echoed ${approved.token}` });
      };
      const { value, warnings } = deps(send, { cancelled: () => cancelled });
      const signingIn = browserSignIn("https://mend.example", value);
      await pollStarted.promise;
      cancelled = true;
      pollResponse.resolve(json(200, approved));

      expect(await signingIn).toBeNull();
      expect(requests).toHaveLength(3);
      expect(requests[2]?.init?.method).toBe("DELETE");
      expect(new Headers(requests[2]?.init?.headers).get("authorization")).toBe(
        `Bearer ${approved.token}`,
      );
      expect(warnings).toEqual([
        "Sign-in was cancelled, but Mend did not confirm revocation of the device approved meanwhile. Revoke VS Code on macbook under Settings → Devices.",
      ]);
      expect(warnings.join(" ")).not.toContain(approved.token);
      expect(warnings.join(" ")).not.toContain("echoed");
    },
  );

  it("discards a completed approval when cancellation arrives at the host handoff", async () => {
    const requests: Array<string> = [];
    let cancelled = false;
    const send: typeof fetch = async (input) => {
      requests.push(String(input));
      if (requests.length === 1) return json(200, opened);
      if (requests.length === 2) return json(200, approved);
      return new Response(null, { status: 204 });
    };
    const { value, warnings } = deps(send, { cancelled: () => cancelled });
    const result = await browserSignIn("https://mend.example", value);
    expect(result?.token).toBe(approved.token);
    expect(await finishBrowserSignIn(result, value)).toBe(result);
    expect(requests).toHaveLength(2);
    cancelled = true;
    expect(await finishBrowserSignIn(result, value)).toBeNull();
    expect(requests).toEqual([
      "https://mend.example/api/cli/auth",
      "https://mend.example/api/cli/auth/token",
      "https://mend.example/api/me/devices/device-1",
    ]);
    expect(warnings).toEqual([]);
  });

  it("stops a cancelled pending poll without revoking or warning", async () => {
    const pollStarted = Promise.withResolvers<void>();
    const pollResponse = Promise.withResolvers<Response>();
    const requests: Array<string> = [];
    let cancelled = false;
    const send: typeof fetch = async (input) => {
      requests.push(String(input));
      if (requests.length === 1) return json(200, opened);
      pollStarted.resolve();
      return pollResponse.promise;
    };
    const { value, warnings } = deps(send, { cancelled: () => cancelled });
    const signingIn = browserSignIn("https://mend.example", value);
    await pollStarted.promise;
    cancelled = true;
    pollResponse.resolve(json(200, { status: "pending" }));
    expect(await signingIn).toBeNull();
    expect(requests).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});

describe("server URL", () => {
  it("normalizes what a person types", () => {
    expect(normalizeServerUrl("mend-mini.local:3105")).toBe("http://mend-mini.local:3105");
    expect(normalizeServerUrl("https://mend.example.com/")).toBe("https://mend.example.com");
    expect(normalizeServerUrl("ssh://mend-mini.local")).toBe(null);
    expect(normalizeServerUrl("  ")).toBe(null);
  });

  it("warns about plain http to another machine, in story h's words, and not on loopback", () => {
    const words = "Plain http: the token travels unencrypted";
    for (const url of [
      "http://mend-mini.local:3105",
      "http://192.168.1.20:3105",
      "http://172.17.0.2:3105",
      "http://mend.example.com:3105",
      "http://203.0.113.9:3105",
      // Just outside 100.64.0.0/10 is not a tailnet.
      "http://100.128.0.1:3105",
      // A DNS name that begins with 127. is not this machine.
      "http://127.remote.example:3105",
    ]) {
      expect(plainHttpWarning(url), url).toBe(words);
    }
    for (const url of [
      "http://localhost:3105",
      "http://127.0.0.1:3105",
      "http://[::1]:3105",
      "https://mend.example.com",
      // Tailscale encrypts the connection itself: by address, IPv6 address, or MagicDNS name.
      "http://100.64.135.118:3105",
      "http://[fd7a:115c:a1e0::1]:3105",
      "http://yianniss-macbook-pro.tailc79e49.ts.net:3105",
    ]) {
      expect(plainHttpWarning(url), url).toBe(null);
    }
  });

  it("lets the URL input accept a plain-http server with the warning, and refuses a non-URL", () => {
    expect(urlNotice("mend-mini.local:3105")).toEqual({
      severity: "warning",
      message: "Plain http: the token travels unencrypted",
    });
    expect(urlNotice("http://localhost:3105")).toBe(null);
    expect(urlNotice("https://mend.example.com")).toBe(null);
    expect(urlNotice("ssh://mend-mini.local")?.severity).toBe("error");
  });

  it("groups the code as the browser shows it", () => {
    expect(groupCode("abcd2345")).toBe("ABCD-2345");
  });
});
