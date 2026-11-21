#!/usr/bin/env node
// The desktop app, built and launched as a person runs it, walks the full thin-shell lifecycle:
// Connect screen → unreachable server inline error → connect to a live HTTP server → verify
// `window.mendDesktop` is exposed and `window.mendShell` is withheld on the remote origin →
// Switch Server (Recent servers + Back) → server goes down → Offline screen → automatic reconnect
// once the server comes back. Uses an isolated `MEND_USER_DATA` and empty `XDG_CONFIG_HOME` so it
// never reads or writes this machine's profile or CLI config.
//
//   pnpm --filter @mend/desktop build && xvfb-run -a pnpm --filter @mend/desktop check:connection
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "mend-desktop-connection-"));

const createStubServer = () =>
  http.createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mend Stub</title></head><body><h1>Mend stub server</h1><p id="bridge-status"></p><script>const s = document.getElementById("bridge-status"); s.textContent = JSON.stringify({ hasDesktop: typeof window.mendDesktop === "object" && window.mendDesktop !== null, hasShell: typeof window.mendShell !== "undefined", serverUrl: window.mendDesktop ? window.mendDesktop.serverUrl : null });</script></body></html>`,
    );
  });

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

let server = createStubServer();
const port = await listen(server, 0);
const serverUrl = `http://127.0.0.1:${port}`;

let app;
try {
  const {
    MEND_URL: _url,
    MEND_TOKEN: _token,
    MEND_DESKTOP_SERVER_URL: _desktopUrl,
    MEND_DESKTOP_START_AT: _startAt,
    ELECTRON_RUN_AS_NODE: _runAsNode,
    WAYLAND_DISPLAY: _wayland,
    ELECTRON_OZONE_PLATFORM_HINT: _ozoneHint,
    ...inherited
  } = process.env;

  app = await electron.launch({
    args: [
      appRoot,
      "--no-sandbox",
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
    ],
    cwd: appRoot,
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      MEND_USER_DATA: join(home, "user-data"),
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });

  const window = await app.firstWindow();
  const uncaught = [];
  window.on("pageerror", (error) => uncaught.push(error.message));

  // 1. Fresh launch opens on the Sheet Connect screen.
  await window
    .getByRole("heading", { name: "Connect to a Mend server" })
    .waitFor({ timeout: 15_000 });
  console.log("PASS fresh launch shows Connect to a Mend server");

  // 2. Unreachable server shows an inline error without navigating away.
  const input = window.getByLabel("Server address");
  await input.fill("http://127.0.0.1:1");
  await window.getByRole("button", { name: "Connect" }).click();
  await window.getByText("Couldn't connect.", { exact: true }).waitFor({ timeout: 15_000 });
  console.log("PASS unreachable server shows inline error");

  // 3. Connecting to the live stub server loads it and exposes only `window.mendDesktop`.
  await input.fill(serverUrl);
  await window.getByRole("button", { name: "Connect" }).click();
  await window.getByRole("heading", { name: "Mend stub server" }).waitFor({ timeout: 15_000 });
  const bridgeStatus = JSON.parse(
    (await window.locator("#bridge-status").textContent({ timeout: 5_000 })) ?? "{}",
  );
  assert.deepEqual(bridgeStatus, {
    hasDesktop: true,
    hasShell: false,
    serverUrl,
  });
  console.log(`PASS connected to ${serverUrl} with origin-scoped window.mendDesktop only`);

  // 4. Switch server returns to Connect with Recent servers + Back button, and Back returns.
  await window.evaluate(() => window.mendDesktop.switchServer());
  await window
    .getByRole("heading", { name: "Connect to a Mend server" })
    .waitFor({ timeout: 15_000 });
  await window.getByRole("heading", { name: "Recent servers" }).waitFor({ timeout: 5_000 });
  await window.getByRole("button", { name: "Back" }).click();
  await window.getByRole("heading", { name: "Mend stub server" }).waitFor({ timeout: 15_000 });
  console.log("PASS Switch server shows Recent servers and Back returns to the server");

  // 5. Dropping the server triggers the Offline screen; bringing it back auto-reconnects.
  await closeServer(server);
  server = null;
  await window.reload().catch(() => undefined);
  await window.getByRole("heading", { name: "Can't reach Mend" }).waitFor({ timeout: 15_000 });
  console.log("PASS unreachable server shows Can't reach Mend offline screen");

  server = createStubServer();
  await listen(server, port);
  await window.getByRole("heading", { name: "Mend stub server" }).waitFor({ timeout: 20_000 });
  console.log("PASS desktop automatically reconnected once the server answered again");

  assert.deepEqual(uncaught, [], "the window threw no uncaught error");
} finally {
  await app?.close();
  if (server !== null) await closeServer(server);
  rmSync(home, { recursive: true, force: true });
}
