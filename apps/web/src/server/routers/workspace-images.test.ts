import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const headers = { "content-type": "application/json", origin, cookie: "test-cookie=credential" };

const ubuntu = {
  mode: "family",
  os: "ubuntu",
  packages: ["jq"],
  shell: "zsh",
  services: { docker: true },
  screen: false,
};

type Answer = { readonly status: number; readonly body: unknown };

/** An API that answers each PUT with `answers[path]`, keeping what it was sent. */
const startApi = async (answers: Record<string, Answer>) => {
  const requests: Array<{ readonly path: string | undefined; readonly body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url, body });
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
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const mutate = (apiUrl: string, path: string, input: unknown) =>
  createTrpcHandler({ network, apiUrl })(
    new Request(`http://internal-web.invalid/trpc/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: input }),
    }),
  );

describe("workspace images, plain values", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });

  it("sends a project's own image and an organization's starting image as they are", async () => {
    api = await startApi({
      "/api/projects/p-1/workspace-image": {
        status: 200,
        body: { saved: false, project: null, resolutions: [] },
      },
      "/api/organization/settings/workspace-environment": {
        status: 422,
        body: { _tag: "SettingsFailure", message: "Boat cannot boot a custom OCI base image." },
      },
    });
    const project = await mutate(api.apiUrl, "projects.setWorkspaceImage", {
      id: "p-1",
      request: { workspaceImage: ubuntu },
    });
    expect(project.status).toBe(200);
    const organization = await mutate(api.apiUrl, "organization.setWorkspaceEnvironment", {
      workspaceImage: ubuntu,
    });
    expect(organization.status).toBe(422);
    expect(api.requests.map((request) => [request.path, JSON.parse(request.body)])).toEqual([
      ["/api/projects/p-1/workspace-image", { workspaceImage: ubuntu }],
      ["/api/organization/settings/workspace-environment", { workspaceImage: ubuntu }],
    ]);
  });

  it("refuses a null image, which used to mean follow a level above, before it reaches the server", async () => {
    api = await startApi({});
    const project = await mutate(api.apiUrl, "projects.setWorkspaceImage", {
      id: "p-1",
      request: { workspaceImage: null },
    });
    const organization = await mutate(api.apiUrl, "organization.setWorkspaceEnvironment", {
      workspaceImage: null,
    });
    expect([project.status, organization.status]).toEqual([400, 400]);
    expect(api.requests).toEqual([]);
  });
});
