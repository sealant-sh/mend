import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import { ProjectId, SessionId, SessionRepositoryId, Sha, WorktreeId } from "@mend/domain";
import { SessionRepository } from "@mend/domain/workbench";
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
import type { WorkspaceLandOutcome } from "../src/workspace-git-hooks.ts";

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
  runService: (argv, port, name, protocol, browserScheme) =>
    Effect.sync(() => {
      seen.push({ argv, port, name });
      seen.push({ run: name, protocol, browserScheme });
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
  addService: (port, name, protocol, browserScheme) =>
    Effect.sync(() => {
      seen.push({ add: name, protocol, browserScheme });
    }).pipe(
      Effect.as({
        service: {
          id: "svc-2",
          name,
          workspacePort: port,
          transport: "tcp",
          currentAttemptId: null,
        },
        attempts: [],
        currentForward: null,
        latestObservation: null,
      }),
    ),
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
  stopSession: () =>
    Effect.sync(() => {
      seen.push({ stopSession: true });
      return {};
    }),
  land: () => Effect.succeed({ landed: false, lines: ["not landed · not in this test"] }),
  listRepositories: () => Effect.succeed([]),
  addableProjects: () => Effect.succeed([]),
  addRepository: () => Effect.die("not in this test"),
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

/** The token store as the database answers it when its statements time out (e2e8 F8). */
const TokensTimingOut: Layer.Layer<SessionChannelTokensRepo> = Layer.effect(
  SessionChannelTokensRepo,
  Effect.map(SessionChannelTokensRepo, (repo) => ({
    ...repo,
    verify: () => Effect.die(new Error("canceling statement due to user request")),
    resolve: () => Effect.die(new Error("canceling statement due to user request")),
  })),
).pipe(Layer.provide(SessionChannelTokensRepoMemory));

const layers = (
  endpoint: { listen: string; url: string } | undefined,
  mode: "local" | "kubernetes",
  tokensLayer: Layer.Layer<SessionChannelTokensRepo> = SessionChannelTokensRepoMemory,
  sessionStore: "colocated" | "captured" = "colocated",
) => {
  const registry = SessionChannelRegistryLive;
  const deployment = Layer.succeed(DeploymentConfig, {
    mode,
    sessionEndpoint: endpoint,
    sessionStore,
  });
  const store = StoreConfig.layerFor(storeRoot);
  const tokens = tokensLayer;
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
  it("accepts a bearer token with a session id, a bare bearer (resolved by hash), and rejects the rest", () => {
    const token = "a".repeat(43);
    expect(
      parseChannelCredentials({ authorization: `Bearer ${token}`, "x-mend-session-id": "sess-1" }),
    ).toEqual({
      sessionId: "sess-1",
      token,
    });
    // sealantd's capture registrar sends the token alone (ADR-0002): the session is resolved
    // from the token's hash, never guessed.
    expect(parseChannelCredentials({ authorization: `Bearer ${token}` })).toEqual({
      sessionId: null,
      token,
    });
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

          const token = yield* tokens.issue(SESSION, SESSION);
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

          // Stop from inside the workspace: answers 202 before acting, then
          // the engine closure runs (the caller's own shell is in the blast radius).
          const stopped = yield* Effect.promise(() => call(address, "POST", "/session/stop", auth));
          expect(stopped).toEqual({ status: 202, json: { status: "stopping" } });
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
          expect(seen).toContainEqual({ stopSession: true });

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

  it("serves a pickup only for the launch the token names, never the socket's unbound one", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const asked: Array<string> = [];
          yield* sockets.start(SESSION, {
            ...api([]),
            pickup: () =>
              Effect.sync(() => void asked.push("socket")).pipe(Effect.as({ files: [] })),
            pickupAs: (grant) => (ticket) =>
              Effect.sync(
                () => void asked.push(`${grant.launchId}:${grant.accountId ?? "nobody"}:${ticket}`),
              ).pipe(
                Effect.flatMap(() =>
                  ticket === "good"
                    ? Effect.succeed({ files: [{ path: ".npmrc", base64: "c2VjcmV0" }] })
                    : Effect.fail(new Error("this pickup ticket is spent, expired or unknown")),
                ),
              ),
          });
          const token = yield* tokens.issue(SESSION, "launch-7");
          const auth = { authorization: `Bearer ${token}`, "x-mend-session-id": SESSION };
          const good = yield* Effect.promise(() =>
            call(address, "POST", "/pickup", auth, { ticket: "good" }),
          );
          expect(good).toEqual({
            status: 200,
            json: { files: [{ path: ".npmrc", base64: "c2VjcmV0" }] },
          });
          const spent = yield* Effect.promise(() =>
            call(address, "POST", "/pickup", auth, { ticket: "spent" }),
          );
          expect(spent).toEqual({
            status: 403,
            json: { message: "this pickup ticket is spent, expired or unknown" },
          });
          const unauthenticated = yield* Effect.promise(() =>
            call(address, "POST", "/pickup", {}, { ticket: "good" }),
          );
          expect(unauthenticated.status).toBe(401);
          // The launch's own token names its launch and nobody: the engine's binding does the rest.
          expect(asked).toEqual(["launch-7:nobody:good", "launch-7:nobody:spent"]);
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  // e2e8 F8: a statement timeout in the token lookup was an unhandled rejection, and Node ended
  // the Mend process with every session on it.
  it("answers 503 when the token lookup fails, and goes on serving", async () => {
    const rejections: Array<unknown> = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const network = yield* SessionChannelNetworkHost;
            const address = network.address ?? "";
            const auth = {
              authorization: `Bearer ${"a".repeat(43)}`,
              "x-mend-session-id": SESSION,
            };
            const first = yield* Effect.promise(() => call(address, "GET", "/services", auth));
            expect(first.status).toBe(503);
            // A bare bearer is resolved by hash: the same lookup, the same answer.
            const bare = yield* Effect.promise(() =>
              call(address, "GET", "/services", { authorization: auth.authorization }),
            );
            expect(bare.status).toBe(503);
            // Still listening.
            const again = yield* Effect.promise(() => call(address, "GET", "/services", auth));
            expect(again.status).toBe(503);
          }).pipe(
            Effect.provide(
              layers(
                { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
                "kubernetes",
                TokensTimingOut,
              ),
            ),
          ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
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
          const token = yield* tokens.issue(SESSION, SESSION);
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
          const token = yield* tokens.issue(SESSION, SESSION);
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
  it("mend repo lists, names what can be added, and adds through the session's own channel, polling until the row settles (docs/adr/0010)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const seen: unknown[] = [];
          const row = (state: "adding" | "ready" | "failed", error: string | null) =>
            new SessionRepository({
              id: SessionRepositoryId.make("repo-1"),
              sessionId: SESSION,
              projectId: ProjectId.make("proj-core"),
              worktreeId: WorktreeId.make("wt-core"),
              name: "core",
              path: "/workspace/repos/core",
              branch: "mend/fix-login",
              baseSha: Sha.make("a".repeat(40)),
              baseRef: "main",
              state,
              error,
              capture: "nested",
              source: "origin",
              addedByUserId: "user-1",
              createdAt: new Date(),
              updatedAt: new Date(),
              readyAt: null,
            });
          // The first list after the add still reads `adding`; the next one `ready`.
          let lists = 0;
          const dir = yield* sockets.start(SESSION, {
            ...api(seen),
            addableProjects: () =>
              Effect.succeed([
                {
                  id: ProjectId.make("proj-core"),
                  name: "core",
                  defaultBranch: "main",
                  originUrl: "git@github.com:acme/core.git",
                },
              ]),
            addRepository: (input) =>
              Effect.sync(() => {
                seen.push({ add: input });
                return row("adding", null);
              }),
            listRepositories: () =>
              Effect.sync(() => {
                lists += 1;
                return [row(lists === 1 ? "adding" : "ready", null)];
              }),
          });
          const token = yield* tokens.issue(SESSION, SESSION);
          const env = {
            MEND_SESSION_ENDPOINT: `http://${address}`,
            MEND_SESSION_ID: SESSION,
            MEND_SESSION_TOKEN: token,
          };
          const helper = (args: string[]) =>
            Effect.promise(() => runScript(path.join(dir, "bin", "mend"), args, env));

          const projects = yield* helper(["repo", "projects"]);
          expect(projects.code).toBe(0);
          expect(projects.stdout).toContain("core");
          expect(projects.stdout).toContain("git@github.com:acme/core.git");

          const added = yield* helper(["repo", "add", "core", "--worktree", "fix-login"]);
          expect(added.stderr).toBe("");
          expect(added.code).toBe(0);
          expect(seen).toContainEqual({
            add: { project: "core", name: null, worktree: "fix-login" },
          });
          expect(added.stdout).toContain(
            "adding core · /workspace/repos/core · branch mend/fix-login",
          );
          expect(added.stdout).toContain("ready · saved with the main repository");
          expect(lists).toBe(2);

          const list = yield* helper(["repo", "list"]);
          expect(list.code).toBe(0);
          expect(list.stdout).toContain("/workspace/repos/core");
          expect(list.stdout).toContain("mend/fix-login");

          // A missing project is a usage line, not a request.
          const usage = yield* helper(["repo", "add"]);
          expect(usage.code).toBe(1);
          expect(usage.stderr).toContain("usage: mend repo add <project>");
          expect(`${projects.stdout}${added.stdout}${list.stdout}`).not.toContain(token);
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });
  it("mend land asks the session's own channel to land, and prints how it ended", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const seen: unknown[] = [];
          let outcome: WorkspaceLandOutcome = {
            landed: true,
            lines: [
              "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed",
              "https://github.com/acme/api/pull/412",
            ],
          };
          const dir = yield* sockets.start(SESSION, {
            ...api(seen),
            land: () =>
              Effect.sync(() => {
                seen.push({ land: SESSION });
                return outcome;
              }),
          });
          const token = yield* tokens.issue(SESSION, SESSION);
          const env = {
            MEND_SESSION_ENDPOINT: `http://${address}`,
            MEND_SESSION_ID: SESSION,
            MEND_SESSION_TOKEN: token,
          };
          const helper = (args: string[], over: Record<string, string> = {}) =>
            Effect.promise(() =>
              runScript(path.join(dir, "bin", "mend"), args, { ...env, ...over }),
            );

          const landed = yield* helper(["land"]);
          expect(landed).toEqual({
            code: 0,
            stdout:
              "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed\n" +
              "https://github.com/acme/api/pull/412\n",
            stderr: "",
          });
          expect(seen).toEqual([{ land: SESSION }]);

          // A refusal is the reason, on stderr, and a failing exit the agent can read.
          outcome = { landed: false, lines: ["not landed · only the change's owner lands it"] };
          const refused = yield* helper(["land"]);
          expect(refused).toEqual({
            code: 1,
            stdout: "",
            stderr: "mend: not landed · only the change's owner lands it\n",
          });

          // Another session's id with this token reaches nothing: the channel is the session's.
          const other = yield* helper(["land"], { MEND_SESSION_ID: OTHER });
          expect(other.code).toBe(1);
          expect(seen).toHaveLength(2);

          // The usage names the verb.
          const usage = yield* helper(["publish"]);
          expect(usage.stderr).toContain("mend land");
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  it("carries a browser scheme from the helper's --http/--https to run and add, and refuses it on UDP", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const seen: unknown[] = [];
          const dir = yield* sockets.start(SESSION, api(seen));
          const token = yield* tokens.issue(SESSION, SESSION);
          const auth = { authorization: `Bearer ${token}`, "x-mend-session-id": SESSION };
          const env = {
            MEND_SESSION_ENDPOINT: `http://${address}`,
            MEND_SESSION_ID: SESSION,
            MEND_SESSION_TOKEN: token,
          };
          const helper = (args: string[]) =>
            Effect.promise(() => runScript(path.join(dir, "bin", "mend"), args, env));

          const web = yield* helper([
            "service",
            "run",
            "--port",
            "5173",
            "--name",
            "web",
            "--http",
            "--",
            "pnpm",
            "dev",
          ]);
          expect(web.code).toBe(0);
          expect(seen).toContainEqual({ run: "web", protocol: "tcp", browserScheme: "http" });

          const adopted = yield* helper(["service", "add", "8443", "--name", "api", "--https"]);
          expect(adopted.code).toBe(0);
          expect(seen).toContainEqual({ add: "api", protocol: "tcp", browserScheme: "https" });

          // No flag is no scheme: a port to copy, not a page to open.
          yield* helper(["service", "add", "5432", "--name", "db"]);
          expect(seen).toContainEqual({ add: "db", protocol: "tcp", browserScheme: null });

          // The helper refuses a scheme on UDP before any request; the route refuses it too.
          const udp = yield* helper(["service", "add", "9000", "--udp", "--http"]);
          expect(udp.code).toBe(1);
          expect(udp.stderr).toContain("TCP only");
          const refusedUdp = yield* Effect.promise(() =>
            call(address, "POST", "/services/add", auth, {
              port: 9000,
              name: "stats",
              protocol: "udp",
              browserScheme: "http",
            }),
          );
          expect(refusedUdp).toEqual({
            status: 400,
            json: { message: "browserScheme applies to TCP Services only" },
          });
          const refusedScheme = yield* Effect.promise(() =>
            call(address, "POST", "/services/run", auth, {
              argv: ["pnpm", "dev"],
              port: 3000,
              name: "web",
              browserScheme: "ftp",
            }),
          );
          expect(refusedScheme.status).toBe(400);
          expect(seen).not.toContainEqual(expect.objectContaining({ add: "stats" }));
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  /**
   * docs/adr/0016, decision 4: a person's token names the person, and the process names its
   * session. The channel hands both to the engine's grant and serves what it answers.
   */
  it("routes a person's token to the session its process names, as that person, and nothing else", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const scopes: Array<unknown> = [];
          const asMaria: unknown[] = [];
          const granted = (session: SessionId): SessionSocketApi => ({
            ...api([]),
            channelFor: (scope) =>
              Effect.sync(() => {
                scopes.push({ session, ...scope });
                if (scope.accountId === "user-maria" && session === OTHER) {
                  return { ok: false, status: 403, message: "not hers" } as const;
                }
                return { ok: true, api: api(scope.accountId === null ? [] : asMaria) } as const;
              }),
          });
          yield* sockets.start(SESSION, granted(SESSION));
          yield* sockets.start(OTHER, granted(OTHER));
          // Maria's token of the launch whose session is SESSION, used from her own session.
          const token = yield* tokens.issuePerson("launch-1", "user-maria");
          const auth = (session: string) => ({
            authorization: `Bearer ${token}`,
            "x-mend-session-id": session,
          });
          const ran = yield* Effect.promise(() =>
            call(address, "POST", "/services/run", auth(SESSION), {
              argv: ["pnpm", "dev"],
              port: 3000,
              name: "web",
            }),
          );
          expect(ran.status).toBe(200);
          expect(asMaria).toContainEqual({ argv: ["pnpm", "dev"], port: 3000, name: "web" });
          expect(scopes).toEqual([
            { session: SESSION, launchId: "launch-1", accountId: "user-maria" },
          ]);
          // The grant's refusal is the answer, with its status.
          const refused = yield* Effect.promise(() =>
            call(address, "GET", "/services", auth(OTHER)),
          );
          expect(refused).toEqual({ status: 403, json: { message: "not hers" } });
          // A person's token names no session by itself.
          expect(
            (yield* Effect.promise(() =>
              call(address, "GET", "/services", { authorization: `Bearer ${token}` }),
            )).status,
          ).toBe(401);
          // A person's token never verifies as the launch's own token.
          expect(yield* tokens.verify(SESSION, token)).toBeNull();
          // A session served without a grant takes no person's token.
          yield* sockets.stop(OTHER);
          yield* sockets.start(OTHER, api([]));
          expect(
            (yield* Effect.promise(() => call(address, "GET", "/services", auth(OTHER)))).status,
          ).toBe(401);
          // The launch's own token still names its own session only.
          const own = yield* tokens.issue(SESSION, "launch-1");
          expect(
            (yield* Effect.promise(() =>
              call(address, "GET", "/services", {
                authorization: `Bearer ${own}`,
                "x-mend-session-id": OTHER,
              }),
            )).status,
          ).toBe(401);
          expect(
            (yield* Effect.promise(() =>
              call(address, "GET", "/services", {
                authorization: `Bearer ${own}`,
                "x-mend-session-id": SESSION,
              }),
            )).status,
          ).toBe(200);
          expect(scopes).toContainEqual({
            session: SESSION,
            launchId: "launch-1",
            accountId: null,
          });
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  it("the staged scripts present the token in the file a person's process names, never the workspace's", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const address = network.address ?? "";
          const accounts: Array<string | null> = [];
          const dir = yield* sockets.start(SESSION, {
            ...api([]),
            channelFor: (scope) =>
              Effect.sync(() => {
                accounts.push(scope.accountId);
                return { ok: true, api: api([]) } as const;
              }),
          });
          const workspaceToken = yield* tokens.issue(SESSION, "launch-1");
          const personToken = yield* tokens.issuePerson("launch-1", "user-maria");
          const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-token-home-"));
          const tokenFile = path.join(home, "session-token");
          fs.writeFileSync(tokenFile, `${personToken}\n`, { mode: 0o600 });
          const env = {
            MEND_SESSION_ENDPOINT: `http://${address}`,
            MEND_SESSION_ID: SESSION,
            // The workspace's own token is in every process's environment; the file wins.
            MEND_SESSION_TOKEN: workspaceToken,
            MEND_SESSION_TOKEN_FILE: tokenFile,
          };
          const list = yield* Effect.promise(() =>
            runScript(path.join(dir, "bin", "mend"), ["service", "list"], env),
          );
          expect(list.code).toBe(0);
          const shim = yield* Effect.promise(() =>
            runScript(
              path.join(dir, "bin", "mend-git-ssh"),
              ["github.com", "git-upload-pack 'acme/app.git'"],
              env,
              Buffer.from("hello pack\n"),
            ),
          );
          expect(shim.code).toBe(3);
          expect(accounts).toEqual(["user-maria", "user-maria"]);
          expect(`${list.stdout}${list.stderr}${shim.stderr}`).not.toContain(personToken);
          // A named file that cannot be read sends nothing, and never falls back to the
          // workspace's token.
          fs.rmSync(tokenFile);
          const unreadable = yield* Effect.promise(() =>
            runScript(path.join(dir, "bin", "mend"), ["service", "list"], env),
          );
          expect(unreadable.code).toBe(1);
          expect(unreadable.stderr).toContain("Mend session token");
          expect(unreadable.stderr).toContain("cannot be read");
          expect(accounts).toEqual(["user-maria", "user-maria"]);
          fs.rmSync(home, { recursive: true, force: true });
        }).pipe(
          Effect.provide(
            layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
          ),
        ),
      ),
    );
  });

  // Review of mend#553, P2-1: a setup command or the dependency install runs as the person with
  // no Mend environment; it still speaks as that person, never with the workspace's token.
  it.skipIf(process.getuid?.() === 0)(
    "a person's process with no token file named finds its own in its passwd home, never $HOME",
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const network = yield* SessionChannelNetworkHost;
            const sockets = yield* SessionSocketHost;
            const tokens = yield* SessionChannelTokensRepo;
            const address = network.address ?? "";
            const accounts: Array<string | null> = [];
            const dir = yield* sockets.start(SESSION, {
              ...api([]),
              channelFor: (scope) =>
                Effect.sync(() => {
                  accounts.push(scope.accountId);
                  return { ok: true, api: api([]) } as const;
                }),
            });
            const workspaceToken = yield* tokens.issue(SESSION, "launch-1");
            const personToken = yield* tokens.issuePerson("launch-1", "user-maria");
            const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-passwd-home-"));
            fs.mkdirSync(path.join(home, ".mend"), { mode: 0o700 });
            fs.writeFileSync(path.join(home, ".mend/session-token"), personToken, { mode: 0o600 });
            const passwd = path.join(home, "passwd-home.cjs");
            fs.writeFileSync(
              passwd,
              `const os = require("node:os"); const real = os.userInfo; os.userInfo = (o) => ({ ...real(o), homedir: ${JSON.stringify(home)} });`,
            );
            const env = {
              MEND_SESSION_ENDPOINT: `http://${address}`,
              MEND_SESSION_ID: SESSION,
              MEND_SESSION_TOKEN: workspaceToken,
              MEND_SESSION_TOKEN_FILE: "",
              HOME: path.join(home, "not-the-home"),
              NODE_OPTIONS: `--require ${passwd}`,
            };
            const list = yield* Effect.promise(() =>
              runScript(path.join(dir, "bin", "mend"), ["service", "list"], env),
            );
            expect(list.code).toBe(0);
            expect(accounts).toEqual(["user-maria"]);
            // A user with no token file of their own (a shared executor's non-root image user)
            // keeps the workspace's token, as before.
            fs.rmSync(path.join(home, ".mend"), { recursive: true });
            const shared = yield* Effect.promise(() =>
              runScript(path.join(dir, "bin", "mend"), ["service", "list"], env),
            );
            expect(shared.code).toBe(0);
            expect(accounts).toEqual(["user-maria", null]);
            fs.rmSync(home, { recursive: true, force: true });
          }).pipe(
            Effect.provide(
              layers({ listen: "127.0.0.1:0", url: "http://127.0.0.1:0" }, "kubernetes"),
            ),
          ),
        ),
      );
    },
  );

  it("binds no socket in capture mode: the executor speaks over the network channel with a token", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sockets = yield* SessionSocketHost;
          const dir = yield* sockets.start(SESSION, api([]));
          expect(fs.existsSync(path.join(dir, "bin", "mend"))).toBe(true);
          expect(fs.existsSync(path.join(dir, "mend.sock"))).toBe(false);
        }).pipe(
          Effect.provide(
            layers(
              { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
              "local",
              undefined,
              "captured",
            ),
          ),
        ),
      ),
    );
  });
});
