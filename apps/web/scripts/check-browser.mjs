#!/usr/bin/env node
// Proves the built web app loads in a real browser: the production front (.output/front.mjs, which
// supervises the nitro server) serves the sign-in page, the first screen a person sees, and the
// client bundle renders it in headless Chromium with no uncaught error. No API runs behind it: the
// page must still render when the instance cannot be asked, and a request that fails for that is
// not an error of the page.
//
// Playwright comes from $MEND_VERIFY_PLAYWRIGHT, a directory whose package.json resolves
// playwright-core (CI: apps/mobile), as for the verify skill's drivers; the web app does not depend
// on it.
//
//   pnpm --filter @mend/web build
//   MEND_VERIFY_PLAYWRIGHT=$PWD/apps/mobile pnpm --filter @mend/web check:browser
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const front = spawn(process.execPath, [".output/front.mjs"], {
  cwd: webRoot,
  // An address nothing listens on: every API call fails fast.
  env: { ...process.env, PORT: String(port), MEND_API_URL: "http://127.0.0.1:9" },
  stdio: ["ignore", "inherit", "inherit"],
});
const exited = new Promise((resolve) => front.once("exit", resolve));

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
    throw new Error(`the sign-in page did not render (${thrown})`, { cause });
  }
  // The form is live, not a static shell: what a person types stays in it.
  await page.getByLabel("Email", { exact: true }).fill("carol@example.test");
  assert.equal(await page.getByLabel("Email", { exact: true }).inputValue(), "carol@example.test");
  assert.deepEqual(uncaught, [], "the page threw no uncaught error");
  console.log(`PASS the built web app rendered its sign-in page in Chromium ${browser.version()}`);
} finally {
  await browser?.close();
  front.kill("SIGTERM");
  await exited;
}
