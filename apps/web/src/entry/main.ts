import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

import { loadPublicNetwork } from "@mend/network";
import { Effect } from "effect";

import { forwardHeaders } from "./proxy-headers.ts";
import { securityHeaders } from "./security-headers.ts";

/**
 * The web tier's FRONT (ARCHITECTURE.md §2): one public port that owns the
 * single concern nitro cannot — relaying `/api` verbatim to the Mend API
 * server, including WebSocket upgrades (/api/tty, the service tunnel, the
 * keys bridge) and unbuffered SSE. Everything else — pages, assets, and the
 * /trpc server route — is the TanStack Start app, served by nitro's own
 * node server (.output/server/index.mjs), which this process supervises as
 * a child unless MEND_APP_URL points at one already running.
 *
 * Stateless by design: no database, no engine, no sessions — replicate
 * freely; every stateful concern lives behind the /api proxy.
 */

const port = Number(process.env["PORT"] ?? "3105");
const apiUrl = new URL(process.env["MEND_API_URL"] ?? "http://localhost:3101");
const publicNetwork = Effect.runSync(loadPublicNetwork);

// ─── The app server: nitro output, supervised unless external ───────────────
const here = path.dirname(fileURLToPath(import.meta.url));
// Bundled (.output/front.mjs → sibling server/) or source (src/entry → ../../.output).
const nitroEntry = [
  path.join(here, "server/index.mjs"),
  path.resolve(here, "../../.output/server/index.mjs"),
].find(existsSync);

const externalApp = process.env["MEND_APP_URL"];
const appUrl = new URL(externalApp ?? "http://127.0.0.1:3210");
if (externalApp === undefined) {
  if (nitroEntry === undefined) {
    console.error("[web] no app build found (.output/server/index.mjs) and no MEND_APP_URL");
    process.exit(1);
  }
  const child = spawn(process.execPath, [nitroEntry], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: appUrl.port,
      HOST: "127.0.0.1",
      NITRO_PORT: appUrl.port,
      NITRO_HOST: "127.0.0.1",
    },
  });
  // The pair lives and dies together; the supervisor (systemd, k8s) restarts us.
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => child.kill("SIGTERM"));
  }
}

/**
 * pipeline() THROWS synchronously (ERR_STREAM_UNABLE_TO_PIPE, node ≥24) when
 * either end is already destroyed — which is routine in a proxy: a readiness
 * probe or impatient client hangs up while the upstream is still answering.
 * Every relay goes through here so an early hangup tears down the pair
 * instead of the whole process.
 */
const relay = (
  source: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
  destination: NodeJS.WritableStream & { destroy?: (error?: Error) => void },
): void => {
  try {
    pipeline(source, destination, () => {});
  } catch {
    source.destroy?.();
    destination.destroy?.();
  }
};

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Forward one request verbatim; stream both directions, never buffer. */
const proxyRequest = (
  target: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void => {
  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: forwardHeaders({
        headers: request.headers,
        remoteAddress: request.socket.remoteAddress,
      }),
    },
    (upstreamResponse) => {
      // The client can be gone before the upstream answers (probe hangups
      // are routine); writing to the dead response would error or throw.
      if (response.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      const headers = {
        ...Object.fromEntries(
          Object.entries(upstreamResponse.headers).filter(([name]) => !hopByHop.has(name)),
        ),
        // The browser header policy, on the app's responses and the API's alike (MEND-11).
        ...securityHeaders({
          pathname: new URL(request.url ?? "/", "http://mend.local").pathname,
          appUrl: publicNetwork.appUrl,
        }),
      };
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      relay(upstreamResponse, response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        "content-type": "text/plain",
        ...securityHeaders({
          pathname: new URL(request.url ?? "/", "http://mend.local").pathname,
          appUrl: publicNetwork.appUrl,
        }),
      });
    }
    response.end("upstream unreachable");
  });
  relay(request, upstream);
};

const isApiPath = (url: string): boolean => url === "/api" || url.startsWith("/api/");

const server = http.createServer((request, response) => {
  proxyRequest(isApiPath(request.url ?? "/") ? apiUrl : appUrl, request, response);
});

// ─── WebSocket upgrades: pipe both sockets raw, verbatim ────────────────────

/** Rebuild the upstream's header block from rawHeaders — repeats (set-cookie) survive. */
const rawHeaderBlock = (
  upstreamResponse: http.IncomingMessage,
  options: { readonly stripHopByHop: boolean },
): string => {
  let lines = "";
  for (let k = 0; k + 1 < upstreamResponse.rawHeaders.length; k += 2) {
    const name = upstreamResponse.rawHeaders[k] ?? "";
    if (options.stripHopByHop && hopByHop.has(name.toLowerCase())) continue;
    lines += `${name}: ${upstreamResponse.rawHeaders[k + 1]}\r\n`;
  }
  if (options.stripHopByHop) lines += "connection: close\r\n";
  return lines;
};

server.on("upgrade", (request, socket, head) => {
  const url = request.url ?? "/";
  if (!isApiPath(url)) {
    socket.destroy();
    return;
  }
  const upstream = http.request({
    host: apiUrl.hostname,
    port: apiUrl.port,
    method: request.method,
    path: url,
    headers: forwardHeaders({
      headers: request.headers,
      remoteAddress: request.socket.remoteAddress,
    }),
  });
  // Node hands the detached socket to this listener with NO error handling of
  // its own: a client reset before the API answers would otherwise be an
  // uncaught 'error' and take down the whole web tier.
  let upstreamAnswered = false;
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => {
    if (!upstreamAnswered) upstream.destroy();
  });
  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstreamAnswered = true;
    const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n`;
    socket.write(statusLine + rawHeaderBlock(upstreamResponse, { stripHopByHop: false }) + "\r\n");
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    relay(socket, upstreamSocket);
    relay(upstreamSocket, socket);
  });
  // The API answered without upgrading (401, 404, ...): relay it as HTTP. Its headers are relayed
  // as they are: every API answer carries the API's own policy (nosniff, no framing, no referrer,
  // `default-src 'none'`), which is tighter than the browser policy set on documents above.
  // Hop-by-hop headers are stripped — node already de-chunked the body, so
  // `connection: close` + EOF delimits it instead of stale framing headers.
  upstream.on("response", (upstreamResponse) => {
    upstreamAnswered = true;
    const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ""}\r\n`;
    socket.write(statusLine + rawHeaderBlock(upstreamResponse, { stripHopByHop: true }) + "\r\n");
    relay(upstreamResponse, socket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(port, () => {
  console.log(
    `[web] listening on :${port} · public ${publicNetwork.appUrl} · /api → ${apiUrl.origin} · app → ${appUrl.origin}${externalApp === undefined ? " (supervised nitro)" : ""}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
