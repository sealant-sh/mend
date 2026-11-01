import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type * as net from "node:net";

import { SessionChannelTokensRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import {
  AgentHookReport,
  PAGE_REQUEST_MAX_BYTES,
  ReaderTimeZone,
  type ResourceSessionAnswer,
  type ResourceLoadAnswer,
  type ServiceBrowserScheme,
} from "@mend/domain/workbench";
import { redactDetail } from "@mend/network";
import { DeploymentConfig } from "@mend/store";
import { Cause, Effect, Exit, Layer, Redacted, Schema, Stream } from "effect";
import * as Context from "effect/Context";

import { CAPTURE_ROUTES, dispatchCaptureRoute, MAX_CAPTURE_BODY_BYTES } from "./capture-channel.ts";
import { frame, makeFrameFeed, makePushSniffer, type GitTransportPlan } from "./git-transport.ts";
import {
  agentProcessNamed,
  MEND_MCP_AGENT_PROCESS_HEADER,
  MEND_MCP_CALL_KEY_HEADER,
  MEND_MCP_PATH,
} from "./mend-mcp/caller.ts";
import type { MendMcp } from "./mend-mcp/server.ts";
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

/**
 * `mend resource <argv>` from inside a session (`Resources.forSession`), decided as the session's
 * owner: the lines the helper prints, or why the act was refused.
 */
export type SessionResources = (
  sessionId: SessionId,
  argv: ReadonlyArray<string>,
  clock: { readonly now: Date; readonly timeZone: string },
) => Effect.Effect<ResourceSessionAnswer, { readonly message: string }>;

/** The channel's raw dump body stays streamed through to the instance. */
export type SessionResourceLoads = (
  sessionId: SessionId,
  method: string,
  id: string | null,
  input: unknown,
  body: Stream.Stream<Uint8Array, unknown>,
  clock: { readonly now: Date; readonly timeZone: string },
) => Effect.Effect<ResourceLoadAnswer, { readonly message: string }>;

export class SessionChannelRegistry extends Context.Service<
  SessionChannelRegistry,
  {
    readonly register: (sessionId: SessionId, api: SessionSocketApi) => void;
    readonly unregister: (sessionId: SessionId) => void;
    readonly lookup: (sessionId: SessionId) => SessionSocketApi | undefined;
    readonly size: () => number;
    readonly serveMcp: (server: MendMcp["Service"] | undefined) => void;
    readonly mcp: () => MendMcp["Service"] | undefined;
    readonly serveResources: (reader: SessionResources | undefined) => void;
    readonly resources: () => SessionResources | undefined;
    readonly serveResourceLoads?: (handler: SessionResourceLoads | undefined) => void;
    readonly resourceLoads?: () => SessionResourceLoads | undefined;
  }
>()("@mend/sessions/SessionChannelRegistry") {}

export const SessionChannelRegistryLive: Layer.Layer<SessionChannelRegistry> = Layer.sync(
  SessionChannelRegistry,
  () => {
    const live = new Map<SessionId, SessionSocketApi>();
    let mcp: MendMcp["Service"] | undefined;
    let resources: SessionResources | undefined;
    let loads: SessionResourceLoads | undefined;
    return {
      register: (sessionId, api) => {
        live.set(sessionId, api);
      },
      unregister: (sessionId) => {
        live.delete(sessionId);
      },
      lookup: (sessionId) => live.get(sessionId),
      size: () => live.size,
      serveMcp: (server) => {
        mcp = server;
      },
      mcp: () => mcp,
      serveResources: (reader) => {
        resources = reader;
      },
      resources: () => resources,
      serveResourceLoads: (handler) => {
        loads = handler;
      },
      resourceLoads: () => loads,
    };
  },
);

// ─── Shared request handling ────────────────────────────────────────────────

/** Largest JSON body either listener accepts; the helper's requests are tiny. */
export const MAX_BODY_BYTES = 64 * 1024;

const MAX_AGENT_HOOK_BODY_BYTES = 4 * 1024;
const decodeAgentHookReport = Schema.decodeUnknownExit(AgentHookReport);
const decodeTimeZone = Schema.decodeUnknownExit(ReaderTimeZone);

const readBody = (
  request: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> =>
  new Promise((resolve) => {
    let text = "";
    let settled = false;
    const settle = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      text += String(chunk);
      if (text.length > maxBytes) {
        request.destroy();
        settle({});
      }
    });
    request.on("end", () => {
      let parsed: unknown = {};
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = {};
        }
      }
      settle(parsed);
    });
  });

const readBytes = (request: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      if (length > maxBytes) return;
      length += chunk.length;
      if (length > maxBytes) resolve(null);
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const MCP_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  MEND_MCP_CALL_KEY_HEADER,
] as const;

const isToolCall = (body: Buffer): boolean => {
  try {
    return asRecord(JSON.parse(body.toString("utf8")))["method"] === "tools/call";
  } catch {
    return false;
  }
};

const relayMcp = async (
  api: SessionSocketApi,
  server: MendMcp["Service"] | undefined,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> => {
  const unavailable = (message: string) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ message }));
  };
  const caller = await Effect.runPromise(
    Effect.result(api.mcpCaller(agentProcessNamed(request.headers[MEND_MCP_AGENT_PROCESS_HEADER]))),
  );
  if (caller._tag === "Failure") return unavailable(caller.failure.message);
  if (server === undefined) return unavailable("Mend's MCP server is not running on this instance");
  const method = request.method ?? "GET";
  const body = method === "POST" ? await readBytes(request, PAGE_REQUEST_MAX_BYTES) : undefined;
  if (body === null) {
    response.writeHead(413, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        message: `an MCP request may be at most ${PAGE_REQUEST_MAX_BYTES} bytes`,
      }),
      () => request.destroy(),
    );
    return;
  }
  // Effect's MCP server keeps a session's `initialize` until the session ends.
  if (body !== undefined && body.length > MAX_BODY_BYTES && !isToolCall(body)) {
    response.writeHead(413, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        message: `an MCP request other than a tool call may be at most ${MAX_BODY_BYTES} bytes`,
      }),
    );
    return;
  }
  const headers = new Headers();
  for (const name of MCP_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const left = new AbortController();
  response.once("close", () => left.abort());
  const answer = await Effect.runPromise(
    server.handle(
      new Request(`http://mend.session${MEND_MCP_PATH}`, {
        method,
        headers,
        signal: left.signal,
        ...(body === undefined ? {} : { body: body.toString("utf8") }),
      }),
      caller.success,
    ),
  );
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (answer.body === null) {
    response.end();
    return;
  }
  const reader = answer.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (left.signal.aborted) cancel();
  else left.signal.addEventListener("abort", cancel);
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      response.write(read.value);
    }
    response.end();
  } catch {
    response.destroy();
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The optional `browserScheme` of a run/add body: absent or null is none; `http | https` is a
 * Service to open in a browser; anything else, or any scheme on UDP, is refused.
 */
export const browserSchemeOf = (
  body: Record<string, unknown>,
  protocol: "tcp" | "udp",
):
  | { readonly ok: true; readonly value: ServiceBrowserScheme }
  | { readonly ok: false; readonly message: string } => {
  const raw = body["browserScheme"];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (raw !== "http" && raw !== "https") {
    return { ok: false, message: 'browserScheme must be "http" or "https"' };
  }
  if (protocol === "udp") {
    return { ok: false, message: "browserScheme applies to TCP Services only" };
  }
  return { ok: true, value: raw };
};

/** Keep the underlying failure ahead of wrapper stacks; never serialize query parameters or error fields. */
const resourceFailureDetails = (cause: Cause.Cause<never>): ReadonlyArray<string> =>
  Cause.prettyErrors(cause)
    .slice(0, 3)
    .flatMap((error) => {
      const chain: Error[] = [];
      let current: Error | undefined = error;
      while (current !== undefined && chain.length < 6) {
        chain.push(current);
        current = current.cause instanceof Error ? current.cause : undefined;
      }
      return chain.toReversed().map((entry) =>
        redactDetail(
          [
            `${entry.name}: ${entry.message.split("\n")[0]}`,
            ...(entry.stack ?? "")
              .split("\n")
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 4),
          ].join("\n"),
        ),
      );
    });

/** Route one helper request to the session-scoped closures. Transport-neutral. */
export const handleSessionRequest = async (
  api: SessionSocketApi,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  registry: Pick<SessionChannelRegistry["Service"], "mcp" | "resources" | "resourceLoads">,
): Promise<void> => {
  const respond = (status: number, payload: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const url = new URL(request.url ?? "/", "http://mend.sock");
  const route = `${request.method} ${url.pathname}`;
  try {
    if (url.pathname === MEND_MCP_PATH) {
      return await relayMcp(api, registry.mcp(), request, response);
    }
    if (request.method === "POST" && CAPTURE_ROUTES.has(url.pathname)) {
      // sealantd's registrar (ADR-0002 "Session channel routes"): a manifest can run to
      // megabytes, so these read a larger body than the helper's tiny requests. Arrival is
      // logged before the body is read, so a hung executor call is visible as "received"
      // without its "capture route" completion line.
      console.info(`session channel: capture route received · ${route}`);
      const body = await readBody(request, MAX_CAPTURE_BODY_BYTES);
      return await dispatchCaptureRoute(api.capture, url.pathname, body, respond);
    }
    // A pickup (`pickup-tickets.ts`): the secret an exec holds a ticket for, never its argv's.
    // The ticket is never logged, and neither is what it answers.
    if (route === "POST /pickup") {
      if (api.pickup === undefined) return respond(404, { message: "no pickups on this channel" });
      const body = asRecord(await readBody(request));
      const ticket = typeof body["ticket"] === "string" ? body["ticket"] : "";
      if (ticket === "") return respond(400, { message: "ticket is required" });
      const answer = await Effect.runPromise(Effect.result(api.pickup(ticket)));
      return answer._tag === "Success"
        ? respond(200, answer.success)
        : respond(403, { message: answer.failure.message });
    }
    if (route === "POST /session/screen-secret") {
      const passwords =
        api.screenSecret === undefined ? null : await Effect.runPromise(api.screenSecret());
      if (passwords === null) {
        return respond(409, { message: "no screen of this session is waiting for its passwords" });
      }
      return respond(200, {
        full: Redacted.value(passwords.full),
        viewOnly: Redacted.value(passwords.viewOnly),
      });
    }
    if (route === "POST /doppler") {
      if (api.doppler === undefined)
        return respond(403, { message: "Doppler requires your own session channel" });
      return respond(200, await Effect.runPromise(api.doppler(await readBody(request))));
    }
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
      const scheme = browserSchemeOf(body, protocol);
      if (!scheme.ok) return respond(400, { message: scheme.message });
      return respond(
        200,
        await Effect.runPromise(api.runService(argv, port, name, protocol, scheme.value)),
      );
    }
    if (route === "POST /services/add") {
      const body = asRecord(await readBody(request));
      const port = Number(body["port"]);
      const name = typeof body["name"] === "string" ? body["name"] : null;
      const protocol = body["protocol"] === "udp" ? ("udp" as const) : ("tcp" as const);
      if (!Number.isInteger(port)) return respond(400, { message: "port is required" });
      const scheme = browserSchemeOf(body, protocol);
      if (!scheme.ok) return respond(400, { message: scheme.message });
      return respond(
        200,
        await Effect.runPromise(api.addService(port, name, protocol, scheme.value)),
      );
    }
    const action = /^POST \/services\/([^/]+)\/(stop|restart)$/.exec(route);
    if (action?.[1] !== undefined) {
      const effect =
        action[2] === "stop" ? api.stopService(action[1]) : api.restartService(action[1]);
      return respond(200, await Effect.runPromise(effect));
    }
    // Repositories in a session (docs/adr/0010): `mend repo list|projects|add`. The add answers
    // 202 with the row in `adding`; the clone runs in the engine's lifetime, past this
    // request's 30 s, and the helper polls the list for `ready` or `failed`.
    if (route === "GET /repositories") {
      return respond(200, await Effect.runPromise(api.listRepositories()));
    }
    if (route === "GET /repositories/projects") {
      return respond(200, await Effect.runPromise(api.addableProjects()));
    }
    if (route === "POST /repositories") {
      const body = asRecord(await readBody(request));
      const project = typeof body["project"] === "string" ? body["project"].trim() : "";
      if (project === "") return respond(400, { message: "project is required" });
      const name = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : null;
      const worktree =
        typeof body["worktree"] === "string" && body["worktree"] !== "" ? body["worktree"] : null;
      return respond(202, await Effect.runPromise(api.addRepository({ project, name, worktree })));
    }
    if (
      url.pathname === "/resources/loads" ||
      /^\/resources\/loads\/[0-9a-f-]+(?:\/body)?$/.test(url.pathname)
    ) {
      const serve = registry.resourceLoads?.();
      if (serve === undefined)
        return respond(503, { message: "resource loads cannot be reached now" });
      const zone = decodeTimeZone(url.searchParams.get("timeZone") ?? "UTC");
      if (Exit.isFailure(zone))
        return respond(400, { message: "timeZone must be an IANA time zone" });
      if (!["POST", "GET", "PUT"].includes(request.method ?? ""))
        return respond(405, { message: "use POST, GET or PUT" });
      const raw = request.method === "POST" ? await readBody(request) : null;
      const bytes = Stream.fromAsyncIterable<Uint8Array, Error>(
        request,
        () => new Error("upload ended"),
      );
      const sessionId = await Effect.runPromise(api.resourceSession());
      const result = await Effect.runPromiseExit(
        Effect.result(
          Effect.suspend(() =>
            serve(
              sessionId,
              request.method ?? "GET",
              url.pathname.split("/")[3] ?? null,
              raw,
              bytes,
              { now: new Date(), timeZone: zone.value },
            ),
          ),
        ),
      );
      if (Exit.isFailure(result)) {
        console.error("session channel: resource load failed", {
          sessionId,
          cause: resourceFailureDetails(result.cause),
        });
        return respond(503, { message: "the load could not finish" });
      }
      return result.value._tag === "Success"
        ? respond(200, result.value.success)
        : respond(409, { message: result.value.failure.message });
    }
    // Resources (ADR 0019, story 8): the agent's `mend resource`, decided as the session's owner.
    if (route === "POST /resources") {
      const serve = registry.resources();
      if (serve === undefined) return respond(503, { message: "resources cannot be reached now" });
      const timeZone = decodeTimeZone(url.searchParams.get("timeZone") ?? "UTC");
      if (Exit.isFailure(timeZone)) {
        return respond(400, { message: "timeZone must be an IANA time zone" });
      }
      const body = asRecord(await readBody(request));
      const argv = Array.isArray(body["argv"]) ? body["argv"].map(String) : [];
      const sessionId = await Effect.runPromise(api.resourceSession());
      const answer = await Effect.runPromiseExit(
        Effect.result(
          Effect.suspend(() =>
            serve(sessionId, argv, { now: new Date(), timeZone: timeZone.value }),
          ),
        ),
      );
      if (Exit.isFailure(answer)) {
        console.error("session channel: resource command failed", {
          sessionId,
          cause: resourceFailureDetails(answer.cause),
        });
        return respond(503, { message: "resources could not be reached now" });
      }
      if (answer.value._tag === "Failure")
        return respond(403, { message: answer.value.failure.message });
      return respond(200, answer.value.success);
    }
    if (route === "POST /session/land") {
      // The landing answers when it has pushed and its pull request step is done, or refused.
      return respond(200, await Effect.runPromise(api.land()));
    }
    if (route === "POST /session/agent-hook") {
      const report = decodeAgentHookReport(await readBody(request, MAX_AGENT_HOOK_BODY_BYTES));
      if (Exit.isFailure(report)) return respond(400, { message: "not an agent hook report" });
      const outcome = await Effect.runPromise(api.agentHook(report.value));
      if (typeof outcome === "object") {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(outcome.retryAfterSeconds),
        });
        response.end(
          JSON.stringify({
            message: "too many hook reports from this session",
          }),
        );
        return;
      }
      if (outcome === "no-live-agent") {
        return respond(409, {
          message: "no terminal agent of this harness is live in this session",
        });
      }
      if (outcome === "other-process") {
        return respond(409, {
          message: "the report names another process than this session's terminal agent",
        });
      }
      if (outcome === "unidentified") {
        return respond(400, { message: "the report names no harness session" });
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === "POST /session/stop") {
      // Answer before acting: the stop closes this workspace's PTYs, so
      // awaiting completion races the response against the caller's teardown.
      respond(202, { status: "stopping" });
      void Effect.runPromise(Effect.ignore(api.stopSession()));
      return;
    }
    return respond(404, { message: `unknown route: ${route}` });
  } catch (error) {
    return respond(422, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Write a CONNECT refusal: status line plus a percent-encoded reason header, then close. */
/**
 * A request this server could not answer: the token lookup failed (the store timed out), or
 * the handler threw. Answered 503 — the executor asks again — and logged; never an unhandled
 * rejection, which ends the Mend process (e2e8 F8: a statement timeout in the token lookup
 * took the API down with every session on it).
 */
const unanswered = (cause: unknown) =>
  Effect.runFork(
    Effect.logWarning("session channel: a request could not be answered · 503").pipe(
      Effect.annotateLogs({
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );

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

/**
 * Parse the bearer token and session id; undefined when the token is missing or malformed.
 * The session id header is optional: sealantd's capture registrar presents the token alone
 * (`SEALANT_CAPTURE_TOKEN`, one token under two names), and the token's hash resolves the
 * session; the helper and the git shim keep sending the id, which is verified against it.
 */
export const parseChannelCredentials = (
  headers: http.IncomingHttpHeaders,
): { readonly sessionId: SessionId | null; readonly token: string } | undefined => {
  const authorization = headers["authorization"];
  const sessionId = headers[SESSION_ID_HEADER];
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,256})$/.exec(authorization);
  if (match?.[1] === undefined) return undefined;
  if (sessionId === undefined) return { sessionId: null, token: match[1] };
  if (typeof sessionId !== "string" || !SESSION_ID_SHAPE.test(sessionId)) return undefined;
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
      | {
          readonly ok: true;
          readonly api: SessionSocketApi;
          /** A one-off write's token: its pickups, and nothing else (mend#615 review 3). */
          readonly pickupOnly: boolean;
        }
      | {
          readonly ok: false;
          readonly status: number;
          readonly message: string;
        }
    > => {
      const credentials = parseChannelCredentials(headers);
      if (credentials === undefined) {
        return {
          ok: false,
          status: 401,
          message: "session channel: missing or malformed credentials",
        };
      }
      // The token names one launch (cross-repo decision 5). The launch's own token names its
      // session too, and a session id sent with it must be that one. A person's token (docs/adr/
      // 0016, decision 4) is good for any session live in its launch that the person may act on:
      // the process names its session, and the engine checks both.
      const resolved = await Effect.runPromise(tokens.resolve(credentials.token));
      const notAccepted = {
        ok: false,
        status: 401,
        message: "session channel: the session token was not accepted",
      } as const;
      if (resolved === null) return notAccepted;
      let target: SessionId;
      if (resolved.accountId === null) {
        if (credentials.sessionId !== null && credentials.sessionId !== resolved.sessionId) {
          return notAccepted;
        }
        target = SessionId.make(resolved.sessionId);
      } else {
        if (credentials.sessionId === null) return notAccepted;
        target = credentials.sessionId;
      }
      const api = registry.lookup(target);
      if (api === undefined) {
        return {
          ok: false,
          status: 409,
          message: "session channel: this session is not live on this Mend instance",
        };
      }
      const scope = {
        launchId: resolved.launchId,
        accountId: resolved.accountId,
        ...(resolved.writeOnly ? { writeOnly: true } : {}),
      };
      if (api.channelFor !== undefined) {
        const grant = await Effect.runPromise(api.channelFor(scope));
        return grant.ok ? { ok: true, api: grant.api, pickupOnly: resolved.writeOnly } : grant;
      }
      // A session served without a grant takes its launch's own token, as before, and no
      // person's.
      if (resolved.accountId !== null) return notAccepted;
      // Launch-bound, always (review 2026-09-28 (4) #10): an authenticated executor reaches only
      // the capture routes of the launch its token names — never the session's unbound view,
      // which answers whichever launch the row names now (or the session id before a create
      // answers). A session served without launch-bound routes serves no capture routes here.
      const capture = api.captureAs?.(resolved.launchId);
      // Pickups likewise: a ticket redeemed here answers only for the launch the token names, and,
      // for a person's token, only for that person (`pickupChannelMatch`). The launch's own token
      // names nobody.
      const pickup = api.pickupAs?.({
        launchId: resolved.launchId,
        accountId: null,
      });
      return { ok: true, api: { ...api, capture, pickup }, pickupOnly: false };
    };
    /** What a one-off write's token may ask: its pickup, nothing else. */
    const pickupOnlyRefusal = {
      message: "session channel: this token redeems pickups only",
    };

    const onRequest = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      authenticate(request.headers)
        .then((auth) => {
          if (!auth.ok) {
            response.writeHead(auth.status, {
              "content-type": "application/json",
            });
            response.end(JSON.stringify({ message: auth.message }));
            return;
          }
          if (
            auth.pickupOnly &&
            (request.method !== "POST" ||
              new URL(request.url ?? "/", "http://x").pathname !== "/pickup")
          ) {
            response.writeHead(403, { "content-type": "application/json" });
            response.end(JSON.stringify(pickupOnlyRefusal));
            return;
          }
          return handleSessionRequest(auth.api, request, response, registry);
        })
        .catch((cause: unknown) => {
          unanswered(cause);
          if (!response.headersSent) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                message: "session channel: this request could not be answered now",
              }),
            );
          } else {
            response.destroy();
          }
        });
    };
    const onConnect = (request: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
      authenticate(request.headers)
        .then((auth) => {
          if (!auth.ok) {
            return refuseConnect(
              socket,
              `${auth.status} ${auth.status === 401 ? "Unauthorized" : "Conflict"}`,
              auth.message,
            );
          }
          if (auth.pickupOnly) {
            return refuseConnect(socket, "403 Forbidden", pickupOnlyRefusal.message);
          }
          return handleGitConnect(auth.api, request, socket, head);
        })
        .catch((cause: unknown) => {
          unanswered(cause);
          if (socket.writable) {
            refuseConnect(
              socket,
              "503 Service Unavailable",
              "session channel: this request could not be answered now",
            );
          } else {
            socket.destroy();
          }
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
  {
    endpoint: undefined,
    address: undefined,
  },
);
