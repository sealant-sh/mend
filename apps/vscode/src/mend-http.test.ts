import { afterEach, describe, expect, it, vi } from "vitest";

import { MendApiError, MUTATION_TIMEOUT_MS, REQUEST_TIMEOUT_MS, requestMend } from "./mend-http.js";

const connection = {
  url: "http://mend-mini:3105",
  token: "secret",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestMend", () => {
  it("reports an unreachable server instead of returning fallback state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    await expect(requestMend(connection, "/workspace-ssh")).rejects.toEqual(
      expect.objectContaining({
        name: "MendApiError",
        status: null,
        message: "Cannot reach Mend at http://mend-mini:3105. connection refused",
      }),
    );
  });

  it("preserves an authentication failure for the caller to display", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Sign in to continue." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const failure = requestMend(connection, "/workspace-ssh");
    await expect(failure).rejects.toBeInstanceOf(MendApiError);
    await expect(failure).rejects.toEqual(
      expect.objectContaining({ status: 401, message: "Sign in to continue." }),
    );
  });

  it("sends authentication and returns successful discovery metadata", async () => {
    const body = { gateway: null, keys: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestMend(connection, "/workspace-ssh")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mend-mini:3105/api/workspace-ssh",
      expect.objectContaining({
        headers: expect.objectContaining({}),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("names the network's reason, not only Node's \"fetch failed\"", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: new Error("connect EHOSTUNREACH 192.168.1.20:3105"),
        }),
      ),
    );
    await expect(requestMend(connection, "/projects")).rejects.toThrow(
      "Cannot reach Mend at http://mend-mini:3105. connect EHOSTUNREACH 192.168.1.20:3105",
    );
  });

  it("gives up on a server that never answers instead of hanging", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }),
    );
    await expect(requestMend(connection, "/projects")).rejects.toThrow(
      `Mend at http://mend-mini:3105 did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.`,
    );
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("gives a change the time its work takes: a session create is not cut off at the read bound", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("{}", { status: 200 })),
    );
    try {
      await requestMend(connection, "/projects");
      await requestMend(connection, "/projects/p/sessions", { method: "POST", body: "{}" });
      expect(timeout.mock.calls).toEqual([[REQUEST_TIMEOUT_MS], [MUTATION_TIMEOUT_MS]]);
    } finally {
      timeout.mockRestore();
    }
  });
});
