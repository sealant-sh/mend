import { describe, expect, it } from "vitest";

import {
  upgradeTicketSupport,
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

  it.each([
    [{ status: "ok" }, 200, "legacy"],
    [{ status: "ok", upgradeTickets: false }, 200, "legacy"],
    [{ upgradeTickets: true }, 200, "supported"],
    [{ status: "ok", upgradeTickets: "true" }, 200, "unknown"],
    [{ status: "ok", upgradeTickets: null }, 200, "unknown"],
    [{ status: "starting" }, 200, "unknown"],
    [{}, 200, "unknown"],
    [null, 200, "unknown"],
    [[], 200, "unknown"],
    ["ok", 200, "unknown"],
    [{ status: "ok" }, 502, "unknown"],
    [{ upgradeTickets: true }, 404, "unknown"],
  ])("classifies observed health %j at HTTP%s as %s", async (body, status, expected) => {
    expect(await upgradeTicketSupport("https://mend.example/", health(body, status))).toBe(
      expected,
    );
  });
});

it.each(["headers", "body"])(
  "abandons health discovery on cancellation during %s",
  async (phase) => {
    const controller = new AbortController();
    const received = Promise.withResolvers<void>();
    const headers = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      received.resolve();
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        response.write('{"status":');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing health port");
    const send: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      headers.resolve();
      return response;
    };
    try {
      const discovery = upgradeTicketSupport(
        `http://127.0.0.1:${address.port}`,
        send,
        controller.signal,
      );
      await (phase === "body" ? headers.promise : received.promise);
      controller.abort();
      expect(await discovery).toBe("unknown");
    } finally {
      controller.abort();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  },
);

it(
  "bounds health discovery when a server never completes its response body",
  { timeout: 10_000 },
  async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"status":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing health port");
    try {
      expect(await upgradeTicketSupport(`http://127.0.0.1:${address.port}`)).toBe("unknown");
      expect(requests).toEqual(["GET /api/health"]);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  },
);
import { once } from "node:events";
import { createServer } from "node:http";
