#!/usr/bin/env node
// The desktop app, built and launched as a person runs it, follows its connection as it changes
// outside the window: `mend logout` and `mend login` in a terminal rewrite the credential file the
// CLI and the desktop share, the main process sees it and tells the window, and the window's
// Settings shows the new state without a restart. The app runs with its own XDG_CONFIG_HOME, so
// it never reads this machine's credential. Nothing answers at the server URLs: what is checked is
// the connection the window shows, not anything it fetches.
//
//   pnpm --filter @mend/desktop build && xvfb-run -a pnpm --filter @mend/desktop check:connection
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "mend-desktop-connection-"));
const configDir = join(home, "config", "mend");
mkdirSync(configDir, { recursive: true });
const credential = join(configDir, "cli.json");

/** What `mend login` leaves behind, and what `mend logout` leaves: the URL without a token. */
const login = (url) =>
  writeFileSync(credential, JSON.stringify({ url, token: "mdt_desktopconnectioncheck" }), {
    mode: 0o600,
  });
const logout = (url) => writeFileSync(credential, JSON.stringify({ url }), { mode: 0o600 });

const FIRST = "http://127.0.0.1:9";
const SECOND = "http://127.0.0.2:9";

let app;
try {
  login(FIRST);
  const { MEND_URL: _url, MEND_TOKEN: _token, ...inherited } = process.env;
  app = await electron.launch({
    args: [appRoot, "--no-sandbox"],
    cwd: appRoot,
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  const window = await app.firstWindow();
  const uncaught = [];
  window.on("pageerror", (error) => uncaught.push(error.message));
  await window.evaluate(() => {
    window.location.hash = "#/settings";
  });

  /** The connection row as a person reads it: its state and where it points. */
  const shows = async (state, url) => {
    await window.getByText(state, { exact: true }).waitFor({ timeout: 15_000 });
    await window.getByText(url, { exact: false }).first().waitFor({ timeout: 15_000 });
  };

  await shows("Signed in", FIRST);
  console.log(`PASS the window shows the credential it started with: signed in to ${FIRST}`);

  logout(FIRST);
  await shows("Not signed in", FIRST);
  console.log("PASS `mend logout` in a terminal: the window says it is not signed in");

  login(SECOND);
  await shows("Signed in", SECOND);
  console.log(`PASS \`mend login\` to another server: the window shows ${SECOND}`);

  assert.deepEqual(uncaught, [], "the window threw no uncaught error");
} finally {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
}
