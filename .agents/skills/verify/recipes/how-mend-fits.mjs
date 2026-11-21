// Setup's last step, How Mend fits together (SLNT-1203), in the web app:
//
//   pnpm verify drive web --recipe how-mend-fits
//
// - The first account: step 7 of 7, three screens (How Mend fits together, Inside a session, The
//   sidebar), Next and Back between them on `?screen=`, Skip for now on the first two, Continue to
//   Mend on the last; light, dark and phone (where the third is "The inbox").
// - The pictures are the app's own components with sample data: the sidebar picture is the real
//   sidebar, with its five groups and the reader's organization and project.
// - Skip for now opens Mend, and the steps beside the sheet then say "Skipped" for the step; Continue
//   to Mend ticks it.
// - Where setup sends people: `/welcome` opens Mend for someone who finished setup (never this
//   step); First project sends someone who already sees a project on to this step.
// - Someone who joins from an invitation: step 6 of 6, "You're a member of …".
// - The account menu's "How Mend fits together" opens the same three screens in a dialog, and
//   Done puts focus back on the account row; on a phone, Settings' account sheet opens them.
//
// What is made in the browser, and why: the stack's account is the first account, with or without
// a Mend key, an agent login and a project, as earlier recipes left it. To show someone who
// finished setup, `git.access`, `platform.sealantIdentity` and `projects.list` are answered with
// what it lacks of those; to show the invitee, `organization.current` is answered as a member who
// is not the operator. Nothing on the server changes; the recipe clears what it remembered in this
// browser at its end.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Marks an answer made here that carries superjson's note of which fields are Dates. */
const DATED = Symbol("dated");
const dated = (json, fields) => ({
  [DATED]: {
    json,
    meta: { values: Object.fromEntries(fields.map((field) => [field, ["Date"]])) },
  },
});

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(seen)}`);
};

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  // After a reload the page's reads are still arriving (the roster names the person in the
  // pictures); a capture waits until they have.
  const quiet = async () => {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    // Vite may reload the page while it bundles dependencies on a cold start: load it once more.
    await hydrated().catch(async () => {
      await page.goto(`${web}${path}`);
      await hydrated();
    });
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const text = (words) => visible(page.getByText(words));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const heading = (name) =>
    visible(page.getByRole("heading", { name, level: 1, exact: true })).waitFor();
  const call = (path) =>
    page.evaluate(async (route) => {
      let target = window["__TSR_ROUTER__"].options.context.trpcClient;
      for (const part of route.split(".")) target = target[part];
      return target.query();
    }, path);
  const stepNames = async () =>
    (await page.getByRole("list", { name: "Setup steps" }).locator("li").allTextContents()).map(
      (one) => one.trim(),
    );
  const pathname = () => new URL(page.url()).pathname;

  // Chosen tRPC reads, answered from the server's own answer, changed.
  const answers = {};
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!paths.some((path) => path in answers)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    paths.forEach((path, at) => {
      const answer = answers[path];
      const real = entries[at]?.result?.data;
      if (answer === undefined || real === undefined) return;
      const made = answer(real.json);
      // An answer that carries dates says so the way superjson does: `{ [DATED]: { json, meta } }`.
      const marked = made?.[DATED];
      entries[at] = {
        result: {
          data:
            marked === undefined
              ? { ...real, json: made }
              : {
                  json: marked.json,
                  meta: { values: { ...real.meta?.values, ...marked.meta.values } },
                },
        },
      };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? entries : entries[0]),
    });
  });
  /** Forget what the page read, so the next page reads the changed answers. */
  const forget = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());

  /** One screen: its heading, light and dark on a desktop, then the phone in light. */
  const shoot = async (name, title, phoneTitle = title, darkToo = true) => {
    await heading(title);
    await capture(`${name}-desktop-light`);
    if (darkToo) {
      // The page loaded in dark, as a person who chose it sees it: switching the class on an open
      // page keeps the DOM changing past the capture.
      const here = new URL(page.url());
      await page.evaluate(() => localStorage.setItem("mend-theme", "dark"));
      await open(`${here.pathname}${here.search}`);
      await heading(title);
      await quiet();
      // As tall as the page, so the full-page capture doesn't resize the window while it reads it.
      const tall = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: DESKTOP.width, height: Math.max(DESKTOP.height, tall) });
      await quiet();
      await capture(`${name}-desktop-dark`);
      await page.setViewportSize(DESKTOP);
      await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
      await open(`${here.pathname}${here.search}`);
      await heading(title);
    }
    await page.setViewportSize(PHONE);
    await settled();
    await heading(phoneTitle);
    await capture(`${name}-phone-light`);
    await page.setViewportSize(DESKTOP);
    await settled();
  };

  await page.setViewportSize(DESKTOP);
  // Light unless the recipe chose dark for a capture.
  await page.addInitScript(() => {
    if (localStorage.getItem("mend-theme") === null) localStorage.setItem("mend-theme", "light");
  });
  await open("/");
  const me = await call("organization.current");
  expect("the stack's account is the first account", me.operator && me.role === "owner", me);
  const organization = me.organization.name;
  const clearRemembered = () =>
    page.evaluate((id) => {
      localStorage.removeItem(`mend-setup-nouns:${id}`);
      localStorage.removeItem(`mend-setup-reached:${id}`);
    }, me.userId);
  await clearRemembered();

  // ---- Someone who finished setup is not sent to the step: what the stack's account lacks of a
  // finished setup (Git access, an agent login, a project) is answered as if it had it.
  const now = new Date().toISOString();
  const project = {
    id: "recipe-project",
    name: "checkout-api",
    organizationId: me.organization.id,
    visibility: "shared",
    createdByUserId: me.userId,
    originUrl: "https://github.com/northwind/checkout-api.git",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  };
  const finished = {
    "git.access": (access) => ({ ...access, mode: "bridge" }),
    "platform.sealantIdentity": (identity) => {
      const accounts = identity?.accounts ?? [];
      const all = [
        ...accounts,
        {
          id: "recipe-claude",
          provider: "claude",
          name: "Claude Code",
          kind: "subscription",
          status: "active",
          metadata: {},
          connectedAt: now,
          updatedAt: now,
          lastUsedAt: null,
          isDefault: true,
        },
      ];
      // Only the added login's dates are strings here; the server's own were read as Dates.
      const at = all.length - 1;
      return dated(
        { ...identity, accounts: all },
        all.flatMap((account, index) =>
          index === at || typeof account.connectedAt === "string"
            ? [`accounts.${index}.connectedAt`, `accounts.${index}.updatedAt`]
            : [],
        ),
      );
    },
    "projects.list": (list) => {
      const rows = (list ?? []).length > 0 ? list : [project];
      return dated(
        rows,
        rows.flatMap((_, index) => [`${index}.createdAt`, `${index}.updatedAt`]),
      );
    },
  };
  Object.assign(answers, finished);
  await forget();
  await open("/welcome");
  expect("/welcome sends a person who finished setup on to Mend", pathname() === "/", pathname());
  note(
    `nouns-not-forced: /welcome with Git access, an agent login and a project opened ${pathname()}, not /welcome/how-mend-fits`,
  );

  // ---- First project with a project already in sight hands on to this step.
  await open("/welcome/first-project");
  await heading("How Mend fits together");
  expect(
    "First project hands on to this step",
    pathname() === "/welcome/how-mend-fits",
    pathname(),
  );
  note(
    "nouns-after-first-project: /welcome/first-project with a project in sight opened /welcome/how-mend-fits",
  );
  for (const path of Object.keys(finished)) delete answers[path];
  await forget();

  // ---- The first account: the three screens.
  await open("/welcome/how-mend-fits");
  await heading("How Mend fits together");
  await text("Step 7 of 7").waitFor({ state: "attached" });
  const steps = await stepNames();
  expect(
    "seven steps, this one last",
    steps.length === 7 && (steps[6]?.includes("How Mend fits together") ?? false),
    steps,
  );
  await text(`You're ${organization}'s owner, so you invite its members.`).waitFor();
  await text("1 of 3").waitFor();
  await button("Skip for now").waitFor();
  expect(
    "no Back on the first screen",
    (await page
      .getByRole("button", { name: "Back", exact: true })
      .filter({ visible: true })
      .count()) === 0,
    "Back",
  );
  const picture = page.locator("[inert]");
  expect("the pictures are inert", (await picture.count()) >= 4, await picture.count());
  note(
    `nouns-screens: 'How Mend fits together', step 7 of 7 with ${steps.length} steps beside the sheet, '${organization}' named as its owner, '1 of 3', Skip for now and Next; ${await picture.count()} inert pictures`,
  );
  await shoot("first-1", "How Mend fits together");

  await button("Next").click();
  await heading("Inside a session");
  expect(
    "screen 2 is on the address",
    new URL(page.url()).searchParams.get("screen") === "2",
    page.url(),
  );
  await text("2 of 3").waitFor();
  await button("Back").waitFor();
  await button("Skip for now").waitFor();
  await shoot("first-2", "Inside a session");

  await button("Next").click();
  await heading("The sidebar");
  await text("3 of 3").waitFor();
  await button("Continue to Mend").waitFor();
  expect(
    "no Skip on the last screen",
    (await page.getByRole("button", { name: "Skip for now" }).filter({ visible: true }).count()) ===
      0,
    "Skip",
  );
  // The sidebar picture is the real sidebar over the sample inbox.
  const sidebarPicture = page.locator("[inert] [data-slot=sidebar]");
  expect(
    "the sidebar picture is the app's sidebar",
    (await sidebarPicture.count()) === 1,
    await sidebarPicture.count(),
  );
  const groups = await sidebarPicture
    .locator("section")
    .evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
  expect("five groups in the picture", groups.length === 5, groups);
  note(
    `nouns-sidebar-picture: the picture is the sidebar itself, groups ${groups.join(", ")}, organization ${organization}`,
  );
  await shoot("first-3", "The sidebar", "The inbox");

  await button("Back").click();
  await heading("Inside a session");
  await page.goBack();
  await heading("The sidebar");
  note("nouns-back: Back opened screen 2; the browser's back opened screen 3 again");

  // Continue to Mend opens Mend, and the step reads done.
  await button("Continue to Mend").click();
  await page.waitForURL((url) => url.pathname === "/");
  await open("/welcome/git-access");
  const afterSeen = await stepNames();
  expect(
    "the step reads done after Continue to Mend",
    afterSeen[6]?.startsWith("How Mend fits together, done") === true,
    afterSeen,
  );
  note(
    `nouns-continue: Continue to Mend opened /; going back to Git access, the step reads '${afterSeen[6]}'`,
  );

  // Skip for now opens Mend, and the step reads skipped.
  await open("/welcome/how-mend-fits");
  await button("Skip for now").click();
  await page.waitForURL((url) => url.pathname === "/");
  await open("/welcome/git-access");
  const afterSkip = await stepNames();
  expect("the step reads skipped", afterSkip[6]?.includes("Skipped") ?? false, afterSkip);
  await capture("skipped-rail-desktop-light");
  note(
    `nouns-skip: Skip for now opened /; going back to Git access, the step reads '${afterSkip[6]}'`,
  );
  await clearRemembered();

  // ---- Someone who joins from an invitation.
  answers["organization.current"] = (current) => ({ ...current, operator: false, role: "member" });
  await open("/welcome/how-mend-fits");
  // The server renders who is signed in into the page; the browser reads it again on focus.
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await heading("How Mend fits together");
  await text("Step 6 of 6").waitFor({ state: "attached" });
  const joined = await stepNames();
  expect(
    "six steps, no Organization",
    joined.length === 6 && !joined.some((one) => one.startsWith("Organization")),
    joined,
  );
  await text(`You're a member of ${organization}. Its owners invite people.`).waitFor();
  note(
    `nouns-invitee: step 6 of 6, steps ${joined.join(" · ")}, 'You're a member of ${organization}'`,
  );
  await shoot("invitee-1", "How Mend fits together");
  await button("Next").click();
  await shoot("invitee-2", "Inside a session");
  await button("Next").click();
  await shoot("invitee-3", "The sidebar", "The inbox");
  delete answers["organization.current"];
  await forget();
  await clearRemembered();

  // ---- The account menu opens the same screens.
  await open("/");
  const accountRow = visible(page.getByRole("button", { name: /, account$|^Account$/ }));
  await accountRow.click();
  await visible(page.getByRole("menuitem", { name: "How Mend fits together" })).click();
  const dialog = page.getByRole("dialog", { name: "How Mend fits together" });
  await dialog.waitFor();
  await settled();
  await capture("menu-1-desktop-light");
  await dialog.getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Inside a session" }).waitFor();
  await settled();
  await capture("menu-2-desktop-light");
  await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "The sidebar" }).waitFor();
  await settled();
  await capture("menu-3-desktop-light");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForTimeout(300);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  // The dialog in dark, from a page loaded in dark.
  await page.evaluate(() => localStorage.setItem("mend-theme", "dark"));
  await open("/");
  await accountRow.click();
  await visible(page.getByRole("menuitem", { name: "How Mend fits together" })).click();
  await dialog.waitFor();
  await quiet();
  await capture("menu-1-desktop-dark");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
  note(
    `nouns-menu: the account menu's 'How Mend fits together' opened the three screens in a dialog; Done closed it and focus went to '${focused}'`,
  );

  // On a phone, from Settings.
  await page.setViewportSize(PHONE);
  await open("/settings");
  await visible(page.getByRole("button", { name: /, account$|^Account$/ })).click();
  await visible(page.getByRole("menuitem", { name: "How Mend fits together" })).click();
  await page.getByRole("dialog", { name: "How Mend fits together" }).waitFor();
  await settled();
  await capture("menu-1-phone-light");
  await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Inside a session" }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "The inbox" }).waitFor();
  await settled();
  await capture("menu-3-phone-light");
  note(
    "nouns-menu-phone: Settings' account sheet opened the three screens as a sheet, the last 'The inbox'",
  );
  await page.setViewportSize(DESKTOP);
};
