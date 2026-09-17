import { describe, expect, it } from "vitest";

import {
  mintRefusedInTransit,
  upgradeBaseUrl,
  upgradeUrl,
  type MintTicket,
} from "./upgrade-url.ts";

const minting =
  (calls: Array<unknown>): MintTicket =>
  async (target, params) => {
    calls.push({ target, params });
    return { kind: "ticket", ticket: `mut_${calls.length}` };
  };

/** A `fetch` that answers `/health` with this body. */
const health =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    Response.json(body, { status });

describe("upgrade URLs", () => {
  it("addresses the target over ws(s) with no credential", () => {
    expect(
      upgradeBaseUrl("https://mend.example/", "tty", { session: "s1" }, { from: "12" }).toString(),
    ).toBe("wss://mend.example/api/tty?session=s1&from=12");
    expect(
      upgradeBaseUrl("http://10.0.0.216:3105", "keys-bridge", { host: "laptop" }).toString(),
    ).toBe("ws://10.0.0.216:3105/api/keys/bridge/ws?host=laptop");
  });

  it("carries a fresh ticket per connection and never the saved token", async () => {
    const calls: Array<unknown> = [];
    const connect = () =>
      upgradeUrl({
        serverUrl: "https://mend.example",
        target: "service-tunnel",
        params: { service: "svc_1" },
        mint: minting(calls),
        legacyToken: "mdt_saved",
      });
    const first = await connect();
    const second = await connect();
    expect(first.searchParams.get("ticket")).toBe("mut_1");
    expect(second.searchParams.get("ticket")).toBe("mut_2");
    expect(first.toString()).not.toContain("mdt_saved");
    expect(first.searchParams.has("token")).toBe(false);
    expect(calls).toEqual([
      { target: "service-tunnel", params: { service: "svc_1" } },
      { target: "service-tunnel", params: { service: "svc_1" } },
    ]);
  });

  it("falls back to the token only for a server that predates tickets", async () => {
    const url = await upgradeUrl({
      serverUrl: "https://old.example",
      target: "tty",
      params: { session: "s1" },
      mint: async () => ({ kind: "unsupported" }),
      legacyToken: "mdt_saved",
    });
    expect(url.searchParams.get("token")).toBe("mdt_saved");
    expect(url.searchParams.has("ticket")).toBe(false);
  });

  it("tells a server older than tickets from a mint refused on the way", async () => {
    // Older server: /health does not mention tickets, so the 404 is the server's own.
    expect(await mintRefusedInTransit("https://mend.example/", health({ status: "ok" }))).toBe(
      false,
    );
    // This server mints them, so the 404 came from a hop in between: no bearer in a URL.
    expect(
      await mintRefusedInTransit("https://mend.example", health({ upgradeTickets: true })),
    ).toBe(true);
    expect(await mintRefusedInTransit("https://mend.example", health({}, 502))).toBe(false);
  });
});
