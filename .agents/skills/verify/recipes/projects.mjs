// Projects in the web app (route PR 27, SLNT-1129): the list, adding a project, and removing,
// restoring and purging one. Run the composer's CLI batch first (a fake Codex login, so a session
// can be queued on a clone):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/composer-setup.json
//   pnpm verify drive web --recipe projects
//
// Feature ids (adopt-project.md, project-settings.md): `projects-directory` (the list, its search
// and its filter), `adopt-web` (Add project clones a real public repository and the dialog watches
// the clone finish), `adopt-invalid-url` (an address Mend can't clone is refused before anything is
// sent), `adopt-visibility` (Only you or Everyone in <organization>), `settings-remove` (Remove
// project… asks first and says what is kept), `settings-retention` (Removed projects: restore, and
// purge once the name is typed), and the row's menu. `adopt-access` is gone from the web: the
// frames keep Git access with the person (D11). Also: a clone of a repository the key can't read
// and a clone that fails each say why with git's own words and Try again; a session started in the
// composer while a clone runs waits and then starts; an empty project; the phone width; a list that
// fails to load; no projects at all. The stack reaches GitHub. Fixtures (captures named
// `fixture-…`): no projects (the list answered with none) and a refused removal (the server's
// RemovalRefused answer, which needs a live session in the project to happen for real).
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// Small and public: clones in a few seconds.
const SMALL_REPOSITORY = "https://github.com/octocat/Spoon-Knife.git";
// Big enough (about 40 seconds) to start a session while it clones.
const BIG_REPOSITORY = "https://github.com/godotengine/godot.git";
// Neither exists: over SSH, GitHub refuses Mend's key; over HTTPS, the clone fails.
const UNREADABLE_REPOSITORY = "git@github.com:sealant-sh/mend-verify-no-such-repository.git";
const MISSING_REPOSITORY = "https://github.com/sealant-sh/mend-verify-no-such-repository.git";

const visible = (locator) => locator.filter({ visible: true }).first();

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
  /** The table's row for a project (desktop), by its name. */
  const row = (name) =>
    page
      .getByRole("table", { name: "Projects" })
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
  /** A tRPC call from the page, as the signed-in person. */
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  /** Fill Add project's From a Git URL tab and press Add project. */
  const addFromAddress = async (address, name, shared = false) => {
    await button("Add project…").click();
    await dialog().getByRole("tab", { name: "From a Git URL" }).click();
    await dialog().getByLabel("Repository address").fill(address);
    const nameField = dialog().getByLabel("Name", { exact: true });
    await nameField.fill(name);
    if (shared)
      await dialog()
        .getByRole("tab", { name: /^Everyone in / })
        .click();
    await dialog().getByRole("button", { name: "Add project", exact: true }).click();
  };
  const made = [];

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  const me = await call("organization.current");
  const organization = me.organization.name;
  // The stack's agent login is a fake Codex one (the CLI batch): the composer starts Codex.
  const defaults = await call("platform.sessionDefaults");
  await call("platform.setSessionDefaults", { ...defaults, harness: "codex" }, "mutate");
  const suffix = Math.random().toString(36).slice(2, 6);
  await page.evaluate((owner) => localStorage.removeItem(`mend-adoption.${owner}`), me.userId);
  // Projects an earlier run of this recipe left when it stopped partway go first.
  const LEFT = /^(spoon|godot|empty|missing|unreadable)-[a-z0-9]{4}(-back)?$/;
  for (const project of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );

  // The sidebar's Projects opens the page.
  await visible(page.getByRole("link", { name: "Projects", exact: true })).click();
  await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
  if (new URL(page.url()).pathname !== "/projects")
    throw new Error(`the sidebar's Projects went to ${page.url()}`);
  await page.getByRole("table", { name: "Projects" }).waitFor();
  await both("list-desktop");
  note("projects-directory: the sidebar's Projects opens /projects with the table");

  // adopt-invalid-url: an address Mend can't clone is refused with why, before anything is sent.
  await button("Add project…").click();
  await dialog().getByRole("heading", { name: "Add project" }).waitFor();
  await dialog().getByRole("tab", { name: "From GitHub" }).click();
  await dialog()
    .getByText(/GitHub account can reach|has no GitHub login|couldn't reach GitHub/)
    .first()
    .waitFor();
  await both("add-github-desktop");
  note(
    `From GitHub: ${(await dialog().getByRole("tabpanel").innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
  );
  await dialog().getByRole("tab", { name: "From a Git URL" }).click();
  const address = dialog().getByLabel("Repository address");
  await address.fill("/tmp/not-a-url");
  await address.blur();
  await text(/Local paths and file:\/\/ URLs are not supported/).waitFor();
  if ((await address.getAttribute("aria-invalid")) !== "true")
    throw new Error("the address field isn't marked invalid");
  let adopted = false;
  page.on("request", (request) => {
    if (request.url().includes("projects.adopt")) adopted = true;
  });
  await dialog().getByRole("button", { name: "Add project", exact: true }).click();
  await settled();
  if (adopted) throw new Error("an address Mend can't clone was sent");
  await both("add-invalid-desktop");
  note("adopt-invalid-url: /tmp/not-a-url is refused under the field and nothing is sent");
  await button("Cancel").click();

  // adopt-web and adopt-visibility: a real public repository, shared with the organization.
  const small = `spoon-${suffix}`;
  made.push(small);
  await addFromAddress(SMALL_REPOSITORY, small, true);
  await page
    .getByRole("heading", { name: `Adding ${small}` })
    .or(page.getByRole("heading", { name: `${small} added` }))
    .first()
    .waitFor();
  if (await page.getByRole("heading", { name: `Adding ${small}` }).isVisible())
    await capture("cloning-small-desktop-light");
  await page.getByRole("heading", { name: `${small} added` }).waitFor({ timeout: 120_000 });
  await both("added-desktop");
  await button("Done").click();
  await row(small).waitFor();
  const smallRow = await row(small).innerText();
  if (
    !smallRow.includes(`Everyone in ${organization}`) ||
    !smallRow.includes("github.com/octocat/Spoon-Knife")
  )
    throw new Error(`the new row reads ${smallRow}`);
  note(
    `adopt-web, adopt-visibility: ${SMALL_REPOSITORY} cloned as ${small}, visible to everyone in ${organization}; the row reads: ${smallRow.replace(/\s+/g, " ")}`,
  );

  // projects-directory: search and the filter.
  const search = visible(page.getByRole("searchbox", { name: "Search projects" }));
  await search.fill(small);
  await text("1 of").waitFor();
  await capture("search-desktop-light");
  await search.fill("");
  await page.getByRole("tab", { name: "Only you" }).click();
  if ((await row(small).count()) !== 0) throw new Error("Only you still lists a shared project");
  await page.getByRole("tab", { name: "Shared" }).click();
  await row(small).waitFor();
  await page.getByRole("tab", { name: "All" }).click();
  note("projects-directory: search by name, and the Shared and Only you filter");

  // The row's menu: the "…" and a right-click open the same items.
  await row(small)
    .getByRole("button", { name: `${small} menu` })
    .click();
  await page.getByRole("menuitem", { name: "Remove project…" }).waitFor();
  await both("row-menu-desktop");
  await page.keyboard.press("Escape");
  await row(small).click({ button: "right", position: { x: 300, y: 20 } });
  await page.getByRole("menuitem", { name: "New session" }).click();
  await page.getByRole("heading", { name: "New session" }).waitFor();
  await visible(page.getByRole("button", { name: `Project: ${small}` })).waitFor();
  note(`the row's menu: right-click, New session opens the composer on ${small}`);
  await go("/projects");
  await row(small).waitFor();

  // A session started while a project clones waits, then starts.
  const big = `godot-${suffix}`;
  made.push(big);
  await addFromAddress(BIG_REPOSITORY, big);
  await page.getByRole("heading", { name: `Adding ${big}` }).waitFor();
  await text(/Cloning|Receiving objects|Waiting for the Git host|Starting/).waitFor();
  await both("cloning-desktop");
  await button("Close").click();
  await settled();
  const cloneRow = page
    .getByRole("table", { name: "Projects" })
    .getByRole("row")
    .filter({ hasText: big });
  await cloneRow.filter({ hasText: "Cloning" }).waitFor();
  await capture("clone-row-desktop-light");
  note(`${BIG_REPOSITORY} cloning as ${big}: the dialog closes and the list shows it as Cloning`);
  await go("/");
  await visible(page.getByRole("button", { name: /^Project: / })).click();
  await page.getByRole("option", { name: new RegExp(`^${big}.*Cloning`) }).click();
  await text(`${big} is still cloning.`).waitFor();
  const task = visible(page.getByRole("textbox", { name: "Task" }));
  await task.fill("Change nothing. Reply with done.");
  await task.press("Enter");
  await text(/^Queued\. The session starts when .* finishes cloning\./).waitFor();
  const queued = await waitFor(
    "the session queued on the clone",
    async () => {
      const rows = await call("queuedSessions.list");
      return rows.find((entry) => entry.projectName === big) ?? null;
    },
    20,
  );
  note(`the composer queued ${queued.id} on ${big} while it cloned (state ${queued.state})`);
  const started = await waitFor(
    "the queued session starting",
    async () => {
      const entry = await call("queuedSessions.read", { id: queued.id });
      if (entry.state === "failed")
        throw new Error(`the queued session failed: ${entry.failure?.message}`);
      return entry.state === "started" ? entry.sessionId : null;
    },
    300,
  );
  note(`the clone finished and the queued session started by itself as ${started}`);
  await call("sessions.stop", { id: started }, "mutate").catch(() => undefined);
  await go("/projects");
  await row(big).waitFor({ timeout: 30_000 });
  note(`${big} is listed once its clone finished`);

  // A repository Mend's key can't read: why, git's own words, Mend's key, Try again.
  const unreadable = `unreadable-${suffix}`;
  await addFromAddress(UNREADABLE_REPOSITORY, unreadable);
  await page.getByRole("heading", { name: /^Mend couldn't clone / }).waitFor({ timeout: 120_000 });
  await page.getByLabel("What git said").first().waitFor();
  await button("Show Mend's key").click();
  await text(/Add this key to the repository|You have no Mend key yet/).waitFor();
  await both("unreadable-desktop");
  note(
    `a repository the key can't read (${UNREADABLE_REPOSITORY}): ${(await dialog().innerText()).replace(/\s+/g, " ").slice(0, 400)}`,
  );
  await button("Try again").click();
  await page.getByRole("heading", { name: /^Mend couldn't clone / }).waitFor({ timeout: 120_000 });
  note("Try again cloned again and failed the same way");
  await page.keyboard.press("Escape");

  // A clone that fails, with the dialog closed: the list says so, and the row opens why.
  const missing = `missing-${suffix}`;
  await addFromAddress(MISSING_REPOSITORY, missing);
  await button("Close")
    .click()
    .catch(() => undefined);
  const failedRow = page
    .getByRole("table", { name: "Projects" })
    .getByRole("row")
    .filter({ hasText: missing });
  await failedRow.filter({ hasText: "Clone failed" }).waitFor({ timeout: 120_000 });
  await both("clone-failed-row-desktop");
  await failedRow.getByRole("button", { name: missing }).click();
  await page.getByRole("heading", { name: /^Mend couldn't clone / }).waitFor();
  await both("clone-failed-desktop");
  await button("Change details").click();
  await dialog().getByLabel("Repository address").waitFor();
  if ((await dialog().getByLabel("Repository address").inputValue()) !== MISSING_REPOSITORY)
    throw new Error("Change details lost the address");
  note(
    "a failed clone: the list reads Clone failed, the row opens why, Change details keeps what was asked",
  );
  await button("Cancel").click();
  if ((await failedRow.count()) !== 0)
    throw new Error("the failed clone's row stayed after it was seen");

  // An empty project, private.
  const empty = `empty-${suffix}`;
  made.push(empty);
  await button("Add project…").click();
  await dialog().getByRole("tab", { name: "Empty project" }).click();
  await dialog().getByLabel("Name", { exact: true }).fill(empty);
  await dialog().getByRole("button", { name: "Add project", exact: true }).click();
  await row(empty).waitFor({ timeout: 30_000 });
  if (!(await row(empty).innerText()).includes("Only you"))
    throw new Error("the empty project isn't private");
  note(`an empty project ${empty}, only yours, is listed with "No repository"`);

  // settings-remove: asks first, says what is kept, and the project leaves the list.
  await row(small)
    .getByRole("button", { name: `${small} menu` })
    .click();
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await page.getByRole("heading", { name: `Remove ${small}?` }).waitFor();
  await text(/Mend keeps its copy of github\.com\/octocat\/Spoon-Knife/).waitFor();
  await both("remove-desktop");
  await dialog().getByRole("button", { name: "Remove project" }).click();
  await text(`Removed ${small}. Restore it from Removed projects.`).waitFor();
  await row(small).waitFor({ state: "detached" });
  await capture("removed-toast-desktop-light");
  note(
    `settings-remove: ${small} removed after the dialog said what Mend keeps; the toast says where to restore it`,
  );

  // settings-retention: restore, then remove again and purge with the name typed.
  await button(/^Removed projects/, false).click();
  const removedList = page.getByRole("list", { name: "Removed projects" });
  const removedRow = removedList.getByRole("listitem").filter({ hasText: small });
  await removedRow.waitFor();
  await both("removed-list-desktop");
  await removedRow.getByRole("button", { name: "Restore" }).click();
  await row(small).waitFor({ timeout: 20_000 });
  await text(`Restored ${small}.`).waitFor();
  note(`settings-retention: Restore brought ${small} back to the list`);
  // Restore when the name was taken since: it asks for another name.
  const idOf = async (name) => (await call("projects.list")).find((p) => p.name === name).id;
  await call("projects.remove", { id: await idOf(small) }, "mutate");
  await call("projects.createNew", { name: small }, "mutate");
  made.push(small);
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  const fold = button(/^Removed projects/, false);
  await fold.waitFor();
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await removedRow.waitFor();
  await removedRow.getByRole("button", { name: "Restore" }).click();
  const restoreAs = removedRow.getByLabel("Restore as");
  await restoreAs.waitFor();
  await both("restore-as-desktop");
  const purged = `${small}-back`;
  await restoreAs.fill(purged);
  await removedRow.getByRole("button", { name: "Restore" }).click();
  await row(purged).waitFor({ timeout: 20_000 });
  await text(`Restored ${purged}.`).waitFor();
  note(
    `settings-retention: with ${small} taken again, Restore asked for another name and brought it back as ${purged}`,
  );
  await call("projects.remove", { id: await idOf(purged) }, "mutate");
  made.push(purged);
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  note(
    `removed ${purged} again, to purge at the end: the server holds a purge for a while after a removal`,
  );

  // Fixture: a refused removal says why, and nothing changes.
  await page.route("**/trpc/projects.remove**", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message:
                "Not removed. Grace's session in fix-retry is still running. Stop it, then remove the project again.",
              code: -32009,
              data: {
                code: "CONFLICT",
                httpStatus: 409,
                path: "projects.remove",
                tag: "RemovalRefused",
              },
            },
          },
        },
      ]),
    }),
  );
  await row(empty)
    .getByRole("button", { name: `${empty} menu` })
    .click();
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await dialog().getByRole("button", { name: "Remove project" }).click();
  await text(/Grace.s session in fix-retry is still running/).waitFor();
  await both("fixture-remove-refused-desktop");
  await button("Cancel").click();
  await page.unroute("**/trpc/projects.remove**");
  note("fixture: a refused removal shows the server's words in the dialog and the project stays");

  // The phone: the list, Add project as a sheet, the row's menu and Remove as a sheet.
  await page.setViewportSize(PHONE);
  await settled();
  await visible(page.getByRole("list", { name: "Projects" })).waitFor();
  await both("list-phone");
  await visible(page.getByRole("button", { name: "Add project" })).click();
  await dialog().getByRole("tab", { name: "From a Git URL" }).click();
  await dialog().getByLabel("Repository address").fill("https://github.com/octocat/Hello-World");
  await both("add-phone");
  await button("Cancel").click();
  await visible(page.getByRole("button", { name: `${empty} menu` })).click();
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await page.getByRole("heading", { name: `Remove ${empty}?` }).waitFor();
  const touchHeight =
    (await dialog().getByRole("button", { name: "Remove project" }).boundingBox())?.height ?? 0;
  if (touchHeight < 44) throw new Error(`Remove project is ${touchHeight}px tall on a phone`);
  await both("remove-phone");
  await dialog().getByRole("button", { name: "Remove project" }).click();
  await text(`Removed ${empty}. Restore it from Removed projects.`).waitFor();
  await both("removed-phone");
  note("phone: the list, Add project and Remove project as sheets with 44px buttons");
  await page.setViewportSize(DESKTOP);

  // Fixture: no projects at all.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const at = paths.indexOf("projects.list");
    if (at === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entry = Array.isArray(body) ? body[at] : body;
    entry.result.data.json = [];
    return route.fulfill({ response, json: body });
  });
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["projects", "list"]],
    }),
  );
  await page.getByRole("heading", { name: "No projects yet" }).waitFor();
  await both("fixture-empty-desktop");
  await page.unroute("**/trpc/**");
  note("fixture, no projects: No projects yet with Add project…");

  // A list that fails to load: the route's error screen, and Try again recovers.
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
  await go("/");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go("/projects");
  await page.getByRole("heading", { name: "This page didn't load" }).waitFor();
  await both("error-desktop");
  await page.setViewportSize(PHONE);
  await both("error-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
  note("a list that fails to load shows the error screen; Try again reads it again");

  // settings-retention, purge: off until the name is typed. A purge soon after a removal is refused
  // until an upload the project started can no longer land; the dialog says until when, and the
  // recipe purges again after then.
  await go("/projects");
  await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
  const purgedRow = removedList
    .getByRole("listitem")
    .filter({ has: page.getByText(purged, { exact: true }) });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await purgedRow.waitFor();
  await purgedRow.getByRole("button", { name: "Purge…" }).click();
  await page.getByRole("heading", { name: `Purge ${purged}?` }).waitFor();
  const purge = dialog().getByRole("button", { name: "Purge project" });
  if (!(await purge.isDisabled())) throw new Error("Purge is on before the name is typed");
  await dialog().getByLabel(`Type ${purged} to confirm`).fill(purged);
  await both("purge-desktop");
  for (let attempt = 0; ; attempt += 1) {
    await purge.click();
    // The last refusal's words go as the purge starts again.
    await page.waitForFunction(
      (name) => !document.body.innerText.includes(`${name} wasn't purged.`),
      purged,
      { timeout: 10_000 },
    );
    const outcome = await Promise.race([
      page
        .getByRole("heading", { name: `Purge ${purged}?` })
        .waitFor({ state: "detached", timeout: 60_000 })
        .then(() => "purged"),
      text(`${purged} wasn't purged.`)
        .waitFor({ timeout: 60_000 })
        .then(() => "refused"),
    ]);
    if (outcome === "purged") {
      await purgedRow.waitFor({ state: "detached", timeout: 20_000 });
      break;
    }
    const words = await dialog().innerText();
    const until = /may still land until (\S+?)\. /.exec(words)?.[1];
    if (attempt > 0 || until === undefined) throw new Error(`the purge was refused: ${words}`);
    await both("purge-held-desktop");
    note(`the server held the purge: ${words.replace(/\s+/g, " ").slice(0, 300)}`);
    const wait = Math.max(0, Date.parse(until) - Date.now()) + 5_000;
    if (wait > 12 * 60_000) throw new Error(`the purge is held for ${wait} ms`);
    await page.waitForTimeout(wait);
  }
  made.splice(made.indexOf(purged), 1);
  note(`settings-retention: Purge… stayed off until ${purged} was typed, then purged it for good`);

  // Put back what this drive changed: every project it made is removed and purged.
  await page.evaluate((owner) => localStorage.removeItem(`mend-adoption.${owner}`), me.userId);
  const listed = await call("projects.list");
  for (const name of [...made, empty]) {
    const project = listed.find((entry) => entry.name === name);
    if (project !== undefined)
      await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  }
  // A clone's purge is held while an upload its session started may still land (minutes on a real
  // server, where the queued session uploads): wait out the time the refusal names, then again.
  const ours = async () =>
    (await call("projects.removed")).filter((entry) => entry.name.includes(`-${suffix}`));
  const deadline = Date.now() + 15 * 60_000;
  for (let left = await ours(); left.length > 0; left = await ours()) {
    let holdUntil = 0;
    for (const project of left) {
      const refusal = await call(
        "projects.purge",
        { id: project.id, confirm: project.name },
        "mutate",
      ).then(
        () => null,
        (error) => String(error?.message ?? error),
      );
      const until =
        refusal === null ? undefined : /may still land until (\S+?)\. /.exec(refusal)?.[1];
      if (refusal !== null && until === undefined)
        throw new Error(`the purge of ${project.name} was refused: ${refusal}`);
      if (until !== undefined) {
        holdUntil = Math.max(holdUntil, Date.parse(until));
        note(`cleanup: the server holds the purge of ${project.name} until ${until}; waiting`);
      }
    }
    if (holdUntil === 0) continue;
    if (holdUntil + 5_000 > deadline)
      throw new Error(`a purge is held until ${new Date(holdUntil).toISOString()}, past the wait`);
    await page.waitForTimeout(Math.max(0, holdUntil - Date.now()) + 5_000);
  }
  // Read back from a fresh page: none of the drive's projects listed, removed or not.
  await open("/projects");
  const leftListed = (await call("projects.list")).filter((entry) =>
    entry.name.includes(`-${suffix}`),
  );
  const leftRemoved = await ours();
  if (leftListed.length + leftRemoved.length > 0)
    throw new Error(
      `left after cleanup: ${[...leftListed, ...leftRemoved].map((entry) => entry.name).join(", ")}`,
    );
  await call("platform.setSessionDefaults", defaults, "mutate");
  await both("restored-project-list");
  note(
    `removed and purged the projects this drive made (suffix ${suffix}), read back: none listed or under Removed projects; the session defaults are as before`,
  );
};
