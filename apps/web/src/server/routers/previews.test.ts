import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { serialize } from "superjson";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const view = {
  configured: true,
  fixed: null,
  url: null,
  target: null,
  status: ["Not started."],
  open: null,
  canManage: true,
};

const startApi = async () => {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    cookie: string | undefined;
    authorization: string | undefined;
    origin: string | undefined;
    body: string;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(view));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    requests,
    apiUrl: `http://127.0.0.1:${address.port}`,
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

let api: Awaited<ReturnType<typeof startApi>>;
beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  await api.close();
});

const ask = (path: string, input: unknown, mutation = false) => {
  const payload = JSON.stringify(serialize(input));
  const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
  return handle(
    new Request(
      `${origin}/trpc/previews.${path}${mutation ? "" : `?input=${encodeURIComponent(payload)}`}`,
      {
        method: mutation ? "POST" : "GET",
        headers: {
          origin,
          cookie: "session=person",
          authorization: "Bearer person",
          "content-type": "application/json",
        },
        ...(mutation ? { body: payload } : {}),
      },
    ),
  );
};

it("forwards reads, explicit Start and both target choices with the person's credentials", async () => {
  expect((await ask("project", { id: "p-1" })).status).toBe(200);
  expect((await ask("start", { id: "p-1" }, true)).status).toBe(200);
  expect((await ask("use", { id: "p-1", target: { _tag: "Default" } }, true)).status).toBe(200);
  expect(
    (await ask("use", { id: "p-1", target: { _tag: "Worktree", worktreeId: "wt-2" } }, true))
      .status,
  ).toBe(200);
  expect(api.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: "GET", path: "/api/projects/p-1/preview", body: "" },
    { method: "POST", path: "/api/projects/p-1/preview/start", body: "" },
    {
      method: "PUT",
      path: "/api/projects/p-1/preview/target",
      body: JSON.stringify({ _tag: "Default" }),
    },
    {
      method: "PUT",
      path: "/api/projects/p-1/preview/target",
      body: JSON.stringify({ _tag: "Worktree", worktreeId: "wt-2" }),
    },
  ]);
  for (const request of api.requests)
    expect(request).toMatchObject({
      cookie: "session=person",
      authorization: "Bearer person",
      origin,
    });
});

it("refuses a malformed target before calling the API", async () => {
  expect((await ask("use", { id: "p-1", target: { _tag: "Worktree" } }, true)).status).toBe(400);
  expect(api.requests).toEqual([]);
});
