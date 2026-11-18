import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { afterEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const headers = { "content-type": "application/json", origin, cookie: "test-cookie=credential" };

const OWN = {
  autoTour: true,
  autoSuggest: false,
  autoName: true,
  autoLand: true,
  backgroundSessions: true,
};

/** An API that answers `/api/me/automation` with what it last saved, keeping what it was sent. */
const startApi = async () => {
  let saved = OWN;
  const requests: Array<{ readonly method: string | undefined; readonly body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method, body });
      if (request.url !== "/api/me/automation") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ _tag: "NotFound" }));
        return;
      }
      if (request.method === "PUT") saved = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ own: saved, effective: saved }));
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

const call = (apiUrl: string, path: string, input?: unknown) =>
  createTrpcHandler({ network, apiUrl })(
    new Request(`http://internal-web.invalid/trpc/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers,
      ...(input === undefined ? {} : { body: JSON.stringify({ json: input }) }),
    }),
  );

describe("platform router: your automation, plain values", () => {
  let api: Awaited<ReturnType<typeof startApi>> | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });

  it("reads the person's own switches and saves them as plain values", async () => {
    api = await startApi();
    const read = await call(api.apiUrl, "platform.automation");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ result: { data: { json: { own: OWN } } } });

    const chosen = { ...OWN, autoLand: false };
    const written = await call(api.apiUrl, "platform.setAutomation", chosen);
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({
      result: { data: { json: { own: chosen, effective: chosen } } },
    });
    expect(api.requests.at(-1)).toEqual({ method: "PUT", body: JSON.stringify(chosen) });
  });

  it("refuses an Inherit (null) before it reaches the server", async () => {
    api = await startApi();
    const response = await call(api.apiUrl, "platform.setAutomation", { ...OWN, autoLand: null });
    expect(response.status).toBe(400);
    expect(api.requests).toEqual([]);
  });
});
