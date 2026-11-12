#!/usr/bin/env node
// The verify skill's mobile driver: the Expo app's web build and the stack's API on one local origin,
// so the phone app (driven by drive-web.mjs --viewport 390x844) reaches the stack without the stack
// trusting another origin.
//
//   node drive-mobile.mjs --app <apps/mobile dir> --web <stack url> --port <local port> \
//     --expo-port <port> --log <file>
//   node drive-mobile.mjs --app <apps/mobile dir> --outer --port <local port> ...
//
// It starts `expo start --web --port <expo-port>` in <app>, then listens on 127.0.0.1:<port>:
// requests under /api (HTTP, server-sent events and WebSocket upgrades) go to <web> with their Origin
// and Referer rewritten to <web>'s own, and everything else goes to the Expo dev server. Pair the app
// with http://127.0.0.1:<port> as its server. It runs until killed (SIGTERM ends Expo too). Expo's
// output goes to --log; the proxy prints one line per refused upstream, never a header or a body.
//
// <web> is reached the way its URL says: http or https (TLS verified, SNI by host name), on its port
// or the scheme's default (80, 443). An http <web> whose edge answers with a redirect to https gets
// one line saying so: pass the https URL.
//
// The proxy origin holds for the whole pairing. The server answers POST /api/pair with the URL it
// picked from its own configured ones (APP_URL, never the proxy), and the app saves that URL with
// its token, so every later call would go straight to the server, where the browser's CORS check
// refuses it. The proxy puts its own origin (the one the browser used, http://127.0.0.1:<port> or
// http://localhost:<port>) in that answer's `url` before the app sees it, and prints one line with
// both origins (never the token). A native app pairs with the server directly and never meets this.
//
// --web must be this run's own stack through its tunnel ($MEND_VERIFY_PRIVATE/tunnel.json, with
// MEND_VERIFY_OUTER_URL declared; guard/policy.mjs): any other server is refused (exit 97). With
// --outer it fronts the declared outer instead (MEND_VERIFY_OUTER_URL, as the CLI config names it,
// so its https URL for a server behind an edge): the client pass on a release candidate, where the
// outer is the server under test. --outer takes no --web, or only the declared outer's. Once the
// proxy listens, it records itself in $MEND_VERIFY_PRIVATE/mobile.json (its pid and start time,
// port, the server it fronts, `bound: true`), which is what lets drive-web.mjs drive
// http://127.0.0.1:<port>; the record goes when the proxy ends.
import { spawn } from "node:child_process";
import { openSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

import {
  MOBILE_RECORD,
  Refused,
  allowedTargets,
  checkTarget,
  identityOf,
} from "./guard/policy.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const outerMode = args.includes("--outer");
const app = flag("app");
const webFlag = flag("web") ?? (outerMode ? process.env.MEND_VERIFY_OUTER_URL : undefined);
const port = Number(flag("port"));
const expoPort = Number(flag("expo-port") ?? "8081");
const log = flag("log");
if (!app || !webFlag || !port || !log) {
  process.stderr.write(
    "usage: drive-mobile.mjs --app <dir> (--web <url> | --outer) --port <port> [--expo-port <port>] --log <file>\n",
  );
  process.exit(2);
}

let fronts;
try {
  fronts = checkTarget(webFlag, process.env);
  const [outer, ...tunnels] = allowedTargets(process.env);
  if (outerMode && fronts !== outer)
    throw new Refused(`${webFlag} is not the declared outer (${outer})`);
  // Without --outer, the run's tunnel only: the proxy is the stack's page.
  if (!outerMode && !tunnels.includes(fronts))
    throw new Refused(
      `${webFlag} is the declared outer, not this run's tunnel (--outer fronts it)`,
    );
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  process.stderr.write(
    `drive-mobile: ${error.message}; refused · a verifier never talks to the owner's server\n`,
  );
  process.exit(97);
}
const web = new URL(fronts);
const secure = web.protocol === "https:";
const webPort = Number(web.port || (secure ? 443 : 80));
// SNI takes a host name only; an IP address gets none (and is verified against the certificate's IPs).
const servername = net.isIP(web.hostname) === 0 ? web.hostname : undefined;

const out = openSync(log, "a");
const expo = spawn("pnpm", ["exec", "expo", "start", "--web", "--port", String(expoPort)], {
  cwd: app,
  stdio: ["ignore", out, out],
  env: { ...process.env, CI: "1", BROWSER: "none" },
});
const record = join(process.env.MEND_VERIFY_PRIVATE, MOBILE_RECORD);
const end = () => {
  rmSync(record, { force: true });
  expo.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGTERM", end);
process.on("SIGINT", end);

const upstreamFor = (url) =>
  url.startsWith("/api")
    ? { host: web.hostname, port: webPort, api: true, secure }
    : { host: "127.0.0.1", port: expoPort, api: false, secure: false };

/** The origin the browser reached this proxy by: its own two names, else 127.0.0.1. */
const proxyOrigin = (req) => {
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];
  return `http://${own.includes(req.headers.host ?? "") ? req.headers.host : own[0]}`;
};

const isPairing = (req) => req.method === "POST" && (req.url ?? "").split("?")[0] === "/api/pair";

const rewrite = (headers, api) => {
  const next = { ...headers };
  if (api) {
    if (next.origin) next.origin = web.origin;
    if (next.referer) next.referer = web.origin + "/";
    next.host = web.host;
  } else next.host = `127.0.0.1:${expoPort}`;
  return next;
};

/**
 * A successful pairing answer with the proxy's origin as the saved server URL. Anything that is not
 * a JSON object with a `url` goes through unchanged. The body holds the device's token: it is
 * parsed here and never printed.
 */
const repointPairing = (req, res, answer) => {
  const chunks = [];
  answer.on("data", (chunk) => chunks.push(chunk));
  answer.on("end", () => {
    const original = Buffer.concat(chunks);
    const headers = { ...answer.headers };
    let body = original;
    try {
      const parsed = JSON.parse(original.toString("utf8"));
      if (parsed !== null && typeof parsed === "object" && typeof parsed.url === "string") {
        const chosen = parsed.url;
        parsed.url = proxyOrigin(req);
        body = Buffer.from(JSON.stringify(parsed));
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
        process.stdout.write(
          `drive-mobile · pairing saved with ${parsed.url}, not ${chosen}: every call stays on the proxy\n`,
        );
      }
    } catch {
      process.stdout.write("drive-mobile: the pairing answer was not JSON; passed through as is\n");
    }
    res.writeHead(answer.statusCode ?? 502, headers);
    res.end(body);
  });
};

const server = http.createServer((req, res) => {
  const target = upstreamFor(req.url ?? "/");
  const pairing = target.api && isPairing(req);
  const headers = rewrite(req.headers, target.api);
  // The pairing answer is read and rewritten here, so it must come back uncompressed.
  if (pairing) headers["accept-encoding"] = "identity";
  const upstream = (target.secure ? https : http).request(
    {
      host: target.host,
      port: target.port,
      servername: target.secure ? servername : undefined,
      method: req.method,
      path: req.url,
      headers,
    },
    (answer) => {
      const status = answer.statusCode ?? 502;
      const location = answer.headers.location ?? "";
      if (
        target.api &&
        !target.secure &&
        status >= 300 &&
        status < 400 &&
        /^https:/i.test(location)
      )
        process.stdout.write(
          `drive-mobile: the stack redirects ${req.method} ${req.url?.split("?")[0]} to https; pass its https URL (--web https://${web.host}, or declare the outer by it)\n`,
        );
      const encoded = (answer.headers["content-encoding"] ?? "identity") !== "identity";
      if (pairing && status >= 200 && status < 300 && !encoded) {
        repointPairing(req, res, answer);
        return;
      }
      if (pairing && encoded)
        process.stdout.write(
          "drive-mobile: the pairing answer came back compressed; the app will save the server's URL, not the proxy's\n",
        );
      res.writeHead(status, answer.headers);
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
  const send = () => {
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
  };
  const upstream = target.secure
    ? tls.connect({ host: target.host, port: target.port, servername }, send)
    : net.connect(target.port, target.host, send);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, "127.0.0.1", () => {
  // Bound by this process: the one proxy drive-web.mjs may drive, while this process lives.
  writeFileSync(
    record,
    JSON.stringify({
      pid: process.pid,
      identity: identityOf(process.pid),
      port: String(port),
      web: fronts,
      bound: true,
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    `drive-mobile · app and stack on http://127.0.0.1:${port} · Expo on :${expoPort} · API to ${web.origin}\n`,
  );
});
