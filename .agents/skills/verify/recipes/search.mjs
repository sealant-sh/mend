// Search from anywhere in the web app (route PR 33, SLNT-1142): the command palette (⌘K, Ctrl K
// here), the sidebar's Search field and its rail's button, and on a phone the search screen.
//
//   pnpm verify drive web --recipe search
//
// No feature file yet (search is new). What it walks: nothing typed (recent sessions and the
// actions), results grouped as Actions, Sessions, Projects and Skills with the typed letters bold
// and the count, no results, each kind opened (a session, a project, a skill, New session, Add
// project…, Collapse and Expand sidebar), keyboard only (arrows, Enter, Escape, focus back where it
// was), the shortcut from the home composer, a session page and the Skills page, the sidebar's
// field and its rail's button, a list that fails to read with Try again, and the phone's screen.
// The sessions are fixture rows the recipe answers the inbox read with, titled as the frames are;
// every capture taken with them is named `fixture-…`. The projects and skills are real, made by
// the recipe and removed at the end.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// What an earlier run of this recipe left when it stopped partway.
const LEFT = /^(landing-site|payments-core|landing-checklist|release-notes)-[a-z0-9]{4}$/;

const visible = (locator) => locator.filter({ visible: true }).first();

/** React has taken the page over, so clicks, typing and the router reach it. */
const hydrated = async (on) => {
  await on.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  await on.waitForFunction(() =>
    [...document.querySelectorAll("a[href], button")].some((element) =>
      Object.keys(element).some((key) => key.startsWith("__reactProps")),
    ),
  );
};

const skillMd = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;

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
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated(page);
    // The dev server may reload the page once as it bundles a module it hadn't seen: wait it out.
    await page.waitForTimeout(1_500);
    await hydrated(page);
  };
  const go = (to, params) =>
    page.evaluate(
      ({ path, values }) =>
        window["__TSR_ROUTER__"].navigate({
          to: path,
          ...(values ? { params: values } : {}),
        }),
      { path: to, values: params },
    );
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const expectPath = async (want, what) => {
    await page
      .waitForFunction((path) => location.pathname === path, want)
      .catch(() => {
        throw new Error(`${what} went to ${page.url()}, not ${want}`);
      });
  };
  const palette = () => page.getByRole("dialog", { name: "Command palette" });
  const field = () => palette().getByRole("combobox");
  const option = (name) => palette().getByRole("option", { name: new RegExp(`^${name}`) });
  const footer = () => palette().locator("[data-slot=command-palette-footer]");
  const shortcut = () => page.keyboard.press("Control+k");
  /** Opens the palette with the shortcut from wherever focus is, and waits for it. */
  const byShortcut = async () => {
    await shortcut();
    await field().waitFor();
  };
  const typeQuery = async (words) => {
    await field().fill(words);
    await settled();
  };
  const closePalette = async () => {
    await page.keyboard.press("Escape");
    await palette().waitFor({ state: "detached" });
  };
  const headings = () =>
    palette()
      .locator("[cmdk-group-heading]")
      .evaluateAll((all) => all.map((each) => each.textContent));
  const selected = () => palette().locator("[cmdk-item][data-selected=true]").innerText();

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  await page.evaluate(() => {
    document.cookie = "mend-sidebar-expanded=; path=/; max-age=0";
  });

  // Left from a run that stopped partway, then this run's projects and skills.
  for (const skill of (await call("skills.list")).filter((each) => LEFT.test(each.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.list")).filter((each) => LEFT.test(each.name)))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.removed")).filter((each) => LEFT.test(each.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
  const suffix = Math.random().toString(36).slice(2, 6);
  const names = {
    landingProject: `landing-site-${suffix}`,
    otherProject: `payments-core-${suffix}`,
    landingSkill: `landing-checklist-${suffix}`,
    otherSkill: `release-notes-${suffix}`,
  };
  const landingProject = await call("projects.createNew", { name: names.landingProject }, "mutate");
  await call("projects.createNew", { name: names.otherProject }, "mutate");
  const skillOf = (name, description) =>
    call(
      "skills.create",
      {
        scope: "user",
        projectId: null,
        name,
        description,
        files: [{ path: "SKILL.md", contents: skillMd(name, description) }],
      },
      "mutate",
    );
  await skillOf(names.landingSkill, "Check a landing page before it ships.");
  await skillOf(names.otherSkill, "Write release notes from the merged pull requests.");
  const landingSkill = (await call("skills.list")).find((each) => each.name === names.landingSkill);
  note(
    `made projects ${names.landingProject}, ${names.otherProject} and skills ${names.landingSkill}, ${names.otherSkill}`,
  );

  // The fixture sessions, answered in place of the inbox read (and beside the stack's own rows).
  const me = (await call("organization.current")).userId;
  const fixture = fixtureRows(me);
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const at = paths.indexOf("sessions.inbox");
    if (at === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const data = { result: { data: serialized(fixture) } };
    if (Array.isArray(body)) body[at] = data;
    await route.fulfill({ response, json: Array.isArray(body) ? body : data });
  });
  // Fixtures don't survive a full load (the server renders the page): read the inbox again.
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  await visible(page.getByRole("link", { name: /^Fix flaky checkout retry/ })).waitFor();

  // The shortcut from the home composer, with the message field focused.
  const composer = visible(page.getByRole("textbox", { name: "Task" }));
  await composer.click();
  await composer.fill("Half a thought");
  await byShortcut();
  const nothingTyped = await headings();
  if (JSON.stringify(nothingTyped) !== JSON.stringify(["Recent sessions", "Actions"]))
    throw new Error(`nothing typed lists ${JSON.stringify(nothingTyped)}`);
  const recent = await palette()
    .locator("[cmdk-group]")
    .first()
    .getByRole("option")
    .evaluateAll((all) => all.map((each) => each.textContent));
  if (recent.length !== 4 || !recent[0].startsWith("Fix flaky checkout retry"))
    throw new Error(`recent sessions read ${JSON.stringify(recent)}`);
  for (const action of ["New session", "Add project…", "Collapse sidebar"])
    await option(action).waitFor();
  if (!(await selected()).startsWith("Fix flaky checkout retry"))
    throw new Error("the first recent session is not highlighted");
  const listName = await palette().getByRole("listbox").getAttribute("aria-label");
  note(
    `Ctrl K from the home composer: Recent sessions (${recent.length}), Actions; the list is a listbox named "${listName}"`,
  );
  await both("fixture-empty-desktop");

  // Results: "land" finds two sessions, a project and a skill, grouped, the typed letters bold.
  await typeQuery("land");
  const groups = await headings();
  if (JSON.stringify(groups) !== JSON.stringify(["Sessions", "Projects", "Skills"]))
    throw new Error(`"land" groups read ${JSON.stringify(groups)}`);
  await option("Update landing page pricing").waitFor();
  await option("Mobile landing screen for gift cards").waitFor();
  await option(names.landingProject).waitFor();
  await option(names.landingSkill).waitFor();
  const bold = await option("Update landing page pricing").locator("b").innerText();
  if (bold.toLowerCase() !== "land") throw new Error(`the bold part reads "${bold}"`);
  // The recipe's four, plus whatever this server's own projects and skills match (a check VM holds
  // `main-run-land`): the footer counts what the list shows.
  const shownNames = await palette()
    .getByRole("option")
    .evaluateAll((all) => all.map((each) => each.textContent ?? ""));
  const ours = [
    "Update landing page pricing",
    "Mobile landing screen for gift cards",
    names.landingProject,
    names.landingSkill,
  ];
  const extra = shownNames.filter((shown) => !ours.some((name) => shown.startsWith(name)));
  for (const name of ours)
    if (shownNames.filter((shown) => shown.startsWith(name)).length !== 1)
      throw new Error(`"land" lists ${name} other than once: ${JSON.stringify(shownNames)}`);
  await footer().getByText(`${shownNames.length} results`).waitFor();
  if (extra.length > 0) note(`"land" also finds this server's own: ${extra.join(" · ")}`);
  const announced = await palette().getByRole("listbox").getAttribute("aria-label");
  const live = await footer().locator("[aria-live]").innerText();
  note(
    `"land": ${groups.join(", ")}; "${bold}" in bold; the footer and the listbox's name say "${live}" / "${announced}"`,
  );
  await both("fixture-results-desktop");

  // No results.
  await typeQuery("helm chart");
  await palette().getByText("No results for “helm chart”").waitFor();
  await palette().getByText("Search looks at sessions, projects, skills and actions.").waitFor();
  await footer().getByText("0 results").waitFor();
  if ((await footer().getByText("Move").count()) > 0)
    throw new Error("no results still offers Move");
  note('"helm chart": No results, 0 results, the footer offers only Esc Close');
  await both("no-results-desktop");

  // Escape closes, and focus is back in the composer with what was typed.
  await closePalette();
  const back = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
  );
  if ((await composer.inputValue()) !== "Half a thought")
    throw new Error("the composer lost what was typed");
  note(`Escape closed it; focus back on ${back}; the composer still holds its words`);

  // Keyboard only: the skill, by arrows and Enter.
  await byShortcut();
  await page.keyboard.type("release");
  await settled();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  if (!(await selected()).startsWith(names.otherSkill))
    throw new Error(`the arrows left ${await selected()} highlighted`);
  await page.keyboard.press("Enter");
  await palette().waitFor({ state: "detached" });
  const releaseSkill = (await call("skills.list")).find((each) => each.name === names.otherSkill);
  await expectPath(`/skills/${releaseSkill.id}`, "Enter on the skill");
  await visible(page.getByRole("heading", { name: names.otherSkill })).waitFor();
  note(`keyboard: typed "release", ↓ ↑, Enter opened /skills/${releaseSkill.id}`);

  // From the Skills page: a project, which opens its page.
  await page.keyboard.press("Escape");
  await go("/skills");
  await visible(page.getByRole("heading", { name: "Skills", exact: true })).waitFor();
  await byShortcut();
  await typeQuery(names.landingProject);
  await option(names.landingProject).click();
  await expectPath(`/projects/${landingProject.id}`, "the project");
  await visible(page.getByRole("heading", { name: names.landingProject })).waitFor();
  note(`Ctrl K from /skills; the project opened /projects/${landingProject.id}`);

  // A session, then the shortcut from the session page.
  await go("/");
  await byShortcut();
  await typeQuery("idempotency");
  await page.keyboard.press("Enter");
  const sessionId = fixture.find((row) => row.title === "Add idempotency keys to refunds").session
    .id;
  await expectPath(`/sessions/${sessionId}`, "the session");
  await byShortcut();
  note(`a session opened /sessions/${sessionId}; Ctrl K opens the palette on the session page too`);
  await typeQuery(names.landingSkill);
  await page.keyboard.press("Enter");
  await expectPath(`/skills/${landingSkill.id}`, "the skill");

  // The sidebar's Search field, and the actions. Off a Mac the keys read Ctrl K and Ctrl B.
  const sidebarField = visible(page.getByRole("button", { name: /^Search/ }));
  const fieldWords = (await sidebarField.innerText()).replace(/\s+/g, " ");
  if (!fieldWords.includes("Ctrl K")) throw new Error(`the sidebar's field reads ${fieldWords}`);
  await sidebarField.click();
  await field().waitFor();
  const collapseWords = (await option("Collapse sidebar").innerText()).replace(/\s+/g, " ");
  if (!collapseWords.includes("Ctrl B")) throw new Error(`the action reads ${collapseWords}`);
  await typeQuery("collapse");
  await option("Collapse sidebar").click();
  await visible(page.getByRole("navigation", { name: "Sidebar rail" })).waitFor();
  await visible(page.getByRole("button", { name: "Search", exact: true })).click();
  await field().waitFor();
  await typeQuery("expand");
  await page.keyboard.press("Enter");
  await visible(page.getByRole("button", { name: /^Search/ })).waitFor();
  note(
    "the sidebar's field opens it; Collapse sidebar folds to the rail, whose Search opens it; Expand sidebar opens it again",
  );
  await byShortcut();
  await typeQuery("add pro");
  await page.keyboard.press("Enter");
  await expectPath("/projects", "Add project…");
  await visible(page.getByRole("dialog", { name: /Add project/ })).waitFor();
  if (new URL(page.url()).search !== "") throw new Error(`Add project left ${page.url()}`);
  await page.keyboard.press("Escape");
  await byShortcut();
  await typeQuery("new session");
  await page.keyboard.press("Enter");
  await expectPath("/", "New session");
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  note("Add project… opened /projects with its dialog (no ?add left); New session opened home");

  // A list that fails to read: said in the palette, with Try again.
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.removeQueries({
      queryKey: [["skills"]],
    }),
  );
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  await page.route("**/trpc/**skills.list**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(url.searchParams.has("batch") ? calls.map(() => failure) : failure),
    });
  });
  await byShortcut();
  await palette().getByText("Your skills didn't load.").waitFor({ timeout: 30_000 });
  await typeQuery("land");
  await both("fixture-skills-failed-desktop");
  await page.unroute("**/trpc/**skills.list**");
  await palette().getByRole("button", { name: "Try again" }).click();
  await option(names.landingSkill).waitFor();
  note("skills failed to read: the palette says so; Try again read them and the skill appeared");
  await closePalette();

  // The phone: search is its own screen, from the inbox's search button.
  await page.setViewportSize(PHONE);
  await go("/");
  await settled();
  await visible(page.getByRole("heading", { name: "Inbox", exact: true })).waitFor();
  await visible(page.getByRole("button", { name: "Search", exact: true })).click();
  const screen = page.getByRole("dialog", { name: "Search" });
  const input = screen.getByRole("searchbox", { name: "Search" });
  await input.waitFor();
  await page
    .waitForFunction(() => document.activeElement?.getAttribute("type") === "search", null, {
      timeout: 5_000,
    })
    .catch(() => {
      throw new Error("the phone's search field isn't focused");
    });
  await settled();
  await screen.getByText("Recent sessions").waitFor();
  await screen.getByRole("button", { name: /^New session/ }).waitFor();
  await screen.getByRole("button", { name: /^Add project/ }).waitFor();
  if ((await screen.getByRole("button", { name: /Collapse sidebar/ }).count()) > 0)
    throw new Error("the phone offers Collapse sidebar");
  note(
    "phone: the inbox's search opens its own screen, the field focused, Recent sessions and Actions",
  );
  await both("fixture-phone-empty");
  await input.fill("land");
  await screen.getByRole("button", { name: /^Update landing page pricing/ }).waitFor();
  await both("fixture-phone-results");
  await input.fill("helm chart");
  await screen.getByText("No results for “helm chart”").waitFor();
  await both("phone-no-results");
  await screen.getByRole("button", { name: "Clear" }).click();
  if ((await input.inputValue()) !== "") throw new Error("Clear left the field full");
  if (!(await input.evaluate((element) => element === document.activeElement)))
    throw new Error("Clear took focus out of the field");
  await screen.getByRole("button", { name: "Cancel" }).click();
  await screen.waitFor({ state: "detached" });
  await visible(page.getByRole("button", { name: "Search", exact: true })).click();
  await input.fill(names.landingSkill);
  await input.press("Enter");
  await expectPath(`/skills/${landingSkill.id}`, "the phone's search key");
  note(
    "phone: results, no results, Clear (focus stays in the field), Cancel back to the inbox, the search key opened the first result",
  );
  await page.setViewportSize(DESKTOP);

  // Leave the account as it was.
  await page.unroute("**/trpc/**");
  for (const skill of (await call("skills.list")).filter((each) => LEFT.test(each.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.list")).filter((each) => LEFT.test(each.name)))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.removed")).filter((each) => LEFT.test(each.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
  note("removed and purged the projects and skills this run made");
};

/** A minute ago, by `minutes`. */
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

/** The frames' sessions as the inbox read answers them, all the signed-in person's. */
const fixtureRows = (me) =>
  [
    ["Fix flaky checkout retry", "checkout-api", "waiting", 4],
    ["Add idempotency keys to refunds", "checkout-api", "running", 10],
    ["Upgrade to React Router 8", "web", "failed", 22],
    ["Show prices in the shopper's currency", "web", "completed", 60],
    ["Update landing page pricing", "web", "completed", 90],
    ["Mobile landing screen for gift cards", "mobile-app", "stopped", 150],
  ].map(([title, project, status, minutes], index) => ({
    session: {
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      projectId: `fixture-${project}`,
      worktreeId: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
      harness: "claude",
      label: title,
      branch: `mend/fixture-${index + 1}`,
      status,
      ownerUserId: me,
      sharedControlEnabledAt: null,
      // Required on every row a server sends (the column is never null): the row menu reads it.
      sharedControlUserIds: [],
      startedAt: ago(minutes + 30),
      settledAt: null,
      createdAt: ago(minutes + 30),
      updatedAt: ago(minutes),
      importedConversationWaiting: false,
    },
    projectName: project,
    title,
    annotation: null,
    ask:
      status === "waiting"
        ? { kind: "question", subject: "Should the retry back off on a 409?" }
        : null,
    worktreeName: null,
    failure: status === "failed" ? "Type check found 12 errors" : null,
    activity: null,
  }));

/** Rows as tRPC answers them, through superjson: dates as ISO strings, with their paths named. */
const serialized = (rows) => ({
  json: rows.map((row) => ({
    ...row,
    session: {
      ...row.session,
      startedAt: row.session.startedAt.toISOString(),
      createdAt: row.session.createdAt.toISOString(),
      updatedAt: row.session.updatedAt.toISOString(),
    },
  })),
  meta: {
    values: Object.fromEntries(
      rows.flatMap((_, index) =>
        ["startedAt", "createdAt", "updatedAt"].map((field) => [
          `${index}.session.${field}`,
          ["Date"],
        ]),
      ),
    ),
    v: 1,
  },
});
