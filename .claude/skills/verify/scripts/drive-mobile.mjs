#!/usr/bin/env node
// The verify skill's mobile driver: the Expo app's web build and the stack's API on one local origin,
// so the phone app (driven by drive-web.mjs --viewport 390x844) reaches the stack without the stack
// trusting another origin.
//
//   node drive-mobile.mjs --app <apps/mobile dir> --web <stack url> --port <local port> \
//     --expo-port <port> --log <file>
//
// It starts `expo start --web --port <expo-port>` in <app>, then listens on 127.0.0.1:<port>:
// requests under /api (HTTP, server-sent events and WebSocket upgrades) go to <web> with their Origin
// and Referer rewritten to <web>'s own, and everything else goes to the Expo dev server. Pair the app
// with http://127.0.0.1:<port> as its server. It runs until killed (SIGTERM ends Expo too). Expo's
// output goes to --log; the proxy prints one line per refused upstream, never a header or a body.
// --web must be this run's own stack through its tunnel ($MEND_VERIFY_PRIVATE/tunnel.json, with
// MEND_VERIFY_OUTER_URL declared; guard/policy.mjs): any other server is refused (exit 97).
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import http from "node:http";
import net from "node:net";

import { Refused, checkTarget } from "./guard/policy.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const app = flag("app");
const web = flag("web") && new URL(flag("web"));
const port = Number(flag("port"));
const expoPort = Number(flag("expo-port") ?? "8081");
const log = flag("log");
if (!app || !web || !port || !log) {
  process.stderr.write(
    "usage: drive-mobile.mjs --app <dir> --web <url> --port <port> [--expo-port <port>] --log <file>\n",
  );
  process.exit(2);
}

try {
  checkTarget(web.href, process.env);
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  process.stderr.write(
    `drive-mobile: ${error.message}; refused · a verifier never talks to the owner's server\n`,
  );
  process.exit(97);
}

const out = openSync(log, "a");
const expo = spawn("pnpm", ["exec", "expo", "start", "--web", "--port", String(expoPort)], {
  cwd: app,
  stdio: ["ignore", out, out],
  env: { ...process.env, CI: "1", BROWSER: "none" },
});
const end = () => {
  expo.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", end);
process.on("SIGINT", end);

const upstreamFor = (url) =>
  url.startsWith("/api")
    ? { host: web.hostname, port: Number(web.port || 80), api: true }
    : { host: "127.0.0.1", port: expoPort, api: false };

const rewrite = (headers, api) => {
  const next = { ...headers };
  if (api) {
    if (next.origin) next.origin = web.origin;
    if (next.referer) next.referer = web.origin + "/";
    next.host = web.host;
  } else next.host = `127.0.0.1:${expoPort}`;
  return next;
};

const server = http.createServer((req, res) => {
  const target = upstreamFor(req.url ?? "/");
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: rewrite(req.headers, target.api),
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    process.stdout.write(
      `drive-mobile: ${target.api ? "the stack" : "Expo"} refused ${req.method} ${req.url?.split("?")[0]}\n`,
    );
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const target = upstreamFor(req.url ?? "/");
  const upstream = net.connect(target.port, target.host, () => {
    const headers = rewrite(req.headers, target.api);
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, "127.0.0.1", () =>
  process.stdout.write(
    `drive-mobile · app and stack on http://127.0.0.1:${port} · Expo on :${expoPort}\n`,
  ),
);
