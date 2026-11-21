// Settings → Account → Notifications in the web app (route PR 42, SLNT-1159): which news about
// the sessions a person started reaches the Mend app on their phones, saved per switch through
// `devices.notificationSettings` and `devices.setNotificationSettings` (`GET`/`PUT
// /me/notifications`), and the phones it goes to.
//
//   pnpm verify drive web --recipe settings-notifications
//
// No feature file covers this page. A stack has no phone paired with the Mend app, so one state
// comes from a recorded answer: `devices.list` with an iPhone in it. A slow save and a refused one
// are recorded answers too. The recipe reads the setting first and puts it back at the end, so it
// can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();

/** A recorded `devices.list`: one iPhone and one browser, of which only the phone is listed. */
const DEVICES = [
  {
    id: "dev-phone",
    name: "Ada's iPhone",
    platform: "ios",
    createdAt: "2026-11-09T10:00:00.000Z",
    lastUsedAt: "2026-11-19T09:00:00.000Z",
  },
  {
    id: "dev-browser",
    name: "Firefox on Linux",
    platform: "web",
    createdAt: "2026-11-01T10:00:00.000Z",
    lastUsedAt: null,
  },
];

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
  const toggle = (label) => page.getByRole("switch", { name: label, exact: true });
  const checked = async (label) => (await toggle(label).getAttribute("aria-checked")) === "true";
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();

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
  const before = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.devices.notificationSettings.query(),
  );
  note(`the account's setting before the run: ${JSON.stringify(before)}`);

  // --- The page, with no phone paired ----------------------------------------------------------
  await navigate("/settings/notifications");
  await heading("Notifications");
  await page.getByText("Only you", { exact: true }).first().waitFor();
  for (const [label, key] of [
    ["A session is waiting on you", "needsInput"],
    ["A turn finishes", "turnFinished"],
    ["A session fails", "failed"],
    ["Sessions started from Slack", "slackSessions"],
  ])
    if ((await checked(label)) !== before[key])
      throw new Error(`${label} shows ${!before[key]}, the server holds ${before[key]}`);
  note("each switch shows what the server holds");
  await visible(page.getByText("No phones", { exact: true })).waitFor();
  note("Sent to: no phone is paired on the stack, and the page says where to pair one");
  await shot("notifications-no-phones-desktop-light");
  await visible(page.getByRole("link", { name: "Devices and access keys" })).click();
  await page.waitForURL((url) => url.pathname === "/settings/devices");
  note("No phones links to Devices and access keys, which opens /settings/devices");
  await navigate("/settings/notifications");
  await heading("Notifications");

  // --- A switch saves, and the server keeps it -------------------------------------------------
  const was = await checked("A turn finishes");
  await toggle("A turn finishes").click();
  await toast(
    was
      ? "You won't get a notification when a turn finishes."
      : "You'll get a notification when a turn finishes.",
  );
  const saved = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.devices.notificationSettings.query(),
  );
  if (saved.turnFinished === was) throw new Error("the server didn't keep A turn finishes");
  note(
    `A turn finishes: turned ${was ? "off" : "on"}, and the server now holds ${saved.turnFinished}`,
  );
  await shot("notifications-saved-desktop-light");
  // A second switch sends the first one's new value, so it doesn't undo it.
  const slackWas = await checked("Sessions started from Slack");
  await toggle("Sessions started from Slack").click();
  await toast(
    slackWas
      ? "Sessions you started in Slack don't send notifications. Slack's thread shows their status."
      : "Sessions you started in Slack send notifications too.",
  );
  const both = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.devices.notificationSettings.query(),
  );
  if (both.turnFinished === was || both.slackSessions === slackWas)
    throw new Error(`the second switch undid the first: ${JSON.stringify(both)}`);
  note("a second switch saved without undoing the first; the server holds both");
  // Read again from the server with nothing cached, as a reload does. (A full reload on a cold dev
  // server can fail to hydrate, so this goes through the router.)
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/notifications");
  await heading("Notifications");
  if (
    (await checked("A turn finishes")) !== both.turnFinished ||
    (await checked("Sessions started from Slack")) !== both.slackSessions
  )
    throw new Error("after a reload the switches don't show what was saved");
  note("read again with nothing cached, both switches show what was saved");

  // --- Saving, and a save that fails -----------------------------------------------------------
  stubs.set("devices.setNotificationSettings", {
    delay: 4_000,
    error: "The verify recipe refused this save on purpose.",
  });
  const failedWas = await checked("A session fails");
  await toggle("A session fails").click();
  await visible(page.getByText("Saving…", { exact: true })).waitFor();
  note("while it saves, the switch shows its new position and Saving… beside it");
  await shot("notifications-saving-desktop-light");
  await visible(page.getByText(/Mend didn't save this\./)).waitFor();
  if ((await checked("A session fails")) !== failedWas)
    throw new Error("A session fails didn't go back after the save failed");
  note("a refused save goes back, says so under the row, and offers Try again");
  await shot("notifications-not-saved-desktop-light");
  stubs.delete("devices.setNotificationSettings");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await page.waitForFunction(
    (wanted) =>
      document.querySelector('[aria-label="A session fails"]')?.getAttribute("aria-checked") ===
      String(wanted),
    !failedWas,
  );
  note("Try again saves it");

  // --- With a phone paired (recorded answer) ---------------------------------------------------
  stubs.set("devices.list", { json: DEVICES });
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  await visible(page.getByText("Ada's iPhone", { exact: true })).waitFor();
  if ((await page.getByText("Firefox on Linux").count()) !== 0)
    throw new Error("a browser is listed as a place notifications go");
  note("Sent to lists the paired iPhone and leaves the browser out (recorded answer)");
  await shot("notifications-desktop-light");
  await paint("dark");
  await shot("notifications-desktop-dark");
  await paint("light");

  // --- A failed read ---------------------------------------------------------------------------
  stubs.set("devices.notificationSettings", {
    error: "The verify recipe failed this read on purpose.",
  });
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/notifications");
  await heading("This page didn't load");
  note("the setting's read failing shows the error screen with Try again");
  await shot("notifications-error-desktop-light");
  stubs.delete("devices.notificationSettings");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Notifications");
  note("Try again reads it again and the page draws");

  // --- Phone -----------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/notifications");
  await visible(page.getByText("Phone notifications", { exact: true })).waitFor();
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-notifications-${theme}`);
  }
  await paint("light");

  // --- Put it back -----------------------------------------------------------------------------
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  await page.evaluate(
    (settings) =>
      window["__TSR_ROUTER__"].options.context.trpcClient.devices.setNotificationSettings.mutate(
        settings,
      ),
    before,
  );
  note("put the account's setting back as it was");
};
