import { AsyncLocalStorage } from "node:async_hooks";

import { afterAll, describe, expect, it, vi } from "vitest";

/** The page request being rendered, as TanStack Start's `getRequest` reports it. */
const rendering = new AsyncLocalStorage<Request>();
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => {
    const request = rendering.getStore();
    if (request === undefined) throw new Error("no page request is being rendered");
    return request;
  },
}));

/** Every call the web tier makes to the API, with the cookie it carried. */
const apiCalls: Array<{ readonly cookie: string | null; readonly url: string }> = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    apiCalls.push({ cookie: request.headers.get("cookie"), url: request.url });
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }),
);
afterAll(() => {
  vi.unstubAllGlobals();
});

const { getRouter } = await import("../router.tsx");

const pageRequest = (person: string) =>
  new Request("http://localhost:3105/", { headers: { cookie: `session=${person}` } });

describe("server rendering keeps each page request's calls apart", () => {
  it("gives every router its own tRPC client", () => {
    const first = getRouter().options.context;
    const second = getRouter().options.context;

    expect(first.trpcClient).not.toBe(second.trpcClient);
    expect(first.queryClient).not.toBe(second.queryClient);
  });

  it("calls the API with each rendering page's own cookie when two render at once", async () => {
    const render = (person: string) =>
      rendering.run(pageRequest(person), () => {
        const { trpcClient } = getRouter().options.context;
        return Promise.allSettled([
          trpcClient.organization.current.query(),
          trpcClient.sessions.listActive.query(),
        ]);
      });

    await Promise.all([render("alice"), render("bob")]);

    expect(apiCalls).toHaveLength(4);
    const cookies = apiCalls
      .map((call) => call.cookie)
      .toSorted((a, b) => String(a).localeCompare(String(b)));
    expect(cookies).toEqual(["session=alice", "session=alice", "session=bob", "session=bob"]);
    expect(new Set(apiCalls.map((call) => new URL(call.url).origin))).toEqual(
      new Set(["http://localhost:3101"]),
    );
  });
});
