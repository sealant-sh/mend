import { spawn } from "node:child_process";
// The Authorize page's "Approving as" row (apps/web `/authorize`, SLNT-1193), for the sign-in
// feature's `authorize-page` id (features/sign-in.md):
//
//   pnpm verify drive new-web --recipe new-web-authorize-account
//
// The owner saw "a dot before the email" on the page `mend login` opens. This recipe opens that
// page for a real `mend login` (proved by its ARIA snapshot: the driver withholds pictures of a
// live code), then for a fixture request with the signed-in account answered as three accounts: a
// short name and email, a long name and a long email, and an account with no name. Each is
// captured at 1280px and 390px. The row must read the name, the email under it, and "Not you?
// Sign out", with no "·" anywhere in it. Then the authorized, denied and sign-in-first states.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const ACCOUNTS = [
  { label: "short", name: "Ada", email: "ada@example.com" },
  {
    label: "long",
    name: "Augusta Ada King, Countess of Lovelace",
    email: "augusta.ada.king-noel.countess.of.lovelace@analytical-engine.example.org",
  },
  { label: "no-name", name: "", email: "linus.pauling@example.com" },
];

const stackWeb = () =>
  JSON.parse(readFileSync(resolve(".verify/stack/current.json"), "utf8")).web.replace(/\/$/, "");
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (text) => text.replace(COLOUR, "");

export default async ({ page, web, capture, note, registerSecret }) => {
  const tunnel = stackWeb();
  const privateDir = process.env.MEND_VERIFY_PRIVATE;
  if (!privateDir) throw new Error("no MEND_VERIFY_PRIVATE: run it with pnpm verify drive");
  const cliHome = mkdtempSync(join(privateDir, "authorize-account-cli-"));
  mkdirSync(join(cliHome, "mend"));

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

  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const settled = () => page.waitForTimeout(500);
  const open = async (to) => {
    await page.goto("about:blank");
    await page.goto(`${web}${to}`);
  };
  /** The "Approving as" row's text, as a person reads it. */
  const accountRow = () =>
    page.locator("dt", { hasText: "Approving as" }).locator("xpath=..").innerText();
  const noDot = async (what) => {
    const row = await accountRow();
    if (row.includes("·")) throw new Error(`${what}: the row has a dot: ${JSON.stringify(row)}`);
    return row.replace(/\s+/g, " ").trim();
  };
  const desktopAndPhone = async (name, check) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      await settled();
      const row = check === undefined ? null : await check(viewport);
      await capture(`${name}-${viewport}-light`);
      if (row !== null) note(`${name} at ${viewport}: the row reads '${row}'`);
    }
    await page.setViewportSize(DESKTOP);
  };

  // A real `mend login`: its page, then Deny so the code is spent.
  const run = mend(["login", "--url", tunnel, "--no-open"]);
  let code;
  for (let waited = 0; waited < 60_000 && code === undefined; waited += 250) {
    code = /code\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(run.output())?.[1];
    if (code === undefined) await page.waitForTimeout(250);
  }
  if (code === undefined) throw new Error(`mend login printed no code:\n${run.output()}`);
  registerSecret("cli-login-code", code);
  await open(`/authorize?code=${code}`);
  await heading("Authorize this terminal?");
  for (const [viewport, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    await page.setViewportSize(size);
    await settled();
    note(`a real mend login's page at ${viewport}: the row reads '${await noDot(viewport)}'`);
  }
  await page.setViewportSize(DESKTOP);
  await button("Deny").click();
  await heading("Terminal denied");
  await run.exited;
  note("denied the real request; mend login ended");

  // A fixture request, with the session answered as each account.
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
  for (const who of ACCOUNTS) {
    await page.route("**/api/auth/get-session**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body?.user) body.user = { ...body.user, name: who.name, email: who.email };
      await route.fulfill({ response, json: body });
    });
    await open("/authorize?code=fixture");
    await heading("Authorize this terminal?");
    await page.locator("dd", { hasText: who.email }).waitFor();
    await desktopAndPhone(`authorize-account-${who.label}`, (viewport) =>
      noDot(`${who.label} at ${viewport}`),
    );
    if (who.label === "long") {
      await page.route("**/trpc/devices.approveCliAuth**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ result: { data: { json: { ok: true } } } }]),
        }),
      );
      await button("Approve").click();
      await heading("Terminal authorized");
      await desktopAndPhone("authorize-account-long-approved");
      note(`authorized: '${(await page.locator("main").innerText()).replace(/\s+/g, " ")}'`);
      await page.unroute("**/trpc/devices.approveCliAuth**");
    }
    if (who.label === "no-name") {
      await page.route("**/trpc/devices.approveCliAuth**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ result: { data: { json: { ok: true } } } }]),
        }),
      );
      await button("Approve").click();
      await heading("Terminal authorized");
      const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      if (!text.includes(`signed in as ${who.email}`))
        throw new Error(`an account with no name: '${text}'`);
      note(`authorized with no name: '${text}'`);
      await desktopAndPhone("authorize-account-no-name-approved");
      await page.unroute("**/trpc/devices.approveCliAuth**");
    }
    if (who.label === "short") {
      await page.route("**/trpc/devices.denyCliAuth**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ result: { data: { json: { ok: true } } } }]),
        }),
      );
      await button("Deny").click();
      await heading("Terminal denied");
      await desktopAndPhone("authorize-account-short-denied");
      await page.unroute("**/trpc/devices.denyCliAuth**");
    }
    await page.unroute("**/api/auth/get-session**");
  }

  // Signed out: sign in first.
  const cookies = await page.context().cookies();
  await page.context().clearCookies();
  await open("/authorize?code=fixture");
  await heading("Sign in");
  await desktopAndPhone("authorize-account-sign-in-first");
  note("signed out: 'Sign in', then the same request");
  await page.context().addCookies(cookies);
  await page.unroute("**/trpc/devices.cliAuthRequest**");
};
