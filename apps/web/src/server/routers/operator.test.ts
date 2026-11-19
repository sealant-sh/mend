import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const headers = { origin, cookie: "test-cookie=credential" };
const at = "2026-11-18T09:14:00.000Z";

type Answer = { readonly status: number; readonly body: unknown };

/** An API that answers each path with what `answers` holds, keeping the paths it was asked. */
const startApi = async (answers: Record<string, Answer>) => {
  const paths: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    const answer = answers[request.url ?? ""] ?? {
      status: 404,
      body: { _tag: "NotFound", id: "operator" },
    };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
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

const ask = (apiUrl: string, procedure: string) =>
  createTrpcHandler({ network, apiUrl })(
    new Request(`http://internal-web.invalid/trpc/operator.${procedure}`, { headers }),
  );

const organization = (id: string, name: string) => ({
  id,
  name,
  createdByUserId: null,
  createdAt: at,
  updatedAt: at,
});

describe("operator router", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });

  it("lists every organization on the server with its member and owner counts", async () => {
    api = await startApi({
      "/api/operator/organizations": {
        status: 200,
        body: [
          {
            organization: organization("org-northwind", "Northwind"),
            memberCount: 4,
            ownerCount: 2,
          },
          { organization: organization("org-acme", "Acme Labs"), memberCount: 1, ownerCount: 0 },
        ],
      },
    });
    const response = await ask(api.apiUrl, "organizations");

    expect(api.paths).toEqual(["/api/operator/organizations"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: [
            {
              organization: { id: "org-northwind", name: "Northwind" },
              memberCount: 4,
              ownerCount: 2,
            },
            { organization: { id: "org-acme", name: "Acme Labs" }, memberCount: 1, ownerCount: 0 },
          ],
        },
      },
    });
  });

  it("answers someone who isn't an operator not found, as the API does", async () => {
    api = await startApi({
      "/api/operator/organizations": { status: 404, body: { _tag: "NotFound", id: "operator" } },
    });
    const response = await ask(api.apiUrl, "organizations");

    expect(response.status).toBe(404);
  });

  it("reads the multi mode gate item by item", async () => {
    api = await startApi({
      "/api/operator/gate": {
        status: 200,
        body: [
          { id: "https-origin", ok: true, detail: "APP_URL is https.", fix: null },
          {
            id: "budgets",
            ok: false,
            detail: "No organization budget is set.",
            fix: "Set MEND_BUDGET_ORGANIZATION_TURNS.",
          },
        ],
      },
    });
    const response = await ask(api.apiUrl, "gate");

    expect(api.paths).toEqual(["/api/operator/gate"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: [
            { id: "https-origin", ok: true, fix: null },
            { id: "budgets", ok: false, fix: "Set MEND_BUDGET_ORGANIZATION_TURNS." },
          ],
        },
      },
    });
  });
});
