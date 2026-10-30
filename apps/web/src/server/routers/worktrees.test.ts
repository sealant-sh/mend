import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const worktreeId = "wt-1";

const previews = {
  previews: [
    {
      preview: {
        id: "pv-web",
        projectId: "project-1",
        worktreeId,
        serviceName: "web",
        label: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "kept",
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
      status: ["preview · web · starting · setup"],
      facts: [{ _tag: "Starting", service: "web", phase: "setup" }],
      open: "/preview-auth?preview=pv-web&path=%2F",
      boundTo: null,
    },
  ],
  unprepared: null,
  starting: true,
  routing: "tailnet-https",
};

const startApi = async () => {
  const paths: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(previews));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    paths,
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

describe("worktrees router", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("reads the worktree's previews from the API, where each opens and whether a start runs", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const input = encodeURIComponent(JSON.stringify({ json: { id: worktreeId } }));
    const response = await handle(
      new Request(`http://internal-web.invalid/trpc/worktrees.previews?input=${input}`, {
        headers: { origin, cookie: "test-cookie=credential" },
      }),
    );

    expect(api.paths).toEqual([`/api/worktrees/${worktreeId}/previews`]);
    expect(response.status).toBe(200);
    const body: { readonly result: { readonly data: { readonly json: unknown } } } =
      await response.json();
    expect(body.result.data.json).toEqual(previews);
  });
});
