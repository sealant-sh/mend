import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const sessionId = "8b1c3a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f";

/** An API that refuses every discard with the contract's 409, and keeps what it was sent. */
const startApi = async () => {
  const requests: Array<{ readonly path: string | undefined; readonly body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url, body });
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          _tag: "NothingUnsaved",
          sessionId,
          message: "Nothing is waiting to be saved.",
        }),
      );
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
});
