import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { SessionId } from "@mend/domain";
import { SessionSocketHost, SessionSocketHostLive, makeFrameFeed, frame } from "@mend/sessions";
import { DeploymentConfigLocal, StoreConfig } from "@mend/store";
import { Layer } from "effect";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SessionChannelRegistryLive } from "../src/session-channel.ts";
import type { SessionSocketApi } from "../src/session-socket.ts";

/**
 * The in-workspace control surface over a REAL unix socket: bind, stage the
 * helper, route to the provided closures, tear down.
 */

process.env["MEND_RUN_DIR"] = path.join(os.tmpdir(), `mend-socket-test-${process.pid}`);

const SocketHostLayer = SessionSocketHostLive.pipe(
  Layer.provide(StoreConfig.layerFor(path.join(os.tmpdir(), `mend-socket-store-${process.pid}`))),
  Layer.provide(DeploymentConfigLocal),
  Layer.provide(SessionChannelRegistryLive),
);

const SESSION = SessionId.make("sess-socket-1");

const call = (
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> =>
  new Promise((resolve, reject) => {
    // agent: false — every call dials fresh, like the in-workspace helper; a
    // kept-alive connection would EPIPE against a server that was re-bound.
    const request = http.request({ socketPath, method, path: route, agent: false }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += String(chunk)));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, json: text === "" ? null : JSON.parse(text) }),
      );
    });
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });

describe("SessionSocketHost", () => {
  it("serves the session-scoped api over the socket and stages the helper", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SessionSocketHost;
          const seen: unknown[] = [];
          const api: SessionSocketApi = {
            recipes: () => Effect.succeed([{ name: "web", command: "pnpm dev", port: 3000 }]),
            listServices: () => Effect.succeed([]),
            runServiceRecipe: (name) =>
              Effect.sync(() => {
                seen.push({ recipe: name });
                return { service: { id: "svc-recipe", name }, attempts: [] };
              }),
            runService: (argv, port, name) =>
              Effect.sync(() => {
                seen.push({ argv, port, name });
                return { id: "svc-1", label: name, status: "reachable" };
              }),
            addService: () => Effect.succeed({}),
            stopService: () => Effect.succeed({}),
            restartService: () => Effect.die("unused"),
            gitTransport: () => Effect.die("unused"),
            gitTransportDone: () => Effect.void,
          };
          const dir = yield* host.start(SESSION, api);
          const socketPath = path.join(dir, "mend.sock");

          const recipes = yield* Effect.promise(() => call(socketPath, "GET", "/recipes"));
          expect(recipes.status).toBe(200);
          expect(recipes.json).toEqual([{ name: "web", command: "pnpm dev", port: 3000 }]);

          const run = yield* Effect.promise(() =>
            call(socketPath, "POST", "/services/run", {
              argv: ["sh", "-c", "pnpm dev"],
              port: 3000,
              name: "web",
            }),
          );
          expect(run.status).toBe(200);
          const recipe = yield* Effect.promise(() =>
            call(socketPath, "POST", "/services/recipe", { name: "web" }),
          );
          expect(recipe.status).toBe(200);
          expect(seen).toEqual([
            { argv: ["sh", "-c", "pnpm dev"], port: 3000, name: "web" },
            { recipe: "web" },
          ]);

          const missing = yield* Effect.promise(() => call(socketPath, "GET", "/nope"));
          expect(missing.status).toBe(404);

          // The helper is staged, executable, and hardcodes the mount path.
          const helper = yield* Effect.promise(() =>
            import("node:fs/promises").then((fs) =>
              fs.readFile(path.join(dir, "bin", "mend"), "utf8"),
            ),
          );
          expect(helper).toContain("/run/mend/mend.sock");

          // The git transport shim is staged beside it.
          const shim = yield* Effect.promise(() =>
            import("node:fs/promises").then((fs) =>
              fs.readFile(path.join(dir, "bin", "mend-git-ssh"), "utf8"),
            ),
          );
          expect(shim).toContain("/git/transport");

          // A restart re-binds IN PLACE: the workspace bind-mounts this
          // directory by inode, so recreating it would leave every live
          // container staring at a dangling, empty /run/mend.
          const inodeBefore = (yield* Effect.promise(() =>
            import("node:fs/promises").then((fs) => fs.stat(dir)),
          )).ino;
          yield* host.start(SESSION, api);
          const inodeAfter = (yield* Effect.promise(() =>
            import("node:fs/promises").then((fs) => fs.stat(dir)),
          )).ino;
          expect(inodeAfter).toBe(inodeBefore);
          const rebound = yield* Effect.promise(() => call(socketPath, "GET", "/recipes"));
          expect(rebound.status).toBe(200);

          yield* host.stop(SESSION);
          const refused = yield* Effect.promise(() =>
            call(socketPath, "GET", "/services").then(
              () => false,
              () => true,
            ),
          );
          expect(refused).toBe(true);
        }),
      ).pipe(Effect.provide(SocketHostLayer)),
    );
  });

  it("tunnels a git transport op: framed stdio both ways, exit code, op closeout", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SessionSocketHost;
          const requests: unknown[] = [];
          const closed: unknown[] = [];
          const api: SessionSocketApi = {
            recipes: () => Effect.succeed([]),
            listServices: () => Effect.succeed([]),
            runServiceRecipe: () => Effect.die("unused"),
            runService: () => Effect.die("unused"),
            addService: () => Effect.die("unused"),
            stopService: () => Effect.die("unused"),
            restartService: () => Effect.die("unused"),
            gitTransport: (request) =>
              Effect.sync(() => {
                requests.push(request);
                if (request.command.startsWith("rm ")) throw new Error("not a git command");
                // Stand-in for ssh: echo stdin back, speak on stderr, exit 3.
                return {
                  opId: "op-1",
                  kind: "fetch" as const,
                  argv: ["sh", "-c", 'cat; echo "over ssh stderr" >&2; exit 3'],
                };
              }),
            gitTransportDone: (opId, exitCode, refUpdates) =>
              Effect.sync(() => {
                closed.push({ opId, exitCode, refUpdates });
              }),
          };
          const dir = yield* host.start(SESSION, api);
          const socketPath = path.join(dir, "mend.sock");

          const tunnel = (
            command: string,
            body: Buffer,
          ): Promise<{
            stdout: Buffer;
            stderr: Buffer;
            exit: number | null;
            refusal: string | null;
          }> =>
            new Promise((resolve, reject) => {
              const request = http.request({
                socketPath,
                method: "CONNECT",
                path: "/git/transport",
                headers: {
                  "x-mend-git-host": "git.example.test",
                  "x-mend-git-port": "",
                  "x-mend-git-command": command,
                  "x-mend-git-protocol": "version=2",
                },
              });
              request.on("connect", (res, socket) => {
                // Node surfaces refusals through this same event; the reason
                // travels percent-encoded (headers are latin-1).
                if (res.statusCode !== 200) {
                  const reason = res.headers["x-mend-refusal"];
                  socket.destroy();
                  resolve({
                    stdout: Buffer.alloc(0),
                    stderr: Buffer.alloc(0),
                    exit: null,
                    refusal: typeof reason === "string" ? decodeURIComponent(reason) : "",
                  });
                  return;
                }
                const out: Buffer[] = [];
                const err: Buffer[] = [];
                let exit: number | null = null;
                const feed = makeFrameFeed((type, payload) => {
                  if (type === "o") out.push(Buffer.from(payload));
                  if (type === "e") err.push(Buffer.from(payload));
                  if (type === "x") exit = payload[0] ?? null;
                });
                socket.on("data", feed);
                socket.on("close", () =>
                  resolve({
                    stdout: Buffer.concat(out),
                    stderr: Buffer.concat(err),
                    exit,
                    refusal: null,
                  }),
                );
                socket.write(frame("i", body));
                socket.write(frame("q", Buffer.alloc(0)));
              });
              request.on("error", reject);
              request.end();
            });

          const ok = yield* Effect.promise(() =>
            tunnel("git-upload-pack 'repo.git'", Buffer.from("pack-bytes")),
          );
          expect(ok.refusal).toBeNull();
          expect(ok.stdout.toString()).toBe("pack-bytes");
          expect(ok.stderr.toString()).toContain("over ssh stderr");
          expect(ok.exit).toBe(3);
          expect(requests).toEqual([
            { host: "git.example.test", port: null, command: "git-upload-pack 'repo.git'" },
          ]);
          // The op is closed out with the child's real exit code.
          expect(closed).toEqual([{ opId: "op-1", exitCode: 3, refUpdates: null }]);

          // A refused plan reaches the client as a readable message, no tunnel.
          const refused = yield* Effect.promise(() => tunnel("rm -rf /", Buffer.alloc(0)));
          expect(refused.refusal ?? "").toContain("not a git command");

          yield* host.stop(SESSION);
        }),
      ).pipe(Effect.provide(SocketHostLayer)),
    );
  });
});
