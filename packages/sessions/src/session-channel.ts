import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type * as net from "node:net";

import { SessionChannelTokensRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { DeploymentConfig } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { frame, makeFrameFeed, makePushSniffer, type GitTransportPlan } from "./git-transport.ts";
import type { SessionSocketApi } from "./session-socket.ts";

/**
 * The session channel, transport-neutral (docs/SESSION-SERVICES.md, docs/KUBERNETES.md).
 *
 * Two listeners serve the SAME route table and the SAME git tunnel:
 *
 *   - the per-session Unix socket (`session-socket.ts`): Docker/local mode, authorised by the
 *     bind mount — whoever can open the socket IS the session;
 *   - the network endpoint (this file, `SessionChannelNetworkHost`): Kubernetes mode, where a
 *     workspace Pod on another node presents a per-session bearer token instead. The token is
 *     verified (hash, constant time) BEFORE the session is resolved, and it grants exactly the
 *     closures the socket would — nothing wider.
 *
 * `SessionChannelRegistry` is the one in-memory map both listeners share: a session is
 * reachable while the engine has registered its api (start) and unreachable the moment it is
 * unregistered (stop/drain), independent of whether its token row still exists.
 */

// ─── Registry ───────────────────────────────────────────────────────────────

export class SessionChannelRegistry extends Context.Service<
  SessionChannelRegistry,
  {
    readonly register: (sessionId: SessionId, api: SessionSocketApi) => void;
    readonly unregister: (sessionId: SessionId) => void;
    readonly lookup: (sessionId: SessionId) => SessionSocketApi | undefined;
    readonly size: () => number;
  }
>()("@mend/sessions/SessionChannelRegistry") {}

export const SessionChannelRegistryLive: Layer.Layer<SessionChannelRegistry> = Layer.sync(
  SessionChannelRegistry,
  () => {
    const live = new Map<SessionId, SessionSocketApi>();
    return {
      register: (sessionId, api) => {
        live.set(sessionId, api);
      },
      unregister: (sessionId) => {
        live.delete(sessionId);
      },
      lookup: (sessionId) => live.get(sessionId),
      size: () => live.size,
    };
  },
);

// ─── Shared request handling ────────────────────────────────────────────────

/** Largest JSON body either listener accepts; the helper's requests are tiny. */
export const MAX_BODY_BYTES = 64 * 1024;

const readBody = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    let text = "";
    let overflow = false;
    request.on("data", (chunk: Buffer | string) => {
      if (overflow) return;
      text += String(chunk);
      if (text.length > MAX_BODY_BYTES) {
        overflow = true;
        request.destroy();
        resolve({});
      }
    });
    request.on("end", () => {
      if (overflow) return;
      let parsed: unknown = {};
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
      }
      resolve(parsed);
    });
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Route one helper request to the session-scoped closures. Transport-neutral. */
export const handleSessionRequest = async (
  api: SessionSocketApi,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> => {
  const respond = (status: number, payload: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const url = new URL(request.url ?? "/", "http://mend.sock");
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "GET /recipes") return respond(200, await Effect.runPromise(api.recipes()));
    if (route === "GET /services") return respond(200, await Effect.runPromise(api.listServices()));
    if (route === "POST /services/recipe") {
      const body = asRecord(await readBody(request));
      const name = typeof body["name"] === "string" ? body["name"] : "";
      if (name === "") return respond(400, { message: "name is required" });
      return respond(200, await Effect.runPromise(api.runServiceRecipe(name)));
    }
    if (route === "POST /services/run") {
      const body = asRecord(await readBody(request));
      const argv = Array.isArray(body["argv"]) ? body["argv"].map(String) : [];
      const port = Number(body["port"]);
      const name = typeof body["name"] === "string" ? body["name"] : null;
      const protocol = body["protocol"] === "udp" ? ("udp" as const) : ("tcp" as const);
      if (argv.length === 0 || !Number.isInteger(port)) {
        return respond(400, { message: "argv and port are required" });
      }
      return respond(200, await Effect.runPromise(api.runService(argv, port, name, protocol)));
    }
    if (route === "POST /services/add") {
      const body = asRecord(await readBody(request));
      const port = Number(body["port"]);
      const name = typeof body["name"] === "string" ? body["name"] : null;
      const protocol = body["protocol"] === "udp" ? ("udp" as const) : ("tcp" as const);
      if (!Number.isInteger(port)) return respond(400, { message: "port is required" });
      return respond(200, await Effect.runPromise(api.addService(port, name, protocol)));
    }
    const action = /^POST \/services\/([^/]+)\/(stop|restart)$/.exec(route);
    if (action?.[1] !== undefined) {
      const effect =
        action[2] === "stop" ? api.stopService(action[1]) : api.restartService(action[1]);
      return respond(200, await Effect.runPromise(effect));
    }
    return respond(404, { message: `unknown route: ${route}` });
  } catch (error) {
    return respond(422, { message: error instanceof Error ? error.message : String(error) });
  }
};

/** Write a CONNECT refusal: status line plus a percent-encoded reason header, then close. */
export const refuseConnect = (socket: net.Socket, status: string, message: string): void => {
  const reason = encodeURIComponent(message.replace(/[\r\n]+/g, " · ").slice(0, 900));
  socket.write(`HTTP/1.1 ${status}\r\nx-mend-refusal: ${reason}\r\nconnection: close\r\n\r\n`);
  socket.end();
};

/**
 * The CONNECT tunnel: one workspace git op end to end. Resolve the plan through the engine
 * (refusals become a readable HTTP error the shim prints), spawn ssh on the host, then pump
 * frames — client bytes to ssh stdin, ssh stdout/stderr back as frames, exit code last, and for
 * pushes sniff the opening pkt-lines so the op log can name the refs. Transport-neutral: the
 * socket may be a Unix or a TCP/TLS connection.
 */
export const handleGitConnect = async (
  api: SessionSocketApi,
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> => {
  if ((request.url ?? "") !== "/git/transport") {
    return refuseConnect(socket, "404 Not Found", "unknown tunnel target");
  }
  const header = (name: string): string => {
    const value = request.headers[name];
    return typeof value === "string" ? value : "";
  };
  const host = header("x-mend-git-host");
  const command = header("x-mend-git-command");
  const protocol = header("x-mend-git-protocol");
  const portRaw = header("x-mend-git-port");
  const port = portRaw === "" ? null : Number(portRaw);
  if (host === "" || command === "" || (port !== null && !Number.isInteger(port))) {
    return refuseConnect(
      socket,
      "400 Bad Request",
      "the git transport request is missing its target",
    );
  }
  let plan: GitTransportPlan;
  try {
    plan = await Effect.runPromise(api.gitTransport({ host, port, command }));
  } catch (error) {
    return refuseConnect(
      socket,
      "422 Unprocessable Entity",
      error instanceof Error ? error.message : String(error),
    );
  }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const [executable, ...argv] = plan.argv;
  const child = spawn(executable ?? "ssh", argv, {
    env: {
      ...process.env,
      ...(protocol === "" ? {} : { GIT_PROTOCOL: protocol }),
      ...plan.env,
    },
  });
  const sniffer = plan.kind === "push" ? makePushSniffer() : null;
  let closed = false;
  child.stdout.on("data", (chunk: Buffer) => socket.write(frame("o", chunk)));
  child.stderr.on("data", (chunk: Buffer) => socket.write(frame("e", chunk)));
  child.on("error", (error) => {
    if (closed) return;
    closed = true;
    socket.write(
      frame("e", Buffer.from(`mend: could not run ssh on the host: ${error.message}\n`)),
    );
    socket.write(frame("x", Buffer.from([255])));
    socket.end();
  });
  child.on("close", (code) => {
    if (!closed) {
      closed = true;
      socket.write(
        frame("x", Buffer.from([code === null ? 255 : Math.min(Math.max(code, 0), 255)])),
      );
      socket.end();
    }
    void Effect.runPromise(
      api.gitTransportDone(plan.opId, code, sniffer === null ? null : sniffer.updates()),
    ).catch(() => {});
  });
  const feed = makeFrameFeed((type, payload) => {
    if (type === "i") {
      sniffer?.feed(payload);
      child.stdin.write(payload);
    } else if (type === "q") {
      child.stdin.end();
    }
  });
  if (head.length > 0) feed(head);
  socket.on("data", feed);
  const reap = (): void => {
    child.kill();
  };
  socket.on("close", reap);
  socket.on("error", reap);
  // A dying client must not crash the host on a mid-pump write (EPIPE).
  child.stdin.on("error", () => {});
};

// ─── Network listener (Kubernetes) ──────────────────────────────────────────

/** Header names the helper and shim send on every network request. */
export const SESSION_ID_HEADER = "x-mend-session-id";
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** Parse the bearer token and session id; undefined when either is missing or malformed. */
export const parseChannelCredentials = (
  headers: http.IncomingHttpHeaders,
): { readonly sessionId: SessionId; readonly token: string } | undefined => {
  const authorization = headers["authorization"];
  const sessionId = headers[SESSION_ID_HEADER];
  if (typeof authorization !== "string" || typeof sessionId !== "string") return undefined;
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,256})$/.exec(authorization);
  if (match?.[1] === undefined || !SESSION_ID_SHAPE.test(sessionId)) return undefined;
  return { sessionId: SessionId.make(sessionId), token: match[1] };
};

export class SessionChannelNetworkHost extends Context.Service<
  SessionChannelNetworkHost,
  {
    /** The URL workspaces use, or undefined when the network channel is not configured. */
    readonly endpoint: string | undefined;
    /** The bound address (tests; undefined when not listening). */
    readonly address: string | undefined;
  }
>()("@mend/sessions/SessionChannelNetworkHost") {}

/**
 * Bind the network session channel when `DeploymentConfig.sessionEndpoint` is set. Every
 * request — plain or CONNECT — is authenticated first: bearer token + session id → token hash
 * check → registry lookup (the session must be live). Failures are uniform `401` so the
 * endpoint is not an oracle for which session ids exist; a valid token for a session that is
 * no longer live is `409`.
 */
export const SessionChannelNetworkHostLive: Layer.Layer<
  SessionChannelNetworkHost,
  never,
  DeploymentConfig | SessionChannelRegistry | SessionChannelTokensRepo
> = Layer.effect(
  SessionChannelNetworkHost,
  Effect.gen(function* () {
    const deployment = yield* DeploymentConfig;
    const registry = yield* SessionChannelRegistry;
    const tokens = yield* SessionChannelTokensRepo;
    const config = deployment.sessionEndpoint;
    if (config === undefined) {
      return { endpoint: undefined, address: undefined };
    }

    const authenticate = async (
      headers: http.IncomingHttpHeaders,
    ): Promise<
      | { readonly ok: true; readonly api: SessionSocketApi }
      | { readonly ok: false; readonly status: number; readonly message: string }
    > => {
      const credentials = parseChannelCredentials(headers);
      if (credentials === undefined) {
        return {
          ok: false,
          status: 401,
          message: "session channel: missing or malformed credentials",
        };
      }
      const valid = await Effect.runPromise(
        tokens.verify(credentials.sessionId, credentials.token),
      );
      if (!valid) {
        return {
          ok: false,
          status: 401,
          message: "session channel: the session token was not accepted",
        };
      }
      const api = registry.lookup(credentials.sessionId);
      if (api === undefined) {
        return {
          ok: false,
          status: 409,
          message: "session channel: this session is not live on this Mend instance",
        };
      }
      return { ok: true, api };
    };

    const onRequest = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      void authenticate(request.headers).then((auth) => {
        if (!auth.ok) {
          response.writeHead(auth.status, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: auth.message }));
          return;
        }
        return handleSessionRequest(auth.api, request, response);
      });
    };
    const onConnect = (request: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
      void authenticate(request.headers).then((auth) => {
        if (!auth.ok) {
          return refuseConnect(
            socket,
            `${auth.status} ${auth.status === 401 ? "Unauthorized" : "Conflict"}`,
            auth.message,
          );
        }
        return handleGitConnect(auth.api, request, socket, head);
      });
    };

    const server =
      config.tls === undefined
        ? http.createServer(onRequest)
        : https.createServer(
            {
              cert: fs.readFileSync(config.tls.certPath),
              key: fs.readFileSync(config.tls.keyPath),
            },
            onRequest,
          );
    server.on("connect", onConnect);
    // Bound header budget: helper requests are small; a huge header block is not a client.
    server.maxHeadersCount = 64;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;

    const [host, portText] = splitListen(config.listen);
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(Number(portText), host, () => {
            server.removeListener("error", reject);
            resolve();
          });
        }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.close();
        server.closeAllConnections?.();
      }),
    );
    const bound = server.address();
    const address =
      typeof bound === "object" && bound !== null
        ? `${bound.address}:${String(bound.port)}`
        : undefined;
    yield* Effect.logInfo("session channel: network endpoint listening").pipe(
      Effect.annotateLogs({
        listen: config.listen,
        endpoint: config.url,
        tls: config.tls !== undefined,
      }),
    );
    return { endpoint: config.url, address };
  }),
);

const splitListen = (listen: string): readonly [string, string] => {
  const index = listen.lastIndexOf(":");
  const host = listen.slice(0, index).replace(/^\[|\]$/g, "");
  return [host, listen.slice(index + 1)];
};

/** The listener that serves nothing: local mode, or tests that only exercise the socket. */
export const SessionChannelNetworkHostOff: Layer.Layer<SessionChannelNetworkHost> = Layer.succeed(
  SessionChannelNetworkHost,
  { endpoint: undefined, address: undefined },
);
