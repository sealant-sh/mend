// Settings in the web app (route PR 37, SLNT-1154): the settings frame (its own sidebar, the
// breadcrumb, the audience line), Profile and Appearance, who sees which pages, old addresses, and
// the phone's Settings tab.
//
//   pnpm verify drive web --recipe settings
//
// Feature ids: appearance.md `theme-web` (System, Light, Dark on Appearance), `theme-system` (System
// follows the OS), `theme-persist` (the choice holds across a reload with no flash); sign-in.md
// `web-sign-out` (Profile's Sign out, last). New with this page: text size and the terminal font for
// this browser, a name and a password changed through Better Auth's own endpoints.
//
// The recipe puts back what it changes (the account's name, its password, this browser's choices),
// so it can run again. Sign out is its last step. For the Terminal check, run the Terminal view's
// CLI batch first (a `sleep` session in the worktree `term-ws`), and stop that session after:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/terminal-sessions.json
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
/** Whether a choice of a segmented control is the one picked. */
const pressed = (group, name) =>
  group.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");

export default async ({ page, web, capture, note, account }) => {
  const settled = () => page.waitForTimeout(500);
  const path = () => new URL(page.url()).pathname;
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  /** React has taken the page over, so clicks, typing and the router reach it. */
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
    // The dev server may reload the page once as it bundles a module it hadn't seen.
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  /** How many times the page's DOM changed in one second. */
  const changesInASecond = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let changes = 0;
          const observer = new MutationObserver((records) => {
            changes += records.length;
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(changes);
          }, 1_000);
        }),
    );
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  /** One picture, after the page settles: the sidebar's wrapper clipped to the window. */
  const shot = async (name) => {
    await page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
    await page.mouse.move(1, 1);
    await settled();
    await still();
    await capture(name);
  };
  /** The page's theme as the theme module sets it, without a reload. */
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const sidebarEntries = () =>
    page
      .getByRole("complementary", { name: "Settings" })
      .or(page.locator('[data-slot="sidebar"][aria-label="Settings"]'))
      .first()
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));

  // A fresh browser: no theme, text size or terminal font kept, the light OS.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => {
    localStorage.removeItem("mend-theme");
    for (const name of ["mend-theme", "mend-text-size", "mend-terminal-font"])
      document.cookie = `${name}=; path=/; max-age=0`;
  });

  // --- The frame, and Profile at /settings ----------------------------------------------------
  await open("/settings");
  await heading("Profile");
  const settingsNav = page.locator('[data-slot="sidebar"][aria-label="Settings"]');
  await settingsNav.waitFor();
  if ((await page.locator('[aria-label="Sidebar"]').count()) !== 0)
    throw new Error("the app's sidebar is still drawn on Settings");
  const entries = await sidebarEntries();
  note(`settings sidebar: ${entries.join(" | ")}`);
  for (const want of [
    "Back to app",
    "Profile",
    "Agent logins and Git",
    "Devices and access keys",
    "Dotfiles",
    "MCP servers",
    "Notifications",
    "Your automation",
    "Connected apps",
    "Appearance",
    "General",
    "Workspace image",
    "Runtime",
    "Boat",
    "Integrations",
    "Folders and references",
    "Projects",
    "Audit log",
    "Server",
  ])
    if (!entries.some((entry) => entry.startsWith(want)))
      throw new Error(`the settings sidebar doesn't list ${want}`);
  const active = await settingsNav.locator('[aria-current="page"]').first().textContent();
  if (active?.trim() !== "Profile") throw new Error(`/settings highlights ${active}`);
  await page.getByText("Only you", { exact: true }).first().waitFor();
  const crumbs = await page.getByRole("navigation", { name: "Breadcrumb" }).first().textContent();
  note(`/settings opens Profile; breadcrumb "${crumbs}", audience "Only you"`);
  const email = await page.getByLabel("Email").inputValue();
  if (email !== account.email) throw new Error(`Profile shows ${email}, not ${account.email}`);
  note("Profile shows the account's email, read-only");
  await shot("profile-desktop-light");

  // --- Old addresses ---------------------------------------------------------------------------
  for (const [old, now] of [
    ["/settings/account", "/settings/profile"],
    ["/settings/sessions", "/settings/automation"],
    ["/settings/git-access", "/settings/agent-logins"],
    ["/settings/organization/slack", "/settings/organization/integrations"],
  ]) {
    await page.goto(`${web}${old}`);
    await page.waitForURL((url) => url.pathname === now);
    note(`${old} → ${path()}`);
  }
  // A page not built yet: not found, inside Settings, with its entry highlighted.
  await hydrated();
  await heading("Page not found");
  await settingsNav.waitFor();
  await shot("later-page-desktop-light");
  await page.goto(`${web}/settings#devices`);
  await page.waitForURL((url) => url.pathname === "/settings/devices");
  note(`/settings#devices → ${path()}`);

  // --- Profile: the name ----------------------------------------------------------------------
  await open("/settings/profile");
  const nameField = page.getByLabel("Name", { exact: true });
  const original = await nameField.inputValue();
  const renamed = `${original || "Verify"} (renamed)`;
  await nameField.fill(renamed);
  await nameField.press("Enter");
  await page.getByText("Saved.", { exact: true }).waitFor();
  note(`name changed to "${renamed}": Saved.`);
  await shot("profile-name-saved-desktop-light");
  await page.reload();
  await hydrated();
  if ((await nameField.inputValue()) !== renamed)
    throw new Error("the new name didn't hold across a reload");
  note("the new name holds across a reload (Better Auth's update-user)");
  // The sidebar's account row names the account by the organization's roster: the new name.
  await open("/");
  await visible(page.getByRole("button", { name: `${renamed}, account` })).waitFor();
  note(`the app sidebar's account row reads "${renamed}"`);
  await open("/settings/profile");
  await nameField.fill("   ");
  await nameField.press("Enter");
  await page.getByText("Your name can't be empty.").waitFor();
  note("an empty name is refused beside the field");
  await nameField.fill(original);
  await nameField.press("Enter");
  await page.getByText("Saved.", { exact: true }).waitFor();
  note(`name put back to "${original}"`);

  // --- Profile: the password ------------------------------------------------------------------
  const dialog = () => visible(page.getByRole("dialog", { name: "Change password" }));
  await page.getByRole("button", { name: "Change password…" }).click();
  await dialog().waitFor();
  await page.waitForTimeout(400);
  await shot("change-password-desktop-light");
  await page.getByLabel("Current password").fill("not the password");
  await page.getByLabel("New password").fill("a new password 1");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.getByText("That isn't your current password.").waitFor();
  note("a wrong current password: That isn't your current password. (beside the field)");
  await page.getByLabel("Current password").fill("");
  await account.typePassword(page.getByLabel("Current password"));
  await page.getByLabel("New password").fill("verify-temporary-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  note("password changed with the right current password; the dialog closes");
  // Signing in afresh, with no cookie kept: the old password is refused, the new one accepted.
  // The old password goes from the account straight into a field and from it to the request, so
  // it never reaches this file.
  const signInWith = async (fill) => {
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.type = "password";
      field.id = "verify-sign-in-check";
      document.body.append(field);
    });
    await fill(page.locator("#verify-sign-in-check"));
    return page.evaluate(async (address) => {
      const field = document.getElementById("verify-sign-in-check");
      const password = field.value;
      field.remove();
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, password }),
      });
      return response.status;
    }, account.email);
  };
  const withOld = await signInWith((field) => account.typePassword(field));
  const withNew = await signInWith((field) => field.fill("verify-temporary-password"));
  if (withOld === 200) throw new Error("the old password still signs in");
  if (withNew !== 200) throw new Error(`the new password answered ${withNew}`);
  note(`signing in afresh: the old password answers ${withOld}, the new one ${withNew}`);
  await page.reload();
  await hydrated();
  await heading("Profile");
  note("still signed in after the change");
  // Put the stack's password back.
  await page.getByRole("button", { name: "Change password…" }).click();
  await dialog().waitFor();
  await page.getByLabel("Current password").fill("verify-temporary-password");
  await account.typePassword(page.getByLabel("New password"));
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  note("password put back");
  const passwordLine = await page.getByText(/^You (set|last changed) it on /).textContent();
  note(`Password row: "${passwordLine}"`);

  // --- Appearance -----------------------------------------------------------------------------
  await settingsNav.getByRole("link", { name: "Appearance" }).click();
  await heading("Appearance");
  if (path() !== "/settings/appearance") throw new Error(`Appearance opened ${path()}`);
  await page.getByText("Only this browser", { exact: true }).first().waitFor();
  const themeGroup = page.getByRole("group", { name: "Theme" });
  if ((await pressed(themeGroup, "System")) !== "true") throw new Error("System isn't picked");
  await shot("appearance-desktop-light");
  // theme-system: System follows the OS, live.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  note("theme-system: System follows the OS to dark, live");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  // theme-web and theme-persist: Dark, then a reload.
  await themeGroup.getByRole("button", { name: "Dark", exact: true }).click();
  if (!(await isDark())) throw new Error("Dark didn't darken the page");
  await page
    .getByRole("group", { name: "Text size" })
    .getByRole("button", { name: "Large" })
    .click();
  const rootSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const bodySize = await page.evaluate(() => getComputedStyle(document.body).fontSize);
  if (rootSize !== "18px") throw new Error(`Large set the root to ${rootSize}`);
  note(`text size Large: the root is ${rootSize}, body text ${bodySize}`);
  await page.getByLabel("Terminal font", { exact: true }).selectOption({ label: "JetBrains Mono" });
  await page.getByLabel("Terminal font size").selectOption({ label: "15 px" });
  // What the server sends for the next load, before any script runs.
  const html = await (await page.request.get(`${web}/settings/appearance`)).text();
  if (!/<html[^>]*data-text-size="large"/.test(html))
    throw new Error("the server didn't render the page at Large");
  note(`the server renders the next load with data-text-size="large"`);
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.body === null) return;
      window.darkAtFirstPaint = document.documentElement.classList.contains("dark");
      window.sizeAtFirstPaint = document.documentElement.dataset.textSize ?? "default";
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await hydrated();
  const first = await page.evaluate(() => [window.darkAtFirstPaint, window.sizeAtFirstPaint]);
  if (first[0] !== true || first[1] !== "large")
    throw new Error(`at first paint: dark ${first[0]}, text size ${first[1]}`);
  note("theme-persist: after a reload the page is dark and Large from its first paint");
  if ((await pressed(page.getByRole("group", { name: "Theme" }), "Dark")) !== "true")
    throw new Error("Dark isn't picked after the reload");
  const preview = await page
    .getByText("pnpm vitest run")
    .evaluate((element) => [
      getComputedStyle(element).fontFamily,
      getComputedStyle(element).fontSize,
    ]);
  note(`terminal font kept: the preview draws in ${preview[0]} at ${preview[1]}`);
  await shot("appearance-dark-large-desktop");
  // A session's Terminal draws in the chosen face and size: the batch session in `term-ws` (run
  // terminal-sessions.json first). The terminal is a canvas, so this is read, not pictured.
  const terminalSession = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    const rows = queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]
      ?.state.data;
    if (!Array.isArray(rows)) return null;
    const live = rows.find(
      (row) =>
        row.worktreeName === "term-ws" &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    );
    return live?.session.id ?? null;
  });
  const terminalFont = async () => {
    const box = page.locator("[data-own-shortcuts]").filter({ visible: true }).first();
    await box.waitFor({ timeout: 30_000 });
    await box.locator("canvas").first().waitFor({ timeout: 30_000 });
    return box.evaluate((element) => [
      getComputedStyle(element).fontFamily,
      getComputedStyle(element).fontSize,
    ]);
  };
  if (terminalSession === null) {
    note("no running session in term-ws: the Terminal check was skipped (run the CLI batch)");
  } else {
    await open(`/sessions/${terminalSession}/terminal`);
    const drawn = await terminalFont();
    if (!drawn[0].includes("JetBrains Mono") || drawn[1] !== "15px")
      throw new Error(`the Terminal draws in ${drawn[0]} at ${drawn[1]}`);
    note(`the session's Terminal draws in ${drawn[0]} at ${drawn[1]}`);
    await open("/settings/appearance");
  }
  // The account menu reads the same choice.
  await settingsNav.getByRole("link", { name: "Back to app" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await visible(page.getByRole("button", { name: /, account$/ })).click();
  const themeValue = await visible(page.getByRole("menuitem", { name: /^Theme/ })).textContent();
  if (!themeValue?.includes("Dark")) throw new Error(`the account menu says ${themeValue}`);
  note(`Back to app goes home; the account menu's Theme says "${themeValue?.trim()}"`);
  await page.keyboard.press("Escape");
  // Put this browser back.
  await open("/settings/appearance");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
  await page
    .getByRole("group", { name: "Text size" })
    .getByRole("button", { name: "Default" })
    .click();
  await page.getByLabel("Terminal font", { exact: true }).selectOption({ label: "Geist Mono" });
  await page.getByLabel("Terminal font size").selectOption({ label: "13 px" });
  if ((await page.evaluate(() => document.documentElement.dataset.textSize)) !== undefined)
    throw new Error("Default left a text size on the page");
  if (terminalSession !== null) {
    await open(`/sessions/${terminalSession}/terminal`);
    const drawn = await terminalFont();
    if (!drawn[0].startsWith('"Geist Mono') || drawn[1] !== "13px")
      throw new Error(`after Geist Mono 13 px the Terminal draws in ${drawn[0]} at ${drawn[1]}`);
    note(`back to the default: the Terminal draws in ${drawn[0]} at ${drawn[1]}`);
    await open("/settings/appearance");
  }

  // --- Who sees what ---------------------------------------------------------------------------
  const as = { role: null, operator: null };
  await page.route("**/trpc/**", async (route) => {
    const request = route.request();
    const paths = decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
      .split(",")
      .filter((p) => p !== "");
    if (as.role === null || !paths.includes("organization.current")) return route.continue();
    const response = await route.fetch();
    const answers = await response.json();
    const list = Array.isArray(answers) ? answers : [answers];
    paths.forEach((p, index) => {
      const json = list[index]?.result?.data?.json;
      if (p === "organization.current" && json !== undefined) {
        json.role = as.role;
        json.operator = as.operator;
      }
    });
    await route.fulfill({
      response,
      body: JSON.stringify(Array.isArray(answers) ? list : list[0]),
    });
  });
  // The server renders who is looking from the real answer, so the browser reads it again
  // (signed-in reads refetch when the tab is shown) and the rewritten answer arrives.
  const viewAs = async (role, operator) => {
    as.role = role;
    as.operator = operator;
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes("/trpc/") &&
        decodeURIComponent(response.url()).includes("organization.current"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await answered;
    await settled();
  };
  await viewAs("member", false);
  let seen = await sidebarEntries();
  for (const hidden of ["Projects", "Audit log", "Server"])
    if (seen.some((entry) => entry === hidden)) throw new Error(`a member sees ${hidden}`);
  note(`a member's sidebar: ${seen.join(" | ")}`);
  await shot("sidebar-member-desktop-light");
  // By address, through the router, which reads who is looking from the page's own answer.
  await navigate("/settings/organization/audit-log");
  await page.waitForURL((url) => url.pathname === "/settings/profile");
  note("a member opening /settings/organization/audit-log by address lands on Profile");
  await navigate("/settings/server");
  await page.waitForURL((url) => url.pathname === "/settings/profile");
  note("a member opening /settings/server by address lands on Profile");
  await viewAs("member", true);
  seen = await sidebarEntries();
  if (!seen.includes("Server")) throw new Error("an operator doesn't see Server");
  if (seen.includes("Audit log")) throw new Error("an operator who isn't an owner sees Audit log");
  note(`an operator who is a member: ${seen.join(" | ")}`);
  await navigate("/settings/server");
  await heading("Page not found");
  if (path() !== "/settings/server")
    throw new Error(`an operator's /settings/server went to ${path()}`);
  note("an operator opens /settings/server (not built yet: not found inside Settings)");
  as.role = null;
  await page.unroute("**/trpc/**");

  // --- A failed read --------------------------------------------------------------------------
  await open("/settings/appearance");
  // The roster names the account: its read fails, one answer per call in a batch.
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.includes("organization.members")) return route.continue();
    const response = await route.fetch();
    const answers = await response.json();
    const list = Array.isArray(answers) ? answers : [answers];
    const failure = {
      error: {
        json: {
          message: "The verify recipe failed this read on purpose.",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
        },
      },
    };
    const changed = paths.map((p, index) => (p === "organization.members" ? failure : list[index]));
    await route.fulfill({
      status: paths.length === 1 ? 500 : 207,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
    });
  });
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await navigate("/settings/profile");
  await heading("This page didn't load");
  note("Profile's read failing shows the error screen with Try again");
  await shot("profile-error-desktop-light");
  await page.unroute("**/trpc/**");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Profile");
  note("Try again reads the account again and Profile draws");

  // --- Phone -----------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings");
  await heading("Settings");
  const phoneRows = await page
    .locator("main, body")
    .first()
    .getByRole("link")
    .filter({ visible: true })
    .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
  note(`phone Settings tab: ${phoneRows.join(" | ")}`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-settings-${theme}`);
  }
  await paint("light");
  await visible(page.getByRole("link", { name: "Profile" })).click();
  await page.waitForURL((url) => url.pathname === "/settings/profile");
  await heading("Profile");
  for (const [label, locator] of [
    ["Name", page.getByLabel("Name", { exact: true })],
    ["Change password…", page.getByRole("button", { name: "Change password…" })],
    ["Sign out", page.getByRole("button", { name: "Sign out", exact: true })],
  ]) {
    const height = (await visible(locator).boundingBox())?.height ?? 0;
    if (height < 44) throw new Error(`${label} is ${height}px tall on a phone, under 44px`);
  }
  note("Profile's field and buttons are 44px touch targets on a phone");
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-profile-${theme}`);
  }
  await paint("light");
  await visible(page.getByRole("link", { name: "Settings" })).click();
  await page.waitForURL((url) => url.pathname === "/settings");
  note("the phone header's Back returns to the Settings tab");
  await visible(page.getByRole("link", { name: "Appearance" })).click();
  await heading("Appearance");
  // A phone's controls are 44px touch targets.
  const touch = async (label, locator) => {
    const height = (await visible(locator).boundingBox())?.height ?? 0;
    if (height < 44) throw new Error(`${label} is ${height}px tall on a phone, under 44px`);
    return `${label} ${height}px`;
  };
  note(
    `touch sizes: ${[
      await touch("Terminal font", page.getByLabel("Terminal font", { exact: true })),
      await touch("Terminal font size", page.getByLabel("Terminal font size")),
      await touch("Theme", page.getByRole("group", { name: "Theme" })),
    ].join(", ")}`,
  );
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-appearance-${theme}`);
  }
  await paint("light");
  await page.setViewportSize(DESKTOP);
  await open("/settings/appearance");
  await paint("dark");
  await shot("appearance-desktop-dark");
  await open("/settings/profile");
  await paint("dark");
  await shot("profile-desktop-dark");
  await paint("light");

  // --- web-sign-out, last ---------------------------------------------------------------------
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/login");
  await heading("Sign in");
  note("web-sign-out: Profile's Sign out lands on /login");
};
