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

/** A Mend API that answers the key check with each response in turn. */
const startApi = async (answers: ReadonlyArray<unknown>) => {
  const requests: Array<{
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly cookie: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, cookie: request.headers.cookie });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answers[requests.length - 1]));
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

describe("git.checkKey", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi([
      {
        state: "accepted",
        githubLogin: "linus-p",
        deployKeyRepository: null,
        observed:
          "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
        checkedAt: "2026-11-18T03:00:00.000Z",
      },
      {
        state: "refused",
        observed: "git@github.com: Permission denied (publickey).",
        checkedAt: "2026-11-18T03:01:00.000Z",
      },
      { state: "no-key", checkedAt: "2026-11-18T03:02:00.000Z" },
    ]);
  });
  afterEach(async () => {
    await api.close();
  });

  it("asks the API to check the caller's key and hands each answer back by its state", async () => {
    const client = clientFor(api.apiUrl);

    expect(await client.git.checkKey.mutate()).toEqual({
      state: "accepted",
      githubLogin: "linus-p",
      deployKeyRepository: null,
      observed:
        "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
      checkedAt: new Date("2026-11-18T03:00:00.000Z"),
    });
    expect(await client.git.checkKey.mutate()).toEqual({
      state: "refused",
      observed: "git@github.com: Permission denied (publickey).",
      checkedAt: new Date("2026-11-18T03:01:00.000Z"),
    });
    expect(await client.git.checkKey.mutate()).toEqual({
      state: "no-key",
      checkedAt: new Date("2026-11-18T03:02:00.000Z"),
    });

    expect(api.requests).toEqual(
      Array.from({ length: 3 }, () => ({
        method: "POST",
        path: "/api/keys/git/check",
        cookie: "test-cookie=credential",
      })),
    );
  });
});
