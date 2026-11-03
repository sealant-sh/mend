import { afterEach, describe, expect, it, vi } from "vitest";

import { getRouter } from "../router.tsx";
import { makeTrpcClient } from "./trpc.ts";

const batchJson = (count: number) =>
  JSON.stringify(Array.from({ length: count }, () => ({ result: { data: { json: null } } })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server rendering keeps each page request's calls apart", () => {
  it("gives every router its own tRPC client", () => {
    const first = getRouter().options.context;
    const second = getRouter().options.context;

    expect(first.trpcClient).not.toBe(second.trpcClient);
    expect(first.queryClient).not.toBe(second.queryClient);
  });

  it("sends two people's calls made in the same tick with their own cookies", async () => {
    const sent: Array<{ readonly cookie: string | null; readonly url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        sent.push({ cookie: headers.get("cookie"), url });
        const calls = new URL(url, "http://web.test").pathname.split("/").at(-1)?.split(",") ?? [];
        return new Response(batchJson(calls.length), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const alice = makeTrpcClient({ cookie: "session=alice" });
    const bob = makeTrpcClient({ cookie: "session=bob" });

    await Promise.all([
      alice.organization.current.query(),
      bob.organization.current.query(),
      alice.sessions.listActive.query(),
    ]);

    expect(sent).toHaveLength(2);
    const byCookie = new Map(sent.map((request) => [request.cookie, request.url]));
    expect(byCookie.get("session=alice")).toContain("organization.current,sessions.listActive");
    expect(byCookie.get("session=bob")).toContain("organization.current");
    expect(byCookie.get("session=bob")).not.toContain("sessions.listActive");
  });
});
