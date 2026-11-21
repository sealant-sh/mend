import { describe, expect, it } from "vitest";

import { probeServer } from "./probe.ts";

const okFetch: typeof fetch = async () => new Response('{"ok":true}', { status: 200 });
const authGateFetch: typeof fetch = async () => new Response(null, { status: 302 });
const notFoundFetch: typeof fetch = async () => new Response("Not Found", { status: 404 });
const badGatewayFetch: typeof fetch = async () => new Response("Bad Gateway", { status: 502 });
const refusedFetch: typeof fetch = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};
const slowFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("probeServer", () => {
  it("succeeds on 200 and on reverse-proxy auth gates (401/302)", async () => {
    expect(await probeServer("http://localhost:3115", okFetch)).toEqual({ ok: true });
    expect(await probeServer("https://mend.example.com", authGateFetch)).toEqual({ ok: true });
  });

  it("rejects 404 and 5xx with plain-English reasons", async () => {
    const notFound = await probeServer("https://wrong.example.com", notFoundFetch);
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.reason).toContain("/api/health");

    const badGateway = await probeServer("https://down.example.com", badGatewayFetch);
    expect(badGateway.ok).toBe(false);
    if (!badGateway.ok) expect(badGateway.reason).toContain("502");
  });

  it("reports connection refused and timeouts cleanly", async () => {
    const refused = await probeServer("http://127.0.0.1:9", refusedFetch);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("Connection refused");

    const timedOut = await probeServer("http://127.0.0.1:9", slowFetch, 15);
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.reason).toContain("in time");
  });
});
