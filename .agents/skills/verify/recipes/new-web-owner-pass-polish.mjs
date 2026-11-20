// Four things from the owner's pass of 20 Nov 2026 (SLNT-1201), on a local stack:
//
//   pnpm verify drive new-web --recipe new-web-owner-pass-polish
//
// - The agent's screen is on by default: the organization's Workspace image, which the stack made
//   with nothing saved, reads Screen on; a project added now (Spoon-Knife, from GitHub) opens its
//   image editor with Screen on, and a shell session started there gets a live screen. After the
//   owner turns the organization's Screen off, the next project starts without one and the first
//   keeps its own. Migration 0234's effect on saved images is the box's (a local stack starts
//   empty); its Postgres test covers it here.
// - The project's Sessions tab counts what it shows, and with nothing open says how to see the
//   stopped sessions; no match says so with Clear filters; Projects with no match likewise.
// - Empty states sit in the middle of the space they're in: the project's Skills tab with no
//   skills, and every other empty state the stack shows, each measured against its container.
// - Settings sections stand apart: Agent logins and Git, and the organization's General page.
// - Executor's runner choice, before Executor is set up, always has one option selected, and the
//   header has the one action that sets it up. Real on the stack: Executor not set up, as the stack
//   has it. Recorded answers (tRPC answers this recipe writes): this server can't run Executor (Use
//   your own is selected), saving your own address (refused, then saved), and Executor set up by
//   Mend (picking the selected option again opens nothing; the other opens its dialog).
//
// Captures are named `<what>-<desktop|phone>-<light|dark>`; recorded states start `fixture-`.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
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
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const shot = async (name) => {
    await page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
  };
  /** Light and dark at the current width. */
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`${name}-${theme}`);
    }
    await paint("light");
  };
  const width = async (size) => {
    await page.setViewportSize(size === "phone" ? PHONE : DESKTOP);
    await settled();
  };
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );

  /** How far the empty state's middle sits from its container's, across, in px. */
  const offCentre = () =>
    page.evaluate(() => {
      const empty = [...document.querySelectorAll('[data-slot="empty"][data-kind="page"]')].find(
        (each) => each.getBoundingClientRect().width > 0,
      );
      if (empty === undefined) return null;
      const box = empty.getBoundingClientRect();
      const title = empty.querySelector('[data-slot="empty-title"]');
      const middle = (title ?? empty).getBoundingClientRect();
      let host = empty.parentElement;
      while (host !== null && host.getBoundingClientRect().width <= box.width + 1)
        host = host.parentElement;
      const space = (host ?? document.body).getBoundingClientRect();
      return {
        across: Math.round(middle.left + middle.width / 2 - (space.left + space.width / 2)),
        emptyWidth: Math.round(box.width),
        spaceWidth: Math.round(space.width),
      };
    });
  // tRPC answers this recipe writes, by procedure: `{ json }` or `{ error }`.
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
    const real = paths.some((p) => !stubs.has(p)) ? await route.fetch() : null;
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = real === null ? 200 : real.status();
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.error !== undefined) {
        status = paths.length === 1 ? 422 : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422 },
            },
          },
        };
      }
      return { result: { data: { json: stub.json } } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await width("desktop");
  await page.goto(`${web}/settings/profile`);
  await hydrated();
  await heading("Profile");

  // --- 15. Settings sections stand apart ---------------------------------------------------------
  /** The space above each section's heading on this page, in px, from the browser's layout. */
  const sectionGaps = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("section[aria-label]")]
        .filter((section) => section.querySelector(":scope > div > div > h2") !== null)
        .map(
          (section) =>
            `${section.getAttribute("aria-label")} ${getComputedStyle(section).marginTop}`,
        ),
    );
  for (const [path, name, slug] of [
    ["/settings/agent-logins", "Agent logins and Git", "settings-agent-logins"],
    ["/settings/organization", "General", "settings-organization-general"],
  ]) {
    await navigate(path);
    await heading(name);
    await settled();
    note(`${name}: the space above each section: ${(await sectionGaps()).join(", ")}`);
    await width("desktop");
    await both(`${slug}-desktop`);
    await width("phone");
    await both(`${slug}-phone`);
    await width("desktop");
  }

  // --- 17. Executor's runner choice --------------------------------------------------------------
  const runner = () => visible(page.getByRole("group", { name: "Who runs Executor" }));
  const pressed = async () =>
    page
      .locator('[aria-label="Who runs Executor"] [data-slot="segmented-item"]')
      .filter({ visible: true })
      .evaluateAll((items) =>
        items.filter((item) => item.hasAttribute("data-pressed")).map((item) => item.textContent),
      );
  const header = () =>
    visible(page.locator("h2", { hasText: /^Executor$/ }).locator("xpath=ancestor::div[2]"));
  await navigate("/settings/organization/integrations");
  await heading("Integrations");
  await visible(page.getByText("Not set up.", { exact: true })).waitFor();
  await runner()
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  const real = await client(async (trpc) => trpc.executor.configuration.query(), null);
  note(
    `as the stack has it: executor.configuration answers mode ${real.mode}, mendRunAvailable ${real.mendRunAvailable}; selected: ${JSON.stringify(await pressed())}; header buttons: ${JSON.stringify(await header().getByRole("button").allTextContents())}`,
  );
  if ((await pressed()).length !== 1) throw new Error("the runner choice has no single selection");
  await width("desktop");
  await both("integrations-executor-not-set-up-desktop");
  await width("phone");
  await both("integrations-executor-not-set-up-phone");
  await width("desktop");

  // Use your own: the address field shows, and the header's action saves it.
  stubs.set("executor.configure", { error: "Mend couldn't reach an Executor at that address." });
  const own = visible(
    page.locator('[aria-label="Who runs Executor"] [data-slot="segmented-item"]', {
      hasText: "Use your own",
    }),
  );
  await own.click();
  await visible(page.getByLabel("Your Executor's address")).waitFor();
  note(
    `Use your own: selected ${JSON.stringify(await pressed())}; header button ${JSON.stringify(await header().getByRole("button").allTextContents())}`,
  );
  await both("integrations-executor-own-desktop");
  await visible(page.getByRole("button", { name: "Set up Executor", exact: true })).click();
  await settled();
  if (sent.has("executor.configure")) throw new Error("an empty address was sent");
  note("Set up Executor with no address sends nothing");
  await page.getByLabel("Your Executor's address").fill("https://executor.northwind.example");
  await page.getByLabel("Your Executor's address").press("Enter");
  await visible(page.getByText("Mend couldn't reach an Executor at that address.")).waitFor();
  note(`Enter in the field sends executor.configure ${sent.get("executor.configure")}`);
  await shot("fixture-integrations-executor-own-refused-desktop-light");
  sent.delete("executor.configure");
  stubs.set("executor.configure", { json: null });
  stubs.set("executor.configuration", {
    json: {
      ...real,
      mode: "own",
      url: "https://executor.northwind.example",
      member: { state: "unlinked", observedAt: null },
    },
  });
  await visible(page.getByRole("button", { name: "Set up Executor", exact: true })).click();
  await visible(page.getByText("Saved your Executor's address.")).waitFor();
  await visible(
    page.getByText("Your own Executor at https://executor.northwind.example."),
  ).waitFor();
  note(
    `the header's Set up Executor sends ${sent.get("executor.configure")}; the page then reads "Your own Executor at https://executor.northwind.example." with ${JSON.stringify(await pressed())} selected`,
  );
  await shot("fixture-integrations-executor-own-saved-desktop-light");

  // This server can't run Executor: Use your own is selected and Mend runs it is disabled.
  stubs.set("executor.configuration", { json: { ...real, mode: null, mendRunAvailable: false } });
  await reread();
  await visible(page.getByText("Not set up.", { exact: true })).waitFor();
  await page.waitForTimeout(800);
  const mendRun = visible(
    page.locator('[data-slot="segmented-item"]', { hasText: "Mend runs it" }),
  );
  note(
    `mendRunAvailable false: selected ${JSON.stringify(await pressed())}; Mend runs it disabled: ${await mendRun.isDisabled()}`,
  );
  if (JSON.stringify(await pressed()) !== JSON.stringify(["Use your own"]))
    throw new Error("with Mend unable to run Executor, Use your own isn't the one selected");
  await shot("fixture-integrations-executor-no-mend-run-desktop-light");

  // Mend runs it, set up: the selected option opens nothing; the other opens its dialog.
  stubs.set("executor.configuration", {
    json: {
      ...real,
      mode: "mend-run",
      url: null,
      mendRunAvailable: true,
      member: { state: "active", observedAt: null },
      managed: {
        available: true,
        reason: null,
        state: "running",
        observedAt: null,
        image: "ghcr.io/rhyssullivan/executor:v1.4.2",
        releaseImage: "ghcr.io/rhyssullivan/executor:v1.4.2",
        memoryBytes: 1.5 * 1024 ** 3,
        backupAt: null,
        retained: true,
      },
    },
  });
  stubs.set("executor.directory", { json: { services: [] } });
  await reread();
  await visible(page.getByText(/^Running/)).waitFor();
  await mendRun.click();
  await settled();
  // The toasts are dialogs too; the confirm dialog is the one with its own heading.
  if (await page.getByRole("heading", { name: /^Let Mend run Executor/ }).isVisible())
    throw new Error("picking the selected option opened a dialog");
  await visible(page.locator('[data-slot="segmented-item"]', { hasText: "Use your own" })).click();
  await heading("Use your own Executor");
  note("set up by Mend: Mend runs it again opens nothing; Use your own opens its dialog");
  await page.keyboard.press("Escape");
  stubs.clear();

  // --- 3. The agent's screen is on by default ----------------------------------------------------
  const projects = () => client(async (trpc) => trpc.projects.list.query(), null);
  const imageOf = async (id) =>
    (await client(async (trpc, project) => trpc.projects.detail.query({ id: project }), id)).project
      .workspaceImage;
  /** Add Spoon-Knife as a new project, as anyone would, and wait until it is listed. */
  const addProject = async (prefix) => {
    const name = `${prefix}-${Date.now().toString(36).slice(-4)}`;
    await client(
      async (trpc, project) =>
        trpc.projects.adopt.mutate({
          name: project,
          source: "https://github.com/octocat/Spoon-Knife.git",
        }),
      name,
    );
    for (let tries = 0; tries < 90; tries += 1) {
      const found = (await projects()).find((p) => p.name === name);
      if (found !== undefined) return found;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${name} wasn't added`);
  };
  /** The project's Screen switch, as its image editor opens with it; closed without saving. */
  const projectScreen = async (projectId, name) => {
    await page.goto(`${web}/projects/${projectId}/settings/workspace`);
    await hydrated();
    await visible(page.getByRole("button", { name: "Edit image…" })).click();
    const screenSwitch = visible(page.getByRole("switch", { name: "Screen for the agent" }));
    await screenSwitch.waitFor({ timeout: 30_000 });
    await screenSwitch.scrollIntoViewIfNeeded();
    const checked = await screenSwitch.getAttribute("aria-checked");
    await shot(name);
    await page.keyboard.press("Escape");
    return checked;
  };

  // The organization's starting image, which the stack made with nothing saved.
  await page.goto(`${web}/settings/organization/workspace-image`);
  await hydrated();
  const orgScreen = visible(
    page.locator('[data-slot="setting-row"]', { hasText: "Screen for the agent" }),
  );
  await orgScreen.waitFor({ timeout: 30_000 });
  await orgScreen.scrollIntoViewIfNeeded();
  note(
    `the organization's Workspace image page reads ${JSON.stringify((await orgScreen.innerText()).replace(/\s+/g, " "))}`,
  );
  await shot("organization-workspace-image-desktop-light");

  // A project added now, with no setting saved anywhere, copies it.
  const fresh = await addProject("screen-default");
  note(
    `${fresh.name}, added with nothing saved, has the image ${JSON.stringify(await imageOf(fresh.id))}`,
  );
  note(
    `${fresh.name}'s image editor opens with Screen for the agent ${await projectScreen(fresh.id, "project-workspace-screen-on-desktop-light")}`,
  );

  // A session there gets a live screen, with nothing about the screen changed.
  const startShell = async (projectId) => {
    const worktree = await client(
      async (trpc, [project, name]) =>
        trpc.worktrees.create.mutate({ projectId: project, worktree: { name, base: null } }),
      [projectId, `screen-${Date.now().toString(36)}`],
    );
    const shell = await client(
      async (trpc, tree) =>
        trpc.worktrees.createSession.mutate({
          id: tree,
          session: { harness: "shell", label: null },
        }),
      worktree.id,
    );
    await client(async (trpc, id) => trpc.sessions.launch.mutate({ id, request: {} }), shell.id);
    let status = "";
    for (let tries = 0; tries < 120; tries += 1) {
      status = (await client(async (trpc, id) => trpc.sessions.detail.query({ id }), shell.id))
        .session.status;
      if (!["starting", "queued", "launching", "pending"].includes(status)) break;
      await page.waitForTimeout(5_000);
    }
    return { id: shell.id, worktree: worktree.name, status };
  };
  let session = await startShell(fresh.id);
  note(`shell session ${session.id} in ${session.worktree} is ${session.status}`);
  if (session.status !== "running") {
    // A local stack's nested Docker doesn't come up (new-web-screen.mjs); the screen needs none.
    const image = await imageOf(fresh.id);
    await client(
      async (trpc, [id, workspaceImage]) =>
        trpc.projects.setWorkspaceImage.mutate({ id, request: { workspaceImage } }),
      [fresh.id, { ...image, services: { docker: false } }],
    );
    session = await startShell(fresh.id);
    note(
      `with Docker inside turned off (a local stack can't run it; Screen left as it was), shell session ${session.id} is ${session.status}`,
    );
  }
  let screen = null;
  for (let tries = 0; tries < 48; tries += 1) {
    screen = await client(async (trpc, id) => trpc.screens.read.query({ id }), session.id);
    if (screen?._tag !== "Screen" || !["NotStarted", "Starting"].includes(screen.life._tag)) break;
    await page.waitForTimeout(5_000);
  }
  note(`screens.read answers ${JSON.stringify(screen)}`);
  await page.goto(`${web}/sessions/${session.id}/screen`);
  await hydrated();
  const body = visible(page.locator('[data-tab-body="view:screen"]'));
  await body.waitFor({ timeout: 30_000 });
  await body
    .getByText(/Reading the screen/)
    .first()
    .waitFor({ state: "hidden", timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForTimeout(3_000);
  note(
    `the Screen view reads ${JSON.stringify((await body.innerText()).replace(/\s+/g, " ").trim())}`,
  );
  note(`its accessibility tree:\n${await body.ariaSnapshot()}`);
  await shot("session-screen-desktop-light");
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), session.id);
  for (let tries = 0; tries < 60; tries += 1) {
    const now = (await client(async (trpc, id) => trpc.sessions.detail.query({ id }), session.id))
      .session.status;
    if (["stopped", "completed", "failed"].includes(now)) break;
    await page.waitForTimeout(2_000);
  }
  note(`stopped session ${session.id}`);

  // The owner turns the organization's Screen off: the next project starts without one, and the
  // project that already existed keeps its own.
  const starting = (await client(async (trpc) => trpc.organization.settings.query(), null))
    .organization.workspaceImage;
  const offSaved = await client(
    async (trpc, image) =>
      trpc.organization.setWorkspaceEnvironment.mutate({ workspaceImage: image }),
    { ...starting, screen: false },
  );
  note(`the organization's Screen turned off: saved ${offSaved.saved}`);
  const later = await addProject("screen-off");
  note(`${later.name}, added after that, has the image ${JSON.stringify(await imageOf(later.id))}`);
  note(
    `${later.name}'s image editor opens with Screen for the agent ${await projectScreen(later.id, "project-after-org-off-workspace-desktop-light")}`,
  );
  note(
    `${fresh.name}, which already existed, still has screen ${(await imageOf(fresh.id)).screen}`,
  );
  await client(
    async (trpc, image) =>
      trpc.organization.setWorkspaceEnvironment.mutate({ workspaceImage: image }),
    starting,
  );
  note("put the organization's image back");

  // A project whose only session has stopped: Docker off from the start (a local stack can't run
  // it), one shell session started and stopped.
  await client(
    async (trpc, [id, workspaceImage]) =>
      trpc.projects.setWorkspaceImage.mutate({ id, request: { workspaceImage } }),
    [later.id, { ...(await imageOf(later.id)), services: { docker: false } }],
  );
  const only = await startShell(later.id);
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), only.id);
  for (let tries = 0; tries < 60; tries += 1) {
    const now = (await client(async (trpc, id) => trpc.sessions.detail.query({ id }), only.id))
      .session.status;
    if (["stopped", "completed"].includes(now)) break;
    await page.waitForTimeout(2_000);
  }
  note(`${later.name}: shell session ${only.id} was ${only.status}, then stopped`);

  // --- 14. The project's Sessions tab: its count, and what it says when nothing is in view --------
  const sessionsTab = visible(page.getByRole("link", { name: /^Sessions/ }));
  for (const project of [fresh, later]) {
    await page.goto(`${web}/projects/${project.id}`);
    await hydrated();
    await sessionsTab.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    note(
      `${project.name}'s Sessions tab reads ${JSON.stringify(await sessionsTab.innerText())}; the open list shows ${await page.locator("table tbody tr").filter({ visible: true }).count()} rows`,
    );
  }
  await shot("project-sessions-desktop-light");
  await visible(page.getByRole("heading", { name: /^Nothing open in / })).waitFor({
    timeout: 30_000,
  });
  note(
    `nothing open: ${JSON.stringify((await visible(page.locator('[data-slot="empty"]')).innerText()).replace(/\s+/g, " "))}; ${JSON.stringify(await offCentre())}`,
  );
  await width("desktop");
  await both("project-sessions-nothing-open-desktop");
  await width("phone");
  await both("project-sessions-nothing-open-phone");
  await width("desktop");
  await visible(page.getByRole("button", { name: "Show stopped sessions" })).click();
  await page.waitForURL((url) => url.searchParams.get("show") === "stopped");
  await page.waitForTimeout(800);
  note(
    `Show stopped sessions: ${await page.locator("table tbody tr").filter({ visible: true }).count()} stopped rows`,
  );
  await shot("project-sessions-stopped-desktop-light");
  await page.goto(`${web}/projects/${later.id}?show=stopped&q=nothing-matches-this`);
  await hydrated();
  await visible(page.getByRole("heading", { name: "No session matches" })).waitFor({
    timeout: 30_000,
  });
  await shot("project-sessions-no-match-desktop-light");
  await visible(page.getByRole("button", { name: "Clear filters" })).click();
  await page.waitForTimeout(800);
  note(
    `a search with no match shows No session matches; Clear filters leaves ${await page.locator("table tbody tr").filter({ visible: true }).count()} rows`,
  );

  // --- 14. Empty states sit in the middle ---------------------------------------------------------
  await page.goto(`${web}/projects/${fresh.id}/skills`);
  await hydrated();
  await visible(page.getByRole("heading", { name: /^No skills in / })).waitFor({
    timeout: 30_000,
  });
  note(`project Skills tab, no skills: ${JSON.stringify(await offCentre())}`);
  await width("desktop");
  await both("project-skills-empty-desktop");
  await width("phone");
  await both("project-skills-empty-phone");
  await width("desktop");

  await page.goto(`${web}/projects`);
  await hydrated();
  await page.getByRole("searchbox").first().fill("nothing-matches-this");
  await visible(page.getByRole("heading", { name: "No project matches" })).waitFor();
  note(`Projects, no match: ${JSON.stringify(await offCentre())}`);
  await shot("projects-no-match-desktop-light");

  // Every other empty state the stack shows, each measured the same way.
  for (const [path, name] of [
    ["/skills", "your-skills"],
    [`/projects/${fresh.id}/worktrees`, "project-worktrees"],
    [`/projects/${fresh.id}/resources`, "project-resources"],
    ["/settings/mcp-servers", "settings-mcp-servers"],
    ["/settings/organization/folders", "settings-organization-folders"],
  ]) {
    await page.goto(`${web}${path}`);
    await hydrated();
    await page.waitForTimeout(1_500);
    note(`${path}: ${JSON.stringify(await offCentre())}`);
    await shot(`empty-${name}-desktop-light`);
  }
  for (const project of [fresh, later])
    await client(async (trpc, id) => trpc.projects.remove.mutate({ id }), project.id).catch(
      () => undefined,
    );
  note(`removed ${fresh.name} and ${later.name}`);
};
