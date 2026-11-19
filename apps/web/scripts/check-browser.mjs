#!/usr/bin/env node
// Proves the built web app loads in a real browser: the production front (.output/front.mjs, which
// supervises the nitro server) serves the sign-in page, the first screen a person sees, and the
// client bundle renders it in headless Chromium with no uncaught error.
//
// The sign-in page asks the server whether it has an account before it draws a form, and says the
// server is not answering when it can't ask (routes/login.tsx). So a small fake API stands behind
// the front and answers that one question ("some accounts, registration closed"); the page must
// then draw a live sign-in form. Once the fake is closed, the same page must say the server is not
// answering instead of drawing a form that can't sign anyone in.
//
// Playwright comes from $MEND_VERIFY_PLAYWRIGHT, a directory whose package.json resolves
// playwright-core (CI: apps/mobile), as for the verify skill's drivers; the web app does not depend
// on it.
//
//   pnpm --filter @mend/web build
//   MEND_VERIFY_PLAYWRIGHT=$PWD/apps/mobile pnpm --filter @mend/web check:browser
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const playwrightHome = process.env.MEND_VERIFY_PLAYWRIGHT;
assert.ok(
  playwrightHome,
  "set MEND_VERIFY_PLAYWRIGHT to a directory that resolves playwright-core",
);
const { chromium } = createRequire(join(playwrightHome, "package.json"))("playwright-core");

const webRoot = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no TCP port was bound"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

// The fake API: the instance question the sign-in page asks, and health. Anything else is a 404
// the check reports, so a page that starts asking more says so here rather than passing by luck.
const asked = [];
const unanswered = [];
const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const api = createHttpServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://api").pathname;
  asked.push(`${request.method} ${path}`);
  if (request.method === "GET" && path === "/api/instance") {
    json(response, 200, { users: "some", registration: "closed" });
    return;
  }
  if (request.method === "GET" && path === "/api/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  unanswered.push(`${request.method} ${path}`);
  json(response, 404, { _tag: "NotFound", message: "not served by the browser check's fake API" });
});
const apiPort = await freePort();
await new Promise((resolve) => api.listen(apiPort, "127.0.0.1", resolve));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const front = spawn(process.execPath, [".output/front.mjs"], {
  cwd: webRoot,
  env: {
    ...process.env,
    PORT: String(port),
    MEND_API_URL: `http://127.0.0.1:${apiPort}`,
    // The tRPC route refuses a browser whose Origin is not the app's own.
    APP_URL: base,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const exited = new Promise((resolve) => front.once("exit", resolve));

const closeApi = () =>
  new Promise((resolve) => {
    api.closeAllConnections();
    api.close(() => resolve(undefined));
  });

let browser;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answered = await fetch(`${base}/login`).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) break;
    assert.ok(front.exitCode === null, `the front exited ${front.exitCode} before it served`);
    assert.ok(Date.now() < deadline, "the front did not serve /login within 30 s");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  browser = await chromium.launch();
  const page = await browser.newPage();
  const uncaught = [];
  page.on("pageerror", (error) => uncaught.push(error.message));

  const response = await page.goto(`${base}/login`);
  assert.equal(response?.status(), 200, "the sign-in page is served");
  try {
    await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 15_000 });
    for (const label of ["Email", "Password"]) {
      await page.getByLabel(label, { exact: true }).waitFor({ timeout: 5_000 });
    }
  } catch (cause) {
    const thrown = uncaught.length === 0 ? "no uncaught error" : uncaught.join("; ");
    const shown = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `the sign-in page did not render (${thrown}; the API was asked ${asked.join(", ") || "nothing"}; the page shows "${shown}")`,
      { cause },
    );
  }
  // The form is live, not a static shell: what a person types stays in it.
  await page.getByLabel("Email", { exact: true }).fill("carol@example.test");
  assert.equal(await page.getByLabel("Email", { exact: true }).inputValue(), "carol@example.test");
  assert.ok(asked.includes("GET /api/instance"), "the sign-in page asked the API for the instance");
  assert.deepEqual(unanswered, [], "the sign-in page asked the API only what the fake answers");

  // With no server answering, the page says so and draws no form (cut-over audit, question 1).
  await closeApi();
  await page.reload();
  await page.getByText("The Mend server is not answering.").first().waitFor({ timeout: 15_000 });
  assert.equal(
    await page.getByLabel("Password", { exact: true }).count(),
    0,
    "no sign-in form is drawn while the server is not answering",
  );

  assert.deepEqual(uncaught, [], "the page threw no uncaught error");
  console.log(
    `PASS the built web app rendered its sign-in page in Chromium ${browser.version()}, and said the server was not answering once it stopped`,
  );
} finally {
  await browser?.close();
  front.kill("SIGTERM");
  await exited;
  if (api.listening) await closeApi();
}
