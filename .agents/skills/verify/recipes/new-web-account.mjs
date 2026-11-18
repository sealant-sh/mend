// The new web app's account menu, organization switcher and collapsed sidebar (apps/web, route
// PR 9, SLNT-1132). It needs a session to review and one running, as the row actions recipe does;
// run that recipe's CLI batch once per stack first:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-row-actions-sessions.json
//   pnpm verify drive new-web --recipe new-web-account
//
// Feature ids:
// - appearance.md `theme-web` (System, Light, Dark from the account menu), `theme-persist` (kept
//   across a reload, dark from the first frame);
// - exposure.md `shell-line` (`exposure · <declared> · <scheme>` in the account menu);
// - organization.md `org-switch-web`: a stack runs one organization (MEND_TENANCY=single), so this
//   recipe shows the switcher listing it, checked, and reading again after a failure. Switching
//   between two needs a multi-organization server: the PR shows that run;
// - now-and-sessions.md `rail`: the sidebar folds to its rail and back, kept across a reload with
//   no jump; each session is its glyph with its title in a tooltip; the inbox opens as a flyout;
// - sign-in.md `web-sign-out`: Sign out lands on sign-in. It runs last.
//
// Every state is captured light and dark; the phone's Settings tab at 390px. The recipe changes
// nothing on the server but the browser's own sign-in, which it ends last.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const RUNNING = "row-running";
const REVIEW = "row-review";
const ACCOUNT_ITEMS = ["Profile", "Pair a phone…", "Theme", "Docs", "Sign out"];
const REFUSAL = "The verify recipe refused this on purpose.";
const visible = (locator) => locator.filter({ visible: true });

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Captures the page in light and dark, as it stands. */
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() => {
      const control = document.querySelector(
        "[data-slot=collapsible-trigger], [data-slot=sidebar] button",
      );
      return control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"));
    });
  };
  const open = async (path) => {
    if (path === undefined) await page.reload();
    else await page.goto(`${web}${path}`);
    await hydrated();
  };
  const button = (name) => visible(page.getByRole("button", { name }));
  const menu = () => visible(page.getByRole("menu")).first();
  const menuItem = (name) => visible(page.getByRole("menuitem", { name }));
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await visible(page.getByRole("menu")).first().waitFor({ state: "hidden" });
  };
  const menuNames = () =>
    menu()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  /** What the first frame of the next load drew: dark or not, the sidebar or its rail. */
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      window["__firstFrame"] = {
        dark: document.documentElement.classList.contains("dark"),
        rail: document.querySelector("nav[aria-label='Sidebar rail']") !== null,
        sidebar: document.querySelector("[data-slot=sidebar-header]") !== null,
      };
    });
  });
  const firstFrame = () => page.evaluate(() => window["__firstFrame"]);
  /** Answers every tRPC call for `path` with a 500, one error per call in a batch. */
  const refuse = (path) =>
    page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      if (!paths.includes(path)) return route.continue();
      const error = {
        error: {
          json: {
            message: REFUSAL,
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(paths.map(() => error)),
      });
    });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-sidebar-expanded=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    // Running open too, so the rail lists the running session beside the one to review.
    document.cookie = `mend-inbox-folds=${encodeURIComponent(
      JSON.stringify({ waiting: true, review: true, running: true, snoozed: false, done: false }),
    )}; path=/`;
    localStorage.setItem("mend-theme", "light");
  });
  await open("/");
  const sidebar = visible(page.locator("[data-slot=sidebar]"));
  await sidebar.getByRole("link", { name: new RegExp(`^${RUNNING}`) }).waitFor();
  await sidebar.getByRole("link", { name: new RegExp(`^${REVIEW}`) }).waitFor();

  // The organization row opens the switcher (frame dnxZc5SyZ4): this server's organizations, the
  // current one checked, then its settings. A stack runs one organization, so it offers no
  // "Create organization…" (new-web-organizations covers that item).
  const orgButton = sidebar.getByRole("button", { name: /, switch organization$/ });
  const organization = (await orgButton.getAttribute("aria-label")).replace(
    /, switch organization$/,
    "",
  );
  await orgButton.click();
  await menuItem(`${organization} settings`).waitFor();
  const label = await menu().locator("[data-slot=dropdown-menu-label]").first().textContent();
  if (!(label ?? "").startsWith("Organizations on "))
    throw new Error(`the switcher reads "${label}"`);
  const current = menu().locator("[aria-current=true]");
  if ((await current.count()) !== 1 || !(await current.textContent()).includes(organization))
    throw new Error(`${organization} is not the checked organization`);
  const orgNames = await menuNames();
  if (orgNames.some((name) => name.startsWith("Create organization")))
    throw new Error("a single-tenant server offers Create organization…");
  note(`org-switch-web: the switcher reads "${label}" | ${orgNames.join(" | ")}`);
  await both("switcher-open-desktop");
  await closeMenu();

  // The switcher's list failing to load says so, with Try again, and reads again.
  await refuse("organizations.list");
  await open("/");
  await orgButton.click();
  await visible(page.getByText("Your organizations didn't load.")).waitFor();
  await both("switcher-failed-desktop");
  await page.unroute("**/trpc/**");
  await menuItem("Try again").click();
  await menu().locator("[aria-current=true]").waitFor();
  note("org-switch-web: a failed read says so; Try again lists the organization, checked");
  await closeMenu();

  // The account row opens the account menu (frame N5x4Nu7v7C): who, how this server is reached,
  // Profile, Pair a phone…, Theme, Docs, Sign out.
  const accountButton = sidebar.getByRole("button", { name: /, account$/ });
  await accountButton.click();
  await menuItem("Sign out").waitFor();
  const accountNames = await menuNames();
  for (const name of ACCOUNT_ITEMS)
    if (!accountNames.some((each) => each.startsWith(name)))
      throw new Error(`the account menu lacks ${name}`);
  const exposure = visible(page.getByText(/^exposure · (loopback|private|public) · https?/));
  await exposure.waitFor();
  note(`shell-line: the account menu reads "${await exposure.textContent()}"`);
  note(`theme-web: the account menu reads ${accountNames.join(" | ")}`);
  await menuItem(/^Theme/).hover();
  await visible(page.getByRole("menuitemradio", { name: "Dark" })).waitFor();
  await both("account-theme-open-desktop");

  // Dark from the menu: the page turns dark at once, and a reload is dark from its first frame.
  await visible(page.getByRole("menuitemradio", { name: "Dark" })).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await open();
  const dark = await firstFrame();
  if (!dark.dark) throw new Error("the reload's first frame was light, then turned dark");
  note(`theme-persist: Dark kept; the reload's first frame was dark (mend-theme=dark)`);
  await page.waitForTimeout(2000);
  await capture("dark-after-reload-desktop");
  await accountButton.click();
  await menuItem(/^Theme/).hover();
  await visible(page.getByRole("menuitemradio", { name: "System" })).click();
  const stored = await page.evaluate(() => localStorage.getItem("mend-theme"));
  if (stored !== "system") throw new Error(`the theme kept is ${stored}, not system`);
  note("theme-web: System chosen again; mend-theme=system, the old app's key");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
  await open();

  // The sidebar folds to its rail from the sheet's header, and a reload keeps it with no jump.
  await button("Collapse sidebar").click();
  const rail = visible(page.getByRole("navigation", { name: "Sidebar rail" }));
  await rail.waitFor();
  await both("rail-home-desktop");
  await open();
  const folded = await firstFrame();
  if (!folded.rail || folded.sidebar)
    throw new Error("the reload's first frame drew the full sidebar, then folded it");
  note("rail: folded, and the reload's first frame is the rail (mend-sidebar-expanded=false)");

  // Each session is its glyph, with its title in a tooltip (frame xu6sX8G4lW).
  const glyph = rail.getByRole("link", { name: new RegExp(`^${REVIEW}, `) });
  await rail.getByRole("link", { name: new RegExp(`^${RUNNING}, `) }).waitFor();
  const glyphs = await rail
    .getByRole("list", { name: "Sessions" })
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));
  note(`rail: the session glyphs read ${glyphs.join(" | ")}`);
  await glyph.hover();
  await visible(page.locator("[data-slot=tooltip-content]").getByText(REVIEW, { exact: true }))
    .first()
    .waitFor();
  await both("rail-tooltip-desktop");
  await glyph.click();
  await page.waitForURL(/\/sessions\//);
  await hydrated();
  if ((await glyph.getAttribute("aria-current")) !== "page")
    throw new Error("the open session's glyph is not marked as the page");
  // The pointer off the rail, so no tooltip is opening or closing while the page is captured.
  await page.mouse.move(700, 450);
  // The session's page reads its record as it opens; the driver withholds a picture taken while
  // the page is still inserting what it read.
  await page.waitForTimeout(3000);
  await both("rail-in-session-desktop");

  // The inbox as a flyout beside the rail (frame c7beWRxNSr); opening a session closes it. The
  // driver's screenshot check closes a popover on a session page, so the flyout is captured from
  // home.
  const flyout = visible(page.getByRole("dialog", { name: "Inbox" }));
  await rail.getByRole("button", { name: /^Inbox/ }).click();
  await flyout.getByRole("link", { name: new RegExp(`^${RUNNING}`) }).click();
  await page.waitForURL(/\/sessions\//);
  await flyout.waitFor({ state: "hidden" });
  note("rail: opening a session from the inbox flyout opened it and closed the flyout");
  await open("/");
  await rail.getByRole("button", { name: /^Inbox/ }).click();
  await flyout.getByRole("link", { name: new RegExp(`^${RUNNING}`) }).waitFor();
  await both("rail-inbox-flyout-desktop");
  await page.keyboard.press("Escape");
  await flyout.waitFor({ state: "hidden" });
  note("rail: the inbox flyout lists the groups, and Escape closes it");

  // The organization and account menus open from the rail too.
  await rail.getByRole("button", { name: /, switch organization$/ }).click();
  await menuItem(`${organization} settings`).waitFor();
  await both("rail-switcher-desktop");
  await closeMenu();
  await rail.getByRole("button", { name: /, account$/ }).click();
  await menuItem("Sign out").waitFor();
  await both("rail-account-desktop");
  await closeMenu();

  // And back: the toggle in the sheet's header opens it in full, kept across a reload.
  await button("Expand sidebar").click();
  await visible(page.locator("[data-slot=sidebar-header]")).waitFor();
  await open();
  const unfolded = await firstFrame();
  if (unfolded.rail || !unfolded.sidebar) throw new Error("the reload folded the sidebar again");
  note("rail: open in full again, and still after a reload");

  // On a phone the switcher and the account sit at the top of the Settings tab.
  await page.setViewportSize(PHONE);
  await open("/settings");
  await button(/, account$/).waitFor();
  await both("settings-tab-phone");
  await button(/, account$/).click();
  await visible(page.getByRole("menuitem", { name: "Appearance" })).waitFor();
  await both("account-sheet-phone");
  await visible(page.getByRole("menuitem", { name: "Appearance" })).click();
  await visible(page.getByRole("menuitemradio", { name: "System" })).waitFor();
  await both("appearance-sheet-phone");
  await page.keyboard.press("Escape");
  await visible(page.getByRole("dialog")).first().waitFor({ state: "hidden" });
  await button(/, switch organization$/).click();
  await visible(page.getByRole("menuitem", { name: `${organization} settings` })).waitFor();
  await both("switcher-sheet-phone");
  await page.keyboard.press("Escape");
  await visible(page.getByRole("dialog")).first().waitFor({ state: "hidden" });
  note("org-switch-web: on a phone the account row and the organization row open their sheets");

  // Sign out, last: the browser lands on sign-in, signed out.
  await page.setViewportSize(DESKTOP);
  await open("/");
  await accountButton.click();
  await menuItem("Sign out").click();
  await page.waitForURL(/\/login/);
  await visible(page.getByRole("button", { name: "Sign in" })).waitFor();
  await both("signed-out-desktop");
  note("web-sign-out: Sign out in the account menu landed on /login");
};
