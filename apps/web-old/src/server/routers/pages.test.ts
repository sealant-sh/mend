import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const id = "8b1c3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f";
let requests: Request[];
let refused: boolean;

beforeEach(() => {
  requests = [];
  refused = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (refused) return Response.json({ _tag: "NotFound", id }, { status: 404 });
    if (request.url.includes(`/sessions/${id}/pages`))
      return Response.json([
        {
          id,
          sessionId: id,
          title: "Request flow",
          height: 240,
          publishedAt: "2026-10-29T12:00:00Z",
        },
      ]);
    return Response.json({
      url: "/api/page-view?view=test-token",
      expiresAt: "2026-10-29T12:30:00Z",
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const query = (path: string, input: unknown) => {
  const handle = createTrpcHandler({ network, apiUrl: "http://api.internal" });
  return handle(
    new Request(
      `${origin}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(serialize(input)))}`,
      {
        headers: { cookie: "session=person", authorization: "Bearer person", origin },
      },
    ),
  );
};

describe("page queries through the web tier", () => {
  it.each(["light", "dark"])("mints a %s frame as the signed-in person", async (appearance) => {
    const response = await query("pages.frame", { id, appearance });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/api/page-view?view=test-token");
    expect(requests.map((request) => request.url)).toEqual([
      `http://api.internal/api/pages/${id}/frame?appearance=${appearance}`,
    ]);
    expect(requests[0]?.headers.get("cookie")).toBe("session=person");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer person");
    expect(requests[0]?.headers.get("origin")).toBe(origin);
  });

  it("reads the session's pages through the contract", async () => {
    const response = await query("sessions.pages", { id });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Request flow");
    expect(requests.map((request) => request.url)).toEqual([
      `http://api.internal/api/sessions/${id}/pages`,
    ]);
    expect(requests[0]?.headers.get("cookie")).toBe("session=person");
  });

  it("passes the API's refusal on as a 404 that names nothing about the page", async () => {
    refused = true;
    for (const [path, input] of [
      ["pages.frame", { id, appearance: "light" }],
      ["sessions.pages", { id }],
    ] as const) {
      const response = await query(path, input);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("Request flow");
      expect(body).not.toContain("page-view");
    }
  });

  it("rejects an unknown appearance before asking the API", async () => {
    const response = await query("pages.frame", { id, appearance: "blue" });
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });
});
