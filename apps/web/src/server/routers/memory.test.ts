import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";
import type { AppRouter } from "./index.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const project = "11111111-1111-4111-8111-111111111111";

const entry = (path: string, name: string, harness = "claude") => ({
  path,
  harness,
  name,
  bytes: 120,
  digest: `sha256:${name}`,
  updatedAt: "2026-11-18T14:20:00.000Z",
  updatedBySession: null,
});

const FILES = [
  entry(".claude/projects/-workspace-repo/memory/MEMORY.md", "MEMORY.md"),
  entry(".claude/projects/-workspace-repo/memory/tests.md", "tests.md"),
  entry(".codex/memories/summary.md", "summary.md", "codex"),
];

/** A fake API holding one person's memory; removing `tests.md` fails, as a busy server might. */
const startApi = async () => {
  const requests: Array<{ readonly method: string | undefined; readonly url: URL }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      // Drain the body: these routes take none.
      await request.toArray();
      const url = new URL(request.url ?? "/", "http://api");
      requests.push({ method: request.method, url });
      const path = url.searchParams.get("path");
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "DELETE") {
        if (path?.endsWith("tests.md") === true) send(404, { _tag: "NotFound", id: path });
        else send(200, { removed: true });
        return;
      }
      if (url.pathname.endsWith("/memory/file")) {
        send(200, {
          entry: FILES.find((file) => file.path === path),
          encoding: "utf8",
          contents: "- run pnpm test before pushing\n",
        });
        return;
      }
      send(200, { files: FILES });
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};

describe("agent memory over tRPC", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let client: ReturnType<typeof createTRPCClient<AppRouter>>;
  beforeEach(async () => {
    api = await startApi();
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    client = createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${origin}/trpc`,
          transformer: superjson,
          headers: { origin, cookie: "test-cookie=credential" },
          fetch: (url, init) =>
            handle(
              new Request(url, {
                ...(init?.method === undefined ? {} : { method: init.method }),
                ...(init?.headers === undefined ? {} : { headers: init.headers }),
                ...(init?.body === undefined ? {} : { body: init.body }),
              }),
            ),
        }),
      ],
    });
  });
  afterEach(async () => {
    await api.close();
  });

  it("lists, shows and removes one file through the API's memory routes", async () => {
    const listed = await client.memory.list.query({ id: project });
    expect(listed.files.map((file) => file.name)).toEqual(["MEMORY.md", "tests.md", "summary.md"]);
    expect(listed.files[0]?.updatedAt).toEqual(new Date("2026-11-18T14:20:00Z"));

    const shown = await client.memory.file.query({ id: project, path: FILES[0]?.path ?? "" });
    expect(shown.contents).toBe("- run pnpm test before pushing\n");

    expect(await client.memory.remove.mutate({ id: project, path: FILES[2]?.path ?? "" })).toEqual({
      removed: true,
    });
    expect(api.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      `GET /api/projects/${project}/memory`,
      `GET /api/projects/${project}/memory/file`,
      `DELETE /api/projects/${project}/memory/file`,
    ]);
    expect(api.requests[1]?.url.searchParams.get("path")).toBe(FILES[0]?.path);
    expect(api.requests[2]?.url.searchParams.get("path")).toBe(FILES[2]?.path);
  });

  it("clears memory by removing each file, and says which it couldn't remove", async () => {
    const cleared = await client.memory.clear.mutate({ id: project });

    // Every file was tried, including the ones after the one that failed.
    const removes = api.requests.filter(({ method }) => method === "DELETE");
    expect(removes.map(({ url }) => url.searchParams.get("path"))).toEqual(
      FILES.map((file) => file.path),
    );
    expect(cleared.removed).toEqual([
      { path: FILES[0]?.path, name: "MEMORY.md" },
      { path: FILES[2]?.path, name: "summary.md" },
    ]);
    expect(cleared.failed).toHaveLength(1);
    expect(cleared.failed[0]).toMatchObject({ path: FILES[1]?.path, name: "tests.md" });
    expect(cleared.failed[0]?.message).not.toBe("");
  });
});
