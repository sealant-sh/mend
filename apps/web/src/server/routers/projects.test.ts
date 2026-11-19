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
  workspaceImage: {
    mode: "family",
    os: "ubuntu",
    packages: [],
    shell: "zsh",
    services: { docker: false },
    screen: false,
  },
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

const mendToml = (apiUrl: string) =>
  createTrpcHandler({ network, apiUrl })(
    new Request(
      `http://internal-web.invalid/trpc/projects.mendToml?input=${encodeURIComponent(
        JSON.stringify({ json: { id: "project-checkout" } }),
      )}`,
      { headers },
    ),
  );

/** `GET /projects/:id/contents?path=…` as the API answers it for a file the branch has or lacks. */
const contents = (path: string, text: string | null) => ({
  status: 200,
  body: {
    projectId: "project-checkout",
    file:
      text === null
        ? null
        : { path, at: null, contents: text, size: text.length, truncated: false, binary: false },
    search: null,
  },
});
const contentsPath = (path: string) =>
  `/api/projects/project-checkout/contents?path=${encodeURIComponent(path)}`;

describe("projects router: the default branch's mend.toml", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  afterEach(async () => {
    await api?.close();
  });

  it("reads .mend/mend.toml first, as sessions do", async () => {
    api = await startApi({
      [contentsPath(".mend/mend.toml")]: contents(
        ".mend/mend.toml",
        "[service.web]\nport = 3000\n",
      ),
    });
    const response = await mendToml(api.apiUrl);

    expect(api.requests.map((request) => request.path)).toEqual([contentsPath(".mend/mend.toml")]);
    expect(await response.json()).toMatchObject({
      result: {
        data: { json: { path: ".mend/mend.toml", contents: "[service.web]\nport = 3000\n" } },
      },
    });
  });

  it("falls back to mend.toml at the root, and answers null when the branch has neither", async () => {
    api = await startApi({
      [contentsPath(".mend/mend.toml")]: contents(".mend/mend.toml", null),
      [contentsPath("mend.toml")]: contents("mend.toml", "[service.db]\nport = 5432\n"),
    });
    expect(await (await mendToml(api.apiUrl)).json()).toMatchObject({
      result: { data: { json: { path: "mend.toml" } } },
    });
    await api.close();

    api = await startApi({
      [contentsPath(".mend/mend.toml")]: contents(".mend/mend.toml", null),
      [contentsPath("mend.toml")]: contents("mend.toml", null),
    });
    expect(await (await mendToml(api.apiUrl)).json()).toMatchObject({
      result: { data: { json: null } },
    });
  });
});
