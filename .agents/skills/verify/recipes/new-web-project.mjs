// A project's page in the new web app (route PR 28, SLNT-1136): its header, facts and tabs, the
// Sessions tab, starting a shell or a session from it, and Set up this project. Run its CLI batch
// first (a fake Codex login, an ended session with a change, one
// with none, and a running one in verify-fixture):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-project-setup.json
//   pnpm verify drive new-web --recipe new-web-project
//
// Feature ids: `project-page` (adopt-project.md: the project opens at its address with its header,
// facts and tabs), `shell-session-web` (session-shell.md: Open shell starts a shell session and
// opens it), `start-in-worktree` (start-session.md: another session in an existing worktree, from
// a row's "…"), `handoff-row` (handoff.md: a handed-off worktree's row says so; read from the
// rows, since a handoff needs a checkout on another machine), `model-shown` (models.md: a row
// shows its model), `join-line` (per-person-homes.md: said when someone else's session runs in the
// worktree; one account here, so the recipe notes it is absent). Also: the filters in the address
// survive a reload; Set up this project, its no-agent state and its start; an empty project; a
// clone's page while it runs and its move to the project; the old setup page's address; a project
// that fails to load and one that doesn't exist; the phone width.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// Big enough (about 40 seconds) to watch a clone's page.
const BIG_REPOSITORY = "https://github.com/godotengine/godot.git";

const visible = (locator) => locator.filter({ visible: true }).first();

/** The request that makes and launches a session (SLNT-1239), alone or in a tRPC batch. */
const starts = (url) => /\/trpc\/(?:[^?]*,)?sessions\.start(?=[,?]|$)/.test(url.href);

export default async ({ page, web, capture, note }) => {
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
  /** React has taken the page over, so clicks, typing and the router reach it. */
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
    await hydrated();
    // The dev server may reload the page once as it bundles a module it hadn't seen: wait it out.
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const text = (words) => visible(page.getByText(words));
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const dialog = () => visible(page.getByRole("dialog"));
  const menuitem = (name) => visible(page.getByRole("menuitem", { name }));
  const path = () => new URL(page.url()).pathname;
  /** A tRPC call from the page, as the signed-in person. */
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: at, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of at.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined && answer !== false) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  /** Rewrite one read in tRPC's answers while the page holds the route. */
  const rewrite = (procedure, change) =>
    page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      const at = paths.indexOf(procedure);
      if (at === -1) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const entry = Array.isArray(body) ? body[at] : body;
      entry.result.data.json = change(entry.result.data.json);
      return route.fulfill({ response, json: body });
    });
  const started = [];
  /** The session page a start opened, as its id. */
  const landedOnSession = async (what) => {
    const id = await waitFor(
      `${what} opening its session`,
      () => /^\/sessions\/([^/]+)$/.exec(path())?.[1],
      60,
    );
    started.push(id);
    return id;
  };
  const stopAll = async () => {
    for (const id of started.splice(0))
      await call("sessions.stop", { id }, "mutate").catch(() => undefined);
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/projects");
  const me = await call("organization.current");
  const organization = me.organization.name;
  const fixture = (await call("projects.list")).find((entry) => entry.name === "verify-fixture");
  if (fixture === undefined) throw new Error("no project verify-fixture on this stack");
  const suffix = Math.random().toString(36).slice(2, 6);
  // Projects an earlier run of this recipe left when it stopped partway go first.
  const LEFT = /^(page-empty|page-clone)-[a-z0-9]{4}$/;
  for (const project of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  // So are the shells and agent sessions it started there: only the CLI batch's `mend run`
  // sessions are meant to run in verify-fixture.
  for (const each of (await call("projects.detail", { id: fixture.id })).sessions)
    if (each.harness !== "run" && ["starting", "running", "waiting", "idle"].includes(each.status))
      await call("sessions.stop", { id: each.id }, "mutate").catch(() => undefined);

  // project-page: the Projects row opens the project at its address.
  await visible(
    page.getByRole("main").getByRole("link", { name: "verify-fixture", exact: true }),
  ).click();
  await page.waitForURL(`**/projects/${fixture.id}`);
  const nav = page.getByRole("navigation", { name: "verify-fixture project" }).first();
  await nav.waitFor();
  for (const tab of ["Sessions", "Worktrees", "Resources", "Skills"])
    await nav.getByRole("link", { name: new RegExp(`^${tab}`) }).waitFor();
  if ((await nav.getByRole("link", { name: /^Sessions/ }).getAttribute("aria-current")) !== "page")
    throw new Error("Sessions isn't the open tab");
  const facts = await visible(page.getByRole("list", { name: "About this project" })).innerText();
  if (!facts.includes("Default branch")) throw new Error(`the facts read ${facts}`);
  await page.getByRole("table", { name: "Sessions" }).waitFor();
  await both("sessions-desktop");
  const table = page.getByRole("table", { name: "Sessions" });
  // The `mend run` session is titled by its worktree; sessions started in it later share the
  // worktree but not the title.
  const runningRow = table
    .getByRole("row")
    // By its worktree's cell: an unnamed `mend run` session reads New session since SLNT-1230.
    .filter({ has: page.getByRole("cell", { name: "project-running", exact: true }) })
    .filter({ has: page.getByRole("cell", { name: "Running", exact: true }) })
    .first();
  await runningRow.waitFor();
  note(
    `project-page: /projects/${fixture.id} shows verify-fixture, the tabs ${(await nav.innerText()).replace(/\s+/g, " ")}, and the facts ${facts.replace(/\s+/g, " ")}`,
  );
  note(
    `model-shown, handoff-row: the running row reads ${(await runningRow.innerText()).replace(/\s+/g, " ")}`,
  );

  // The filters live in the address, and survive a reload.
  const search = visible(page.getByRole("searchbox", { name: "Search sessions" }));
  await search.fill("project-running");
  await page.waitForURL(/[?&]q=project-running/);
  await text(/of \d+ open sessions? match/).waitFor();
  await both("filtered-desktop");
  await page.reload();
  await hydrated();
  await text(/of \d+ open sessions? match/).waitFor();
  if ((await search.inputValue()) !== "project-running")
    throw new Error("the search didn't survive a reload");
  note(`filters in the address: ${page.url()} keeps the search across a reload`);
  await button("Clear filters").click();
  await page.waitForURL((url) => !url.search.includes("q="));
  await page.getByRole("tab", { name: "Mine" }).click();
  await page.waitForURL(/who=mine/);
  await page.getByRole("tab", { name: "Stopped" }).click();
  await page.waitForURL(/show=stopped/);
  // project-ended changed a file, so it waits under Open, for review; project-stopped changed none.
  await table.getByRole("row").filter({ hasText: "project-stopped" }).waitFor();
  await both("stopped-mine-desktop");
  await button("Filter sessions").click();
  await page.getByRole("menuitemradio", { name: "Any agent" }).waitFor();
  await capture("filter-menu-desktop-light");
  await page.keyboard.press("Escape");
  note(`Mine and Stopped: ${page.url()} lists project-stopped, which ended with no change`);
  await page.getByRole("tab", { name: "Everyone" }).click();
  await page.getByRole("tab", { name: "Open" }).click();
  await page.waitForURL((url) => url.search === "");

  // start-in-worktree and shell-session-web from a row's "…".
  await runningRow.getByRole("button", { name: /^Actions for / }).click();
  await menuitem(/^New session in project-running/).hover();
  await menuitem("Codex").waitFor();
  await capture("row-menu-desktop-light");
  const join = await page.getByText(/session is running in this worktree/).count();
  note(
    `join-line: ${join === 0 ? "absent, as it should be: only this account's sessions run in project-running" : "shown"}`,
  );
  await menuitem("Codex").click();
  const inWorktree = await landedOnSession("New session in project-running");
  const inWorktreeRead = await call("sessions.detail", { id: inWorktree }).catch(() => null);
  note(
    `start-in-worktree: New session in project-running → Codex opened /sessions/${inWorktree}${inWorktreeRead === null ? "" : ` (harness ${inWorktreeRead.session?.harness ?? "?"}, worktree ${inWorktreeRead.session?.branch ?? "?"})`}`,
  );
  await go(`/projects/${fixture.id}`);
  await runningRow.waitFor();
  await runningRow.getByRole("button", { name: /^Actions for / }).click();
  await menuitem(/^Open shell in project-running/).click();
  const shellIn = await landedOnSession("Open shell in project-running");
  note(`shell-session-web: Open shell in project-running opened /sessions/${shellIn}`);

  // Open shell in the header, in a new worktree; then the project's "…".
  await go(`/projects/${fixture.id}`);
  await button("Open shell").click();
  await menuitem(/^A new worktree from /).waitFor();
  await capture("open-shell-menu-desktop-light");
  await menuitem(/^A new worktree from /).click();
  const shellNew = await landedOnSession("Open shell in a new worktree");
  note(`shell-session-web: Open shell → a new worktree opened /sessions/${shellNew}`);
  await go(`/projects/${fixture.id}`);
  await button("verify-fixture menu").click();
  await menuitem("Set up this project…").waitFor();
  await both("project-menu-desktop");

  // Set up this project: the dialog, its no-agent state, and its start.
  await menuitem("Set up this project…").click();
  await page.waitForURL(/[?&]setup=/);
  await dialog().getByRole("heading", { name: "Set up this project" }).waitFor();
  await dialog().getByRole("radio", { name: /Codex/ }).waitFor();
  await both("setup-desktop");
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (page.url().includes("setup=")) throw new Error(`Cancel left ${page.url()}`);
  await rewrite("platform.sealantIdentity", (identity) => ({ ...identity, accounts: [] }));
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["platform", "sealantIdentity"]],
    }),
  );
  await button("verify-fixture menu").click();
  await menuitem("Set up this project…").click();
  await text("No agent connected.").waitFor();
  if (!(await dialog().getByRole("button", { name: "Start setup session" }).isDisabled()))
    throw new Error("Start setup session is on with no agent connected");
  await both("fixture-setup-no-agent-desktop");
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await page.unroute("**/trpc/**");
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["platform", "sealantIdentity"]],
    }),
  );
  note("fixture, no agent connected: the dialog links to Agent logins and Start stays off");
  // The old setup page's address opens the dialog; the start is held a moment to see Starting….
  await go(`/projects/${fixture.id}/setup-session`);
  await page.waitForURL(/[?&]setup=/);
  if (path() !== `/projects/${fixture.id}`) throw new Error(`setup-session went to ${page.url()}`);
  await dialog().getByRole("radio", { name: /Codex/ }).waitFor();
  note(`/projects/${fixture.id}/setup-session redirects to ${page.url()} with the dialog open`);
  await page.route(starts, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await dialog().getByRole("button", { name: "Start setup session" }).click();
  await dialog().getByRole("button", { name: "Starting…" }).waitFor();
  await capture("setup-starting-desktop-light");
  const setupSession = await landedOnSession("Start setup session");
  await page.unroute(starts);
  const setupRead = await call("sessions.detail", { id: setupSession }).catch(() => null);
  note(
    `Start setup session opened /sessions/${setupSession}${setupRead === null ? "" : `, purpose ${setupRead.session?.purpose ?? "?"}`}`,
  );
  await stopAll();
  note("stopped the sessions this drive started");

  // An empty project: No sessions yet, with Set up this project….
  const empty = `page-empty-${suffix}`;
  const made = await call("projects.createNew", { name: empty }, "mutate");
  await go(`/projects/${made.id}`);
  await page.getByRole("heading", { name: "No sessions yet" }).waitFor();
  await both("empty-desktop");
  await button("Set up this project…").click();
  await dialog().getByRole("heading", { name: "Set up this project" }).waitFor();
  await dialog().getByRole("button", { name: "Cancel" }).click();
  note(`an empty project (${empty}): No sessions yet, and Set up this project… opens the dialog`);

  // The phone: the page, a row's actions, the project's actions, the setup sheet.
  await page.setViewportSize(PHONE);
  await go(`/projects/${fixture.id}`);
  await settled();
  await visible(page.getByRole("list", { name: "Sessions" })).waitFor();
  await both("sessions-phone");
  await visible(page.getByRole("searchbox", { name: "Search sessions" })).fill("project");
  await both("filtered-phone");
  const phoneRow = visible(
    page
      .getByRole("list", { name: "Sessions" })
      .getByRole("listitem")
      .filter({ hasText: "project-running" }),
  );
  await phoneRow.getByRole("button", { name: /^Actions for / }).click();
  await visible(page.getByRole("menuitem", { name: /^Open shell in/ })).waitFor();
  await both("row-actions-phone");
  await page.keyboard.press("Escape");
  await settled();
  await visible(page.getByRole("button", { name: "verify-fixture actions" })).click();
  await visible(page.getByRole("menuitem", { name: "Set up this project…" })).waitFor();
  await both("project-actions-phone");
  await visible(page.getByRole("menuitem", { name: "Set up this project…" })).click();
  await dialog().getByRole("heading", { name: "Set up this project" }).waitFor();
  const touch =
    (await dialog().getByRole("button", { name: "Start setup session" }).boundingBox())?.height ??
    0;
  if (touch < 44) throw new Error(`Start setup session is ${touch}px tall on a phone`);
  await both("setup-phone");
  await dialog().getByRole("button", { name: "Cancel" }).click();
  await go(`/projects/${made.id}`);
  await page.getByRole("heading", { name: "No sessions yet" }).waitFor();
  await both("empty-phone");
  note("phone: the list, a row's and the project's action sheets, and the setup sheet (44px)");
  await page.setViewportSize(DESKTOP);

  // A clone's page while it runs, then its project once it finishes.
  const cloneName = `page-clone-${suffix}`;
  const adoptionId = crypto.randomUUID();
  await page.evaluate(
    ({ name, source, id }) => {
      void window["__TSR_ROUTER__"].options.context.trpcClient.projects.adopt
        .mutate({ name, source, visibility: "private", adoptionId: id })
        .catch(() => undefined);
    },
    { name: cloneName, source: BIG_REPOSITORY, id: adoptionId },
  );
  await go(`/projects/${adoptionId}`);
  await page.getByRole("heading", { name: /^Cloning / }).waitFor({ timeout: 30_000 });
  await both("cloning-desktop");
  await page.setViewportSize(PHONE);
  await both("cloning-phone");
  await page.setViewportSize(DESKTOP);
  // New session on a cloning project opens the composer on the clone. The composer knows a clone
  // by the key this browser kept when it started it, as Add project keeps it.
  await page.evaluate(
    ({ owner, attempt }) => localStorage.setItem(`mend-adoption.${owner}`, JSON.stringify(attempt)),
    {
      owner: me.userId,
      attempt: {
        id: adoptionId,
        name: cloneName,
        startedAt: Date.now(),
        source: BIG_REPOSITORY,
        visibility: "private",
      },
    },
  );
  await button("New session").click();
  await page.waitForURL((url) => url.pathname === "/");
  await visible(page.getByRole("button", { name: `Project: ${cloneName}` })).waitFor();
  await capture("cloning-new-session-desktop-light");
  note(`New session on the cloning page opened the composer on ${cloneName}, still cloning`);
  await go(`/projects/${adoptionId}`);
  const cloned = await waitFor(
    "the clone's page moving to its project",
    () => (path() !== `/projects/${adoptionId}` ? path() : null),
    240,
  );
  await page
    .getByRole("navigation", { name: `${cloneName} project` })
    .first()
    .waitFor();
  note(`a clone's page at /projects/${adoptionId} showed its progress, then moved to ${cloned}`);

  // Not found, and a project that fails to load.
  await go("/projects/no-such-project");
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
  await capture("not-found-desktop-light");
  await page.route("**/trpc/**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const failure = {
      error: {
        json: {
          message: "The verify recipe failed this read on purpose.",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
        },
      },
    };
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(url.searchParams.has("batch") ? calls.map(() => failure) : failure),
    });
  });
  await go("/projects");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go(`/projects/${fixture.id}`);
  await page.getByRole("heading", { name: "This page didn't load" }).waitFor();
  await both("error-desktop");
  await page.setViewportSize(PHONE);
  await both("error-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await page.getByRole("navigation", { name: "verify-fixture project" }).first().waitFor();
  note("a project that fails to load shows the error screen; Try again reads it again");

  // Put back what this drive changed: the projects it made are removed and purged.
  await stopAll();
  await page.evaluate((owner) => localStorage.removeItem(`mend-adoption.${owner}`), me.userId);
  const listed = await call("projects.list");
  for (const name of [empty, cloneName]) {
    const project = listed.find((entry) => entry.name === name);
    if (project !== undefined)
      await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  }
  for (const project of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
  note(`removed the projects this drive made (suffix ${suffix}) and purged what the server let go`);
  note(`signed in to ${organization} as ${me.userId}`);
};
