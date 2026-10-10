import { createTRPCClient } from "@trpc/client";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "../server/routers/index.ts";
import { trpcLinks } from "./trpc.ts";

/** Which procedures each request carried, by the paths in its URL; nothing is answered. */
const requests = async (ask: (client: ReturnType<typeof makeClient>) => Promise<unknown>[]) => {
  const paths: string[][] = [];
  const client = makeClient((input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    paths.push(decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(","));
    return Promise.reject(new Error("not answered"));
  });
  await Promise.allSettled(ask(client));
  return paths;
};

const makeClient = (fetch: Parameters<typeof trpcLinks>[1]) =>
  createTRPCClient<AppRouter>({ links: trpcLinks("http://localhost:3105/trpc", fetch) });

describe("how the page's reads go out", () => {
  it("sends sessions.recipes on its own, so the viewer never waits behind the workspace", async () => {
    const paths = await requests((client) => [
      client.organization.current.query(),
      client.sessions.recipes.query({ id: "session-1" }),
      client.organization.members.query(),
    ]);
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual(["sessions.recipes"]);
    expect(paths).toContainEqual(["organization.current", "organization.members"]);
  });
});
