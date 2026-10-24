#!/usr/bin/env node
// The verify skill's t3code client: a hosted web build of t3code served on a local origin, so
// drive-web.mjs drives a real t3code client that pairs with the run's T3 gateway as a remote
// environment.
//
//   node serve-t3-client.mjs --dist <t3code apps/web/dist> --port <local port> --gw <gateway url>
//
// It serves <dist> on 127.0.0.1:<port>, every path that names no file answering index.html (the
// client routes in the browser, so a reload of /<environment>/<thread> loads the app). Build the
// dist from the tag packages/t3-contracts/t3code.pin.json names, with
// VITE_HOSTED_APP_CHANNEL=latest: the hosted build adds environments by pairing, as app.t3.codes
// does (features/t3-gateway.md).
//
// The page talks only to the gateway the recipe pairs it with, so the check is on the gateway:
// <gw> is a loopback URL whose listening process (ss) was started with MEND_T3_GATEWAY_MEND_URL
// naming this run's tunnel (/proc/<pid>/environ; guard/policy.mjs). Anything else is refused
// (exit 97). Once it listens, it records itself in $MEND_VERIFY_PRIVATE/t3-client.json (its pid
// and start time, port, the Mend its gateway serves, the gateway, `bound: true`), which is what
// lets drive-web.mjs drive http://127.0.0.1:<port> and tells a recipe where to pair. It ends, and
// the record goes, on SIGTERM or once the gateway process is gone. It prints one line per request
// it could not answer, never a header or a body.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

import { Refused, T3_CLIENT_RECORD, allowedTargets, identityOf } from "./guard/policy.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const dist = flag("dist") && resolve(flag("dist"));
const port = Number(flag("port"));
const gw = flag("gw");
if (!dist || !port || !gw || !process.env.MEND_VERIFY_PRIVATE) {
  process.stderr.write(
    "usage: MEND_VERIFY_PRIVATE=<dir> serve-t3-client.mjs --dist <dir> --port <port> --gw <gateway url>\n",
  );
  process.exit(2);
}
if (!existsSync(join(dist, "index.html"))) {
  process.stderr.write(
    `serve-t3-client: ${dist} has no index.html; build t3code's apps/web first\n`,
  );
  process.exit(2);
}

/** The pid listening on a loopback TCP port, from `ss -ltnp`, or null. */
const listenerPid = (gwPort) => {
  const run = spawnSync("ss", ["-ltnpH", `sport = :${gwPort}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(run.stdout ?? "");
  return pid ? Number(pid[1]) : null;
};

let gateway;
let serves;
try {
  const url = new URL(gw);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol !== "http:")
    throw new Refused(`${gw} is not a gateway on this machine's loopback`);
  const pid = listenerPid(url.port || "80");
  if (pid === null) throw new Refused(`nothing of this user's listens on ${url.host}`);
  const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const mendUrl = environ
    .find((entry) => entry.startsWith("MEND_T3_GATEWAY_MEND_URL="))
    ?.slice("MEND_T3_GATEWAY_MEND_URL=".length);
  const [, ...tunnels] = allowedTargets(process.env);
  const target = mendUrl && new URL(mendUrl).origin;
  if (!target || !tunnels.includes(target))
    throw new Refused(
      `the gateway on ${url.host} serves ${target ?? "the default Mend"}, not this run's tunnel`,
    );
  gateway = { pid, identity: identityOf(pid) };
  serves = target;
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  process.stderr.write(
    `serve-t3-client: ${error.message}; refused · a verifier never talks to the owner's server\n`,
  );
  process.exit(97);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const fileFor = (pathname) => {
  const candidate = normalize(join(dist, decodeURIComponent(pathname)));
  if (!candidate.startsWith(dist)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return extname(pathname) === "" || pathname.endsWith(".html") ? join(dist, "index.html") : null;
};

const record = join(process.env.MEND_VERIFY_PRIVATE, T3_CLIENT_RECORD);
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://client").pathname;
  const file = req.method === "GET" || req.method === "HEAD" ? fileFor(pathname) : null;
  if (file === null) {
    process.stdout.write(`serve-t3-client: no file for ${req.method} ${pathname}\n`);
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
});

const end = () => {
  rmSync(record, { force: true });
  process.exit(0);
};
process.on("SIGTERM", end);
process.on("SIGINT", end);
setInterval(() => {
  if (identityOf(gateway.pid) !== gateway.identity) {
    process.stdout.write("serve-t3-client · the gateway is gone; ending\n");
    end();
  }
}, 2000).unref();

server.listen(port, "127.0.0.1", () => {
  writeFileSync(
    record,
    JSON.stringify({
      pid: process.pid,
      identity: identityOf(process.pid),
      port: String(port),
      web: serves,
      gateway: new URL(gw).origin,
      bound: true,
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    `serve-t3-client · t3code on http://127.0.0.1:${port} · gateway ${gw} (pid ${gateway.pid}) serves ${serves}\n`,
  );
});
