import * as fs from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import * as path from "node:path";

import type { SessionId } from "@mend/domain";
import { DeploymentConfig, StoreConfig } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import {
  GIT_SSH_SHIM_SCRIPT,
  type GitTransportPlan,
  type GitTransportRequest,
} from "./git-transport.ts";
import { SCRIPT_TRANSPORT_PRELUDE } from "./script-transport.ts";
import {
  handleGitConnect,
  handleSessionRequest,
  SessionChannelRegistry,
} from "./session-channel.ts";

/**
 * The in-workspace control surface (docs/SESSION-SERVICES.md): one unix
 * socket PER SESSION, bind-mounted read-only at /run/mend inside that
 * session's workspace. Auth is the mount boundary — whoever can open the
 * socket IS the session; every verb it serves is already scoped to that one
 * session by construction, so there is no token to leak and nothing an agent
 * can reach beyond what its own terminal could already do.
 *
 * The host side is dumb infra: bind the socket, stage the `mend` helper
 * script beside it, route tiny JSON requests to the closures the engine
 * provides. The engine owns the semantics; this file owns the plumbing —
 * the route table and the git tunnel live in `session-channel.ts`, shared
 * with the network listener.
 *
 * Socket dirs live under the store (`<store>/_run/sessions/<id>`) — already
 * inside the platform's mount allowlist, `_`-prefixed like `_references`.
 * Paths are deterministic per session, so a Mend restart re-binds the same
 * path and the running workspace's mount comes back to life without touching
 * the container.
 *
 * Kubernetes mode (docs/KUBERNETES.md): the store is an RWX claim shared with
 * Pods on other nodes, and a Unix socket on it would be neither reachable nor
 * sane. The directory is still staged (the helper and the git shim are
 * mounted at /run/mend exactly as before) but NO socket is created; the
 * session is registered for the network channel instead, and the scripts
 * fall back to `MEND_SESSION_ENDPOINT` when `/run/mend/mend.sock` is absent.
 */

/** What the engine serves over a session's socket — every closure pre-scoped. */
export interface SessionSocketApi {
  readonly recipes: () => Effect.Effect<unknown>;
  readonly listServices: () => Effect.Effect<unknown>;
  readonly runServiceRecipe: (name: string) => Effect.Effect<unknown>;
  readonly runService: (
    argv: ReadonlyArray<string>,
    port: number,
    name: string | null,
    protocol?: "tcp" | "udp",
  ) => Effect.Effect<unknown>;
  readonly addService: (
    port: number,
    name: string | null,
    protocol?: "tcp" | "udp",
  ) => Effect.Effect<unknown>;
  readonly stopService: (processId: string) => Effect.Effect<unknown>;
  readonly restartService: (processId: string) => Effect.Effect<unknown>;
  /**
   * Resolve a workspace git transport request (docs/GIT-ACCESS.md): the
   * engine turns session → project → auth mode into the ssh argv the host
   * spawns, and records the op. Refusal (not a git command, unknown session)
   * reaches the shim as a readable message.
   */
  readonly gitTransport: (request: GitTransportRequest) => Effect.Effect<GitTransportPlan>;
  /** Close the recorded op: exit code, plus push ref updates when sniffed. */
  readonly gitTransportDone: (
    opId: string,
    exitCode: number | null,
    refUpdates: ReadonlyArray<string> | null,
  ) => Effect.Effect<void>;
}

export class SessionSocketHost extends Context.Service<
  SessionSocketHost,
  {
    /** Bind (or re-bind) the session's socket + helper; resolves with the host dir to mount. */
    readonly start: (sessionId: SessionId, api: SessionSocketApi) => Effect.Effect<string>;
    /** Close the socket and remove the session's run dir. Idempotent. */
    readonly stop: (sessionId: SessionId) => Effect.Effect<void>;
  }
>()("@mend/sessions/SessionSocketHost") {}

/**
 * Where per-session run dirs live: `MEND_RUN_DIR`, else `<store root>/_run/sessions`. Derived
 * from the configured store root — not from the home directory — so `MEND_STORE_ROOT`
 * (and the Kubernetes claim mount) moves the run dirs with the store.
 */
export const sessionRunRoot = (storeRoot: string): string =>
  process.env["MEND_RUN_DIR"] ?? path.join(storeRoot, "_run", "sessions");

/** In-container path of the mount — the helper hardcodes it. */
export const SESSION_SOCKET_MOUNT_PATH = "/run/mend";

/**
 * The helper staged beside the socket. Dependency-free node, talking HTTP
 * over the unix socket (or the network endpoint); the wire is the private
 * pact between this script and the routes, versioned together because they
 * ship together.
 */
const HELPER_SCRIPT = `#!/usr/bin/env node
// mend — the in-workspace helper. Talks to YOUR session over /run/mend/mend.sock,
// or over the authenticated session endpoint when this workspace has no socket.
${SCRIPT_TRANSPORT_PRELUDE}
const request = (method, route, body) =>
  new Promise((resolve, reject) => {
    const options = transportOptions(method, route, { "content-type": "application/json" });
    if (options === null) { reject(new Error(transportUnavailable())); return; }
    const req = transportClient().request(options, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          let message = text;
          try { message = JSON.parse(text).message ?? text; } catch {}
          reject(new Error(message));
          return;
        }
        resolve(text === "" ? null : JSON.parse(text));
      });
    });
    req.on("error", () => reject(new Error(transportDownMessage())));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

const fail = (message) => {
  process.stderr.write("mend: " + message + "\\n");
  process.exit(1);
};

const flattenService = (view) => {
  const service = view.service;
  const attempt = service.currentAttemptId === null
    ? null
    : (view.attempts.find((candidate) => candidate.id === service.currentAttemptId) ?? null);
  const observation = view.currentForward !== null &&
    view.latestObservation?.forwardId === view.currentForward.id
      ? view.latestObservation
      : null;
  return {
    id: service.id,
    label: service.name,
    workspacePort: service.workspacePort,
    protocol: service.transport,
    status: observation?.state ?? view.currentForward?.state ?? attempt?.status ?? "stopped",
  };
};

const printService = (s) =>
  console.log(
    (s.label ?? s.id.slice(0, 8)).padEnd(12) +
      "  :" + (s.workspacePort ?? "?") + (s.protocol === "udp" ? "/udp" : "") +
      "  " + s.status +
      "  " + s.id.slice(0, 8),
  );

const main = async () => {
  const [group, verb, ...rest] = process.argv.slice(2);
  if (group !== "service") {
    fail("this workspace helper only speaks: mend service <run|add|list|stop|restart|NAME>");
  }
  try {
    switch (verb) {
      case "list":
      case undefined: {
        const services = (await request("GET", "/services")).map(flattenService);
        if (services.length === 0) console.log("no live services");
        for (const s of services) printService(s);
        return;
      }
      case "run": {
        const dashdash = rest.indexOf("--");
        if (dashdash === -1) {
          // Recipe form: mend service run <name>
          const name = rest.find((a) => !a.startsWith("--"));
          if (name === undefined) {
            fail("usage: mend service run --port <p> [--name <n>] -- <command...> | mend service run <name>");
          }
          const service = await request("POST", "/services/recipe", { name });
          const shown = flattenService(service);
          console.log("Service " + shown.label + " · " + shown.status + " · reachable from the user's machine");
          return;
        }
        const argv = rest.slice(dashdash + 1);
        const head = rest.slice(0, dashdash);
        const portFlag = head.indexOf("--port");
        const port = portFlag === -1 ? NaN : Number(head[portFlag + 1]);
        const nameFlag = head.indexOf("--name");
        const name = nameFlag === -1 ? null : (head[nameFlag + 1] ?? null);
        const protocol = head.includes("--udp") ? "udp" : "tcp";
        if (!Number.isInteger(port) || argv.length === 0) {
          fail("usage: mend service run --port <p> [--name <n>] [--udp] -- <command...>");
        }
        const service = await request("POST", "/services/run", { argv, port, name, protocol });
        const shown = flattenService(service);
        console.log("Service " + shown.label + " · " + shown.status + " · reachable from the user's machine");
        return;
      }
      case "add": {
        const port = Number(rest.find((a) => /^\\d+$/.test(a)));
        const nameFlag = rest.indexOf("--name");
        const name = nameFlag === -1 ? null : (rest[nameFlag + 1] ?? null);
        const protocol = rest.includes("--udp") ? "udp" : "tcp";
        if (!Number.isInteger(port)) fail("usage: mend service add <port> [--name <n>] [--udp]");
        const service = await request("POST", "/services/add", { port, name, protocol });
        const shown = flattenService(service);
        console.log("Service " + shown.label + " · " + shown.status);
        return;
      }
      case "stop":
      case "restart": {
        const needle = rest[0];
        if (needle === undefined) fail("usage: mend service " + verb + " <name-or-id>");
        const services = (await request("GET", "/services")).map(flattenService);
        const match = services.find((s) => s.label === needle || s.id.startsWith(needle));
        if (match === undefined) fail('no live service matches "' + needle + '"');
        const done = flattenService(await request("POST", "/services/" + match.id + "/" + verb));
        console.log(verb + "ped: " + done.label + " · " + done.status);
        return;
      }
      default:
        fail('unknown service command "' + verb + '" — try: run, add, list, stop, restart');
    }
  } catch (error) {
    fail(error.message);
  }
};

// Bare-name sugar without recursion tricks: rewrite argv before dispatch.
const args = process.argv.slice(2);
if (args[0] === "service" && args[1] !== undefined &&
    !["run", "add", "list", "stop", "restart"].includes(args[1])) {
  process.argv = [...process.argv.slice(0, 3), "run", ...process.argv.slice(3)];
}
main();
`;

/** Exported for the script-level tests (run the staged helper under node). */
export const SESSION_HELPER_SCRIPT = HELPER_SCRIPT;

interface ActiveSocket {
  readonly server: http.Server;
}

/** Stage the helper + shim into `<dir>/bin` (idempotent, overwrite in place). */
const stageScripts = (dir: string): void => {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "mend"), HELPER_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "mend-git-ssh"), GIT_SSH_SHIM_SCRIPT, { mode: 0o755 });
};

export const SessionSocketHostLive: Layer.Layer<
  SessionSocketHost,
  never,
  StoreConfig | DeploymentConfig | SessionChannelRegistry
> = Layer.effect(
  SessionSocketHost,
  Effect.gen(function* () {
    const storeConfig = yield* StoreConfig;
    const deployment = yield* DeploymentConfig;
    const registry = yield* SessionChannelRegistry;
    const runRoot = sessionRunRoot(storeConfig.root);
    const active = new Map<SessionId, ActiveSocket>();

    const stopSync = (sessionId: SessionId): void => {
      const entry = active.get(sessionId);
      if (entry !== undefined) {
        active.delete(sessionId);
        entry.server.close();
      }
      registry.unregister(sessionId);
      fs.rmSync(path.join(runRoot, sessionId), { recursive: true, force: true });
    };

    // Shutdown: close every socket or the process cannot exit gracefully.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const sessionId of Array.from(active.keys())) {
          const entry = active.get(sessionId);
          active.delete(sessionId);
          entry?.server.close();
        }
      }),
    );

    const start = Effect.fn("SessionSocketHost.start")(function* (
      sessionId: SessionId,
      api: SessionSocketApi,
    ) {
      // Idempotent re-bind, IN PLACE: a live workspace bind-mounts this
      // directory, and a bind mount follows the inode — rm -rf + mkdir here
      // would leave every running container staring at a dangling, empty
      // /run/mend after a Mend restart (observed live: the helper and the git
      // shim vanished from the workspace). Close the old server, unlink only
      // the socket file, rewrite the scripts; the directory survives.
      const entry = active.get(sessionId);
      if (entry !== undefined) {
        active.delete(sessionId);
        entry.server.close();
      }
      const dir = path.join(runRoot, sessionId);
      const socketPath = path.join(dir, "mend.sock");
      // The network channel (when configured) serves this session from now on, whichever
      // listener the workspace ends up using.
      registry.register(sessionId, api);
      yield* Effect.promise(async () => {
        stageScripts(dir);
        fs.rmSync(socketPath, { force: true });
        if (deployment.mode === "kubernetes") {
          // No socket on a shared RWX claim: the helper finds none and uses the endpoint.
          return;
        }
        const server = http.createServer((request, response) => {
          void handleSessionRequest(api, request, response);
        });
        server.on("connect", (request, socket, head) => {
          void handleGitConnect(api, request, socket as net.Socket, head);
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        // The workspace user must reach the socket through the bind mount.
        fs.chmodSync(socketPath, 0o766);
        active.set(sessionId, { server });
      });
      return dir;
    });

    const stop = Effect.fn("SessionSocketHost.stop")(function* (sessionId: SessionId) {
      yield* Effect.sync(() => stopSync(sessionId));
    });

    return { start, stop };
  }),
);
