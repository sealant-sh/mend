import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";

import { SessionChannelTokensRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { BlobStoreConfig } from "@mend/store";
import { Config, Effect, Layer, Option, Schema, type Scope } from "effect";
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
 *   Services, pickups, agent hooks, sign-ins, Doppler), each request with a bearer token of this
 *   executor's launch, a person's or the launch's own (docs/adr/0016, decision 4: never
 *   tokenless). Captures are not served here. A recovery boot never has one, so its capture
 *   credential reaches captures alone.
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
  /**
   * The store's scheme, as configured: an https store is reached only over TLS. sealantd dials an
   * https presigned URL with TLS over the socket itself, which the relay passes to the store
   * unopened after checking its SNI names the store (`clientHelloServerName`); an http one it
   * writes as plain HTTP, which the relay reads and relays by its `Host`.
   */
  readonly protocol: "http" | "https";
}

const endpointOfUrl = (raw: string | undefined): ObjectStoreEndpoint | null => {
  if (raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  const protocol = url.protocol === "https:" ? "https" : "http";
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port === "" ? (protocol === "https" ? 443 : 80) : Number(url.port),
    protocol,
  };
};

/**
 * The store `capture.sock` relays presigned requests to: the host and port of
 * `MEND_BLOB_STORE_PUBLIC_URL`, the one executors' URLs are minted against, else the endpoint
 * `MEND_BLOB_STORE` names (`s3://…?endpoint=…`), which is what URLs are minted against then. Its
 * scheme is kept: an https store is relayed to over TLS. Null when neither names one.
 */
export const objectStoreEndpointOf = (
  publicUrl: string | undefined,
  storeEndpoint?: string,
): ObjectStoreEndpoint | null => endpointOfUrl(publicUrl) ?? endpointOfUrl(storeEndpoint);

/**
 * The store of a blob store configuration: its public URL, else its endpoint, else (AWS S3 with
 * no endpoint named) the bucket's own host, virtual-hosted (`<bucket>.s3.<region>.amazonaws.com`)
 * or path-style (`s3.<region>.amazonaws.com`), over https.
 */
export const objectStoreOfConfig = (config: {
  readonly target: BlobStoreConfig["Service"]["target"];
  readonly publicUrl: string | undefined;
}): ObjectStoreEndpoint | null => {
  const target = config.target;
  const named = objectStoreEndpointOf(
    config.publicUrl,
    target.kind === "s3" ? target.endpoint : undefined,
  );
  if (named !== null || target.kind !== "s3") return named;
  const region = target.region.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(region)) return null;
  const host = target.forcePathStyle
    ? `s3.${region}.amazonaws.com`
    : `${target.bucket.toLowerCase()}.s3.${region}.amazonaws.com`;
  return { hostname: host, port: 443, protocol: "https" };
};

/** A `Host` header's host and port (null when it names none), or null when it is not one. */
const hostHeaderOf = (
  value: string,
): { readonly hostname: string; readonly port: number | null } | null => {
  if (value === "" || /[\s/\\?#@]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  // `URL` drops a port that is its scheme's default, so read the port from the header itself.
  const explicitPort = /:(\d+)$/.exec(value);
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: explicitPort === null || value.endsWith("]") ? null : Number(explicitPort[1]),
  };
};

/** Whether a request's `Host` names the store: its host, and its port or the scheme's default. */
const namesStore = (
  host: { readonly hostname: string; readonly port: number | null },
  store: ObjectStoreEndpoint,
): boolean =>
  host.hostname === store.hostname &&
  (host.port ?? (store.protocol === "https" ? 443 : 80)) === store.port;

/** How many `Host` headers a request carries, from its raw headers. */
const hostHeaderCount = (rawHeaders: ReadonlyArray<string>): number => {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? "").toLowerCase() === "host") count += 1;
  }
  return count;
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
    /** The headers as they came, every repeat kept (`IncomingMessage.rawHeaders`). */
    readonly rawHeaders?: ReadonlyArray<string>;
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
  // Node keeps the first of several `Host` headers; a relay and a store may each read another.
  if (request.rawHeaders !== undefined && hostHeaderCount(request.rawHeaders) > 1) {
    return refuse(400, "a request to capture.sock names one Host");
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
  if (store !== null && namesStore(host, store)) {
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
  const options = {
    host: store.hostname,
    port: store.port,
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: rawHeadersBeyondHop(request.rawHeaders),
    setHost: false,
    agent: false,
  } as const;
  const upstream =
    store.protocol === "https"
      ? https.request({ ...options, servername: store.hostname })
      : http.request(options);
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

/**
 * The executor sockets a launch binds, or null where Mend does not serve the control root
 * (`MEND_EXECUTOR_CONTROL_ROOT` unset: `pnpm dev`, a test's world, a Kubernetes install). Then a
 * launch names no control scope and its executor reaches Mend over the network channel, as
 * before.
 */
export const LaunchExecutorSockets: Context.Reference<ExecutorSockets["Service"] | null> =
  Context.Reference<ExecutorSockets["Service"] | null>("@mend/sessions/LaunchExecutorSockets", {
    defaultValue: () => null,
  });

/**
 * The session channel's address in a capture source whose executor dials `capture.sock`: plain
 * HTTP, since the socket is local and the relay serves the capture routes whatever host they
 * name (sealant-capture dials plain HTTP over a local socket).
 */
export const EXECUTOR_SOCKET_CHANNEL_URL = "http://mend:3106";

/** Where a Docker workspace's processes reach `session.sock` (its scope is at `/run/sealant`). */
export const WORKSPACE_SESSION_SOCKET = "/run/sealant/session.sock";

/**
 * The control scope Mend names for a launch: `mend-` and 24 hex characters of the launch id's
 * SHA-256. The launch id is random, so the scope cannot be guessed, it is the same each time Mend
 * asks (a restart re-binds it), and its sockets' paths stay far below the 107-byte limit.
 */
export const executorScopeOf = (launchId: string): string =>
  `mend-${createHash("sha256").update(launchId).digest("hex").slice(0, 24)}`;

/** A container name, which is what a `mend-control` subpath is: never `..`, never a path. */
const SCOPE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The server name a TLS ClientHello asks for (its SNI), from the first TLS record, or null when
 * the record names none or is not a ClientHello. `undefined` while more bytes are needed.
 */
export const clientHelloServerName = (bytes: Buffer): string | null | undefined => {
  if (bytes.length < 5) return undefined;
  if (bytes[0] !== 0x16) return null;
  const recordLength = bytes.readUInt16BE(3);
  if (bytes.length < 5 + recordLength) return undefined;
  const record = bytes.subarray(5, 5 + recordLength);
  // Handshake type 1 (ClientHello), its 3-byte length, the client version and 32 random bytes.
  if (record.length < 38 || record[0] !== 0x01) return null;
  let at = 38;
  const need = (count: number) => at + count <= record.length;
  if (!need(1)) return null;
  at += 1 + (record[at] ?? 0); // session id
  if (!need(2)) return null;
  at += 2 + record.readUInt16BE(at); // cipher suites
  if (!need(1)) return null;
  at += 1 + (record[at] ?? 0); // compression methods
  if (!need(2)) return null;
  const extensionsEnd = Math.min(record.length, at + 2 + record.readUInt16BE(at));
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = record.readUInt16BE(at);
    const length = record.readUInt16BE(at + 2);
    const start = at + 4;
    if (type === 0x0000 && start + 5 <= extensionsEnd) {
      // server_name: the list's length, then each entry's type (0 = a host name) and length.
      let entry = start + 2;
      while (entry + 3 <= start + length) {
        const nameType = record[entry];
        const nameLength = record.readUInt16BE(entry + 1);
        const name = record.subarray(entry + 3, entry + 3 + nameLength).toString("ascii");
        if (nameType === 0) return name.toLowerCase();
        entry += 3 + nameLength;
      }
      return null;
    }
    at = start + length;
  }
  return null;
};

/** The largest first TLS record the relay reads before deciding: one record's 16 KiB and its header. */
const MAX_CLIENT_HELLO = 16 * 1024 + 5;

const listen = (server: net.Server, socketPath: string): Promise<void> =>
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
    const store = objectStoreOfConfig(yield* BlobStoreConfig);
    const bound = new Map<string, ReadonlyArray<net.Server>>();
    /** What each scope serves now: whose launch, and whether it boots to recover. */
    const bindings = new Map<
      string,
      { readonly launchId: string; readonly mode: "normal" | "recover" }
    >();
    /**
     * Each scope's upgraded connections (a Git tunnel, an `Upgrade`): once handed over they are
     * no longer the server's, so `closeAllConnections` would leave them open past their scope.
     */
    const upgraded = new Map<string, Set<net.Socket>>();
    /** Each scope's last bind or unbind: the next one waits for it, so two never interleave. */
    const pending = new Map<string, Promise<unknown>>();

    const close = (scope: string): void => {
      for (const server of bound.get(scope) ?? []) {
        server.close();
        if (server instanceof http.Server) server.closeAllConnections();
      }
      bound.delete(scope);
      for (const socket of upgraded.get(scope) ?? []) socket.destroy();
      upgraded.delete(scope);
    };

    /** Keep `socket` with `scope`'s connections, so closing the scope closes it. */
    const held = (scope: string, socket: net.Socket) => {
      const sockets = upgraded.get(scope) ?? new Set<net.Socket>();
      sockets.add(socket);
      upgraded.set(scope, sockets);
      socket.once("close", () => sockets.delete(socket));
    };

    /** Run `work` for `scope` after every bind or unbind of it already asked for has ended. */
    const inTurn = <A>(scope: string, work: () => Promise<A>): Promise<A> => {
      const before = pending.get(scope) ?? Promise.resolve();
      const turn = before.then(work, work);
      const settled = turn.then(
        () => undefined,
        () => undefined,
      );
      pending.set(scope, settled);
      void settled.then(() => {
        if (pending.get(scope) === settled) pending.delete(scope);
        return undefined;
      });
      return turn;
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const scope of Array.from(bound.keys())) close(scope);
      }),
    );

    const captureServer = (scope: string, launchId: string): net.Server => {
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
          {
            method: request.method ?? "",
            target: request.url ?? "",
            headers: request.headers,
            rawHeaders: request.rawHeaders,
          },
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
      // sealantd's capture dial (sealant-capture `transport.rs`) writes plain HTTP for an http URL
      // and speaks TLS over this socket for an https one, naming the URL's host as its SNI. A
      // connection that opens with a ClientHello naming the configured https store is relayed to
      // it byte for byte, the TLS between sealantd and the store left whole; one naming anything
      // else, or any TLS when the store is not https, is closed. Everything else is HTTP.
      const front = net.createServer((socket) => {
        held(scope, socket);
        let first = Buffer.alloc(0);
        const decide = (chunk: Buffer) => {
          first = Buffer.concat([first, chunk]);
          if (first[0] !== 0x16) {
            socket.removeListener("data", decide);
            socket.setTimeout(0);
            socket.pause();
            socket.unshift(first);
            server.emit("connection", socket);
            socket.resume();
            return;
          }
          const name = clientHelloServerName(first);
          if (name === undefined) {
            if (first.length > MAX_CLIENT_HELLO) socket.destroy();
            return;
          }
          socket.removeListener("data", decide);
          socket.setTimeout(0);
          if (store === null || store.protocol !== "https" || name !== store.hostname) {
            socket.destroy();
            return;
          }
          socket.pause();
          const upstream = net.connect({ host: store.hostname, port: store.port });
          held(scope, upstream);
          upstream.once("connect", () => {
            upstream.write(first);
            socket.pipe(upstream);
            upstream.pipe(socket);
            socket.resume();
          });
          const end = () => {
            socket.destroy();
            upstream.destroy();
          };
          upstream.on("error", end);
          upstream.on("close", end);
          socket.on("error", end);
          socket.on("close", end);
        };
        socket.on("data", decide);
        socket.on("error", () => socket.destroy());
        socket.setTimeout(10_000, () => {
          if (first.length === 0 || first[0] === 0x16) socket.destroy();
        });
      });
      front.on("close", () => server.closeAllConnections());
      return front;
    };

    const sessionServer = (scope: string, launchId: string): http.Server => {
      // A token of this executor's launch, never none (docs/adr/0016, decision 4): a person's, or
      // the launch's own, which a shared layout's processes carry. A recovery boot has no
      // session.sock, so its capture credential reaches captures alone. Captures travel over
      // capture.sock: the routes this socket serves carry none.
      const handlers = tokenChannelHandlers(async (headers) => {
        const auth = await authenticateChannelRequest(headers, { tokens, registry }, { launchId });
        if (!auth.ok) return auth;
        const api: SessionSocketApi = { ...auth.api, capture: undefined, captureAs: undefined };
        return { ...auth, api };
      }, registry);

      const server = http.createServer(handlers.onRequest);
      server.on("connect", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        held(scope, socket);
        handlers.onConnect(request, socket, head);
      });
      server.on("upgrade", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        held(scope, socket);
        handlers.onUpgrade(request, socket, head);
      });
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
      const servers: Array<{ readonly server: net.Server; readonly path: string }> = [
        { server: captureServer(binding.scope, binding.launchId), path: capturePath },
        ...(binding.mode === "recover"
          ? []
          : [{ server: sessionServer(binding.scope, binding.launchId), path: sessionPath }]),
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
      bindings.set(binding.scope, { launchId: binding.launchId, mode: binding.mode });
      return servers.map((entry) => entry.path);
    };

    const bind = Effect.fn("ExecutorSockets.bind")(function* (binding: ExecutorSocketsBinding) {
      if (!SCOPE_SHAPE.test(binding.scope)) {
        return yield* new ExecutorScopeError({
          message: `not an executor scope: ${JSON.stringify(binding.scope)}`,
        });
      }
      return yield* Effect.tryPromise({
        // A re-bind closes what the scope served first, tunnels included: a scope that turns to
        // recovery keeps no session connection open.
        try: () =>
          inTurn(binding.scope, () => {
            // Asked again as it stands (a claim, a restart's sweep): left serving, its connections
            // kept.
            const current = bindings.get(binding.scope);
            const dir = path.join(root, binding.scope);
            if (
              current !== undefined &&
              current.launchId === binding.launchId &&
              current.mode === binding.mode &&
              fs.existsSync(path.join(dir, CAPTURE_SOCKET_NAME))
            ) {
              return Promise.resolve(
                [
                  CAPTURE_SOCKET_NAME,
                  ...(binding.mode === "recover" ? [] : [SESSION_SOCKET_NAME]),
                ].map((name) => path.join(dir, name)),
              );
            }
            close(binding.scope);
            return bindIn(dir, binding);
          }),
        catch: (cause) =>
          new ExecutorScopeError({
            message: `could not bind ${binding.scope}'s sockets: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
    });

    const unbind = Effect.fn("ExecutorSockets.unbind")(function* (scope: string) {
      if (!SCOPE_SHAPE.test(scope)) return;
      yield* Effect.promise(() =>
        inTurn(scope, async () => {
          close(scope);
          bindings.delete(scope);
          fs.rmSync(path.join(root, scope, CAPTURE_SOCKET_NAME), { force: true });
          fs.rmSync(path.join(root, scope, SESSION_SOCKET_NAME), { force: true });
        }),
      );
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

/**
 * The executor sockets launches bind, where Mend serves the control root: the bundle names it
 * (`MEND_EXECUTOR_CONTROL_ROOT`, the `mend-control` volume Mend shares with sealant's worker).
 * Unset, launches bind none (`LaunchExecutorSockets` reads null) and reach Mend over the network.
 */
export const LaunchExecutorSocketsFromEnv: Layer.Layer<
  never,
  never,
  SessionChannelRegistry | SessionChannelTokensRepo | BlobStoreConfig
> = Layer.unwrap(
  Config.option(Config.String("MEND_EXECUTOR_CONTROL_ROOT")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map((root) =>
      Option.isNone(root) || root.value.trim() === ""
        ? Layer.empty
        : Layer.effect(LaunchExecutorSockets, makeExecutorSockets(root.value.trim())),
    ),
  ),
);
