// Settings → Account → Devices and access keys in the web app (route PR 39, SLNT-1159):
//
//   pnpm verify drive web --recipe devices
//
// Feature ids: pairing-devices.md `pair-web`, `mint-by-hand`, `device-list`, `revoke`;
// t3-gateway.md's pairing code (the same code; a t3code client shows as a device);
// workspace-ssh.md `ssh-keys` on the web (`no-gateway` too); access keys (ADR 0023).
//
// - `/settings/access-keys` lands on `/settings/devices`, "Only you" under the title.
// - Pair a phone: Show a code makes a code that works once, with its QR and the address the phone
//   uses. A live code is a credential, so the picture is of a code answered in the browser; the
//   real one is checked by its shape only.
// - Make a token by hand: the token is shown once, then the device is in the list, and Revoke…
//   (which names the device) removes it.
// - Access keys: Create access key… with a name and an expiry, the key shown once, then in the
//   list by its name and id; Revoke… removes it. Nothing captures a key while it is shown.
// - Workspace SSH keys: the stack's platform has no SSH gateway (the alert), and nobody can add a
//   key in a drive (the verify guard removes SSH_AUTH_SOCK), so the list, Add SSH key… and
//   Remove… are drawn from a read answered in the browser.
// - Phone width, a page whose reads fail, and an SSH read that fails on its own.
//
// The recipe revokes every device and key it made, so it can run again.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
/** The tRPC calls a request carries, in its batch's order. */
const callsOf = (route) =>
  decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/trpc\//, "")).split(",");

export default async ({ page, web, capture, note, registerSecret }) => {
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const text = (value) => visible(page.getByText(value, { exact: false }));
  const settled = () => page.waitForTimeout(500);
  const path = () => new URL(page.url()).pathname;
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (to) => {
    await page.goto(`${web}${to}`);
    // A cold dev server can leave the first load unhydrated: load it once more.
    await hydrated().catch(async () => {
      note(`${to} didn't hydrate in 90s; loading it again`);
      await page.reload();
      await hydrated();
    });
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  /** One picture; on the desk, in a window tall enough to hold the whole page. */
  const shot = async (name, whole = false) => {
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    const size = page.viewportSize();
    const tall = whole && size !== null && size.width >= 1024;
    if (tall) await page.setViewportSize({ width: size.width, height: 1800 });
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
    if (tall) {
      await page.setViewportSize(size);
      await settled();
    }
  };
  const paint = (dark) =>
    page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);

  /** The signed-in account's API, from the page. */
  const api = (method, url, body) =>
    page.evaluate(
      async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
        const raw = await response.text();
        return { status: response.status, body: raw === "" ? null : JSON.parse(raw) };
      },
      { method, url, body },
    );
  /** Answers one tRPC call with what `change` makes of the server's answer, until unrouted. */
  const rewrite = (call, change) =>
    page.route("**/trpc/**", async (route) => {
      const at = callsOf(route).indexOf(call);
      if (at === -1) return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      const entry = Array.isArray(body) ? body[at] : body;
      entry.result.data.json = change(entry.result.data.json);
      await route.fulfill({ response, json: body });
    });
  /** Answers a tRPC mutation with `answer`, without reaching the server, until unrouted. */
  const answer = (call, json) =>
    page.route(`**/trpc/${call}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          new URL(route.request().url()).searchParams.has("batch")
            ? [{ result: { data: { json } } }]
            : { result: { data: { json } } },
        ),
      }),
    );
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  /** Fails every tRPC call named `call` (every call, with none), one error per call in a batch. */
  const fail = (call) =>
    page.route("**/trpc/**", (route) => {
      const calls = callsOf(route);
      if (call !== undefined && !calls.includes(call)) return route.fallback();
      const batch = new URL(route.request().url()).searchParams.has("batch");
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(batch ? calls.map(() => failure) : failure),
      });
    });
  const readAgain = (key) =>
    page.evaluate(
      (queryKey) =>
        window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({ queryKey }),
      key,
    );
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words, { exact: false })
      .first()
      .waitFor({ timeout: 10_000 });
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const closed = (name) =>
    page.getByRole("dialog", { name }).waitFor({ state: "detached", timeout: 30_000 });
  const list = (name) => page.getByRole("list", { name });
  const stamp = Date.now().toString(36);

  // --- The page, from the old address ---------------------------------------------------------
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  // From the account menu's Pair a phone…, and from Profile's line about this browser.
  await open("/");
  await visible(page.getByRole("button", { name: /, account$/ })).click();
  await visible(page.getByRole("menuitem", { name: /Pair a phone/ })).click();
  await page.waitForURL((url) => url.pathname === "/settings/devices");
  await heading("Devices and access keys");
  note("the account menu's Pair a phone… opened /settings/devices");
  await open("/settings/profile");
  await visible(
    page.getByRole("link", { name: "Devices and access keys", exact: true }).last(),
  ).click();
  await page.waitForURL((url) => url.pathname === "/settings/devices");
  await heading("Devices and access keys");
  note("Profile's 'Devices and access keys' link opened /settings/devices");
  await page.goto(`${web}/settings/access-keys`);
  await page.waitForURL((url) => url.pathname === "/settings/devices");
  await hydrated();
  await heading("Devices and access keys");
  await text("Only you").waitFor();
  const devices = await list("Signed-in devices").locator("li").allTextContents();
  note(
    `/settings/access-keys → ${path()}: 'Devices and access keys', 'Only you'; signed-in devices: ${devices.join(" | ")}`,
  );
  await shot("devices-desktop-light", true);
  await paint(true);
  await shot("devices-desktop-dark", true);
  await page.setViewportSize(PHONE);
  await text("To pair a phone, open Devices and access keys in Mend on your computer").waitFor();
  await shot("devices-phone-dark");
  await paint(false);
  await shot("devices-phone-light");
  await page.setViewportSize(DESKTOP);
  note("at 390px: no QR; the page says to pair from a computer");

  // --- pair-web: a real code, checked by its shape ----------------------------------------------
  await button("Show a code").click();
  const code = visible(page.locator("p.font-mono"));
  await code.waitFor();
  const shown = (await code.textContent())?.trim() ?? "";
  registerSecret("pairing-code", shown.replace("-", ""));
  registerSecret("pairing-code-grouped", shown);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(shown))
    throw new Error("the code isn't two groups of four");
  await page
    .getByRole("img", { name: /^QR code for / })
    .locator("img")
    .waitFor();
  await text("It works once and expires at").waitFor();
  await button("Make a new code").waitFor();
  note(
    "Show a code: a code of two groups of four, its QR drawn, 'It works once and expires at …, in N minutes. The phone reaches this server at …'",
  );
  // The picture: a code answered in the browser, not a live one.
  await open("/settings/devices");
  await answer("devices.createPairing", {
    code: "K7Q29MXA",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    urls: [],
  });
  await button("Show a code").click();
  await text("K7Q2-9MXA").waitFor();
  await page.getByRole("img", { name: "QR code for K7Q2-9MXA" }).locator("img").waitFor();
  note("fixture, a made-up code for the picture: 'K7Q2-9MXA' with its QR and Make a new code");
  await shot("pair-code-desktop-light");
  await page.unroute("**/trpc/devices.createPairing**");

  // --- mint-by-hand, then revoke ----------------------------------------------------------------
  await open("/settings/devices");
  await button("Make a token by hand").click();
  await dialog("Make a token by hand").waitFor();
  const deviceName = `verify-phone-${stamp}`;
  await page.getByLabel("Device name", { exact: true }).fill(deviceName);
  await shot("token-by-hand-desktop-light");
  await button("Make token").click();
  await dialog(`Copy the token for ${deviceName}`).waitFor();
  const token = (
    await dialog(`Copy the token for ${deviceName}`)
      .locator('[data-slot="copy-field-value"]')
      .last()
      .textContent()
  )?.trim();
  if (token === undefined || token === "") throw new Error("no token shown");
  registerSecret("device-token", token);
  note(
    `Make a token by hand, named '${deviceName}': 'Copy the token for ${deviceName}', the server address and the token each with Copy, shown once (not captured)`,
  );
  await button("Done").click();
  await closed(`Copy the token for ${deviceName}`);
  if ((await page.getByText(token).count()) > 0) throw new Error("the token is still on the page");
  await list("Signed-in devices").getByText(deviceName, { exact: true }).waitFor();
  note(`Done: the token left the page; '${deviceName}' is in the list as 'Token made by hand'`);
  await shot("device-listed-desktop-light", true);

  await page.getByRole("button", { name: `Revoke ${deviceName}` }).click();
  await dialog(`Revoke ${deviceName}?`).waitFor();
  await shot("revoke-device-desktop-light");
  await button("Revoke device").click();
  await closed(`Revoke ${deviceName}?`);
  await toastSays(`Revoked ${deviceName}.`);
  await list("Signed-in devices")
    .getByText(deviceName, { exact: true })
    .waitFor({ state: "detached" });
  note(`Revoke… names the device ('Revoke ${deviceName}?'); Revoke device: a toast, the row gone`);

  // --- access keys --------------------------------------------------------------------------------
  const before = (await api("GET", "/api/me/access-keys")).body ?? [];
  note(`the account had ${Array.isArray(before) ? before.length : "?"} access keys`);
  if (Array.isArray(before) && before.length === 0) {
    await text("No access keys yet").waitFor();
    await shot("no-access-keys-desktop-light", true);
    note("no access keys: 'No access keys yet' with Create access key…");
  }
  await visible(page.getByRole("button", { name: "Create access key…" })).click();
  await dialog("Create access key").waitFor();
  const keyName = `verify-ci-${stamp}`;
  await page.getByLabel("Name", { exact: true }).fill(keyName);
  await button("1 year").click();
  await text("This key expires on").waitFor();
  await shot("create-key-desktop-light");
  await page.setViewportSize(PHONE);
  await dialog("Create access key").waitFor();
  await shot("create-key-phone-light");
  await page.setViewportSize(DESKTOP);
  await settled();
  await button("Create key").click();
  await dialog("Copy your access key").waitFor();
  const secret = (
    await dialog("Copy your access key").locator('[data-slot="copy-field-value"]').textContent()
  )?.trim();
  if (secret === undefined || !secret.startsWith("mak_")) throw new Error("no access key shown");
  registerSecret("access-key", secret);
  await text(`This is the only time Mend shows the key for ${keyName}.`).waitFor();
  await text("It expires on").waitFor();
  note(
    `Create access key '${keyName}', 1 year: 'Copy your access key', the key (mak_…) with Copy key and when it expires, shown once (not captured)`,
  );
  await button("Done").click();
  await closed("Copy your access key");
  if ((await page.getByText(secret).count()) > 0) throw new Error("the key is still on the page");
  await list("Access keys").getByText(keyName, { exact: true }).waitFor();
  const keyRow = list("Access keys").locator("li").filter({ hasText: keyName });
  if ((await keyRow.getByText("mak_").count()) > 0)
    throw new Error("the row shows part of the key");
  await keyRow.getByText(/^Created /).waitFor();
  note(
    `Done: the key left the page; its row has its name, 'Created …', Not used yet, its expiry and Revoke…, and no part of the key`,
  );
  await shot("access-keys-desktop-light", true);

  await page.getByRole("button", { name: `Revoke ${keyName}` }).click();
  await dialog(`Revoke ${keyName}?`).waitFor();
  await shot("revoke-key-desktop-light");
  await button("Revoke key").click();
  await closed(`Revoke ${keyName}?`);
  await toastSays(`Revoked ${keyName}.`);
  await list("Access keys")
    .getByText(keyName, { exact: true })
    .waitFor({ state: "detached" })
    .catch(async () => {
      // The last key's list leaves with it.
      await text("No access keys yet").waitFor();
    });
  note(`Revoke… names the key ('Revoke ${keyName}?'); Revoke key: a toast, the row gone`);

  // --- workspace SSH keys -------------------------------------------------------------------------
  const ssh = (await api("GET", "/api/workspace-ssh")).body;
  note(
    `the stack's workspace SSH: gateway ${ssh?.gateway === null ? "none" : "present"}, ${ssh?.keys?.length ?? "?"} keys`,
  );
  if (ssh?.gateway === null) {
    await text("This server has no workspace SSH gateway.").waitFor();
    if ((await page.getByRole("button", { name: "Add SSH key…" }).count()) > 0)
      throw new Error("Add SSH key… is offered with no gateway");
    note("no gateway: the alert, and no Add SSH key…");
    await shot("no-ssh-gateway-desktop-light", true);
  }
  // A read answered in the browser: a gateway, and two keys.
  const keys = [
    {
      sshKeyId: "ssh_fixture_1",
      name: "ada-mbp",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:q3V0nB8xR4mTfa2YwPz9cLd1Ue6hJk0sVb7Xk",
      createdAt: "2026-03-02T10:00:00.000Z",
    },
    {
      sshKeyId: "ssh_fixture_2",
      name: "build-box",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:Lm9tY2Fz8Qe3rWn5JpX0dKv7Hu2Ts4Ga1h2aQ",
      createdAt: "2026-10-20T10:00:00.000Z",
    },
  ];
  await rewrite("platform.workspaceSsh", () => ({
    gateway: { host: "ssh.mend.example", port: 22, usernamePrefix: "ws" },
    keys,
  }));
  await readAgain([["platform", "workspaceSsh"]]);
  await list("Workspace SSH keys").getByText("build-box", { exact: true }).waitFor();
  note(
    "fixture, a gateway and two keys (made in the browser): each key by name with its algorithm and fingerprint, the day it was added, and Remove…",
  );
  await shot("ssh-keys-desktop-light", true);
  await button("Add SSH key…").click();
  await dialog("Add an SSH key").waitFor();
  await dialog("Add an SSH key").getByText("mend ssh setup", { exact: true }).waitFor();
  note("Add SSH key…: 'Add an SSH key' with 'mend ssh setup' to copy, and VS Code's command");
  await shot("add-ssh-key-desktop-light");
  await page.setViewportSize(PHONE);
  await dialog("Add an SSH key").waitFor();
  await shot("add-ssh-key-phone-light");
  await page.setViewportSize(DESKTOP);
  await settled();
  await button("Done").click();
  await closed("Add an SSH key");

  await page.getByRole("button", { name: "Remove build-box" }).click();
  await dialog("Remove build-box?").waitFor();
  await shot("remove-ssh-key-desktop-light");
  await answer("platform.removeWorkspaceSshKey", {
    ...keys[1],
    openConnections: "end",
    runningSessions: [],
  });
  await page.unroute("**/trpc/**");
  await rewrite("platform.workspaceSsh", () => ({
    gateway: { host: "ssh.mend.example", port: 22, usernamePrefix: "ws" },
    keys: [keys[0]],
  }));
  await button("Remove key").click();
  await closed("Remove build-box?");
  await text("Removed build-box.").waitFor();
  note(
    "Remove… names the key ('Remove build-box?') with its fingerprint; Remove key (answered in the browser): 'Removed build-box. Your workspaces refuse it from the next connection, and connections already open with it end within a minute.'",
  );
  await shot("ssh-key-removed-desktop-light", true);
  await page.unroute("**/trpc/platform.removeWorkspaceSshKey**");
  await page.unroute("**/trpc/**");
  // no-gateway: the keys a person registered stay listed, and nothing offers to add one.
  await rewrite("platform.workspaceSsh", () => ({ gateway: null, keys: [keys[0]] }));
  await readAgain([["platform", "workspaceSsh"]]);
  await text("This server has no workspace SSH gateway.").waitFor();
  if ((await page.getByRole("button", { name: "Add SSH key…" }).count()) > 0)
    throw new Error("Add SSH key… is offered with no gateway");
  note(
    "fixture, no gateway (made in the browser): 'This server has no workspace SSH gateway.' with the key still listed, and no Add SSH key…",
  );
  await shot("no-ssh-gateway-desktop-light", true);
  await page.unroute("**/trpc/**");

  // --- failures ----------------------------------------------------------------------------------
  await open("/settings/devices");
  await fail("platform.workspaceSsh");
  await readAgain([["platform", "workspaceSsh"]]);
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["platform", "workspaceSsh"]],
    }),
  );
  await text("Mend couldn't read your SSH keys.").waitFor();
  note(
    "the SSH keys read failed alone: 'Mend couldn't read your SSH keys.' with Try again; the rest of the page stands",
  );
  await shot("ssh-read-failed-desktop-light", true);
  await page.unroute("**/trpc/**");

  await fail();
  await page.evaluate(() => {
    const router = window["__TSR_ROUTER__"];
    router.options.context.queryClient.clear();
    return router.invalidate();
  });
  await heading("This page didn't load");
  note("every read failed: 'This page didn't load' with Try again");
  await shot("error-desktop-light");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Devices and access keys");
  note("Try again with the server back shows the page");
};
