import * as fs from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import * as path from "node:path";

import { SessionChannelTokensRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { BlobStoreConfig } from "@mend/store";
import { Config, Effect, Layer, Schema, type Scope } from "effect";
import * as Context from "effect/Context";

import {
  CAPTURE_ROUTES,
  dispatchCaptureRoute,
  MAX_CAPTURE_BODY_BYTES,
  type SessionCaptureApi,
} from "./capture-channel.ts";
import {
  authenticateChannelRequest,
  parseChannelCredentials,
  refuseConnect,
  SessionChannelRegistry,
  tokenChannelHandlers,
} from "./session-channel.ts";
import type { SessionSocketApi } from "./session-socket.ts";

/**
 * An executor's two channels to Mend, as Unix sockets in its own `mend-control` scope (agent-home
 * `workspace-isolation-architecture.md` §6.1). The executor mounts that scope at `/run/sealant`;
 * on `host-vm`, sealantd relays vsock ports 1025 and 1027 to the same two sockets.
 *
 * - `capture.sock`: what sealantd's capture registrar dials (`SEALANT_CAPTURE_DIAL`). It writes
 *   each request unchanged, with the `Host` header its URL names (sealant-capture
 *   `transport.rs`): `Host: mend:3106` for a capture route, `Host: garage:3900` for a presigned
 *   object URL. It serves only those two: a POST to a capture route with the capture credential
 *   of this executor's launch, and a presigned request relayed to the configured object store
 *   with its `Host` kept, so the signature over it still holds. Never a tunnel, never another
 *   host: it is all a recovering executor reaches.
 * - `session.sock`: the session channel's routes (Git, MCP, `mend resource`, land, repositories,
 *   Services, pickups, agent hooks, sign-ins, Doppler), each request with a person's bearer token
 *   of this executor's launch (docs/adr/0016, decision 4: never tokenless). The launch's own token
 *   is the capture credential and is refused here; captures are not served here. A recovery boot
 *   never has one.
 */

/** The capture relay's file name in an executor's scope. */
export const CAPTURE_SOCKET_NAME = "capture.sock";
/** The session channel's file name in an executor's scope. */
export const SESSION_SOCKET_NAME = "session.sock";
/** Where Mend's container mounts the `mend-control` volume (compose.v2.yaml). */
export const EXECUTOR_CONTROL_ROOT_DEFAULT = "/run/sealant/sockets";

/** The object store presigned URLs name, as the capture relay compares and dials it. */
export interface ObjectStoreEndpoint {
  /** Lowercase, without brackets for an IPv6 literal. */
  readonly hostname: string;
  readonly port: number;
}

/**
 * The store `capture.sock` relays presigned requests to: the host and port of
 * `MEND_BLOB_STORE_PUBLIC_URL`, the one executors' URLs are minted against. Null when there is
 * none, or when it is https: sealantd dials an https URL over TLS through the socket, which a
 * relay that reads each request's `Host` cannot read.
 */
export const objectStoreEndpointOf = (
  publicUrl: string | undefined,
): ObjectStoreEndpoint | null => {
  if (publicUrl === undefined) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname === "") return null;
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port === "" ? 80 : Number(url.port),
  };
};

/** A `Host` header's host and port (80 when it names none), or null when it is not one. */
const hostHeaderOf = (value: string): ObjectStoreEndpoint | null => {
  if (value === "" || /[\s/\\?#@]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port === "" ? 80 : Number(url.port),
  };
};

/** What `capture.sock` does with one request, decided before any credential is read. */
export type CaptureSocketRequest =
  | { readonly kind: "capture"; readonly route: string }
  | { readonly kind: "object" }
  | { readonly kind: "refused"; readonly status: 400 | 403 | 405; readonly message: string };

const ONLY_CAPTURE =
  "capture.sock serves the capture routes and presigned object-store requests only";
const OBJECT_METHODS = new Set(["GET", "HEAD", "PUT"]);

const refuse = (status: 400 | 403 | 405, message: string) =>
  ({ kind: "refused", status, message }) as const;

/**
 * Sort one request that reached `capture.sock`. A request whose `Host` names the object store's
 * host and port must be a GET, HEAD or PUT carrying a SigV4 query signature and no
 * `Authorization` header; it is relayed, and only it ever leaves this process. Any other request
 * must be a POST to a capture route, served here once its credential is checked, whatever host it
 * names: Mend and the store may share one (`172.17.0.1:3106` beside `172.17.0.1:3900`). Everything
 * else, a tunnel, an absolute-form or unreadable target and the store's other ports included, is
 * refused. Never throws: a request this cannot read is a 400.
 */
export const classifyCaptureSocketRequest = (
  request: {
    readonly method: string;
    readonly target: string;
    readonly headers: http.IncomingHttpHeaders;
  },
  store: ObjectStoreEndpoint | null,
): CaptureSocketRequest => {
  if (request.method === "CONNECT") return refuse(405, "capture.sock opens no tunnel");
  if (request.headers.upgrade !== undefined) {
    return refuse(405, "capture.sock upgrades no connection");
  }
  // An absolute-form target is how a request asks a proxy for another host.
  if (!request.target.startsWith("/")) {
    return refuse(403, "capture.sock is not a proxy: a request names a path, never a URL");
  }
  // `//host/…` reads as a network-path reference, which a URL parser takes for a host.
  if (request.target.startsWith("//")) {
    return refuse(400, "capture.sock reads a request target that starts with one /");
  }
  const hostHeader = request.headers.host;
  const host = typeof hostHeader === "string" ? hostHeaderOf(hostHeader) : null;
  if (host === null) return refuse(400, "a request to capture.sock names its Host");
  let url: URL;
  try {
    url = new URL(request.target, "http://capture.sock");
  } catch {
    return refuse(400, "capture.sock cannot read this request target");
  }
  if (store !== null && host.hostname === store.hostname && host.port === store.port) {
    if (!OBJECT_METHODS.has(request.method)) {
      return refuse(405, "capture.sock relays GET, HEAD and PUT to the object store");
    }
    if (
      request.headers.authorization !== undefined ||
      !url.searchParams.has("X-Amz-Signature") ||
      !url.searchParams.has("X-Amz-Credential")
    ) {
      return refuse(403, "capture.sock relays presigned object-store requests only");
    }
    return { kind: "object" };
  }
  if (!CAPTURE_ROUTES.has(url.pathname)) return refuse(403, ONLY_CAPTURE);
  if (request.method !== "POST") return refuse(405, "the capture routes take POST");
  return { kind: "capture", route: url.pathname };
};

/** Headers that end at a hop, never relayed (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

const rawHeadersBeyondHop = (raw: ReadonlyArray<string>): string[] => {
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";
    if (!HOP_BY_HOP.has(name.toLowerCase())) kept.push(name, raw[index + 1] ?? "");
  }
  return kept;
};

/**
 * Relay one presigned request to `store` as it came: its method, target and headers, `Host`
 * included, in their order. The connection goes to the configured store only, whatever the
 * request says; `classifyCaptureSocketRequest` has already matched its `Host` to it.
 */
const relayObjectRequest = (
  store: ObjectStoreEndpoint,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void => {
  const upstream = http.request({
    host: store.hostname,
    port: store.port,
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: rawHeadersBeyondHop(request.rawHeaders),
    setHost: false,
    agent: false,
  });
  upstream.on("response", (answer) => {
    response.writeHead(answer.statusCode ?? 502, rawHeadersBeyondHop(answer.rawHeaders));
    answer.pipe(response);
    answer.on("error", () => response.destroy());
  });
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "the object store did not answer" }));
  });
  request.on("aborted", () => upstream.destroy());
  // The executor went away before the answer was through: stop reading the store for it.
  response.on("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
};

const respondJson = (response: http.ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

/** The launch's capture routes a request's credential reaches, or why not. */
type CaptureAuthentication =
  | { readonly ok: true; readonly capture: SessionCaptureApi }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Authenticate a capture route on an executor's `capture.sock`: the launch's own token (the one
 * sealantd presents as `SEALANT_CAPTURE_TOKEN`) for that executor's launch, and nothing else. A
 * person's token, a one-off write's token or another launch's token is refused.
 */
export const authenticateCaptureRequest = async (
  headers: http.IncomingHttpHeaders,
  launchId: string,
  deps: {
    readonly tokens: SessionChannelTokensRepo["Service"];
    readonly registry: Pick<SessionChannelRegistry["Service"], "lookup">;
  },
): Promise<CaptureAuthentication> => {
  const notAccepted = {
    ok: false,
    status: 401,
    message: "capture.sock: the capture credential was not accepted",
  } as const;
  const credentials = parseChannelCredentials(headers);
  if (credentials === undefined) return notAccepted;
  const resolved = await Effect.runPromise(deps.tokens.resolve(credentials.token));
  if (
    resolved === null ||
    resolved.launchId !== launchId ||
    resolved.accountId !== null ||
    resolved.writeOnly ||
    (credentials.sessionId !== null && credentials.sessionId !== resolved.sessionId)
  ) {
    return notAccepted;
  }
  const capture = deps.registry
    .lookup(SessionId.make(resolved.sessionId))
    ?.captureAs?.(resolved.launchId);
  if (capture === undefined) {
    return {
      ok: false,
      status: 409,
      message: "capture.sock: this launch's captures are not served on this Mend instance",
    };
  }
  return { ok: true, capture };
};

/** One executor's sockets: whose scope, which launch, and whether it boots to recover. */
export interface ExecutorSocketsBinding {
  /**
   * The executor's scope in `mend-control`: its container name, the volume subpath it mounts at
   * `/run/sealant`.
   */
  readonly scope: string;
  /** The launch the executor's tokens were issued for; no other launch's token is accepted. */
  readonly launchId: string;
  /** `recover`: a recovery boot, which flushes its captures over `capture.sock` and has no other. */
  readonly mode: "normal" | "recover";
}

export class ExecutorScopeError extends Schema.TaggedError<ExecutorScopeError>()(
  "ExecutorScopeError",
  { message: Schema.String },
) {}

export class ExecutorSockets extends Context.Service<
  ExecutorSockets,
  {
    /**
     * Bind (or re-bind) an executor's sockets in its scope: `capture.sock` always, `session.sock`
     * unless it boots to recover, when any `session.sock` there is removed. Answers the socket
     * paths now served.
     */
    readonly bind: (
      binding: ExecutorSocketsBinding,
    ) => Effect.Effect<ReadonlyArray<string>, ExecutorScopeError>;
    /** Close the executor's sockets and remove their files. Idempotent. */
    readonly unbind: (scope: string) => Effect.Effect<void>;
  }
>()("@mend/sessions/ExecutorSockets") {}

/** A container name, which is what a `mend-control` subpath is: never `..`, never a path. */
const SCOPE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const listen = (server: http.Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

const makeExecutorSockets = (
  root: string,
): Effect.Effect<
  ExecutorSockets["Service"],
  never,
  SessionChannelRegistry | SessionChannelTokensRepo | BlobStoreConfig | Scope.Scope
> =>
  Effect.gen(function* () {
    const registry = yield* SessionChannelRegistry;
    const tokens = yield* SessionChannelTokensRepo;
    const store = objectStoreEndpointOf((yield* BlobStoreConfig).publicUrl);
    const bound = new Map<string, ReadonlyArray<http.Server>>();

    const close = (scope: string): void => {
      for (const server of bound.get(scope) ?? []) {
        server.close();
        server.closeAllConnections();
      }
      bound.delete(scope);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const scope of Array.from(bound.keys())) close(scope);
      }),
    );

    const captureServer = (launchId: string): http.Server => {
      const server = http.createServer((request, response) => {
        try {
          serveCapture(request, response);
        } catch {
          // Nothing a request carries may throw out of the listener and take Mend down.
          if (response.headersSent) response.destroy();
          else respondJson(response, 400, { message: "capture.sock cannot read this request" });
          request.resume();
        }
      });
      const serveCapture = (request: http.IncomingMessage, response: http.ServerResponse) => {
        const sorted = classifyCaptureSocketRequest(
          { method: request.method ?? "", target: request.url ?? "", headers: request.headers },
          store,
        );
        if (sorted.kind === "refused") {
          respondJson(response, sorted.status, { message: sorted.message });
          request.resume();
          return;
        }
        if (sorted.kind === "object" && store !== null) {
          relayObjectRequest(store, request, response);
          return;
        }
        if (sorted.kind !== "capture") return;
        void authenticateCaptureRequest(request.headers, launchId, { tokens, registry })
          .then(async (auth) => {
            if (!auth.ok) {
              respondJson(response, auth.status, { message: auth.message });
              request.resume();
              return;
            }
            const body = await readJson(request);
            return dispatchCaptureRoute(auth.capture, sorted.route, body, (status, payload) =>
              respondJson(response, status, payload),
            );
          })
          .catch(() => {
            if (response.headersSent) response.destroy();
            else respondJson(response, 503, { message: "capture.sock: not answered now" });
          });
      };
      const refuseTunnel = (_request: http.IncomingMessage, socket: net.Socket) =>
        refuseConnect(socket, "405 Method Not Allowed", ONLY_CAPTURE);
      server.on("connect", refuseTunnel);
      server.on("upgrade", refuseTunnel);
      server.maxHeadersCount = 64;
      server.headersTimeout = 10_000;
      return server;
    };

    const sessionServer = (launchId: string): http.Server => {
      // A person's token only (docs/adr/0016, decision 4): the launch's own token is the capture
      // credential, which reaches capture.sock and nothing else. Captures travel over
      // capture.sock: the routes this socket serves carry none.
      const handlers = tokenChannelHandlers(async (headers) => {
        const auth = await authenticateChannelRequest(
          headers,
          { tokens, registry },
          { launchId, personOnly: true },
        );
        if (!auth.ok) return auth;
        const api: SessionSocketApi = { ...auth.api, capture: undefined, captureAs: undefined };
        return { ...auth, api };
      }, registry);
      const server = http.createServer(handlers.onRequest);
      server.on("connect", handlers.onConnect);
      server.on("upgrade", handlers.onUpgrade);
      server.maxHeadersCount = 64;
      server.headersTimeout = 10_000;
      return server;
    };

    /** Bind `binding`'s sockets in `dir`; if one cannot listen, none is left serving. */
    const bindIn = async (
      dir: string,
      binding: ExecutorSocketsBinding,
    ): Promise<ReadonlyArray<string>> => {
      const capturePath = path.join(dir, CAPTURE_SOCKET_NAME);
      const sessionPath = path.join(dir, SESSION_SOCKET_NAME);
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(capturePath, { force: true });
      fs.rmSync(sessionPath, { force: true });
      const servers: Array<{ readonly server: http.Server; readonly path: string }> = [
        { server: captureServer(binding.launchId), path: capturePath },
        ...(binding.mode === "recover"
          ? []
          : [{ server: sessionServer(binding.launchId), path: sessionPath }]),
      ];
      try {
        for (const entry of servers) {
          await listen(entry.server, entry.path);
          // The executor's user reaches the sockets through its volume subpath; nothing there runs.
          fs.chmodSync(entry.path, 0o666);
        }
      } catch (cause) {
        for (const entry of servers) {
          entry.server.close();
          fs.rmSync(entry.path, { force: true });
        }
        throw cause;
      }
      bound.set(
        binding.scope,
        servers.map((entry) => entry.server),
      );
      return servers.map((entry) => entry.path);
    };

    const bind = Effect.fn("ExecutorSockets.bind")(function* (binding: ExecutorSocketsBinding) {
      if (!SCOPE_SHAPE.test(binding.scope)) {
        return yield* new ExecutorScopeError({
          message: `not an executor scope: ${JSON.stringify(binding.scope)}`,
        });
      }
      close(binding.scope);
      return yield* Effect.tryPromise({
        try: () => bindIn(path.join(root, binding.scope), binding),
        catch: (cause) =>
          new ExecutorScopeError({
            message: `could not bind ${binding.scope}'s sockets: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
    });

    const unbind = Effect.fn("ExecutorSockets.unbind")(function* (scope: string) {
      if (!SCOPE_SHAPE.test(scope)) return;
      yield* Effect.sync(() => {
        close(scope);
        fs.rmSync(path.join(root, scope, CAPTURE_SOCKET_NAME), { force: true });
        fs.rmSync(path.join(root, scope, SESSION_SOCKET_NAME), { force: true });
      });
    });

    return ExecutorSockets.of({ bind, unbind });
  });

const readJson = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const settle = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_CAPTURE_BODY_BYTES) {
        request.destroy();
        settle({});
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        settle(text === "" ? {} : JSON.parse(text));
      } catch {
        settle({});
      }
    });
    request.on("error", () => settle({}));
  });

/** The sockets in `root`'s scopes (a test names a directory of its own). */
export const executorSocketsAt = (
  root: string,
): Layer.Layer<
  ExecutorSockets,
  never,
  SessionChannelRegistry | SessionChannelTokensRepo | BlobStoreConfig
> => Layer.effect(ExecutorSockets, makeExecutorSockets(root));

/** The sockets in `MEND_EXECUTOR_CONTROL_ROOT`, else where Mend's container mounts `mend-control`. */
export const ExecutorSocketsLive: Layer.Layer<
  ExecutorSockets,
  never,
  SessionChannelRegistry | SessionChannelTokensRepo | BlobStoreConfig
> = Layer.unwrap(
  Config.String("MEND_EXECUTOR_CONTROL_ROOT").pipe(
    Config.withDefault(EXECUTOR_CONTROL_ROOT_DEFAULT),
    Effect.orElseSucceed(() => EXECUTOR_CONTROL_ROOT_DEFAULT),
    Effect.map(executorSocketsAt),
  ),
);
