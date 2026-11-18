import { once } from "node:events";
import { createServer } from "node:http";

import {
  AdoptionProgress,
  LaunchRequest,
  NewWorkbenchSession,
  QueuedSession,
} from "@mend/api-contracts";
import { QueuedSessionId } from "@mend/domain";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "http://localhost:3105";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const id = QueuedSessionId.make("3f0c8a52-7e0f-4c1e-9a6d-2f4b5c6d7e8f");
const adoptionId = "5c0ffee0-1b2c-4d3e-8f4a-5b6c7d8e9f00";
const at = new Date("2026-11-18T09:14:00.000Z");

const session = new NewWorkbenchSession({
  harness: "claude",
  label: null,
  name: "lazy-order-history",
  base: null,
  autoLand: null,
});
const launch = new LaunchRequest({
  mode: "protocol",
  prompt: "Load the first 20 orders and fetch more as the list scrolls.",
  model: "opus",
});
/** What the API answers for the session while mobile-app is 64% cloned. */
const waiting = Schema.encodeSync(QueuedSession)(
  new QueuedSession({
    id,
    state: "waiting",
    projectName: "mobile-app",
    clone: new AdoptionProgress({
      id: adoptionId,
      name: "mobile-app",
      source: "https://github.com/northwind/mobile-app",
      state: "running",
      phase: "cloning",
      git: {
        step: "Receiving objects",
        remote: false,
        percent: 64,
        done: 640,
        total: 1000,
        received: "212.00 MiB",
        rate: "3.10 MiB/s",
      },
      projectId: null,
      failure: null,
      gitSaid: null,
      startedAt: at,
      updatedAt: at,
    }),
    failure: null,
    sessionId: null,
    session,
    launch,
    createdAt: at,
    updatedAt: at,
  }),
);

/** An API that answers each queued-session request as the contract says, keeping what it got. */
const startApi = async () => {
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
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(waiting));
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
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
};

const headers = { "content-type": "application/json", origin, cookie: "test-cookie=credential" };

describe("queued sessions router", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeEach(async () => {
    api = await startApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("queues a session on the clone, as the contract's request, and answers its waiting state", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/queuedSessions.queue", {
        method: "POST",
        headers,
        body: JSON.stringify({
          json: {
            id,
            adoptionId,
            session: {
              harness: "claude",
              label: null,
              name: "lazy-order-history",
              base: null,
              autoLand: null,
            },
            launch: { mode: "protocol", prompt: launch.prompt, model: "opus" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "POST", path: "/api/queued-sessions" });
    expect(JSON.parse(api.requests[0]?.body ?? "")).toEqual({
      id,
      adoptionId,
      session: {
        harness: "claude",
        label: null,
        name: "lazy-order-history",
        base: null,
        autoLand: null,
      },
      launch: { mode: "protocol", prompt: launch.prompt, model: "opus" },
    });
    expect(await response.json()).toMatchObject({
      result: { data: { json: { id, state: "waiting", projectName: "mobile-app" } } },
    });
  });

  it("reads how far the clone it waits on got", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const query = encodeURIComponent(JSON.stringify({ json: { id } }));
    const response = await handle(
      new Request(`http://internal-web.invalid/trpc/queuedSessions.read?input=${query}`, {
        headers,
      }),
    );

    expect(api.requests).toEqual([{ method: "GET", path: `/api/queued-sessions/${id}`, body: "" }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: {
            state: "waiting",
            clone: { state: "running", git: { percent: 64 } },
            launch: { prompt: launch.prompt },
          },
        },
      },
    });
  });

  it("cancels it", async () => {
    const handle = createTrpcHandler({ network, apiUrl: api.apiUrl });
    const response = await handle(
      new Request("http://internal-web.invalid/trpc/queuedSessions.cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({ json: { id } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(api.requests).toEqual([
      { method: "DELETE", path: `/api/queued-sessions/${id}`, body: "" },
    ]);
  });
});
