import { once } from "node:events";
import { createServer } from "node:http";

import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";
import type { AppRouter } from "./index.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);

/** A Mend API that answers each request with the next answer, and keeps what it was sent. */
const startApi = async (answers: ReadonlyArray<unknown>) => {
  const requests: Array<{
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: body === "" ? null : JSON.parse(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answers[requests.length - 1]));
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

const clientFor = (apiUrl: string) => {
  const handle = createTrpcHandler({ network, apiUrl });
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${origin}/trpc`,
        transformer: superjson,
        headers: { origin, cookie: "test-cookie=credential" },
        fetch: (url, init) =>
          handle(
            new Request(url, {
              ...(init?.method === undefined ? {} : { method: init.method }),
              ...(init?.headers === undefined ? {} : { headers: init.headers }),
              ...(init?.body === undefined ? {} : { body: init.body }),
            }),
          ),
      }),
    ],
  });
};

const saved = { slackSessions: false, turnFinished: false, needsInput: true, failed: true };

describe("devices.notificationSettings and setNotificationSettings", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi([saved, { ...saved, turnFinished: true }]);
  });
  afterEach(async () => {
    await api.close();
  });

  it("reads the signed-in person's setting and saves the whole of it", async () => {
    const client = clientFor(api.apiUrl);

    expect(await client.devices.notificationSettings.query()).toEqual(saved);
    expect(
      await client.devices.setNotificationSettings.mutate({ ...saved, turnFinished: true }),
    ).toEqual({ ...saved, turnFinished: true });

    expect(api.requests).toEqual([
      { method: "GET", path: "/api/me/notifications", body: null },
      {
        method: "PUT",
        path: "/api/me/notifications",
        body: { ...saved, turnFinished: true },
      },
    ]);
  });
});
