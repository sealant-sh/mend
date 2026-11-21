// A second person's pass over the new web app (SLNT-1229). Run the CLI batch once per stack first;
// it starts two sessions that keep running, one after the other:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-second-pass-sessions.json
//   pnpm verify drive new-web --recipe new-web-second-pass
//
// 1. Rows of tabs that scroll sideways (a project's tabs, the Record view's filters, a phone tile's
//    strip, and the project picture in How Mend fits together) never scroll up and down and draw
//    no scrollbar. Headless Chromium hides scrollbars, so this checks the boxes and their styles;
//    the PR shows the scrollbar itself in a headed Chrome with classic scrollbars.
// 2. Every framed picture in How Mend fits together has room for what it draws.
// 4. A press on the sidebar's edge folds the sidebar wherever the pointer is let go: a drag toward
//    the page folds it, a drag the other way does nothing, a click still folds it.
// 5. Running lists its sessions newest made first, and keeps that order while they work: each read
//    of the inbox is answered with the other session as the one that did something last.
// 6. A session row's menus have no Open session (a click on the row opens it): the sidebar row's
//    right-click menu and "…", and the project page's row "…".
// 7. A skill's header has Edit skill and a Remove skill button, with no "…" (it held Edit skill
//    again and Remove skill…); the button asks first. The recipe makes the skill and removes it.
//    A shell that isn't yours (a session's own terminal) has its one action, Copy working directory,
//    as a button. A member's own row in Members has Leave as a button (recorded answers: the
//    account reads as a member with a second organization; the dialog is closed unsent).
//
// It puts the sidebar back open and changes no server state.
const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 1100, height: 900 };
const PHONE = { width: 390, height: 844 };
const OLDER = "second-pass-older";
const NEWER = "second-pass-newer";

/** A sideways row's box: whether it can scroll up and down, and its scrollbar. */
/** The procedures a tRPC request asks for. */
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

const strip = (locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflow: element.scrollHeight - element.clientHeight,
      overflowY: style.overflowY,
      scrollbar: style.scrollbarWidth,
    };
  });

export default async ({ page, web, capture, note }) => {
  const failures = [];
  const expect = (ok, what) => {
    note(`${ok ? "yes" : "NO"} · ${what}`);
    if (!ok) failures.push(what);
  };
  const settled = () => page.waitForTimeout(500);
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
    await page.waitForTimeout(1_000);
  };
  const call = (path, input) =>
    page.evaluate(
      async ([route, value]) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target.query(value);
      },
      [path, input],
    );
  const menuNames = () =>
    page
      .getByRole("menu")
      .filter({ visible: true })
      .first()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  /** A session's row in the sidebar, by its id: a new session's title is "New session". */
  const sessionRow = (id) => inbox().locator(`a[data-session-id="${id}"]`).first();
  const showRunning = async () => {
    const heading = inbox()
      .getByRole("region", { name: "Running", exact: true })
      .getByRole("button", { name: /^Running/ });
    if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
    await sessionRow(older).waitFor();
  };
  const stripHolds = async (locator, what) => {
    const seen = await strip(locator);
    // What pokes out below (a hidden underline) may stay: the row can't scroll to it.
    expect(
      seen.overflowY === "hidden" && seen.scrollbar === "none",
      `${what} scroll sideways only, with no scrollbar: ${JSON.stringify(seen)}`,
    );
  };

  await page.setViewportSize(DESKTOP);
  await open("/");
  const [project] = await call("projects.list");
  if (!project) throw new Error("the stack has no project");
  const rows = await call("sessions.inbox");
  const idOf = (name) =>
    rows.find((row) => row.session.branch === `mend/${name}` && row.session.status === "running")
      ?.session.id;
  const older = idOf(OLDER);
  const newer = idOf(NEWER);
  if (!older || !newer) throw new Error("run new-web-second-pass-sessions.json first");

  // ---- 1. Tab rows.
  await open(`/projects/${project.id}`);
  const projectTabs = () =>
    page.getByRole("navigation", { name: `${project.name} project` }).filter({ visible: true });
  await stripHolds(projectTabs().first(), "a project's tabs, desktop");
  await capture("tabs-project-desktop");
  await open(`/sessions/${older}/record`);
  const filters = page.getByRole("tablist", { name: "Show" }).filter({ visible: true }).first();
  await filters.waitFor();
  await stripHolds(filters, "the Record view's filters");
  await page.setViewportSize(PHONE);
  await open(`/projects/${project.id}`);
  await stripHolds(projectTabs().first(), "a project's tabs, phone");
  await open(`/sessions/${older}`);
  const tileStrip = page.getByRole("tablist", { name: "Tabs" }).filter({ visible: true }).first();
  await tileStrip.waitFor();
  await stripHolds(tileStrip, "a phone tile's strip");
  await page.setViewportSize(DESKTOP);
  await open("/welcome/how-mend-fits");
  await stripHolds(page.locator("[inert] nav").first(), "the project picture's tabs");

  // ---- 2. The pictures in How Mend fits together.
  for (const [width, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    await page.setViewportSize(size);
    for (const screen of [1, 2, 3]) {
      await open(`/welcome/how-mend-fits?screen=${screen}`);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      const pictures = await page.evaluate(() =>
        [...document.querySelectorAll("[inert]")].flatMap((frame) => {
          const drawing = frame.firstElementChild;
          const drawn = drawing?.firstElementChild;
          if (!(drawing instanceof HTMLElement) || !drawn) return [];
          const scale = drawing.getBoundingClientRect().width / drawing.offsetWidth;
          return [
            {
              size: `${drawing.offsetWidth}x${drawing.offsetHeight}`,
              room: frame.clientHeight / scale,
              drawn: drawn.getBoundingClientRect().height / scale,
            },
          ];
        }),
      );
      for (const picture of pictures)
        expect(
          picture.drawn <= picture.room + 0.75,
          `${width} screen ${screen}: the ${picture.size} picture draws ${picture.drawn.toFixed(1)}px in ${picture.room.toFixed(1)}px`,
        );
      if (screen === 1) await capture(`fits-1-${width}`);
    }
  }

  // ---- 4. The sidebar's edge.
  await page.setViewportSize(NARROW);
  await open("/");
  const rail = page.locator("[data-slot=sidebar-rail]");
  const state = () => page.locator("[data-slot=sidebar]").first().getAttribute("data-state");
  /** The edge's box once the sidebar has stopped moving (it folds and opens in 200ms). */
  const railBox = async () => {
    let last = null;
    for (let tries = 0; tries < 20; tries++) {
      const box = await rail.boundingBox();
      if (box && last && box.x === last.x && box.width === last.width) return box;
      last = box;
      await page.waitForTimeout(150);
    }
    throw new Error("the sidebar's edge kept moving");
  };
  const drag = async (dx) => {
    const box = await railBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(x + (dx * step) / 10, y);
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  const reopen = async () => {
    if ((await state()) !== "expanded") {
      await page.keyboard.press("Control+b");
      await page.waitForTimeout(600);
    }
  };
  await drag(-140);
  expect((await state()) === "collapsed", "a drag from the edge toward the page folds the sidebar");
  // The capture comes after the drags: a full-page capture between two drags ate the second press.
  await drag(140);
  expect((await state()) === "expanded", "a drag from the folded edge outward opens it again");
  await drag(-140);
  await capture("edge-dragged-folded");
  await reopen();
  await drag(80);
  expect((await state()) === "expanded", "a drag outward on an open sidebar leaves it open");
  const box = await railBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  expect((await state()) === "collapsed", "a click on the edge still folds the sidebar");
  await reopen();

  // ---- 5. Running keeps its order while its sessions work.
  await page.setViewportSize(DESKTOP);
  await open("/");
  await showRunning();
  let reads = 0;
  const base = Date.now();
  await page.route("**/trpc/**", async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    if (!text.includes(older) && !text.includes(newer))
      return route.fulfill({ response, body: text });
    reads += 1;
    // Each read says the other one did something last.
    const latest = reads % 2 === 1 ? older : newer;
    const body = JSON.parse(text);
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const id = node.session?.id;
      if (id === older || id === newer)
        node.session.updatedAt = new Date(base + (id === latest ? 60_000 : 0)).toISOString();
      for (const value of Object.values(node)) walk(value);
    };
    walk(body);
    await route.fulfill({ response, json: body });
  });
  const order = () =>
    inbox()
      .getByRole("region", { name: "Running", exact: true })
      .locator("a[data-session-id]")
      .evaluateAll(
        (links, ids) =>
          links
            .map((link) => link.getAttribute("data-session-id"))
            .filter((id) => ids.includes(id)),
        [older, newer],
      );
  const orders = [];
  for (let round = 1; round <= 3; round++) {
    await page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions"]],
      }),
    );
    await page.waitForTimeout(1_500);
    orders.push((await order()).map((id) => (id === newer ? "newer" : "older")).join(" / "));
  }
  await page.unroute("**/trpc/**");
  expect(
    reads >= 2 && orders.every((each) => each === "newer / older"),
    `Running stays newest made first over ${reads} reads that each said the other one worked last: ${orders.join(" | ")}`,
  );
  await capture("running-order");

  // ---- 6. No Open session in a row's menus.
  await sessionRow(older).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Open project/ }).waitFor();
  const rightClick = await menuNames();
  expect(
    !rightClick.some((name) => name.startsWith("Open session")),
    `the sidebar row's right-click menu reads ${rightClick.join(" | ")}`,
  );
  await capture("row-right-click-menu");
  await page.keyboard.press("Escape");
  await settled();
  await sessionRow(older).hover();
  await inbox()
    .locator("li")
    .filter({ has: page.locator(`a[data-session-id="${older}"]`) })
    .getByRole("button", { name: /^Actions for / })
    .click();
  await page.getByRole("menuitem", { name: /^Open project/ }).waitFor();
  const dots = await menuNames();
  expect(
    !dots.some((name) => name.startsWith("Open session")),
    `the sidebar row's "…" reads ${dots.join(" | ")}`,
  );
  await page.keyboard.press("Escape");
  await settled();
  await sessionRow(older).click();
  await page.waitForURL(new RegExp(`/sessions/${older}$`));
  note("a click on the sidebar row opened its session");
  await open(`/projects/${project.id}`);
  const table = page.getByRole("table", { name: "Sessions" });
  const tableRow = table
    .locator("tr")
    .filter({ has: page.locator(`a[href$="/sessions/${older}"]`) });
  await tableRow.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: /^Copy link/ }).waitFor();
  const projectMenu = await menuNames();
  expect(
    !projectMenu.some((name) => name.startsWith("Open session")),
    `the project page's row "…" reads ${projectMenu.join(" | ")}`,
  );
  await capture("project-row-menu");
  await page.keyboard.press("Escape");
  await settled();
  await tableRow.locator(`a[href$="/sessions/${older}"]`).click();
  await page.waitForURL(new RegExp(`/sessions/${older}$`));
  note("a click on the project page's row opened its session");

  // ---- 7. A skill's header: no "…" for one more action.
  const mutate = (path, input) =>
    page.evaluate(
      async ([route, value]) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target.mutate(value);
      },
      [path, input],
    );
  const skillName = `second-pass-${Date.now().toString(36).slice(-4)}`;
  const about = "A skill this recipe removes again.";
  const made = await mutate("skills.create", {
    scope: "user",
    projectId: null,
    name: skillName,
    description: about,
    files: [
      {
        path: "SKILL.md",
        contents: `---\nname: ${skillName}\ndescription: ${about}\n---\n\nNothing here.\n`,
      },
    ],
  });
  try {
    await page.setViewportSize(DESKTOP);
    await open(`/skills/${made.skill.id}`);
    const header = page.locator("article header").filter({ visible: true }).first();
    await header.getByRole("button", { name: "Edit skill" }).waitFor();
    const more = await header.getByRole("button", { name: /^More for / }).count();
    const remove = header.getByRole("button", { name: "Remove skill", exact: true });
    expect(
      more === 0 && (await remove.count()) === 1,
      `a skill's header has Edit skill and Remove skill, and ${more} "…"`,
    );
    await capture("skill-header");
    await remove.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: `Remove ${skillName}?` }).waitFor();
    await capture("skill-remove-asks");
    await dialog.getByRole("button", { name: "Remove skill", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    note("Remove skill asked first, then removed the skill");
  } finally {
    await mutate("skills.remove", { skillId: made.skill.id }).catch(() => undefined);
  }

  // ---- 7. Someone else's shell: the session's own terminal.
  await open(`/sessions/${older}/terminal`);
  const shells = page.getByRole("list", { name: "Open shells" }).filter({ visible: true }).first();
  await shells.waitFor();
  // The row's button shows while the row is pointed at.
  await shells.getByRole("listitem").first().hover();
  const copies = await shells
    .getByRole("button", { name: /^Copy the working directory of / })
    .count();
  expect(copies >= 1, `the session's own shell has a Copy working directory button (${copies})`);
  await capture("terminal-shells");

  // ---- 7. A member's own row in Members: Leave as its own button.
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!paths.includes("organization.current") && !paths.includes("organizations.list"))
      return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const list = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      const data = list[index]?.result?.data;
      if (!data) return;
      if (path === "organization.current") data.json = { ...data.json, role: "member" };
      if (path === "organizations.list" && Array.isArray(data.json) && data.json.length === 1) {
        const copy = structuredClone(data.json[0]);
        copy.organization = {
          ...copy.organization,
          id: "00000000-0000-4000-8000-000000001229",
          name: "Second organization",
        };
        data.json.push(copy);
        for (const [key, value] of Object.entries(data.meta?.values ?? {}))
          if (key.startsWith("0.")) data.meta.values[key.replace(/^0\./, "1.")] = value;
      }
    });
    await route.fulfill({ response, json: body });
  });
  await open("/settings/organization/members");
  // The page arrived with the server's reads: read them again through the recorded answers.
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  const leave = page.getByRole("button", { name: /^Leave .+…$/ }).filter({ visible: true });
  await leave.first().waitFor();
  expect(
    (await leave.count()) === 1 &&
      (await page.getByRole("button", { name: "Your membership" }).count()) === 0,
    "a member's own row has a Leave button and no …",
  );
  await capture("members-member-leave");
  await leave.first().click();
  await page.getByRole("dialog").waitFor();
  await capture("members-member-leave-asks");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.unroute("**/trpc/**");
  note("a member's Leave button opened the leave dialog, closed unsent");

  if (failures.length > 0) throw new Error(`not as expected: ${failures.join("; ")}`);
};
