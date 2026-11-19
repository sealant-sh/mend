// Settings → Account → Your automation in the new web app (route PR 43, SLNT-1169): what Mend does
// in a person's sessions without being asked, as plain switches saved to their account
// (`platform.automation` / `platform.setAutomation`, `GET`/`PUT /me/automation`), and the T3 Code
// switch "Stop the session when you settle its thread" (`platform.settleSettings`).
//
//   pnpm verify drive new-web --recipe new-web-settings-automation
//
// Feature ids: land-change.md land-automatic (the composer starts from the switch);
// review-change.md's description-and-tour and suggest-fixes switches; project-settings.md
// settings-review-automation and settings-landing (moved here, with no Inherit). Every switch is
// flipped for real and read back from the server; a slow save, a refused save and a failed read are
// recorded answers. The recipe reads both documents first and puts them back at the end, so it can
// run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();

const SWITCHES = [
  ["Change description and tour", "autoTour"],
  ["Suggested fixes", "autoSuggest"],
  ["Automatic landing", "autoLand"],
];
const SETTLE = "Stop the session when you settle its thread";

export default async ({ page, web, capture, note }) => {
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
  const toggle = (label) => visible(page.getByRole("switch", { name: label, exact: true }));
  const checked = async (label) => (await toggle(label).getAttribute("aria-checked")) === "true";
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();
  const automation = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.trpcClient.platform.automation.query(),
    );
  const settle = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.trpcClient.platform.settleSettings.query(),
    );
  const setAutomation = (own) =>
    page.evaluate(
      (value) =>
        window["__TSR_ROUTER__"].options.context.trpcClient.platform.setAutomation.mutate(value),
      own,
    );
  const readAgain = async () => {
    await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/automation");
    await heading("Your automation");
  };

  // tRPC answers this recipe writes, by procedure: `{ json }`, `{ error }`, and a `delay` in ms.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p)) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let failed = false;
    let delay = 0;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      delay = Math.max(delay, stub.delay ?? 0);
      if (stub.error !== undefined) {
        failed = true;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
      }
      return { result: { data: { json: stub.json } } };
    });
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const batched = route.request().url().includes("batch=1");
    await route.fulfill({
      status: failed ? (paths.length === 1 ? 500 : 207) : 200,
      contentType: "application/json",
      body: JSON.stringify(batched ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const before = (await automation()).own;
  const settleBefore = await settle();
  note(
    `the account before the run: automation ${JSON.stringify(before)}, settle ${JSON.stringify(settleBefore)}`,
  );

  // --- Old addresses come here -------------------------------------------------------------------
  for (const old of ["/settings/review", "/settings/landing", "/settings/sessions"]) {
    await open(old);
    await heading("Your automation");
    if (new URL(page.url()).pathname !== "/settings/automation")
      throw new Error(`${old} stayed at ${page.url()}`);
  }
  note("/settings/review, /settings/landing and /settings/sessions each open /settings/automation");

  // --- The page, as the server holds it ----------------------------------------------------------
  await visible(page.getByText("Only you", { exact: true })).waitFor();
  for (const [label, key] of SWITCHES)
    if ((await checked(label)) !== before[key])
      throw new Error(`${label} shows ${!before[key]}, the server holds ${before[key]}`);
  if ((await checked(SETTLE)) !== settleBefore.stopSessionOnSettle)
    throw new Error(`${SETTLE} doesn't show what the server holds`);
  note('under "Only you", each of the four switches shows what the server holds');
  for (const absent of [
    "Inherit",
    "Name the session",
    "Background sessions",
    "Run sessions in the background",
    "Send steers the running turn",
  ])
    if ((await page.getByText(absent).count()) !== 0) throw new Error(`the page shows ${absent}`);
  note(
    "no Inherit, no organization value, no Name the session, no background sessions, no steer-or-queue switch",
  );
  await shot("automation-desktop-light");
  await paint("dark");
  await shot("automation-desktop-dark");
  await paint("light");

  // --- Each switch saves, and the server keeps it --------------------------------------------------
  for (const [label, key] of SWITCHES) {
    const was = await checked(label);
    await toggle(label).click();
    const words = {
      autoTour: was
        ? "Mend won't write a description and tour of your changes."
        : "Mend will write a description and tour of your changes.",
      autoSuggest: was
        ? "Mend won't draft fixes for the problems it finds."
        : "Mend will draft a fix for each problem it finds.",
      autoLand: was
        ? "New sessions start with automatic landing off."
        : "New sessions start with automatic landing on.",
    }[key];
    await toast(words);
    const held = (await automation()).own;
    if (held[key] === was) throw new Error(`the server didn't keep ${label}`);
    if (held.autoName !== before.autoName || held.backgroundSessions !== before.backgroundSessions)
      throw new Error(`saving ${label} changed a value the page has no switch for`);
    note(
      `${label}: turned ${was ? "off" : "on"}; the server now holds ${key} ${held[key]}, autoName and backgroundSessions unchanged`,
    );
  }
  const settleWas = await checked(SETTLE);
  await toggle(SETTLE).click();
  await toast(
    settleWas
      ? "Settling a thread in T3 Code leaves its session running."
      : "Settling a thread in T3 Code stops its session.",
  );
  if ((await settle()).stopSessionOnSettle === settleWas)
    throw new Error("the server didn't keep the settle switch");
  note(`${SETTLE}: turned ${settleWas ? "off" : "on"}, and the server keeps it`);
  await shot("automation-saved-desktop-light");

  const after = (await automation()).own;
  await readAgain();
  for (const [label, key] of SWITCHES)
    if ((await checked(label)) !== after[key])
      throw new Error(`after a reload ${label} doesn't show what was saved`);
  if ((await checked(SETTLE)) === settleWas)
    throw new Error("after a reload the settle switch doesn't show what was saved");
  note("read again with nothing cached, all four switches show what was saved");

  // --- land-automatic: the home composer starts from the switch ------------------------------------
  const pick = (name) => page.getByRole("button", { name }).filter({ visible: true }).first();
  for (const land of [true, false]) {
    await setAutomation({ ...after, autoLand: land });
    await navigate("/settings/automation");
    await heading("Your automation");
    await page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
    );
    await page.waitForFunction(
      (wanted) =>
        document
          .querySelector('[role="switch"][aria-label="Automatic landing"]')
          ?.getAttribute("aria-checked") === String(wanted),
      land,
    );
    await navigate("/");
    await page.getByRole("textbox", { name: "Task" }).filter({ visible: true }).waitFor();
    await pick(/^Agent and model: /).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Land when a turn completes" });
    await item.waitFor();
    const startsOn = (await item.getAttribute("aria-checked")) === "true";
    if (startsOn !== land)
      throw new Error(`Automatic landing is ${land}, the composer's choice starts ${startsOn}`);
    if (land) await shot("composer-land-on-desktop-light");
    await page.keyboard.press("Escape");
    await item.waitFor({ state: "hidden" });
    note(
      `land-automatic: Automatic landing ${land ? "on" : "off"}, and the home composer's "Land when a turn completes" starts ${startsOn ? "on" : "off"}`,
    );
  }
  await navigate("/settings/automation");
  await heading("Your automation");

  // --- Saving, and a save that fails ---------------------------------------------------------------
  stubs.set("platform.setAutomation", {
    delay: 4_000,
    error: "The verify recipe refused this save on purpose.",
  });
  const tourWas = await checked("Change description and tour");
  await toggle("Change description and tour").click();
  await visible(page.getByText("Saving…", { exact: true })).waitFor();
  if ((await checked("Change description and tour")) === tourWas)
    throw new Error("the switch didn't show its new position while saving");
  note("while it saves, the switch shows its new position and Saving… beside it");
  await shot("automation-saving-desktop-light");
  await visible(page.getByText(/Mend didn't save this\./)).waitFor();
  if ((await checked("Change description and tour")) !== tourWas)
    throw new Error("the switch didn't go back after the save failed");
  note("a refused save puts the switch back, says why under the row, and offers Try again");
  await shot("automation-not-saved-desktop-light");
  stubs.delete("platform.setAutomation");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await page.waitForFunction(
    (wanted) =>
      document
        .querySelector('[role="switch"][aria-label="Change description and tour"]')
        ?.getAttribute("aria-checked") === String(wanted),
    !tourWas,
  );
  if ((await automation()).own.autoTour === tourWas) throw new Error("Try again didn't save");
  note("Try again saves it, and the server keeps it");

  stubs.set("platform.setSettleSettings", {
    error: "The verify recipe refused this save on purpose.",
  });
  const settleNow = await checked(SETTLE);
  await toggle(SETTLE).click();
  await visible(page.getByText(/Mend didn't save this\./)).waitFor();
  if ((await checked(SETTLE)) !== settleNow)
    throw new Error("the settle switch didn't go back after the save failed");
  note("the T3 Code switch: a refused save goes back and says why too");
  stubs.delete("platform.setSettleSettings");

  // --- A failed read -------------------------------------------------------------------------------
  stubs.set("platform.automation", { error: "The verify recipe failed this read on purpose." });
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/automation");
  await heading("This page didn't load");
  note("the automation read failing shows the error screen with Try again");
  await shot("automation-error-desktop-light");
  stubs.delete("platform.automation");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Your automation");
  note("Try again reads it again and the page draws");

  // --- Phone ---------------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/automation");
  await visible(
    page.getByText("For sessions you work on from T3 Code.", { exact: true }),
  ).waitFor();
  await visible(
    page.getByText(
      "New sessions start from this choice. You can change it in the composer for one session.",
      { exact: true },
    ),
  ).waitFor();
  note("phone: one column with the phone frame's shorter words");
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-automation-${theme}`);
  }
  await paint("light");

  // --- Put it back ---------------------------------------------------------------------------------
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  await setAutomation(before);
  await page.evaluate(
    (settings) =>
      window["__TSR_ROUTER__"].options.context.trpcClient.platform.setSettleSettings.mutate(
        settings,
      ),
    settleBefore,
  );
  note("put the account's automation and settle settings back as they were");
};
