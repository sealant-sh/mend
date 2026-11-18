import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const headers = { "content-type": "application/json", origin, cookie: "test-cookie=credential" };
const at = "2026-11-18T09:14:00.000Z";

const engine = {
  id: "org-difference-engine",
  name: "Difference Engine",
  createdByUserId: "ada",
  createdAt: at,
  updatedAt: at,
};

/** What the API answers to `GET /organization`, from a server too old to say whether to offer it. */
const olderServerView = {
  organization: { ...engine, id: "org-acme", name: "Acme Labs" },
  userId: "ada",
  role: "member",
  memberCount: 4,
  operator: false,
  tenancy: "multi",
  mountDelivery: "sources",
};

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

const create = (apiUrl: string, name: string) =>
  createTrpcHandler({ network, apiUrl })(
    new Request("http://internal-web.invalid/trpc/organizations.create", {
      method: "POST",
      headers,
      body: JSON.stringify({ json: { name } }),
    }),
  );

describe("organizations router: creating an organization", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  beforeEach(() => {
    api = null;
  });
  afterEach(async () => {
    await api?.close();
  });

  it("sends the name to the API and answers the organization this sign-in is now in", async () => {
    api = await startApi({
      "/api/account/organizations": {
        status: 200,
        body: { organization: engine, role: "owner", joinedAt: at, active: true },
      },
    });
    const response = await create(api.apiUrl, "Difference Engine");

    expect(api.requests).toEqual([
      {
        method: "POST",
        path: "/api/account/organizations",
        body: JSON.stringify({ name: "Difference Engine" }),
      },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: { organization: { id: engine.id }, role: "owner", active: true },
        },
      },
    });
  });

  it("a taken name reaches the page by its tag, beside the server's sentence", async () => {
    const words = "There's already an organization called Labs. Pick another name.";
    api = await startApi({
      "/api/account/organizations": {
        status: 409,
        body: { _tag: "OrganizationNameTaken", name: "Labs", message: words },
      },
    });
    const response = await create(api.apiUrl, "Labs");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { json: { message: words, data: { tag: "OrganizationNameTaken" } } },
    });
  });

  it("reads no offer to create from a server that does not say", async () => {
    api = await startApi({ "/api/organization": { status: 200, body: olderServerView } });
    const response = await createTrpcHandler({ network, apiUrl: api.apiUrl })(
      new Request("http://internal-web.invalid/trpc/organization.current", { headers }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { data: { json: { tenancy: "multi", canCreateOrganizations: false } } },
    });
  });
});
