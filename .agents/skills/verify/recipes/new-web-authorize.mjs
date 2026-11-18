// The new web app's authorize page (apps/web `/authorize`, SLNT-1104), driven by the sign-in
// feature's ids (features/sign-in.md) and VS Code's `vscode-connect` (features/vscode.md):
//
//   pnpm verify drive new-web --recipe new-web-authorize --account
//
// - `cli-login`: a real `mend login`, from this checkout's CLI through the guard, against the
//   stack's tunnel, with a CLI config of the run's own (never this machine's). The recipe approves
//   its code on the new page and the CLI says it signed in; `mend status` then answers with that
//   token. A second `mend login` is denied, and the CLI says so.
// - `authorize-page`: the code, Approve and Deny, the account approving, Approving… while the
//   request runs and a failure on the button row; a missing, unknown and spent code; a server that
//   doesn't answer, with Try again; signed out, the sign-in form and back to the same request;
//   "Not you? Sign out" signs out and offers sign-in for the same request.
// - `vscode-connect`, `desktop-connect`: a request opened with VS Code's and the desktop's `client`
//   reads "Authorize VS Code?" and "Authorize the Mend app?".
//
// Every state is captured light and dark, at 1280px and 390px. The driver withholds the picture of
// any page that shows a live code (drive-web.mjs), so the request's own states are proven by their
// ARIA snapshots; the last pass answers the lookup with a fixture whose code no server makes (a U is
// outside the code alphabet), for pictures of those states beside their frames.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// In the shape of a code (4 + 4 from the pairing alphabet), but one the server never made.
const UNKNOWN_CODE = "ZZZZ-ZZZZ";

/** The stack this drive runs beside: the CLI dials its tunnel, the only server the guard allows. */
const stackWeb = () =>
  JSON.parse(readFileSync(resolve(".verify/stack/current.json"), "utf8")).web.replace(/\/$/, "");

// The CLI's colours: ESC, then a select-graphic-rendition sequence.
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text) => text.replace(COLOUR, "");

export default async ({ page, web, capture, note, registerSecret, account }) => {
  if (account === null)
    throw new Error("this recipe signs in on the new page: run it with --account");
  const tunnel = stackWeb();
  const privateDir = process.env.MEND_VERIFY_PRIVATE;
  if (!privateDir) throw new Error("no MEND_VERIFY_PRIVATE: run it with pnpm verify drive");
  // The CLI's own config home: `mend login --url <tunnel>` writes mend/cli.json here, and nowhere else.
  const cliHome = mkdtempSync(join(privateDir, "authorize-cli-"));
  mkdirSync(join(cliHome, "mend"));

  /** Runs `mend …` through the guard (first on PATH) with the run's own CLI config. */
  const mend = (args) => {
    const child = spawn("mend", args, {
      env: { ...process.env, XDG_CONFIG_HOME: cliHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    const exited = new Promise((done) => child.on("close", (code) => done(code)));
    return { output: () => plain(out), exited };
  };

  /** Starts `mend login` and waits for the code it prints. */
  const login = async () => {
    const run = mend(["login", "--url", tunnel, "--no-open"]);
    for (let waited = 0; waited < 60_000; waited += 250) {
      const code = /code\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(run.output())?.[1];
      if (code !== undefined) {
        // A live code: redacted from every note and snapshot from here on.
        registerSecret("cli-login-code", code);
        return { ...run, code };
      }
      if ((await Promise.race([run.exited, page.waitForTimeout(250)])) !== undefined)
        throw new Error(`mend login ended before it printed a code:\n${run.output()}`);
    }
    throw new Error(`mend login printed no code within a minute:\n${run.output()}`);
  };

  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const settled = () => page.waitForTimeout(500);
  const open = async (to) => {
    await page.goto("about:blank");
    await page.goto(`${web}${to}`);
  };
  const button = (name) => page.getByRole("button", { name, exact: true });

  const touchTargets = async () => {
    for (const control of await page.locator("main button, main a[href]").all()) {
      if (!(await control.isVisible())) continue;
      const name = (await control.textContent())?.trim() ?? "";
      if (name === "") continue;
      let height = 0;
      for (let tries = 0; tries < 20 && height < 44; tries += 1) {
        if (tries > 0) await page.waitForTimeout(100);
        height = (await control.boundingBox())?.height ?? 0;
      }
      if (height < 44) throw new Error(`${name} is ${height}px tall on a phone, under 44px`);
    }
  };

  /** The page as it is now, light and dark, desktop and phone, without reloading it. */
  const captureAll = async (name) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (on) => document.documentElement.classList.toggle("dark", on),
          theme === "dark",
        );
        await settled();
        if (viewport === "phone") await touchTargets();
        await capture(`${name}-${viewport}-${theme}`);
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(DESKTOP);
    await settled();
  };

  const emptyPasswords = async () => {
    for (const field of await page.locator('input[type="password"]').all()) await field.fill("");
  };
  // Better Auth lets one address sign in 3 times in 10 seconds.
  const outOfTheLimit = () => page.waitForTimeout(11_000);

  // authorize-page: a link with no code, and a code the server never made.
  await open("/authorize");
  await heading("Authorize a terminal or an app");
  await page.getByText("This code can't be used.").waitFor();
  note("/authorize with no code: 'This code can't be used.' and how to start again");
  await captureAll("authorize-no-code");
  await open(`/authorize?code=${UNKNOWN_CODE}`);
  await page.getByText("This code can't be used.").waitFor();
  note(`/authorize?code=${UNKNOWN_CODE} (never made): 'This code can't be used.'`);

  // cli-login: a real `mend login`, approved on the new page.
  const first = await login();
  note(`mend login --url <stack tunnel> --no-open printed the code ${first.code} and waits`);
  await open(`/authorize?code=${first.code}`);
  await heading("Authorize this terminal?");
  await page.getByText(first.code, { exact: true }).waitFor();
  await page.getByText(account.email).waitFor();
  await button("Not you? Sign out").waitFor();
  note(
    `the page shows ${first.code}, 'Mend CLI on <host>' as asking, and approving as ${account.email} with 'Not you? Sign out'`,
  );
  await captureAll("authorize");

  // Approving…, held; then a request that never reached the server.
  let release = () => {};
  const held = new Promise((done) => {
    release = done;
  });
  await page.route("**/trpc/devices.approveCliAuth**", async (route) => {
    await held;
    await route.abort("connectionrefused");
  });
  await button("Approve").click();
  await button("Approving…").waitFor();
  if (!(await button("Deny").isDisabled())) throw new Error("Deny can be pressed while approving");
  note("while the approval runs, Approve reads 'Approving…' and both buttons are disabled");
  await captureAll("authorize-approving");
  release();
  await page
    .getByText("Mend's server didn't answer, so nothing was approved. Try again.")
    .waitFor();
  note("an approval that never reached the server: one sentence on the button row");
  await captureAll("authorize-approve-failed");
  await page.unroute("**/trpc/devices.approveCliAuth**");

  await button("Approve").click();
  await heading("Terminal authorized");
  await page.getByText("You can go back to your terminal.").waitFor();
  await captureAll("authorize-approved");
  const firstExit = await first.exited;
  const signedIn = first
    .output()
    .split("\n")
    .find((line) => line.includes("signed in as"));
  if (firstExit !== 0 || signedIn === undefined)
    throw new Error(`mend login did not sign in (exit ${firstExit}):\n${first.output()}`);
  note(`Approve: 'Terminal authorized'; mend login exited 0: '${signedIn.trim()}'`);
  const status = mend(["status"]);
  const statusExit = await status.exited;
  if (statusExit !== 0)
    throw new Error(`mend status with the new token failed (${statusExit}):\n${status.output()}`);
  note(`mend status with the token mend login saved exited 0 (${status.output().split("\n")[0]})`);

  // The same code again: spent.
  await open(`/authorize?code=${first.code}`);
  await page.getByText("This code can't be used.").waitFor();
  note(`the approved code ${first.code} again: 'This code can't be used.'`);
  await captureAll("authorize-code-cant-be-used");

  // A second `mend login`, denied.
  const second = await login();
  await open(`/authorize?code=${second.code}`);
  await heading("Authorize this terminal?");
  await button("Deny").click();
  await heading("Terminal denied");
  await page.getByText("Nothing was allowed.", { exact: false }).waitFor();
  await captureAll("authorize-denied");
  const secondExit = await second.exited;
  if (secondExit === 0) throw new Error(`a denied mend login exited 0:\n${second.output()}`);
  const deniedLine = second
    .output()
    .split("\n")
    .find((line) => line.includes("denied"));
  note(`Deny: 'Terminal denied'; mend login exited ${secondExit}: '${deniedLine?.trim()}'`);

  // A server that doesn't answer the lookup, then Try again.
  const third = await login();
  await page.route("**/trpc/devices.cliAuthRequest**", (route) => route.abort("connectionrefused"));
  await open(`/authorize?code=${third.code}`);
  await page.getByText("Mend's server didn't answer.").waitFor();
  await button("Try again").waitFor();
  note("a lookup that never reached the server: 'Mend's server didn't answer.' and Try again");
  await captureAll("authorize-server-unreachable");
  await page.unroute("**/trpc/devices.cliAuthRequest**");
  await button("Try again").click();
  await heading("Authorize this terminal?");
  note("Try again with the server back shows the request");

  // Not you? Sign out: signed out, the same request offers sign-in.
  await button("Not you? Sign out").click();
  await heading("Sign in");
  if (!page.url().includes(`/authorize?code=${third.code}`))
    throw new Error(`signing out left the request: ${page.url()}`);
  await page.getByText("After you sign in, you can see what is asking").waitFor();
  note("'Not you? Sign out' signed out and the same /authorize?code= shows the sign-in form");
  await captureAll("authorize-sign-in-first");

  // Signing in comes back to the same request.
  await outOfTheLimit();
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await account.typePassword(page.getByLabel("Password", { exact: true }));
  await button("Sign in").click();
  await heading("Authorize this terminal?");
  await page.getByText(third.code, { exact: true }).waitFor();
  await emptyPasswords();
  note(`signed in on the page: back at the same request, ${third.code}`);
  await button("Approve").click();
  await heading("Terminal authorized");
  const thirdExit = await third.exited;
  if (thirdExit !== 0) throw new Error(`mend login did not sign in:\n${third.output()}`);
  note("approved after signing in; mend login exited 0");

  // vscode-connect and desktop-connect: their requests, opened the way each client opens one.
  for (const [client, name, title] of [
    ["vscode", "VS Code on verify-stack", "Authorize VS Code?"],
    ["desktop", "verify-stack · desktop", "Authorize the Mend app?"],
  ]) {
    const opened = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/cli/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
      { name, client },
    );
    if (opened.status !== 200) throw new Error(`POST /api/cli/auth answered ${opened.status}`);
    registerSecret(`${client}-device-code`, opened.body.deviceCode);
    await open(opened.body.verifyPath);
    await heading(title);
    await page.getByText(name, { exact: true }).waitFor();
    note(`a request with client '${client}' reads '${title}', asking '${name}'`);
    await capture(`authorize-${client}-desktop-light`);
    await button("Deny").click();
    await heading(client === "vscode" ? "VS Code denied" : "Mend app denied");
    await capture(`authorize-${client}-denied-desktop-light`);
  }

  // Pictures of the request, Approving… and a failed approval, with the lookup answered by a fixture.
  const now = Date.now();
  const fixture = {
    code: "K7QF-2MXU",
    name: "ada-laptop",
    client: "cli",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 570_000).toISOString(),
    expiresIn: 570,
  };
  await page.route("**/trpc/devices.cliAuthRequest**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ result: { data: { json: fixture } } }]),
    }),
  );
  await open("/authorize?code=fixture");
  await heading("Authorize this terminal?");
  await page.getByText("K7QF-2MXU", { exact: true }).waitFor();
  note("the fixture request (lookup answered in the browser), for its pictures");
  await captureAll("authorize-fixture");
  let releaseFixture = () => {};
  const heldFixture = new Promise((done) => {
    releaseFixture = done;
  });
  await page.route("**/trpc/devices.approveCliAuth**", async (route) => {
    await heldFixture;
    await route.abort("connectionrefused");
  });
  await button("Approve").click();
  await button("Approving…").waitFor();
  await captureAll("authorize-fixture-approving");
  releaseFixture();
  await page
    .getByText("Mend's server didn't answer, so nothing was approved. Try again.")
    .waitFor();
  await captureAll("authorize-fixture-approve-failed");
  await page.unroute("**/trpc/devices.approveCliAuth**");
  await page.unroute("**/trpc/devices.cliAuthRequest**");
};
