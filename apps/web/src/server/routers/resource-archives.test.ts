import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { deserialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
afterEach(() => vi.unstubAllGlobals());

describe("the owner's archived resources read", () => {
  it("reads the organization's inventory through the API and keeps unknown sizes", async () => {
    const asked: Array<string> = [];
    vi.stubGlobal("fetch", async (input: Request | URL | string) => {
      asked.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      return Response.json([
        {
          organizationId: "org-a",
          projectId: "p-old",
          projectName: "api",
          createdByUserId: "alice",
          archivedAt: "2026-10-31T14:02:00Z",
          volumes: [
            {
              instanceKey: "db",
              resourceName: "db",
              name: "data",
              dockerName: "kept-db",
              bytes: null,
            },
          ],
        },
      ]);
    });
    const handle = createTrpcHandler({ network, apiUrl: "http://api.internal" });
    const response = await handle(
      new Request(`${origin}/trpc/organization.resourceArchives`, {
        headers: { authorization: "Bearer person", origin },
      }),
    );
    expect(response.status).toBe(200);
    const body: { result: { data: Parameters<typeof deserialize>[0] } } = await response.json();
    expect(deserialize(body.result.data)).toMatchObject([
      { projectName: "api", volumes: [{ dockerName: "kept-db", bytes: null }] },
    ]);
    expect(asked).toEqual(["/api/organization/resource-archives"]);
  });
});
