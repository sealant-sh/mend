// Settings → the organization → Boat in the web app (route PR 48, SLNT-1164): the
// organization's Boat key. Connect, check, full check, wallet, replace and remove; a member reads
// only whether there is one. The personal Boat key is gone (docs/adr/0025).
//
//   pnpm verify drive web --recipe settings-boat
//
// A stack has no Boat account. What it does for real: the page as the stack has it (no key), a key
// refused for its shape by the server, and the verify skill's fake Boat key sent to the server and
// refused (typed with typeSecret; the field empties the moment it is sent, so it is empty in every
// picture). Everything about a connected key comes from recorded answers (tRPC answers the recipe
// writes): a key that expires in nine days, a check, a wallet change, a full check, a refused and an
// accepted replacement, a refused and an accepted removal, and a member's view. The page never
// shows any part of the key: the recipe checks the page's text for it.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const DAY = 86_400_000;

const visible = (locator) => locator.filter({ visible: true }).first();

/** Boat's report of a personal key whose account can bill two wallets, expiring in nine days. */
const report = (now, observedAt) => ({
  observedAt,
  organization: null,
  identity: {
    observed: true,
    accountId: "acct_north",
    login: "northwind-ci",
    displayName: "Northwind CI",
    serviceAccount: true,
    accountStatus: "active",
  },
  keyKind: { observed: true, kind: "personal" },
  wallet: {
    observed: true,
    kind: "organization",
    organizationId: "org_north",
    organizationName: "northwind-team",
    role: "admin",
  },
  wallets: {
    observed: true,
    choices: [
      { id: "personal", kind: "personal", name: null, role: null, active: false },
      {
        id: "org_north",
        kind: "organization",
        name: "northwind-team",
        role: "admin",
        active: true,
      },
    ],
  },
  billing: { mode: "pinned", organization: "org_north" },
  requiredPermissions: [],
  permissions: { observed: true, held: ["*"], missing: [], limitedToSandboxes: false },
  expiry: {
    observed: true,
    expiresAt: new Date(now + 9 * DAY).toISOString(),
    expired: false,
    expiringSoon: true,
  },
  start: {
    observed: true,
    canStart: true,
    blockedReason: null,
    billingStatus: "active",
    runningVms: 1,
    allowedVms: 5,
  },
  snapshots: { observed: true, used: 3, included: 10 },
});

const passed = (step) => ({ step, outcome: "passed", boat: null });

/** A recorded `boatKey.status` with a key, as an owner reads it. */
const connected = (now, { replaced = false, running = false } = {}) => {
  const finishedAt = new Date(now - 3 * 3_600_000).toISOString();
  const observedAt = new Date(now - 2 * 3_600_000).toISOString();
  return {
    json: {
      connected: true,
      sessionRuntime: "boat",
      peopleWithOwnKeys: [],
      details: {
        sealantBoatAccountId: "boat-account-1",
        connectedByUserId: "grace",
        connectedByName: "Grace Hopper",
        connectedAt: "2026-09-02T09:00:00.000Z",
        keyReplacedAt: replaced ? new Date(now).toISOString() : null,
        report: report(now, observedAt),
        fullCheck: {
          runningSince: running ? new Date(now).toISOString() : null,
          last: {
            proofId: "proof-1",
            startedAt: new Date(now - 3 * 3_600_000 - 64_000).toISOString(),
            finishedAt,
            outcome: "passed",
            steps: [
              "start-vm",
              "run-command",
              "publish-port",
              "save-snapshot",
              "delete-snapshot",
              "delete-vm",
            ].map(passed),
            starts: 1,
            leftBehind: { vm: null, snapshot: null, removalConfirmed: true },
          },
        },
        unreachable: null,
      },
    },
    meta: {
      values: {
        "details.connectedAt": ["Date"],
        ...(replaced ? { "details.keyReplacedAt": ["Date"] } : {}),
        "details.report.observedAt": ["Date"],
        "details.report.expiry.expiresAt": ["Date"],
        ...(running ? { "details.fullCheck.runningSince": ["Date"] } : {}),
        "details.fullCheck.last.startedAt": ["Date"],
        "details.fullCheck.last.finishedAt": ["Date"],
      },
    },
  };
};

const NOT_CONNECTED = {
  json: { connected: false, sessionRuntime: "boat", details: null, peopleWithOwnKeys: [] },
};

export default async ({ page, web, capture, note, typeSecret }) => {
  const now = Date.now();
  const settled = () => page.waitForTimeout(500);
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
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
    await hydrated();
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const clearCache = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();
  const dialog = visible(page.getByRole("dialog"));
  const section = (name) => visible(page.getByRole("region", { name, exact: true }));
  const noKeyShown = async () => {
    const text = (await page.locator("body").textContent()) ?? "";
    if (text.includes(FAKES.boatKey) || text.includes(FAKES.boatKey.slice(-6)))
      throw new Error("the page shows part of the Boat key");
  };

  // tRPC answers this recipe writes, by procedure: `{ json, meta }`, `{ error, tag }`, or
  // `{ edit }`, which changes the server's own answer.
  const stubs = new Map();
  const sent = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    for (const p of paths) if (stubs.has(p)) sent.set(p, route.request().postData());
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p) && stubs.get(p).edit === undefined)
      ? null
      : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.edit !== undefined) {
        const data = answers[index]?.result?.data;
        return data === undefined ? answers[index] : { result: { data: stub.edit(data) } };
      }
      if (stub.error !== undefined) {
        status = paths.length === 1 ? 422 : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422, tag: stub.tag ?? null },
            },
          },
        };
      }
      return { result: { data: stub.meta === undefined ? { json: stub.json } : stub } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");

  // --- As the stack has it: no key --------------------------------------------------------------
  await navigate("/settings/organization/boat");
  await heading("Boat");
  await page
    .getByText(/^Everyone in /)
    .first()
    .waitFor();
  await visible(page.getByText(/^No key connected\./)).waitFor();
  await section("Where Boat is used").waitFor();
  const sidebarBoat = visible(page.getByRole("link", { name: "Boat", exact: true }));
  if ((await sidebarBoat.getAttribute("href")) !== "/settings/organization/boat")
    throw new Error("the settings sidebar's Boat entry doesn't open the page");
  note("as the stack is: no Boat key; the sidebar's Boat entry opens this page");
  await shot("boat-no-key-desktop-light");

  // --- Connect: a value that isn't a key, then the fake key, both refused by the server ---------
  const org = await orgName(page);
  await visible(page.getByRole("button", { name: "Connect key…" })).click();
  await heading(`Connect ${org}'s Boat key`);
  await dialog.getByText("For a Boat organization").waitFor();
  await shot("boat-connect-dialog-desktop-light");
  await dialog.getByLabel("Boat key").fill("not a key");
  await dialog.getByRole("button", { name: "Connect key" }).click();
  await dialog.getByText(/^That is not a Boat key\./).waitFor();
  if ((await dialog.getByLabel("Boat key").inputValue()) !== "")
    throw new Error("the key field kept the value after it was sent");
  note("a value that isn't a key: the server refuses it (shape) and the field is empty again");
  await shot("boat-connect-refused-desktop-light");
  await typeSecret(dialog.getByLabel("Boat key"), "boat-key", FAKES.boatKey);
  const answered = page.waitForResponse((response) => response.url().includes("boatKey.connect"), {
    timeout: 90_000,
  });
  await dialog.getByRole("button", { name: "Connect key" }).click();
  await answered;
  await page.waitForTimeout(500);
  await dialog.locator("[role=alert]").first().waitFor({ timeout: 90_000 });
  const refusal = (await dialog.locator("[role=alert]").first().textContent()) ?? "";
  if ((await dialog.getByLabel("Boat key").inputValue()) !== "")
    throw new Error("the key field kept the fake key after it was sent");
  await noKeyShown();
  note(`the fake Boat key, sent to the stack's server for real, is refused: "${refusal.trim()}"`);
  await shot("boat-connect-fake-refused-desktop-light");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // --- A connected key that expires in nine days (recorded) -------------------------------------
  stubs.set("boatKey.status", connected(now));
  await reread();
  await visible(page.getByText(/Boat key expires on /)).waitFor();
  await visible(page.getByText(/^Grace Hopper added it on .+, and it expires on /)).waitFor();
  await visible(
    page.getByText("Boat accepted the key 2 hours ago. The account is active."),
  ).waitFor();
  await section("What Boat reported").waitFor();
  await noKeyShown();
  note(
    "connected (recorded): the expiry banner, who added the key and when it expires, the wallet, the last check, the last full check and Boat's report; no part of the key",
  );
  await shot("boat-desktop-light");
  await paint("dark");
  await shot("boat-desktop-dark");
  await paint("light");

  // Check again asks the server, and the line says what Boat answered.
  stubs.set("boatKey.check", {
    json: {
      state: "active",
      observedAt: new Date(now).toISOString(),
      keyReplacedAt: null,
      report: report(now, new Date(now).toISOString()),
      unanswered: null,
    },
    meta: {
      values: {
        observedAt: ["Date"],
        "report.observedAt": ["Date"],
        "report.expiry.expiresAt": ["Date"],
      },
    },
  });
  await visible(page.getByRole("button", { name: "Check again" })).click();
  await visible(page.getByText("Boat accepted the key just now. The account is active.")).waitFor();
  note("check: Check again sends boatKey.check; the line reads just now (recorded answer)");

  // The wallet: choosing the other one sends it.
  stubs.set("boatKey.chooseWallet", connected(now));
  await visible(page.getByLabel("Wallet")).selectOption("personal");
  await page.waitForTimeout(1_000);
  if (!(sent.get("boatKey.chooseWallet") ?? "").includes("personal"))
    throw new Error("choosing a wallet didn't send it");
  note("wallet: choosing the personal wallet sends boatKey.chooseWallet with it");

  // A full check: its dialog, then running.
  await visible(page.getByRole("button", { name: "Run a full check…" })).click();
  await heading("Run a full check of the Boat key?");
  await shot("boat-full-check-dialog-desktop-light");
  stubs.set("boatKey.fullCheck", {
    json: { last: null, runningSince: new Date(now).toISOString() },
    meta: { values: { runningSince: ["Date"] } },
  });
  stubs.set("boatKey.status", connected(now, { running: true }));
  await dialog.getByRole("button", { name: "Run the full check" }).click();
  await visible(page.getByText(/^Running since /)).waitFor();
  note("full check: started; the row reads Running since… and the button waits (recorded)");
  await shot("boat-full-check-running-desktop-light");
  stubs.set("boatKey.status", connected(now));
  await reread();

  // --- Replace, from the banner: refused, then accepted -----------------------------------------
  await visible(page.locator("[data-slot=banner]"))
    .getByRole("button", { name: "Replace key…" })
    .click();
  await heading(`Replace ${org}'s Boat key`);
  if ((await dialog.getByLabel("New key").inputValue()) !== "")
    throw new Error("the replace dialog filled in a key");
  await shot("boat-replace-dialog-desktop-light");
  stubs.set("boatKey.connect", {
    error: "Boat rejected this key. Check it and try again.",
    tag: "BoatKeyRefused",
  });
  await typeSecret(dialog.getByLabel("New key"), "boat-key-2", FAKES.boatKey);
  await dialog.getByRole("button", { name: "Replace key" }).click();
  await dialog.getByText("Boat rejected this key. Check it and try again.").waitFor();
  await noKeyShown();
  note("replace refused (recorded): Boat's words under an empty field");
  await shot("boat-replace-refused-desktop-light");
  stubs.set("boatKey.connect", connected(now, { replaced: true }));
  stubs.set("boatKey.status", connected(now, { replaced: true }));
  await typeSecret(dialog.getByLabel("New key"), "boat-key-3", FAKES.boatKey);
  await dialog.getByRole("button", { name: "Replace key" }).click();
  await toast("Replaced the Boat key.");
  await visible(page.getByText(/and it was replaced today/)).waitFor();
  await noKeyShown();
  note("replace accepted (recorded): a toast, and the key's line says it was replaced today");
  await shot("boat-replaced-desktop-light");

  // --- Remove: refused while the account is in use, then removed --------------------------------
  await visible(page.getByRole("button", { name: "Remove key…" })).click();
  await heading(`Remove ${org}'s Boat key?`);
  await shot("boat-remove-dialog-desktop-light");
  stubs.set("boatKey.disconnect", {
    error:
      "The Boat account still holds 1 session's VM. Stop the organization's Boat sessions first.",
    tag: "BoatKeyConflict",
  });
  await dialog.getByRole("button", { name: "Remove key" }).click();
  await dialog.getByText(/still holds 1 session's VM/).waitFor();
  note("remove refused (recorded): the server's reason in the dialog");
  stubs.set("boatKey.disconnect", NOT_CONNECTED);
  stubs.set("boatKey.status", NOT_CONNECTED);
  await dialog.getByRole("button", { name: "Remove key" }).click();
  await toast("Removed the Boat key.");
  await visible(page.getByText(/^No key connected\./)).waitFor();
  note("remove accepted (recorded): a toast, and the page reads No key connected");

  // --- A member: whether there is a key, and nothing to change ----------------------------------
  stubs.set("boatKey.status", {
    json: { ...NOT_CONNECTED.json, connected: true, peopleWithOwnKeys: null },
  });
  stubs.set("organization.current", {
    edit: (data) => ({ ...data, json: { ...data.json, role: "member" } }),
  });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/boat");
  await visible(page.getByText(/has its own Boat key, so its Boat sessions run in/)).waitFor();
  if ((await page.getByRole("button", { name: /key…$/ }).count()) > 0)
    throw new Error("a member sees a button that changes the key");
  note("a member (role rewritten) reads only that there is a key, with no buttons");
  await shot("boat-member-desktop-light");
  stubs.delete("organization.current");

  // --- Failed to load, then Try again -----------------------------------------------------------
  stubs.set("boatKey.status", { error: "The verify recipe failed this read on purpose." });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/boat");
  await heading("This page didn't load");
  note("a status read that fails shows the error screen with Try again");
  await shot("boat-error-desktop-light");
  stubs.set("boatKey.status", connected(now));
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Boat");

  // --- Phone ------------------------------------------------------------------------------------
  // Recorded answers don't reach the server's own render: load a page, then move through the router.
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await clearCache();
  await navigate("/settings/organization/boat");
  await visible(page.getByText(/Boat key expires on /)).waitFor();
  const replace = visible(page.getByRole("button", { name: "Replace key…" }));
  const height = (await replace.boundingBox())?.height ?? 0;
  if (height < 44) throw new Error(`Replace key… is ${height}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-boat-${theme}`);
  }
  await paint("light");
  await replace.click();
  await visible(page.getByText(`Replace ${org}'s Boat key`, { exact: true })).waitFor();
  await shot("phone-boat-replace-sheet-light");
  await page.keyboard.press("Escape");
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  note("phone: 44px buttons, the banner stacked, Replace key as a sheet");
};

/** The organization's name, from the audience line ("Everyone in Northwind"). */
async function orgName(page) {
  const line = await page
    .getByText(/^Everyone in /)
    .filter({ visible: true })
    .first()
    .textContent();
  return (line ?? "").replace(/^Everyone in /, "").trim();
}
