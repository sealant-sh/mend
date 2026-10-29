import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { describe, expect, it } from "vitest";

import type { Connection } from "./live";
import type { PairingConfigStore, PairingDevice } from "./pairing-client";
import { HttpPairingClient } from "./pairing-client";
import { parsePairUrl } from "./pairing-code";

class InMemoryConfigStore implements PairingConfigStore {
  config: Connection | null = null;
  readonly writes: Array<Connection> = [];

  async saveConfig(config: Connection): Promise<void> {
    this.config = config;
    this.writes.push(config);
  }
}

const device: PairingDevice = { name: "Test phone", platform: "ios" };
const network = makePublicNetwork(PublicOrigin.make("https://mend.example"), [
  PublicOrigin.make("http://100.64.1.2:3105"),
]);
const claimResponse = {
  url: network.appUrl,
  token: "test-device-token",
  device: { name: "Paired phone" },
  user: { id: "user-1", name: "Test user", email: "test@example.com" },
};

const startPairServer = async (body: unknown, status = 200) => {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    origin: string | undefined;
    authorization: string | undefined;
    body: string;
  }> = [];
  const server = createServer((request, response) => {
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        origin: request.headers.origin,
        authorization: request.headers.authorization,
        body: requestBody,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
};

describe("mobile pairing over HTTP", () => {
  it.each(["manual", "scan"])(
    "saves the configured server-selected URL after an unlisted %s arrival",
    async (arrival) => {
      const server = await startPairServer(claimResponse);
      const store = new InMemoryConfigStore();
      const client = new HttpPairingClient(store);
      try {
        expect(network.allowedOrigins.some((url) => url === server.url)).toBe(false);
        const payload =
          arrival === "scan"
            ? parsePairUrl(`mend://pair?u=${encodeURIComponent(server.url)}&c=ABCDEFGH`)
            : { url: `${server.url}/`, code: "abcd-efgh" };
        if (payload === null) throw new Error("test pairing link did not parse");
        const result = await client.claim(payload, device);
        expect(result.state).toBe("paired");
        if (result.state !== "paired") throw new Error("test pairing was refused");
        expect(result.user).toEqual(claimResponse.user);
        expect(result.config).toEqual({
          url: network.appUrl,
          token: claimResponse.token,
          deviceName: "Paired phone",
          pairedAt: expect.any(String),
        });
        expect(store.config).toEqual(result.config);
        expect(store.writes).toEqual([result.config]);
        expect(server.requests).toEqual([
          {
            method: "POST",
            path: "/api/pair",
            origin: undefined,
            authorization: undefined,
            body: JSON.stringify({
              code: "ABCDEFGH",
              name: device.name,
              platform: device.platform,
            }),
          },
        ]);
      } finally {
        await server.close();
      }
    },
  );

  it.each([
    undefined,
    null,
    42,
    {},
    "",
    "not a URL",
    "/relative",
    "mend.example",
    "ftp://mend.example",
    "javascript:alert(1)",
    "https://user:password@mend.example",
    "https://mend.example/path",
    "https://mend.example?query=1",
    "https://mend.example#fragment",
    "https://mend.example/",
    "https://MEND.example",
    "https://mend.example:443",
    " https://mend.example",
    "http://0.0.0.0:3105",
    "http://[::]:3105",
    "https://*.example",
  ])("refuses server URL %j without saving bearer credentials", async (url) => {
    const server = await startPairServer({ ...claimResponse, url });
    const store = new InMemoryConfigStore();
    try {
      const result = await new HttpPairingClient(store).claim(
        { url: server.url, code: "ABCDEFGH" },
        device,
      );
      expect(result).toEqual({ state: "refused", reason: "server answered an unreadable body" });
      expect(store.config).toBeNull();
      expect(store.writes).toEqual([]);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("leaves an existing pairing intact when the new server returns a malformed URL", async () => {
    const server = await startPairServer({
      ...claimResponse,
      url: "https://user:password@mend.example",
    });
    const store = new InMemoryConfigStore();
    const previous: Connection = {
      url: "https://previous.example",
      token: "previous-test-token",
      deviceName: null,
      pairedAt: null,
    };
    await store.saveConfig(previous);
    try {
      const result = await new HttpPairingClient(store).claim(
        { url: server.url, code: "ABCDEFGH" },
        device,
      );
      expect(result.state).toBe("refused");
      expect(store.config).toEqual(previous);
      expect(store.writes).toEqual([previous]);
    } finally {
      await server.close();
    }
  });

  it.each([404, 410, 429, 500])(
    "does not save credentials from HTTP %s even with a valid body",
    async (status) => {
      const server = await startPairServer(claimResponse, status);
      const store = new InMemoryConfigStore();
      try {
        const result = await new HttpPairingClient(store).claim(
          { url: server.url, code: "ABCDEFGH" },
          device,
        );
        expect(result.state).toBe("refused");
        expect(store.writes).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );
});
