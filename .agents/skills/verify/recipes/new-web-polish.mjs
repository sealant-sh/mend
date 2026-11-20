// The owner's pass, part 1 (SLNT-1198): the line beside the sheet, focus rings the sidebars cut
// off, Open project in a session row's menu, a table row that opens from anywhere on it, and
// breadcrumbs whose parts link to their pages. Run the CLI batch once per stack first; it starts
// one session that keeps running:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-polish-sessions.json
//   pnpm verify drive new-web --recipe new-web-polish
//
// With MEND_VERIFY_POLISH_BEFORE=1 it only captures and notes what it finds (for pictures of the
// app before the change); otherwise each check throws when the app doesn't do it. It changes no
// server state.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const SESSION = "polish-running";
const PROJECT = "verify-fixture";
const BEFORE = process.env.MEND_VERIFY_POLISH_BEFORE === "1";

export default async ({ page, web, capture: captureOnce, note }) => {
  const tag = BEFORE ? "before" : "after";
  const capture = (name) => captureOnce(`${tag}-${name}`);
  const failures = [];
  /** A check: throws once the recipe ends when the app doesn't do it (only notes, before). */
  const expect = (ok, what) => {
    note(`${ok ? "yes" : "NO"} · ${what}`);
    if (!ok) failures.push(what);
  };
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => {
        const control = document.querySelector("a[href], button");
        return (
          control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"))
        );
      },
      null,
      { timeout: 90_000 },
    );
    await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await settled();
  };
  const path = () => new URL(page.url()).pathname;
  /** Waits for the address to reach `pattern`; false when it doesn't within `ms`. */
  const reaches = (pattern, ms = 5_000) =>
    page
      .waitForURL((url) => pattern.test(url.pathname), { timeout: ms })
      .then(() => true)
      .catch(() => false);
  /** Clicks the middle of `locator` by position, as a person does, whatever covers it. */
  const clickAt = async (locator) => {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("nothing to click");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const parkMouse = () => page.mouse.move(DESKTOP.width - 4, DESKTOP.height - 4);
  /**
   * Every control under `selector` whose focus ring (3px outside its box) a scrolling or clipping
   * ancestor cuts off: the control's name, where, and the ancestor that clips it.
   */
  const clippedRings = (selector) =>
    page.evaluate((sel) => {
      const RING = 3;
      const found = [];
      const controls = document.querySelectorAll(
        `${sel} :is(a[href], button, [tabindex]:not([tabindex="-1"]), input)`,
      );
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        for (
          let up = control.parentElement;
          up !== null && up !== document.body;
          up = up.parentElement
        ) {
          const style = getComputedStyle(up);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const outer = up.getBoundingClientRect();
          const left = outer.left + up.clientLeft;
          const right = left + up.clientWidth;
          const top = outer.top + up.clientTop;
          const bottom = top + up.clientHeight;
          const side = box.left - RING < left - 0.5 || box.right + RING > right + 0.5;
          // Top and bottom count only for a control the list shows whole (one scrolled half out
          // of view is cut by scrolling, not by its ring).
          const whole = box.top >= top && box.bottom <= bottom;
          const end = whole && (box.top - RING < top - 0.5 || box.bottom + RING > bottom + 0.5);
          if (side || end) {
            found.push({
              control: (control.getAttribute("aria-label") ?? control.textContent ?? "")
                .trim()
                .slice(0, 40),
              at: side ? "side" : "top or bottom",
              clippedBy:
                up.getAttribute("data-slot") ??
                `${up.tagName.toLowerCase()}${up.getAttribute("aria-label") ? `[${up.getAttribute("aria-label")}]` : ""}`,
            });
            break;
          }
        }
      }
      return found;
    }, selector);
  const auditRings = async (where, selector) => {
    const clipped = await clippedRings(selector);
    note(`rings in ${where}: ${clipped.length === 0 ? "none cut off" : JSON.stringify(clipped)}`);
    return clipped;
  };
  /** Moves keyboard focus onto `locator` the way Tab does, so it shows its focus ring. */
  const keyboardFocus = async (locator) => {
    await locator.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await settled();
  };
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const sessionRow = () =>
    inbox()
      .getByRole("link", { name: new RegExp(`^${SESSION}`) })
      .first();
  /** Opens the inbox's Running group (folded by default), where the session's row is. */
  const showRunning = async () => {
    const heading = inbox()
      .getByRole("region", { name: "Running", exact: true })
      .getByRole("button", { name: /^Running/ });
    if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
    await sessionRow().waitFor();
  };
  const menuNames = () =>
    page
      .getByRole("menu")
      .filter({ visible: true })
      .first()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    document.cookie = "mend-sidebar-expanded=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });

  // 10. The Projects table: the whole row opens the project; its "…" keeps its own menu.
  await open("/projects");
  const projectRow = page
    .getByRole("table", { name: "Projects" })
    .getByRole("row")
    .filter({ hasText: PROJECT })
    .first();
  await projectRow.waitFor();
  const projectHref = await projectRow.getByRole("link", { name: PROJECT }).getAttribute("href");
  const projectId = projectHref?.split("/").pop() ?? "";
  note(`project ${PROJECT} is ${projectId}`);
  await parkMouse();

  // 5. The sheet's edge beside the sidebar: nothing drawn at rest, in light and dark.
  const edge = () =>
    page.evaluate(() => {
      const container = document.querySelector("[data-slot=sidebar-container]");
      const rail = document.querySelector("[data-slot=sidebar-rail]");
      const after = rail === null ? null : getComputedStyle(rail, "::after");
      return {
        border: container === null ? null : getComputedStyle(container).borderRightWidth,
        railColour: after?.backgroundColor ?? null,
        railHeight: after?.height ?? null,
        railLeft: rail === null ? null : rail.getBoundingClientRect().left,
      };
    });
  const atRest = await edge();
  note(`the sidebar's edge at rest: ${JSON.stringify(atRest)}`);
  expect(atRest.border === "0px", "no border on the sidebar's edge beside the sheet");
  expect(
    atRest.railColour === "rgba(0, 0, 0, 0)" || atRest.railColour === "transparent",
    "the rail draws nothing at rest",
  );
  await both("projects-desktop");
  // Pointing at the edge: a short handle, not a line the height of the window.
  const rail = page.locator("[data-slot=sidebar-rail]");
  const railBox = await rail.boundingBox();
  if (railBox !== null) {
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
    await settled();
    const hovered = await edge();
    note(`the sidebar's edge while pointed at: ${JSON.stringify(hovered)}`);
    expect(
      Number.parseFloat(hovered.railHeight ?? "9999") <= 48,
      "the hovered rail is a short handle",
    );
    await both("edge-hover");
  }
  await parkMouse();
  // Folded to the rail (⌘B; Projects has no toggle in its header): still no line.
  await page.keyboard.press("Control+b");
  await page.getByRole("navigation", { name: "Sidebar rail" }).waitFor();
  await settled();
  expect((await edge()).border === "0px", "no border on the folded rail's edge");
  await both("rail-desktop");
  expect(
    (await auditRings("the folded rail", "[data-slot=sidebar]")).length === 0,
    "no focus ring in the folded rail is cut off",
  );
  await page.keyboard.press("Control+b");
  await page.getByRole("navigation", { name: "Inbox" }).waitFor();
  await settled();

  await projectRow.hover();
  await settled();
  await capture("projects-row-hover-light");
  // A click on the row away from the name (its "Visible to" cell).
  await clickAt(projectRow.getByRole("cell").nth(1));
  expect(
    await reaches(new RegExp(`^/projects/${projectId}`)),
    "a click on the project's row opens it",
  );
  await open("/projects");
  // The row is one stop for the keyboard: its link, then its "…".
  const stops = await projectRow.evaluate(
    (row) => row.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])').length,
  );
  expect(stops === 2, `the project's row has two keyboard stops (it has ${stops})`);
  await keyboardFocus(projectRow.getByRole("link", { name: PROJECT }));
  await page.keyboard.press("Enter");
  expect(
    await reaches(new RegExp(`^/projects/${projectId}`)),
    "Enter on the project's row opens it",
  );
  await open("/projects");
  await projectRow.getByRole("button", { name: `${PROJECT} menu` }).click();
  await page.getByRole("menuitem", { name: "Open project" }).waitFor();
  expect(path() === "/projects", 'the row\'s "…" opens its menu and stays on Projects');
  await page.keyboard.press("Escape");
  expect(
    (await auditRings("the Projects table", "table[aria-label=Projects]")).length === 0,
    "no focus ring in the Projects table is cut off",
  );

  // 10. A project's sessions: the whole row opens the session.
  await open(`/projects/${projectId}`);
  const sessionsTable = page.getByRole("table", { name: "Sessions" });
  const projectSessionRow = sessionsTable.getByRole("row").filter({ hasText: SESSION }).first();
  await projectSessionRow.waitFor();
  const sessionHref = await projectSessionRow.getByRole("link").first().getAttribute("href");
  const sessionId = sessionHref?.split("/")[2] ?? "";
  note(`session ${SESSION} is ${sessionId}`);
  await projectSessionRow.hover();
  await settled();
  await capture("project-sessions-row-hover-light");
  expect(
    (await auditRings("the project's Sessions table", "table[aria-label=Sessions]")).length === 0,
    "no focus ring in the project's Sessions table is cut off",
  );
  await clickAt(projectSessionRow.getByRole("cell").nth(3));
  expect(
    await reaches(new RegExp(`^/sessions/${sessionId}`)),
    "a click on a session's row opens it",
  );

  // 12. The session's header: the project's name links to the project.
  await open(`/sessions/${sessionId}`);
  const header = page.locator("[data-slot=workspace-header]");
  await header.waitFor();
  const crumb = header.getByRole("link", { name: PROJECT });
  const linked = (await crumb.count()) > 0;
  expect(linked, "the session header's project name is a link");
  await capture("session-header-light");
  if (linked) {
    expect(
      (await crumb.getAttribute("href")) === `/projects/${projectId}`,
      "it goes to the project's page",
    );
    await crumb.click();
    expect(await reaches(new RegExp(`^/projects/${projectId}$`)), "clicking it opens the project");
  }

  // 8. The session row's focus ring, whole, and its right-click menu with Open project.
  await open("/projects");
  await showRunning();
  await keyboardFocus(sessionRow());
  await both("row-focus");
  await auditRings("the app sidebar", "[data-slot=sidebar]");
  expect(
    (await clippedRings("[data-slot=sidebar]")).length === 0,
    "no focus ring in the app sidebar is cut off",
  );
  await sessionRow().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Open session/ }).waitFor();
  const names = await menuNames();
  note(`the row's right-click menu reads ${names.join(" | ")}`);
  const openAt = names.findIndex((name) => name.startsWith("Open session"));
  expect(
    names[openAt + 1]?.startsWith("Open project") === true,
    "Open project follows Open session",
  );
  await both("row-menu");
  const openProject = page.getByRole("menuitem", { name: /^Open project/ });
  if ((await openProject.count()) > 0) {
    await openProject.click();
    expect(await reaches(new RegExp(`^/projects/${projectId}$`)), "Open project opens the project");
  } else {
    await page.keyboard.press("Escape");
  }
  // The same item in the row's "…".
  await open("/projects");
  await showRunning();
  await sessionRow().hover();
  await inbox()
    .getByRole("button", { name: `Actions for ${SESSION}` })
    .click();
  await page.getByRole("menuitem", { name: /^Open session/ }).waitFor();
  expect(
    (await menuNames()).some((name) => name.startsWith("Open project")),
    'the row\'s "…" has Open project',
  );
  await page.keyboard.press("Escape");

  // 16. The settings sidebar's rings, and 12. its breadcrumbs.
  await open("/settings/agent-logins");
  const settingsSidebar = page
    .getByRole("complementary", { name: "Settings" })
    .or(page.locator("[data-slot=sidebar][aria-label=Settings]"));
  await keyboardFocus(settingsSidebar.first().getByRole("link", { name: "Profile" }));
  await both("settings-focus");
  expect(
    (await clippedRings("[data-slot=sidebar][aria-label=Settings]")).length === 0,
    "no focus ring in the settings sidebar is cut off",
  );
  await auditRings("the settings sidebar", "[data-slot=sidebar][aria-label=Settings]");

  const breadcrumb = () =>
    page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true });
  await open("/settings/organization/members");
  const settingsCrumb = breadcrumb().getByRole("link", {
    name: "Settings",
    exact: true,
  });
  expect((await settingsCrumb.count()) > 0, '"Settings" in the breadcrumb is a link');
  const orgCrumb = breadcrumb().locator('a[href="/settings/organization"]');
  expect((await orgCrumb.count()) > 0, "the organization's name links to its General page");
  await capture("settings-members-breadcrumb-light");
  await open(`/projects/${projectId}/settings/general`);
  const projectCrumb = breadcrumb().getByRole("link", { name: PROJECT });
  expect(
    (await projectCrumb.count()) > 0 &&
      (await projectCrumb.getAttribute("href")) === `/projects/${projectId}`,
    "a project settings page's breadcrumb links the project's name to the project",
  );
  await capture("settings-project-breadcrumb-light");
  await open("/settings/profile");
  expect(
    (await breadcrumb().getByRole("link", { name: "Account" }).count()) === 0,
    "Account, a group with no page, stays text",
  );

  // 8 on a phone: the row's sheet has Open project.
  await page.setViewportSize(PHONE);
  await open("/");
  const phoneActions = page
    .getByRole("button", { name: `Actions for ${SESSION}` })
    .filter({ visible: true })
    .first();
  await phoneActions.waitFor();
  await phoneActions.click();
  const sheet = page.getByRole("menu", { name: `Actions for ${SESSION}` });
  await sheet.waitFor();
  await settled();
  const sheetItems = await sheet
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  note(`the phone row sheet reads ${sheetItems.join(" | ")}`);
  expect(
    sheetItems.some((item) => item.startsWith("Open project")),
    "the phone sheet has Open project",
  );
  await both("phone-row-sheet");
  const phoneOpen = sheet.getByRole("menuitem", { name: /^Open project/ });
  if ((await phoneOpen.count()) > 0) {
    await phoneOpen.click();
    expect(
      await reaches(new RegExp(`^/projects/${projectId}$`)),
      "on a phone, Open project opens the project",
    );
  }
  await open("/projects");
  await capture("phone-projects-light");
  await page.setViewportSize(DESKTOP);

  if (BEFORE) note(`before the change, ${failures.length} checks fail: ${failures.join("; ")}`);
  else if (failures.length > 0) throw new Error(`failed: ${failures.join("; ")}`);
};
