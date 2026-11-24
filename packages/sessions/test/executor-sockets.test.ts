import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { SessionId } from "@mend/domain";
import { BlobStoreConfig } from "@mend/store";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionCaptureApi } from "../src/capture-channel.ts";
import {
  CAPTURE_SOCKET_NAME,
  classifyCaptureSocketRequest,
  ExecutorSockets,
  executorSocketsAt,
  objectStoreEndpointOf,
  SESSION_SOCKET_NAME,
} from "../src/executor-sockets.ts";
import { SessionChannelRegistry, SessionChannelRegistryLive } from "../src/session-channel.ts";
import type { SessionSocketApi } from "../src/session-socket.ts";

/**
 * An executor's `capture.sock` and `session.sock` (agent-home workspace-isolation-architecture.md
 * §6.1), driven the way sealantd drives them: raw HTTP/1.1 written to the Unix socket, with the
 * `Host` header its URL names (sealant-capture `transport.rs`).
 */

const SESSION = SessionId.make("sess-executor-sockets");
const LAUNCH = "launch-executor-1";
const OTHER_LAUNCH = "launch-executor-2";
const SCOPE = "sealant-run-1";
const RECOVERING = "sealant-run-2";

const SIGNED_QUERY =
  "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=GK1%2F20261124%2Fgarage%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20261124T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly body: string;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-xs-"));
const received: Received[] = [];
const captureLaunches: string[] = [];
let store: http.Server;
let storePort = 0;
let runtime: ManagedRuntime.ManagedRuntime<
  ExecutorSockets | SessionChannelRegistry | SessionChannelTokensRepo,
  never
>;
let launchToken = "";
let otherLaunchToken = "";
let personToken = "";

const capture: SessionCaptureApi = {
  planGet: () => Effect.die("not in this test"),
  uploadUrls: () => Effect.die("not in this test"),
  uploadComplete: () => Effect.die("not in this test"),
  register: () => Effect.die("not in this test"),
  changeSummary: () => Effect.die("not in this test"),
  heartbeat: () => Effect.succeed({ expires_in_secs: 30 }),
};

const refused = () => Effect.die("not in this test");
const sessionApi: SessionSocketApi = {
  recipes: () => Effect.succeed([{ name: "web" }]),
  listServices: refused,
  runServiceRecipe: refused,
  runService: refused,
  addService: refused,
  stopService: refused,
  restartService: refused,
  stopSession: refused,
  land: refused,
  agentHook: refused,
  resourceSession: refused,
  mcpCaller: refused,
  keepMcpSignIns: refused,
  listRepositories: refused,
  addableProjects: refused,
  addRepository: refused,
  gitTransport: refused,
  gitTransportDone: () => Effect.void,
  capture,
  captureAs: (launchId) => {
    captureLaunches.push(launchId);
    return capture;
  },
};

/** Write `request` to the socket as is and read everything until the server closes. */
const exchange = (socketPath: string, request: string | Buffer): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    socket.write(request);
  });

const statusOf = (answer: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1]);

const capturePath = path.join(root, SCOPE, CAPTURE_SOCKET_NAME);
const sessionPath = path.join(root, SCOPE, SESSION_SOCKET_NAME);

const post = (
  socketPath: string,
  route: string,
  token: string | null,
  body: unknown,
  host = "mend:3106",
) => {
  const text = JSON.stringify(body);
  return exchange(
    socketPath,
    `POST ${route} HTTP/1.1\r\nHost: ${host}\r\n` +
      (token === null ? "" : `Authorization: Bearer ${token}\r\n`) +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n` +
      `Connection: close\r\n\r\n${text}`,
  );
};

beforeAll(async () => {
  store = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        host: request.headers.host,
        body,
      });
      response.writeHead(200, { etag: '"etag-1"', "content-type": "text/plain" });
      response.end(request.method === "GET" ? "stored bytes" : "");
    });
  });
  await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", resolve));
  const address = store.address();
  storePort = typeof address === "object" && address !== null ? address.port : 0;
  runtime = ManagedRuntime.make(
    executorSocketsAt(root).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SessionChannelRegistryLive,
          SessionChannelTokensRepoMemory,
          BlobStoreConfig.layerFor(
            { kind: "dir", root: path.join(root, "blobs") },
            `http://127.0.0.1:${storePort}`,
          ),
        ),
      ),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* SessionChannelRegistry;
      const tokens = yield* SessionChannelTokensRepo;
      registry.register(SESSION, sessionApi);
      launchToken = yield* tokens.issue(SESSION, LAUNCH);
      otherLaunchToken = yield* tokens.issue(SESSION, OTHER_LAUNCH);
      personToken = yield* tokens.issuePerson(LAUNCH, "account-anna");
      const sockets = yield* ExecutorSockets;
      yield* sockets.bind({ scope: SCOPE, launchId: LAUNCH, mode: "normal" });
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await new Promise<void>((resolve) => store.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("capture.sock", () => {
  it("serves a capture route to the capture credential of its own launch", async () => {
    captureLaunches.length = 0;
    const answer = await post(capturePath, "/lease.heartbeat", launchToken, {
      worktree_id: "wt",
      epoch: 1,
    });
    expect(statusOf(answer)).toBe(200);
    expect(answer).toContain('{"expires_in_secs":30}');
    expect(captureLaunches).toEqual([LAUNCH]);
  });

  it("refuses a capture route without the capture credential of its own launch", async () => {
    const heartbeat = { worktree_id: "wt", epoch: 1 };
    for (const token of [null, otherLaunchToken, personToken, "not-a-token-at-all-0000"]) {
      expect(statusOf(await post(capturePath, "/lease.heartbeat", token, heartbeat))).toBe(401);
    }
  });

  it("relays a presigned PUT and GET to the object store with the request line and Host as sent", async () => {
    received.length = 0;
    const host = `127.0.0.1:${storePort}`;
    const target = `/mend/captures/wt/3/packs/abc?${SIGNED_QUERY}`;
    const put = await exchange(
      capturePath,
      `PUT ${target} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/octet-stream\r\n` +
        `Content-Length: 5\r\nConnection: close\r\n\r\nbytes`,
    );
    expect(statusOf(put)).toBe(200);
    expect(put.toLowerCase()).toContain('etag: "etag-1"');
    const get = await exchange(
      capturePath,
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nRange: bytes=0-0\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(get)).toBe(200);
    expect(get).toContain("stored bytes");
    expect(received).toEqual([
      { method: "PUT", url: target, host, body: "bytes" },
      { method: "GET", url: target, host, body: "" },
    ]);
  });

  it("refuses tunnels, other hosts and ports, unsigned and absolute-form requests, and every session route", async () => {
    received.length = 0;
    const storeHost = `127.0.0.1:${storePort}`;
    const raw = (request: string) => exchange(capturePath, request).then(statusOf);
    expect(
      await raw(`CONNECT /git/transport HTTP/1.1\r\nHost: mend:3106\r\nConnection: close\r\n\r\n`),
    ).toBe(405);
    expect(
      await raw(
        `GET /git/transport HTTP/1.1\r\nHost: mend:3106\r\nConnection: Upgrade\r\nUpgrade: mend-git\r\n\r\n`,
      ),
    ).toBe(405);
    // The store's host on another port: Garage's admin API.
    expect(
      await raw(
        `GET /v2/GetClusterStatus HTTP/1.1\r\nHost: 127.0.0.1:${storePort + 1}\r\nConnection: close\r\n\r\n`,
      ),
    ).toBe(403);
    expect(await raw(`GET / HTTP/1.1\r\nHost: postgres:5432\r\nConnection: close\r\n\r\n`)).toBe(
      403,
    );
    expect(
      await raw(
        `PUT /mend/captures/wt/x HTTP/1.1\r\nHost: ${storeHost}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      ),
    ).toBe(403);
    expect(
      await raw(
        `GET http://${storeHost}/mend/captures/wt/x?${SIGNED_QUERY} HTTP/1.1\r\nHost: ${storeHost}\r\nConnection: close\r\n\r\n`,
      ),
    ).toBe(403);
    for (const route of ["/session/land", "/pickup", "/session/mcp", "/repositories", "/doppler"]) {
      expect(statusOf(await post(capturePath, route, launchToken, {})), route).toBe(403);
    }
    expect(
      await raw(
        `GET /recipes HTTP/1.1\r\nHost: mend:3106\r\nAuthorization: Bearer ${launchToken}\r\nConnection: close\r\n\r\n`,
      ),
    ).toBe(403);
    expect(received).toEqual([]);
  });
});

describe("capture.sock's sorting of a request", () => {
  const garage = objectStoreEndpointOf("http://garage:3900");
  const sort = (method: string, target: string, headers: http.IncomingHttpHeaders) =>
    classifyCaptureSocketRequest({ method, target, headers }, garage);

  it("relays presigned requests to garage:3900 and refuses its admin port", () => {
    expect(sort("PUT", `/mend/captures/k?${SIGNED_QUERY}`, { host: "garage:3900" })).toEqual({
      kind: "object",
    });
    expect(sort("GET", "/v2/GetClusterStatus", { host: "garage:3903" })).toMatchObject({
      kind: "refused",
      status: 403,
    });
    expect(sort("POST", "/plan.get", { host: "garage:3903" })).toMatchObject({
      kind: "refused",
      status: 403,
    });
    expect(
      sort("DELETE", `/mend/captures/k?${SIGNED_QUERY}`, { host: "garage:3900" }),
    ).toMatchObject({ kind: "refused", status: 405 });
    expect(
      sort("PUT", `/mend/captures/k?${SIGNED_QUERY}`, {
        host: "garage:3900",
        authorization: "AWS4-HMAC-SHA256 Credential=GK1",
      }),
    ).toMatchObject({ kind: "refused", status: 403 });
  });

  it("serves capture routes by POST only, and nothing at a host it was not configured for", () => {
    expect(sort("POST", "/capture.register", { host: "mend:3106" })).toEqual({
      kind: "capture",
      route: "/capture.register",
    });
    expect(sort("GET", "/plan.get", { host: "mend:3106" })).toMatchObject({ status: 405 });
    expect(
      sort("GET", `/latest/meta-data?${SIGNED_QUERY}`, { host: "169.254.169.254" }),
    ).toMatchObject({ status: 403 });
    expect(
      classifyCaptureSocketRequest(
        { method: "PUT", target: `/k?${SIGNED_QUERY}`, headers: { host: "garage:3900" } },
        objectStoreEndpointOf("https://s3.example.com"),
      ),
    ).toMatchObject({ status: 403 });
  });
});

describe("session.sock", () => {
  const get = (route: string, token: string | null) =>
    exchange(
      sessionPath,
      `GET ${route} HTTP/1.1\r\nHost: localhost\r\n` +
        (token === null ? "" : `Authorization: Bearer ${token}\r\n`) +
        `Connection: close\r\n\r\n`,
    );

  it("serves the session routes to a token of its own launch, and nothing without one", async () => {
    const served = await get("/recipes", launchToken);
    expect(statusOf(served)).toBe(200);
    expect(served).toContain('[{"name":"web"}]');
    expect(statusOf(await get("/recipes", null))).toBe(401);
    expect(statusOf(await get("/recipes", otherLaunchToken))).toBe(401);
    expect(
      statusOf(
        await exchange(
          sessionPath,
          `CONNECT /git/transport HTTP/1.1\r\nHost: localhost\r\nx-mend-git-host: github.com\r\n` +
            `x-mend-git-command: git-upload-pack 'acme/api.git'\r\n\r\n`,
        ),
      ),
    ).toBe(401);
  });

  it("serves no capture route: captures travel over capture.sock", async () => {
    expect(
      statusOf(
        await post(sessionPath, "/lease.heartbeat", launchToken, { worktree_id: "wt", epoch: 1 }),
      ),
    ).toBe(404);
  });
});

describe("a recovery boot", () => {
  it("binds capture.sock and never session.sock, removing one a normal boot left", async () => {
    const dir = path.join(root, RECOVERING);
    const bound = await runtime.runPromise(
      Effect.gen(function* () {
        const sockets = yield* ExecutorSockets;
        yield* sockets.bind({ scope: RECOVERING, launchId: LAUNCH, mode: "normal" });
        expect(fs.existsSync(path.join(dir, SESSION_SOCKET_NAME))).toBe(true);
        return yield* sockets.bind({ scope: RECOVERING, launchId: LAUNCH, mode: "recover" });
      }),
    );
    expect(bound).toEqual([path.join(dir, CAPTURE_SOCKET_NAME)]);
    expect(fs.readdirSync(dir)).toEqual([CAPTURE_SOCKET_NAME]);
    const heartbeat = await post(
      path.join(dir, CAPTURE_SOCKET_NAME),
      "/lease.heartbeat",
      launchToken,
      { worktree_id: "wt", epoch: 1 },
    );
    expect(statusOf(heartbeat)).toBe(200);
  });

  it("refuses a scope that is not a container name", async () => {
    const outcome = await runtime.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const sockets = yield* ExecutorSockets;
          return yield* sockets.bind({ scope: "../escape", launchId: LAUNCH, mode: "recover" });
        }),
      ),
    );
    expect(outcome._tag).toBe("ExecutorScopeError");
    expect(fs.existsSync(path.join(root, "..", "escape"))).toBe(false);
  });
});
