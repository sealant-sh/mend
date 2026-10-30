import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const sessionId = "8b1c3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f";
const alice = "user-alice";

const organizationOf = (userId: string) => ({
  organization: {
    id: "org-test",
    name: "Test",
    createdByUserId: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  userId,
  role: "member",
  memberCount: 2,
  operator: false,
  tenancy: "single",
  mountDelivery: "bind",
});

/**
 * An API where `signedIn` is signed in and every other request is refused with `refusal` as its
 * 409. It keeps what it was sent.
 */
const startApi = async (
  refusal: Record<string, unknown> = {
    _tag: "NothingUnsaved",
    sessionId,
    message: "Nothing is waiting to be saved.",
  },
  signedIn = alice,
) => {
  const requests: Array<{ readonly path: string | undefined; readonly body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url, body });
      if (request.url === "/api/organization") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(organizationOf(signedIn)));
        return;
      }
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify(refusal));
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

describe("sessions router", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("sends the owner's discard to the API as the contract's request class", async () => {
    // A plain `{ confirm }` object fails the client's encode before any request leaves, and the
    // page's "Discard unsaved and stop…" answered 500 every time (RC 0.36.0-next.754, E-F1).
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.discardUnsaved", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({ json: { id: sessionId } }),
      }),
    );

    expect(api.requests).toEqual([
      {
        path: `/api/sessions/${sessionId}/discard-unsaved`,
        body: JSON.stringify({ confirm: "discard unsaved" }),
      },
    ]);
    // The API's refusal crosses as its own status and words, not as an internal error.
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Nothing is waiting to be saved.");
  });

  it("forwards a message's words and key, and its refusal reaches the browser in words", async () => {
    const words =
      "You have two running turns in this session; Mend cannot tell which one to steer.";
    await api.close();
    api = await startApi({ _tag: "MessageTargetAmbiguous", sessionId, message: words });
    const clientMessageId = "0d6f3c1a-2b4e-4f6a-9c8d-7e5f4a3b2c1d";
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: {
            id: sessionId,
            input: "also check the migrations",
            clientMessageId,
            expectedUserId: alice,
          },
        }),
      }),
    );

    expect(api.requests).toEqual([
      { path: "/api/organization", body: "" },
      {
        path: `/api/sessions/${sessionId}/messages`,
        body: JSON.stringify({ input: "also check the migrations", clientMessageId }),
      },
    ]);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: { json: { message: words, data: { tag: "MessageTargetAmbiguous" } } },
    });
  });

  it("forwards nothing when another account is signed in than the one who wrote the message", async () => {
    await api.close();
    api = await startApi(undefined, "user-bob");
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/sessions.sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "test-cookie=credential" },
        body: JSON.stringify({
          json: {
            id: sessionId,
            input: "Alice private words",
            clientMessageId: "0d6f3c1a-2b4e-4f6a-9c8d-7e5f4a3b2c1d",
            expectedUserId: alice,
          },
        }),
      }),
    );

    expect(api.requests).toEqual([{ path: "/api/organization", body: "" }]);
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: {
        json: {
          message: "another account is signed in now · this message was not sent",
          data: { tag: "MessageAuthorChanged" },
        },
      },
    });
  });
});
