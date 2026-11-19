import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const headers = { "content-type": "application/json", origin, cookie: "test-cookie=credential" };
const at = "2026-11-19T09:14:00.000Z";

/** A project as `POST /projects/:id/name` answers it. */
const project = (name: string) => ({
  id: "project-checkout",
  name,
  organizationId: "org-northwind",
  visibility: "shared",
  createdByUserId: "ada",
  originUrl: "git@github.com:northwind/checkout-api.git",
  storePath: "/var/lib/mend/store/project-checkout/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: true,
  hotSessions: 0,
  createdAt: at,
  updatedAt: at,
});

type Answer = { readonly status: number; readonly body: unknown };

/** An API that answers each path with what `answers` holds, keeping what it was sent. */
const startApi = async (answers: Record<string, Answer>) => {
  const requests: Array<{
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly body: string;
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method, path: request.url, body });
      const answer = answers[request.url ?? ""] ?? { status: 404, body: { _tag: "NotFound" } };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
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

const rename = (apiUrl: string, id: string, name: string) =>
  createTrpcHandler({ network, apiUrl })(
    new Request("http://internal-web.invalid/trpc/projects.rename", {
      method: "POST",
      headers,
      body: JSON.stringify({ json: { id, name } }),
    }),
  );

describe("projects router: renaming a project", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  beforeEach(() => {
    api = null;
  });
  afterEach(async () => {
    await api?.close();
  });

  it("sends the name to the API and answers the renamed project", async () => {
    api = await startApi({
      "/api/projects/project-checkout/name": { status: 200, body: project("payments-api") },
    });
    const response = await rename(api.apiUrl, "project-checkout", "payments-api");

    expect(api.requests).toEqual([
      {
        method: "POST",
        path: "/api/projects/project-checkout/name",
        body: JSON.stringify({ name: "payments-api" }),
      },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { data: { json: { id: "project-checkout", name: "payments-api" } } },
    });
  });

  it("a refused name reaches the page by its tag, with the server's sentence", async () => {
    const words = 'A project named "web" already exists.';
    api = await startApi({
      "/api/projects/project-checkout/name": {
        status: 422,
        body: { _tag: "StoreFailure", message: words },
      },
    });
    const response = await rename(api.apiUrl, "project-checkout", "web");

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { json: { message: words, data: { tag: "StoreFailure" } } },
    });
  });
});
