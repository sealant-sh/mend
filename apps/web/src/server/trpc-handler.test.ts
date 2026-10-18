import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apiClientFor } from "./api/run.ts";
import { createTrpcHandler } from "./trpc-handler.ts";

const network = makePublicNetwork(PublicOrigin.make("http://localhost:3105"), [
  PublicOrigin.make("http://mac-mini.local:3105"),
]);

const startApi = async () => {
  const requests: Array<{
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly headers: IncomingHttpHeaders;
  }> = [];
  let exists = false;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    if (request.method === "POST") exists = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        exists,
        publicKey: exists ? "test-public-key" : null,
        fingerprint: exists ? "test-fingerprint" : null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No API address");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    exists: () => exists,
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

const request = (headers: Record<string, string>, path = "git.initKey", method = "POST") =>
  new Request(`http://internal-web.invalid/trpc/${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: JSON.stringify({ json: null }) } : {}),
  });

describe("tRPC source-request trust and API forwarding", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it.each([
    "http://evil.invalid",
    "http://mac-mini.local:3106",
    "https://mac-mini.local:3105",
    "null",
    "",
    "http://localhost:3105, http://evil.invalid",
  ])("rejects %s at the source boundary without issuing an API request", async (origin) => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    for (const [path, method] of [
      ["git.initKey", "POST"],
      ["git.initKey,git.initKey?batch=1", "POST"],
      ["git.key", "GET"],
    ]) {
      const response = await handle(
        request(
          {
            origin,
            cookie: "test-cookie=credential",
            authorization: "Bearer test-native-token",
            host: "localhost:3105",
            "x-forwarded-host": "localhost:3105",
            "x-forwarded-proto": "http",
          },
          path,
          method,
        ),
      );
      expect(response.status).toBe(403);
    }
    expect(api.requests).toHaveLength(0);
    expect(api.exists()).toBe(false);
  });
  it("requires Origin for cookie-bearing POSTs rather than inferring it from the internal URL or Host", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      request({ cookie: "test-cookie=credential", host: "localhost:3105" }),
    );
    expect(response.status).toBe(403);
    expect(api.requests).toHaveLength(0);
  });
  it.each(network.allowedOrigins)(
    "forwards a mutation's credentials and Origin together from %s",
    async (origin) => {
      const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
      const response = await handle(
        request({ origin, cookie: "test-cookie=credential", "x-forwarded-host": "evil.invalid" }),
      );
      expect(response.status).toBe(200);
      expect(api.exists()).toBe(true);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        method: "POST",
        path: "/api/keys/git",
        headers: { origin, cookie: "test-cookie=credential" },
      });
      expect(api.requests[0]?.headers["x-forwarded-host"]).toBeUndefined();
    },
  );
  it("preserves no-Origin bearer clients without manufacturing a trusted Origin", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(request({ authorization: "Bearer test-native-token" }));
    expect(response.status).toBe(200);
    expect(api.exists()).toBe(true);
    expect(api.requests[0]?.headers["authorization"]).toBe("Bearer test-native-token");
    expect(api.requests[0]?.headers["origin"]).toBeUndefined();
    expect(api.requests[0]?.headers["cookie"]).toBeUndefined();
  });
  it("preserves cookie-authenticated GET queries with no Origin", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(request({ cookie: "test-cookie=credential" }, "git.key", "GET"));
    expect(response.status).toBe(200);
    expect(api.requests[0]).toMatchObject({
      method: "GET",
      headers: { cookie: "test-cookie=credential" },
    });
    expect(api.exists()).toBe(false);
  });
  it("the derived client itself never drops or replaces an unlisted Origin", async () => {
    const headers = new Headers({
      cookie: "test-cookie=credential",
      authorization: "Bearer test-native-token",
      origin: "http://evil.invalid",
      host: "localhost:3105",
      forwarded: "host=localhost:3105;proto=http",
      "x-forwarded-host": "localhost:3105",
      "x-forwarded-proto": "http",
    });
    await Effect.runPromise(
      Effect.flatMap(apiClientFor({ headers, apiUrl: api.apiUrl }), (client) =>
        client.gitKeys.init(),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(api.requests[0]?.headers).toMatchObject({
      cookie: "test-cookie=credential",
      authorization: "Bearer test-native-token",
      origin: "http://evil.invalid",
    });
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto"])
      expect(api.requests[0]?.headers[name]).toBeUndefined();
    expect(api.requests[0]?.headers["host"]).toBe(new URL(api.apiUrl).host);
  });
});
