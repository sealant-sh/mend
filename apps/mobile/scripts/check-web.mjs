#!/usr/bin/env node
// Proves the web build loads: the static export (what a static host serves)
// and the dev server (`expo start --web`, what verification runs drive). Each
// route is opened in headless Chromium and any page error fails the check.
// Both are needed: the dev server compiles the browser bundle differently from
// the export (see babel.config.js for the case that broke every Schema.Class
// there and nowhere else), and a bundle that builds can still throw on load.
//
//   node scripts/check-web.mjs        (from apps/mobile)

import { spawn } from "node:child_process";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

import { chromium } from "playwright-core";

const ROUTES = ["/", "/pair", "/projects", "/settings"];
const EXPORT_DIR = "dist";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

const run = (args) =>
  new Promise((done, fail) => {
    const child = spawn("pnpm", ["exec", "expo", ...args], {
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    });
    child.on("exit", (code) => {
      if (code === 0) done();
      else fail(new Error(`expo ${args[0]} exited ${code}`));
    });
  });

const listen = (server) =>
  new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      ready(typeof address === "object" && address ? address.port : 0);
    });
  });

const freePort = async () => {
  const probe = createServer();
  const port = await listen(probe);
  probe.close();
  return port;
};

// The export is one HTML file per route (`/pair` is pair.html) beside the
// bundles, the way a static host serves it.
const serveExport = async () => {
  const resolve = (pathname) => {
    const path = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
      const file = join(EXPORT_DIR, candidate);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
    return undefined;
  };
  const server = createServer((request, response) => {
    const file = resolve(new URL(request.url ?? "/", "http://export").pathname);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
};

// Metro answers once it listens; the first page request bundles, so the
// route checks below give it room.
const startDevServer = async () => {
  const port = await freePort();
  const child = spawn("pnpm", ["exec", "expo", "start", "--web", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CI: "1" },
    detached: true,
  });
  const stop = () => {
    if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`expo start exited ${child.exitCode}`);
    if (Date.now() > deadline) {
      stop();
      throw new Error("expo start did not listen in 120 s");
    }
    const up = await fetch(`${origin}/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { origin, stop };
    await new Promise((later) => setTimeout(later, 1_000));
  }
};

const checkRoutes = async (browser, label, origin) => {
  const failures = [];
  for (const route of ROUTES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    const response = await page.goto(origin + route, { timeout: 300_000 });
    if (response?.status() !== 200) errors.push(`HTTP ${response?.status()}`);
    // The app has rendered once the root holds text; a throw during module
    // load or the first render leaves it empty and raises a page error.
    await page
      .waitForFunction(
        () => (document.getElementById("root")?.innerText.trim() ?? "") !== "",
        null,
        {
          timeout: 60_000,
        },
      )
      .catch(() => errors.push("nothing rendered in 60 s"));
    // Let effects that run after the first paint raise theirs too.
    await page.waitForTimeout(1_000);
    if (errors.length > 0) failures.push(`${label} ${route}\n  ${errors.join("\n  ")}`);
    else console.log(`✓ ${label} ${route}`);
    await page.close();
  }
  return failures;
};

rmSync(EXPORT_DIR, { recursive: true, force: true });
await run(["export", "--platform", "web", "--output-dir", EXPORT_DIR]);

const browser = await chromium.launch();
const failures = [];
try {
  const exported = await serveExport();
  try {
    failures.push(...(await checkRoutes(browser, "export", exported.origin)));
  } finally {
    exported.stop();
  }
  const dev = await startDevServer();
  try {
    failures.push(...(await checkRoutes(browser, "dev server", dev.origin)));
  } finally {
    dev.stop();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`✗ the web build throws in the browser:\n${failures.join("\n")}`);
  process.exit(1);
}
