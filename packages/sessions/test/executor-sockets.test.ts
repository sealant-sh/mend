import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { SessionId } from "@mend/domain";
import { BlobStoreConfig } from "@mend/store";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionCaptureApi } from "../src/capture-channel.ts";
import {
  CAPTURE_SOCKET_NAME,
  classifyCaptureSocketRequest,
  executorScopeOf,
  clientHelloServerName,
  ExecutorSockets,
  executorSocketsAt,
  objectStoreEndpointOf,
  objectStoreOfConfig,
  SESSION_SOCKET_NAME,
} from "../src/executor-sockets.ts";
import { SCRIPT_TRANSPORT_PRELUDE } from "../src/script-transport.ts";
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
let otherLaunchPersonToken = "";

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
  // The engine grants a launch's tokens the session's routes; session.sock still takes only a
  // person's, which is what these tests check of it.
  channelFor: () => Effect.succeed({ ok: true, api: sessionApi }),
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
      otherLaunchPersonToken = yield* tokens.issuePerson(OTHER_LAUNCH, "account-anna");
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

  it("answers 400 to a target it cannot read, and goes on serving", async () => {
    for (const target of ["//", "//[", "//:80/x"]) {
      const answer = await exchange(
        capturePath,
        `GET ${target} HTTP/1.1\r\nHost: mend:3106\r\nConnection: close\r\n\r\n`,
      );
      expect(statusOf(answer), target).toBe(400);
    }
    const heartbeat = await post(capturePath, "/lease.heartbeat", launchToken, {
      worktree_id: "wt",
      epoch: 1,
    });
    expect(statusOf(heartbeat)).toBe(200);
  });

  it("serves Mend and the object store on one hostname, and only the store's own port relays", async () => {
    received.length = 0;
    // Mend at 127.0.0.1:3106 beside the store at 127.0.0.1:<storePort>, as .env.example puts
    // both on 172.17.0.1.
    const heartbeat = await post(
      capturePath,
      "/lease.heartbeat",
      launchToken,
      { worktree_id: "wt", epoch: 1 },
      "127.0.0.1:3106",
    );
    expect(statusOf(heartbeat)).toBe(200);
    const target = `/mend/captures/wt/4/packs/def?${SIGNED_QUERY}`;
    const put = await exchange(
      capturePath,
      `PUT ${target} HTTP/1.1\r\nHost: 127.0.0.1:${storePort}\r\nContent-Length: 2\r\n` +
        `Connection: close\r\n\r\nok`,
    );
    expect(statusOf(put)).toBe(200);
    // The store's admin port on the same host: never relayed, whatever the method.
    const admin = `127.0.0.1:${storePort + 3}`;
    for (const request of [
      `GET /v2/GetClusterStatus?${SIGNED_QUERY} HTTP/1.1\r\nHost: ${admin}\r\nConnection: close\r\n\r\n`,
      `POST /v2/CreateKey HTTP/1.1\r\nHost: ${admin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      `PUT ${target} HTTP/1.1\r\nHost: ${admin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    ]) {
      expect(statusOf(await exchange(capturePath, request)), request).toBe(403);
    }
    expect(received.map((each) => each.method)).toEqual(["PUT"]);
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
    // A capture route is Mend's whatever host it names; it is never relayed.
    expect(sort("POST", "/plan.get", { host: "garage:3903" })).toEqual({
      kind: "capture",
      route: "/plan.get",
    });
    expect(sort("PUT", `/mend/captures/k?${SIGNED_QUERY}`, { host: "garage:3903" })).toMatchObject({
      kind: "refused",
      status: 403,
    });
    for (const target of ["//", "//[", "//:80/x"]) {
      expect(sort("GET", target, { host: "garage:3900" }), target).toMatchObject({ status: 400 });
    }
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
        (token === null
          ? ""
          : `Authorization: Bearer ${token}\r\nx-mend-session-id: ${SESSION}\r\n`) +
        `Connection: close\r\n\r\n`,
    );
  const connect = (token: string | null) =>
    exchange(
      sessionPath,
      `CONNECT /git/transport HTTP/1.1\r\nHost: localhost\r\n` +
        (token === null
          ? ""
          : `Authorization: Bearer ${token}\r\nx-mend-session-id: ${SESSION}\r\n`) +
        `x-mend-git-host: github.com\r\nx-mend-git-command: git-upload-pack 'acme/api.git'\r\n\r\n`,
    );

  it("serves the session routes to a person's token of its own launch", async () => {
    const served = await get("/recipes", personToken);
    expect(statusOf(served)).toBe(200);
    expect(served).toContain('[{"name":"web"}]');
  });

  it("takes its own launch's token, which a shared layout's processes carry, and refuses none and another launch's", async () => {
    expect(statusOf(await get("/recipes", launchToken))).toBe(200);
    for (const token of [null, otherLaunchToken, otherLaunchPersonToken]) {
      expect(statusOf(await get("/recipes", token)), String(token)).toBe(401);
      expect(statusOf(await connect(token)), String(token)).toBe(401);
    }
  });

  it("serves no capture route: captures travel over capture.sock", async () => {
    const text = JSON.stringify({ worktree_id: "wt", epoch: 1 });
    const answer = await exchange(
      sessionPath,
      `POST /lease.heartbeat HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${personToken}\r\n` +
        `x-mend-session-id: ${SESSION}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
    );
    expect(statusOf(answer)).toBe(404);
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

describe("the object store capture.sock relays to", () => {
  it("is MEND_BLOB_STORE_PUBLIC_URL's, else MEND_BLOB_STORE's endpoint, scheme kept", () => {
    expect(objectStoreEndpointOf("http://garage:3900", "https://s3.example.com")).toEqual({
      hostname: "garage",
      port: 3900,
      protocol: "http",
    });
    expect(objectStoreEndpointOf(undefined, "http://garage:3900")).toEqual({
      hostname: "garage",
      port: 3900,
      protocol: "http",
    });
    expect(objectStoreEndpointOf(undefined, "https://s3.example.com")).toEqual({
      hostname: "s3.example.com",
      port: 443,
      protocol: "https",
    });
    expect(objectStoreEndpointOf(undefined, undefined)).toBeNull();
  });

  it("takes a Host without a port for an https store's default port", () => {
    const s3 = objectStoreEndpointOf(undefined, "https://s3.example.com");
    const put = (host: string) =>
      classifyCaptureSocketRequest(
        { method: "PUT", target: `/mend/k?${SIGNED_QUERY}`, headers: { host } },
        s3,
      );
    expect(put("s3.example.com")).toEqual({ kind: "object" });
    expect(put("s3.example.com:443")).toEqual({ kind: "object" });
    expect(put("s3.example.com:80")).toMatchObject({ status: 403 });
  });
});

describe("capture.sock and more than one Host", () => {
  it("answers 400 to a request naming Host twice, and goes on serving", async () => {
    const answer = await exchange(
      capturePath,
      `PUT /mend/k?${SIGNED_QUERY} HTTP/1.1\r\nHost: 127.0.0.1:${storePort}\r\n` +
        `Host: garage:3903\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(answer)).toBe(400);
    expect(
      classifyCaptureSocketRequest(
        {
          method: "PUT",
          target: `/k?${SIGNED_QUERY}`,
          headers: { host: "garage:3900" },
          rawHeaders: ["Host", "garage:3900", "host", "garage:3903"],
        },
        objectStoreEndpointOf("http://garage:3900"),
      ),
    ).toMatchObject({ status: 400 });
    const heartbeat = await post(capturePath, "/lease.heartbeat", launchToken, {
      worktree_id: "wt",
      epoch: 1,
    });
    expect(statusOf(heartbeat)).toBe(200);
  });
});

describe("binding one scope", () => {
  it("binds one call at a time: the last asked is what the scope serves", async () => {
    const scope = "sealant-run-3";
    const dir = path.join(root, scope);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sockets = yield* ExecutorSockets;
        yield* Effect.all(
          [
            sockets.bind({ scope, launchId: LAUNCH, mode: "normal" }),
            sockets.bind({ scope, launchId: LAUNCH, mode: "recover" }),
            sockets.bind({ scope, launchId: LAUNCH, mode: "normal" }),
            sockets.bind({ scope, launchId: LAUNCH, mode: "recover" }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(fs.readdirSync(dir)).toEqual([CAPTURE_SOCKET_NAME]);
    const heartbeat = await post(
      path.join(dir, CAPTURE_SOCKET_NAME),
      "/lease.heartbeat",
      launchToken,
      {
        worktree_id: "wt",
        epoch: 1,
      },
    );
    expect(statusOf(heartbeat)).toBe(200);
  });

  it("closes a Git tunnel the session socket handed over when the scope turns to recovery", async () => {
    const scope = "sealant-run-4";
    const session = SessionId.make("sess-executor-sockets-tunnel");
    const launch = "launch-executor-4";
    const holding: SessionSocketApi = {
      ...sessionApi,
      capture: undefined,
      captureAs: undefined,
      // The tunnel waits on Mend's signer, as one whose remote is slow to answer does.
      gitTransport: () => Effect.never,
      channelFor: () => Effect.succeed({ ok: true, api: holding }),
    };
    const person = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* SessionChannelRegistry;
        const tokens = yield* SessionChannelTokensRepo;
        registry.register(session, holding);
        const token = yield* tokens.issuePerson(launch, "account-anna");
        yield* tokens.issue(session, launch);
        const sockets = yield* ExecutorSockets;
        yield* sockets.bind({ scope, launchId: launch, mode: "normal" });
        return token;
      }),
    );
    const tunnel = net.createConnection(path.join(root, scope, SESSION_SOCKET_NAME));
    const closed = new Promise<void>((resolve) => tunnel.on("close", () => resolve()));
    tunnel.on("error", () => undefined);
    tunnel.write(
      `CONNECT /git/transport HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${person}\r\n` +
        `x-mend-session-id: ${session}\r\nx-mend-git-host: github.com\r\n` +
        `x-mend-git-command: git-upload-pack 'acme/api.git'\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tunnel.destroyed).toBe(false);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sockets = yield* ExecutorSockets;
        yield* sockets.bind({ scope, launchId: launch, mode: "recover" });
      }),
    );
    await closed;
    expect(fs.readdirSync(path.join(root, scope))).toEqual([CAPTURE_SOCKET_NAME]);
  });
});

describe("capture.sock in front of an https object store", () => {
  // sealant-capture's capture dial (`transport.rs`) speaks TLS over the socket for an https
  // presigned URL, naming the URL's host as its SNI: the relay passes those bytes to the store.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-xs-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const seen: Array<{ readonly method: string; readonly url: string; readonly host: string }> = [];
  let tlsStore: https.Server;
  let tlsRuntime: ManagedRuntime.ManagedRuntime<ExecutorSockets, never>;
  const scope = "sealant-run-tls";
  const socketPath = path.join(dir, "sockets", scope, CAPTURE_SOCKET_NAME);

  beforeAll(async () => {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
      ].concat(
        [
          "-keyout",
          key,
          "-out",
          cert,
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        ["-days", "1"],
      ),
      { stdio: "ignore" },
    );
    tlsStore = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (request, response) => {
        seen.push({
          method: request.method ?? "",
          url: request.url ?? "",
          host: request.headers.host ?? "",
        });
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { etag: '"etag-tls"' });
          response.end();
        });
      },
    );
    await new Promise<void>((resolve) => tlsStore.listen(0, "127.0.0.1", resolve));
    const address = tlsStore.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    tlsRuntime = ManagedRuntime.make(
      executorSocketsAt(path.join(dir, "sockets")).pipe(
        Layer.provide(
          Layer.mergeAll(
            SessionChannelRegistryLive,
            SessionChannelTokensRepoMemory,
            BlobStoreConfig.layerFor(
              { kind: "dir", root: path.join(dir, "blobs") },
              `https://localhost:${port}`,
            ),
          ),
        ),
      ),
    );
    await tlsRuntime.runPromise(
      Effect.gen(function* () {
        const sockets = yield* ExecutorSockets;
        yield* sockets.bind({ scope, launchId: LAUNCH, mode: "normal" });
      }),
    );
  });

  afterAll(async () => {
    await tlsRuntime.dispose();
    await new Promise<void>((resolve) => tlsStore.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const overTls = (servername: string, request: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const client = tls.connect({
        socket: net.createConnection(socketPath),
        servername,
        ca: fs.readFileSync(cert),
      });
      let answer = "";
      client.setEncoding("utf8");
      client.on("secureConnect", () => client.write(request));
      client.on("data", (chunk: string) => (answer += chunk));
      client.on("end", () => resolve(answer));
      client.on("close", () => resolve(answer));
      client.on("error", reject);
    });

  it("relays TLS naming the store to it unchanged, its certificate checked end to end", async () => {
    const answer = await overTls(
      "localhost",
      `PUT /mend/k?${SIGNED_QUERY} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n` +
        `Connection: close\r\n\r\nhi`,
    );
    expect(statusOf(answer)).toBe(200);
    expect(answer).toContain('"etag-tls"');
    expect(seen).toEqual([{ method: "PUT", url: `/mend/k?${SIGNED_QUERY}`, host: "localhost" }]);
  });

  it("closes TLS that names another host, and reaches nothing", async () => {
    const before = seen.length;
    const answer = await overTls(
      "garage",
      `GET / HTTP/1.1\r\nHost: garage\r\nConnection: close\r\n\r\n`,
    ).catch(() => "");
    expect(answer).toBe("");
    expect(seen).toHaveLength(before);
  });

  it("still serves plain HTTP capture routes beside it", async () => {
    const answer = await exchange(
      socketPath,
      `POST /lease.heartbeat HTTP/1.1\r\nHost: mend:3106\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    // No credential: refused by the capture route's own check, so the HTTP path was taken.
    expect(statusOf(answer)).toBe(401);
  });
});

describe("a TLS ClientHello's server name", () => {
  it("is read from the record, and answers undefined until the record is whole", () => {
    expect(clientHelloServerName(Buffer.from([0x47, 0x45, 0x54, 0x20, 0x2f]))).toBeNull();
    expect(clientHelloServerName(Buffer.from([0x16, 0x03, 0x01]))).toBeUndefined();
    expect(
      clientHelloServerName(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x40, 0x01])),
    ).toBeUndefined();
  });
});

describe("a workspace process on session.sock", () => {
  it("speaks the channel through it with its token, as MEND_SESSION_SOCKET names it", async () => {
    const script = `${SCRIPT_TRANSPORT_PRELUDE}
const options = transportOptions("GET", "/recipes");
transportClient()
  .request(options, (response) => {
    let body = "";
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => process.stdout.write(transport.kind + " " + response.statusCode + " " + body));
  })
  .end();
`;
    // Run beside this process, not blocking it: the socket's server answers from here.
    const answer = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["-e", script],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            MEND_SESSION_SOCKET: sessionPath,
            MEND_SESSION_ID: SESSION,
            MEND_SESSION_TOKEN: launchToken,
            MEND_SESSION_ENDPOINT: "http://mend.invalid:3106",
          },
          encoding: "utf8",
          timeout: 20_000,
        },
        (error, stdout) => {
          if (error === null) resolve(stdout);
          else reject(error);
        },
      ),
    );
    expect(answer).toBe('session-socket 200 [{"name":"web"}]');
  });
});

describe("binding a scope again as it stands", () => {
  it("leaves it serving, its open connections kept", async () => {
    const scope = "mend-rebind-scope";
    const socketPath = path.join(root, scope, SESSION_SOCKET_NAME);
    await runtime.runPromise(
      Effect.flatMap(ExecutorSockets, (sockets) =>
        sockets.bind({ scope, launchId: LAUNCH, mode: "normal" }),
      ),
    );
    const held = net.createConnection(socketPath);
    await new Promise<void>((resolve) => held.once("connect", () => resolve()));
    await runtime.runPromise(
      Effect.flatMap(ExecutorSockets, (sockets) =>
        sockets.bind({ scope, launchId: LAUNCH, mode: "normal" }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held.destroyed).toBe(false);
    held.destroy();
    expect(executorScopeOf("launch-1")).toMatch(/^mend-[0-9a-f]{24}$/);
    expect(executorScopeOf("launch-1")).toBe(executorScopeOf("launch-1"));
  });
});

describe("the store capture.sock relays to, from the configuration", () => {
  it("is the origin of the URLs its presigner mints, else the public URL as it is", async () => {
    expect(
      await Effect.runPromise(
        objectStoreOfConfig({
          target: {
            kind: "s3",
            bucket: "mend",
            endpoint: "http://garage:3900",
            region: "garage",
            forcePathStyle: true,
          },
          publicUrl: "http://garage:3900",
        }),
      ),
    ).toEqual({ hostname: "garage", port: 3900, protocol: "http" });
    expect(
      await Effect.runPromise(
        objectStoreOfConfig({ target: { kind: "dir", root: "/tmp/blobs" }, publicUrl: undefined }),
      ),
    ).toBeNull();
  });

  it("serves a capture route by plain HTTP whatever host it names, as a plan over the socket asks", () => {
    expect(
      classifyCaptureSocketRequest(
        { method: "POST", target: "/plan.get", headers: { host: "mend:3106" } },
        { hostname: "mend.captures.s3.eu-west-1.amazonaws.com", port: 443, protocol: "https" },
      ),
    ).toEqual({ kind: "capture", route: "/plan.get" });
  });
});
