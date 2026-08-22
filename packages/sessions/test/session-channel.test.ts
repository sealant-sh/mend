import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { SessionId } from "@mend/domain";
import { DeploymentConfig, StoreConfig } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frame, makeFrameFeed } from "../src/git-transport.ts";
import {
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistryLive,
  parseChannelCredentials,
} from "../src/session-channel.ts";
import {
  SessionSocketHost,
  SessionSocketHostLive,
  type SessionSocketApi,
} from "../src/session-socket.ts";

/**
 * The NETWORK session channel (docs/KUBERNETES.md): the same routes and the same git tunnel as
 * the per-session socket, reachable over TCP with a per-session bearer token. Kubernetes mode
 * creates no socket; the staged helper and shim fall back to the endpoint.
 */

const storeRoot = path.join(os.tmpdir(), `mend-channel-test-${process.pid}`);
const SESSION = SessionId.make("sess-channel-1");
const OTHER = SessionId.make("sess-channel-2");

const api = (seen: unknown[]): SessionSocketApi => ({
  recipes: () => Effect.succeed([{ name: "web", command: "pnpm dev", port: 3000 }]),
  listServices: () => Effect.succeed([]),
  runServiceRecipe: (name) =>
    Effect.sync(() => {
      seen.push({ recipe: name });
      return {
        service: { id: "svc-recipe", name, currentAttemptId: null },
        attempts: [],
        currentForward: null,
        latestObservation: null,
      };
    }),
  runService: (argv, port, name) =>
    Effect.sync(() => {
      seen.push({ argv, port, name });
      return {
        service: {
          id: "svc-1",
          name,
          workspacePort: port,
          transport: "tcp",
          currentAttemptId: null,
        },
        attempts: [],
        currentForward: null,
        latestObservation: null,
      };
    }),
  addService: (port, name) =>
    Effect.succeed({
      service: { id: "svc-2", name, workspacePort: port, transport: "tcp", currentAttemptId: null },
      attempts: [],
      currentForward: null,
      latestObservation: null,
    }),
  stopService: (id) =>
    Effect.succeed({
      service: { id, name: "x", currentAttemptId: null },
      attempts: [],
      currentForward: null,
      latestObservation: null,
    }),
  restartService: (id) =>
    Effect.succeed({
      service: { id, name: "x", currentAttemptId: null },
      attempts: [],
      currentForward: null,
      latestObservation: null,
    }),
  gitTransport: (request) =>
    Effect.sync(() => {
      seen.push({ git: request });
      // "ssh" stand-in: echo stdin to stdout, a line to stderr, exit 3.
      return {
        opId: "op-1",
        kind: "fetch" as const,
        argv: ["sh", "-c", 'cat; printf "remote says hi\\n" >&2; exit 3'],
      };
    }),
  gitTransportDone: (opId, exitCode, refUpdates) =>
    Effect.sync(() => {
      seen.push({ done: { opId, exitCode, refUpdates } });
    }),
});

const layers = (
  endpoint: { listen: string; url: string } | undefined,
  mode: "local" | "kubernetes",
) => {
  const registry = SessionChannelRegistryLive;
  const deployment = Layer.succeed(DeploymentConfig, { mode, sessionEndpoint: endpoint });
  const store = StoreConfig.layerFor(storeRoot);
  const tokens = SessionChannelTokensRepoMemory;
  const socketHost = SessionSocketHostLive.pipe(
    Layer.provide(store),
    Layer.provide(deployment),
    Layer.provide(registry),
  );
  const network = SessionChannelNetworkHostLive.pipe(
    Layer.provide(deployment),
    Layer.provide(registry),
    Layer.provide(tokens),
  );
  return Layer.mergeAll(socketHost, network, tokens, registry);
};

const call = (
  address: string,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: unknown }> =>
  new Promise((resolve, reject) => {
    const [host, port] = address.split(":");
    const request = http.request(
      { host, port: Number(port), method, path: route, headers, agent: false },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            json: text === "" ? null : JSON.parse(text),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });

const runScript = (script: string, args: string[], env: Record<string, string>, stdin?: Buffer) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

describe("parseChannelCredentials", () => {
  it("accepts a bearer token with a session id and rejects anything else", () => {
    const token = "a".repeat(43);
    expect(
      parseChannelCredentials({ authorization: `Bearer ${token}`, "x-mend-session-id": "sess-1" }),
    ).toEqual({
      sessionId: "sess-1",
      token,
    });
    expect(parseChannelCredentials({ authorization: `Bearer ${token}` })).toBeUndefined();
    expect(parseChannelCredentials({ "x-mend-session-id": "sess-1" })).toBeUndefined();
    expect(
      parseChannelCredentials({ authorization: "Basic xyz", "x-mend-session-id": "s" }),
    ).toBeUndefined();
    expect(
      parseChannelCredentials({ authorization: `Bearer ${token}`, "x-mend-session-id": "../x" }),
    ).toBeUndefined();
    expect(
      parseChannelCredentials({ authorization: "Bearer short", "x-mend-session-id": "s" }),
    ).toBeUndefined();
  });
});

describe("SessionChannelNetworkHost", () => {
  beforeAll(() => fs.mkdirSync(storeRoot, { recursive: true }));
  afterAll(() => fs.rmSync(storeRoot, { recursive: true, force: true }));

  it("is off in local mode without an endpoint", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SessionChannelNetworkHost;
          expect(host.endpoint).toBeUndefined();
          expect(host.address).toBeUndefined();
        }).pipe(Effect.provide(layers(undefined, "local"))),
      ),
    );
  });

  it("authenticates every request, serves the session api, and revocation cuts access", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          expect(address).not.toBe("");

          const seen: unknown[] = [];
          const dir = yield* sockets.start(SESSION, api(seen));
          // Kubernetes mode: scripts staged, NO socket on the shared store.
          expect(fs.existsSync(path.join(dir, "bin", "mend"))).toBe(true);
          expect(fs.existsSync(path.join(dir, "mend.sock"))).toBe(false);

          const token = yield* tokens.issue(SESSION);
          const auth = { authorization: `Bearer ${token}`, "x-mend-session-id": SESSION };

          // No credentials / wrong token / right token for another session: uniform 401.
          expect((yield* Effect.promise(() => call(address, "GET", "/services", {}))).status).toBe(
            401,
          );
          expect(
            (yield* Effect.promise(() =>
              call(address, "GET", "/services", {
                ...auth,
                authorization: `Bearer ${"b".repeat(43)}`,
              }),
            )).status,
          ).toBe(401);
          expect(
            (yield* Effect.promise(() =>
              call(address, "GET", "/services", { ...auth, "x-mend-session-id": OTHER }),
            )).status,
          ).toBe(401);

          // Valid: the session's own closures.
          const recipes = yield* Effect.promise(() => call(address, "GET", "/recipes", auth));
          expect(recipes).toEqual({
            status: 200,
            json: [{ name: "web", command: "pnpm dev", port: 3000 }],
          });
          const ran = yield* Effect.promise(() =>
            call(address, "POST", "/services/run", auth, {
              argv: ["pnpm", "dev"],
              port: 3000,
              name: "web",
            }),
          );
          expect(ran.status).toBe(200);
          expect(seen).toContainEqual({ argv: ["pnpm", "dev"], port: 3000, name: "web" });

          // A valid token whose session is no longer live: 409, never the other session's api.
          yield* sockets.stop(SESSION);
          expect(
            (yield* Effect.promise(() => call(address, "GET", "/services", auth))).status,
          ).toBe(409);

          // Revoked: 401 again even if the session came back.
          yield* sockets.start(SESSION, api(seen));
          yield* tokens.revoke(SESSION);
          expect(
            (yield* Effect.promise(() => call(address, "GET", "/services", auth))).status,
          ).toBe(401);
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  it("tunnels a git op over the network with the same frames as the socket", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const seen: unknown[] = [];
          yield* sockets.start(SESSION, api(seen));
          const token = yield* tokens.issue(SESSION);
          const [host, port] = address.split(":");

          const result = yield* Effect.promise(
            () =>
              new Promise<{ stdout: string; stderr: string; exit: number | null }>(
                (resolve, reject) => {
                  const request = http.request({
                    host,
                    port: Number(port),
                    method: "CONNECT",
                    path: "/git/transport",
                    headers: {
                      authorization: `Bearer ${token}`,
                      "x-mend-session-id": SESSION,
                      "x-mend-git-host": "github.com",
                      "x-mend-git-port": "",
                      "x-mend-git-command": "git-upload-pack 'acme/app.git'",
                      "x-mend-git-protocol": "version=2",
                    },
                  });
                  request.on("connect", (response, socket) => {
                    if (response.statusCode !== 200) {
                      reject(new Error(`refused ${response.statusCode}`));
                      return;
                    }
                    let stdout = "";
                    let stderr = "";
                    let exit: number | null = null;
                    socket.on(
                      "data",
                      makeFrameFeed((type, payload) => {
                        if (type === "o") stdout += payload.toString();
                        else if (type === "e") stderr += payload.toString();
                        else if (type === "x") exit = payload[0] ?? 255;
                      }),
                    );
                    socket.on("close", () => resolve({ stdout, stderr, exit }));
                    socket.write(frame("i", Buffer.from("pack bytes\n")));
                    socket.write(frame("q", Buffer.alloc(0)));
                  });
                  request.on("error", reject);
                  request.end();
                },
              ),
          );
          expect(result).toEqual({ stdout: "pack bytes\n", stderr: "remote says hi\n", exit: 3 });
          expect(seen).toContainEqual({ done: { opId: "op-1", exitCode: 3, refUpdates: null } });

          // Unauthenticated CONNECT is refused before the engine is consulted.
          const refused = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const request = http.request({
                  host,
                  port: Number(port),
                  method: "CONNECT",
                  path: "/git/transport",
                  headers: {
                    "x-mend-git-host": "github.com",
                    "x-mend-git-command": "git-upload-pack x",
                  },
                });
                request.on("connect", (response, socket) => {
                  socket.destroy();
                  resolve(response.statusCode ?? 0);
                });
                request.on("error", reject);
                request.end();
              }),
          );
          expect(refused).toBe(401);
          expect(
            seen.filter((entry) => typeof entry === "object" && entry !== null && "git" in entry)
              .length,
          ).toBe(1);
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  it("the staged helper and git shim use the endpoint when no socket is mounted, and never print the token", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const seen: unknown[] = [];
          const dir = yield* sockets.start(SESSION, api(seen));
          const token = yield* tokens.issue(SESSION);
          const env = {
            MEND_SESSION_ENDPOINT: `http://${address}`,
            MEND_SESSION_ID: SESSION,
            MEND_SESSION_TOKEN: token,
          };

          const list = yield* Effect.promise(() =>
            runScript(path.join(dir, "bin", "mend"), ["service", "list"], env),
          );
          expect(list.code).toBe(0);
          expect(list.stdout).toContain("no live services");
          expect(`${list.stdout}${list.stderr}`).not.toContain(token);

          const shim = yield* Effect.promise(() =>
            runScript(
              path.join(dir, "bin", "mend-git-ssh"),
              ["-o", "SendEnv=GIT_PROTOCOL", "github.com", "git-upload-pack 'acme/app.git'"],
              env,
              Buffer.from("hello pack\n"),
            ),
          );
          expect(shim).toEqual({ code: 3, stdout: "hello pack\n", stderr: "remote says hi\n" });

          // Without any transport the scripts fail readably.
          const none = yield* Effect.promise(() =>
            runScript(path.join(dir, "bin", "mend"), ["service", "list"], {
              MEND_SESSION_ENDPOINT: "",
              MEND_SESSION_TOKEN: "",
              MEND_SESSION_ID: "",
            }),
          );
          expect(none.code).toBe(1);
          expect(none.stderr).toContain("no session channel in this workspace");

          // A wrong token is a readable refusal, not a stack trace.
          const bad = yield* Effect.promise(() =>
            runScript(path.join(dir, "bin", "mend"), ["service", "list"], {
              ...env,
              MEND_SESSION_TOKEN: "c".repeat(43),
            }),
          );
          expect(bad.code).toBe(1);
          expect(bad.stderr).toContain("was not accepted");
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });
});
