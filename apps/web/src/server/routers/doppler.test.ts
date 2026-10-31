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
const token = "dp.fake.web-router-test";

const startApi = async () => {
  const requests: Array<{
    readonly path: string | undefined;
    readonly method: string | undefined;
    readonly cookie: string | undefined;
    readonly origin: string | undefined;
    readonly body: string;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      body,
    });
    const output =
      request.method === "PUT"
        ? request.url?.endsWith("/projects/p1")
          ? { projectId: "p1", dopplerProject: "backend", config: "dev" }
          : { connected: true }
        : request.method === "DELETE"
          ? { removed: true }
          : request.url?.includes("/configs?")
            ? { configs: [{ name: "dev" }] }
            : request.url?.endsWith("/projects")
              ? { projects: [{ id: "backend", name: "Backend" }] }
              : {
                  connected: true,
                  name: null,
                  updatedAt: "2026-10-31T00:00:00.000Z",
                  mappings: [],
                };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(output));
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

describe("Doppler settings transport", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("forwards the person's credentials and write-only token through the contract client", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const client = createTRPCClient<AppRouter>({
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

    expect(await client.doppler.connect.mutate({ token })).toEqual({ connected: true });
    const status = await client.doppler.status.query();
    expect(status.updatedAt).toEqual(new Date("2026-10-31T00:00:00Z"));
    expect(JSON.stringify(status)).not.toContain(token);
    expect(await client.doppler.projects.query()).toEqual({
      projects: [{ id: "backend", name: "Backend" }],
    });
    expect(await client.doppler.configs.query({ project: "backend" })).toEqual({
      configs: [{ name: "dev" }],
    });
    await client.doppler.use.mutate({ projectId: "p1", dopplerProject: "backend", config: "dev" });
    await client.doppler.removeMapping.mutate({ projectId: "p1" });
    await client.doppler.disconnect.mutate();

    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /api/me/doppler",
      "GET /api/me/doppler",
      "GET /api/me/doppler/projects",
      "GET /api/me/doppler/configs?project=backend",
      "PUT /api/me/doppler/projects/p1",
      "DELETE /api/me/doppler/projects/p1",
      "DELETE /api/me/doppler",
    ]);
    expect(JSON.parse(api.requests[0]?.body ?? "")).toEqual({ token });
    expect(JSON.parse(api.requests[4]?.body ?? "")).toEqual({
      dopplerProject: "backend",
      config: "dev",
    });
    for (const request of api.requests) {
      expect(request.cookie).toBe("test-cookie=credential");
      expect(request.origin).toBe(origin);
    }
  });
});
