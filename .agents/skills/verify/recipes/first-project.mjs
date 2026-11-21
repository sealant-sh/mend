// Setup's First project step in the web app (route PR 6, SLNT-1135), at
// /welcome/first-project. Run the composer's CLI batch first (a fake Codex login, so a session can
// be queued on a clone):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/composer-setup.json
//   pnpm verify drive web --recipe first-project
//
// Feature ids (adopt-project.md): `adopt-web` (the step clones a real public repository by its Git
// URL and watches it), `adopt-invalid-url` (an address Mend can't clone is refused before anything
// is sent), `adopt-visibility` (Only you or Everyone in <organization>). `adopt-access` is gone from
// the web: the frames keep Git access with the person (D11). Also: a clone that fails says why with
// git's own words, Clone again and Change details; a clone in progress survives a reload; Continue
// opens How Mend fits together, whose Skip for now opens the composer, where a session started
// while the clone runs waits and then starts; someone who can see a project is sent on to How Mend
// fits together; the phone width; the step failing to load.
//
// The stack's account has projects already, and a person who can see one never sees this step.
// The recipe answers the project list with only the projects it made, so the step shows as it does
// for a new person; every other read, each clone and the queued session are real. The stack's
// server has no GitHub login, so the GitHub list's pictures answer `github.status` and
// `github.repos` with fixtures; those captures are named `fixture-…`, as are the ones that answer
// the agent logins with none (the agent login skipped) and the organization's members with two
// (Skip for now).
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// Small and public: clones in a few seconds.
const SMALL_REPOSITORY = "https://github.com/octocat/Spoon-Knife.git";
// Big enough (about 40 seconds) to start a session while it clones.
const BIG_REPOSITORY = "https://github.com/godotengine/godot.git";
// Neither exists: over SSH, GitHub refuses Mend's key; over HTTPS, the clone fails.
const UNREADABLE_REPOSITORY = "git@github.com:sealant-sh/mend-verify-no-such-repository.git";
const MISSING_REPOSITORY = "https://github.com/sealant-sh/mend-verify-no-such-repository.git";
const HOUR = 3_600_000;
const pushed = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const repository = (name, visibility, hours) => ({
  nameWithOwner: `northwind/${name}`,
  description: null,
  visibility,
  isFork: false,
  language: null,
  stars: 0,
  pushedAt: pushed(hours),
  url: `https://github.com/northwind/${name}`,
});
// The frame's fourteen repositories, as `github.repos` answers them.
const REPOSITORIES = [
  repository("checkout-api", "private", 2),
  repository("web", "private", 0.34),
  repository("mobile-app", "private", 3),
  repository("infra", "private", 30),
  repository("checkout-web", "private", 72),
  repository("design-tokens", "public", 340),
  repository("billing", "private", 400),
  repository("docs", "public", 500),
  repository("ledger", "private", 600),
  repository("search", "private", 700),
  repository("notifications", "private", 900),
  repository("analytics", "private", 1200),
  repository("auth", "private", 1500),
  repository("status-page", "public", 2000),
];

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
  /** Light and dark, desktop and phone. */
  const all = async (name) => {
    await both(`${name}-desktop`);
    await page.setViewportSize(PHONE);
    await settled();
    await both(`${name}-phone`);
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  /** React has taken the page over, so clicks, typing and the router reach it. */
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button, textarea")].some((element) =>
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
  const heading = () => page.getByRole("heading", { name: "Add a project", level: 1 });
  /** A tRPC call from the page, as the signed-in person. */
  const call = async (path, input, kind = "query") => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await page.evaluate(
          async ({ path: route, input: value, kind: verb }) => {
            let target = window["__TSR_ROUTER__"].options.context.trpcClient;
            for (const part of route.split(".")) target = target[part];
            return target[verb](value);
          },
          { path, input, kind },
        );
      } catch (error) {
        if (attempt >= 2 || !String(error).includes("Execution context was destroyed")) throw error;
        await hydrated();
      }
    }
  };
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  const refresh = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const forgetClone = (owner) =>
    page.evaluate((id) => localStorage.removeItem(`mend-adoption.${id}`), owner);

  // Answers chosen tRPC reads in a batch, each from the server's own answer (or none, when it
  // failed). `answers` maps a procedure to a function from its result to the one to send.
  let answers = {};
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    // Every call is a POST (the app's `methodOverride`); only reads are named in `answers`.
    if (!paths.some((path) => path in answers)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    paths.forEach((path, at) => {
      const answer = answers[path];
      if (answer === undefined) return;
      const real = entries[at]?.result?.data;
      const json = answer(real?.json);
      // Meta describes the server's answer (its dates); an answer made here carries none of it.
      entries[at] = { result: { data: json === real?.json ? real : { json } } };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? entries : entries[0]),
    });
  });

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  const me = await call("organization.current");
  const organization = me.organization.name;
  // The stack's agent login is a fake Codex one (the CLI batch): the composer starts Codex.
  const defaults = await call("platform.sessionDefaults");
  await call("platform.setSessionDefaults", { ...defaults, harness: "codex" }, "mutate");
  const suffix = Math.random().toString(36).slice(2, 6);
  const made = (name) => name.endsWith(`-${suffix}`);
  await forgetClone(me.userId);
  // Projects an earlier run of this recipe left when it stopped partway go first.
  const LEFT = /^(first|spoon)-[a-z0-9]{4}$/;
  for (const project of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );

  // The step comes after Git access: without it, the step sends the person back to /welcome. A
  // stack's account has none until it opens /welcome, which makes the Mend key; so does this.
  const access = await call("git.access");
  if (access.mode === "mend-key" && !access.key.exists) {
    await go("/welcome/first-project");
    await page.waitForURL((url) => url.pathname === "/welcome", { timeout: 15_000 });
    note("with no Git access, /welcome/first-project went back to /welcome (Git access)");
    await call("git.initKey", undefined, "mutate");
    note("made the account's Mend key, as opening /welcome does");
    await go("/");
  }

  // Someone who can see a project is sent on to the next step, How Mend fits together.
  const seen = (await call("projects.list")).length;
  await go("/welcome/first-project");
  await page.waitForURL((url) => url.pathname === "/welcome/how-mend-fits", { timeout: 15_000 });
  note(`with ${seen} projects in sight, /welcome/first-project went on to /welcome/how-mend-fits`);

  // From here the person sees only the projects this drive makes: the step as a new person has it.
  answers = { "projects.list": (list) => (list ?? []).filter((entry) => made(entry.name)) };
  await refresh();
  await go("/welcome/first-project");
  await heading().waitFor();
  await text("Step 6 of 7").waitFor();
  // Neither the account nor the stack's server has a GitHub login: the step shows how to connect
  // one (SLNT-1191), above the repository address.
  await text(/Waiting for GitHub to connect/).waitFor();
  await all("no-github");
  note("no GitHub login: in place of the list, the step shows how to connect one");

  // Fixture: the GitHub list, as a server with a GitHub login answers it.
  const github = { available: true, authenticated: true, login: "linus-p", detail: null };
  answers = {
    ...answers,
    "github.status": () => github,
    // The login's own account only: setup-order drives the owner choice.
    "github.owners": () => ({ login: "linus-p", owners: [{ login: "linus-p", kind: "user" }] }),
    "github.repos": () => REPOSITORIES,
  };
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["github"]],
    }),
  );
  await text("Repositories").waitFor();
  const search = visible(page.getByRole("searchbox", { name: "Search repositories" }));
  await search.waitFor();
  if ((await search.getAttribute("placeholder")) !== "Search 14 repositories")
    throw new Error(`the search reads ${await search.getAttribute("placeholder")}`);
  await text("8 more. Search to find them.").waitFor();
  if (!(await button("Add project").isDisabled()))
    throw new Error("Add project is on before a repository is chosen");
  await all("fixture-choose");
  note("fixture, GitHub: 14 repositories, six shown, 8 more; Add project off until one is chosen");

  await search.fill("check");
  await text("2 of 14").waitFor();
  await visible(page.getByText("northwind/checkout-api")).click();
  const name = visible(page.getByLabel("Name", { exact: true }));
  if ((await name.inputValue()) !== "checkout-api")
    throw new Error(`the name reads ${await name.inputValue()}`);
  await text("Mend starts cloning when you add it.").waitFor();
  await all("fixture-picked");
  note("fixture, GitHub: a search for check reads 2 of 14; picking one fills the name");

  // Fixture: the agent login skipped, and the organization with another member (Skip for now).
  answers = {
    ...answers,
    "platform.sealantIdentity": (identity) => ({ ...identity, accounts: [] }),
    "organization.members": (members) => [
      ...(members ?? []),
      {
        ...members?.[0],
        userId: "fixture-member",
        name: "Grace Hopper",
        email: "grace@example.test",
      },
    ],
  };
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      predicate: (query) =>
        ["platform", "organization"].includes(query.queryKey[0]?.[0]) &&
        ["sealantIdentity", "members"].includes(query.queryKey[0]?.[1]),
    }),
  );
  const steps = page.getByRole("list", { name: "Setup steps" });
  await steps.getByText("Skipped", { exact: true }).waitFor();
  await button("Skip for now").waitFor();
  await both("fixture-agent-skipped-desktop");
  await button("Skip for now").click();
  await page.waitForURL((url) => url.pathname === "/welcome/how-mend-fits", { timeout: 15_000 });
  note(
    "fixture, agent login skipped: the steps read Agent login Skipped; with another member in the organization, Skip for now goes on to How Mend fits together",
  );
  delete answers["organization.members"];
  delete answers["platform.sealantIdentity"];
  await refresh();
  await go("/welcome/first-project");
  await heading().waitFor();
  if (await button("Skip for now").isVisible())
    throw new Error("the only member of the organization is offered Skip for now");

  // Fixture: GitHub lists no repositories.
  answers = { ...answers, "github.repos": () => [] };
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({ queryKey: [["github"]] }),
  );
  await page.getByRole("heading", { name: "linus-p owns no repositories." }).waitFor();
  await button("Check again").waitFor();
  await all("fixture-no-repositories");
  note("fixture, no repositories: 'linus-p owns no repositories.', with Check again");

  // The real path: From a Git URL. A refused address first, then a clone that fails.
  await button("Paste a Git URL instead").click();
  const address = visible(page.getByLabel("Repository address"));
  let adopted = false;
  page.on("request", (request) => {
    if (request.url().includes("projects.adopt")) adopted = true;
  });
  await address.fill("/tmp/not-a-url");
  await address.blur();
  await text(/Local paths and file:\/\/ URLs are not supported/).waitFor();
  if ((await address.getAttribute("aria-invalid")) !== "true")
    throw new Error("the address field isn't marked invalid");
  if (!(await button("Add project").isDisabled()))
    throw new Error("Add project is on for an address Mend can't clone");
  if (adopted) throw new Error("an address Mend can't clone was sent");
  await both("invalid-desktop");
  note("adopt-invalid-url: /tmp/not-a-url is refused under the field and nothing is sent");

  const missing = `first-${suffix}`;
  await address.fill(MISSING_REPOSITORY);
  await name.fill(missing);
  await button("Add project").click();
  await text("The clone failed.").waitFor({ timeout: 120_000 });
  await all("failed");
  note(
    `a clone that fails: ${(await page.getByRole("main").innerText()).replace(/\s+/g, " ").slice(0, 500)}`,
  );
  await button("Clone again").click();
  await text("Running")
    .waitFor()
    .catch(() => undefined);
  await text("The clone failed.").waitFor({ timeout: 120_000 });
  note("Clone again cloned again and failed the same way");
  await button("Change details").click();
  if ((await address.inputValue()) !== MISSING_REPOSITORY)
    throw new Error("Change details lost the address");
  note("Change details went back to the form with the address and name kept");

  // Over SSH the clone signs with Mend's key: the failure offers the key to add on GitHub.
  await address.fill(UNREADABLE_REPOSITORY);
  await button("Add project").click();
  await text("The clone failed.").waitFor({ timeout: 120_000 });
  await button("Show Mend's key").click();
  await text(/Add this key to the repository|You have no Mend key yet/).waitFor();
  await both("failed-ssh-desktop");
  note(
    `a clone over SSH that GitHub refuses (${UNREADABLE_REPOSITORY}) offers Show Mend's key, which shows the key to add`,
  );
  await button("Change details").click();

  // adopt-web and adopt-visibility: a small public repository, shared, watched to the end.
  await address.fill(SMALL_REPOSITORY);
  const small = `spoon-${suffix}`;
  await name.fill(small);
  await visible(page.getByRole("tab", { name: `Everyone in ${organization}` })).click();
  await button("Add project").click();
  await text(`Cloned ${small}`).waitFor({ timeout: 120_000 });
  await text("Completed").waitFor();
  await all("cloned");
  // Fixture: the same, with the agent login skipped.
  answers = {
    ...answers,
    "platform.sealantIdentity": (identity) => ({ ...identity, accounts: [] }),
  };
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["platform", "sealantIdentity"]],
    }),
  );
  await text("You can add an agent login later in Settings.").waitFor();
  await all("fixture-cloned-agent-skipped");
  delete answers["platform.sealantIdentity"];
  const smallProject = (await call("projects.list")).find((entry) => entry.name === small);
  if (smallProject?.visibility !== "shared")
    throw new Error(`${small} is ${smallProject?.visibility ?? "missing"}`);
  note(
    `adopt-web, adopt-visibility: ${SMALL_REPOSITORY} cloned as ${small} on the step, visible to everyone in ${organization}`,
  );
  await button("Continue").click();
  await page.getByRole("heading", { name: "How Mend fits together", level: 1 }).waitFor();
  await button("Skip for now").click();
  await page.getByRole("heading", { name: "New session" }).waitFor();
  note(
    "Continue after the clone opens How Mend fits together; Skip for now there opens the composer",
  );
  // Back to a person with no project, for the clone that runs while they go on.
  await call("projects.remove", { id: smallProject.id }, "mutate");
  await refresh();

  // A big clone: a reload keeps it, and the composer queues a session on it.
  const big = `first-${suffix}`;
  await go("/welcome/first-project");
  await heading().waitFor();
  await button("Paste a Git URL instead").click();
  await address.fill(BIG_REPOSITORY);
  await name.fill(big);
  await button("Add project").click();
  await text(`Cloning ${big}`).waitFor();
  // Git's own progress, for the picture; the clone may still be starting after 30 seconds.
  await text(/Receiving objects/)
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await all("cloning");
  await open("/welcome/first-project");
  await text(`Cloning ${big}`).waitFor();
  await text("Running").waitFor();
  note(
    `${BIG_REPOSITORY} cloning as ${big}; after a reload the step still shows the clone running`,
  );
  await button("Continue").click();
  await page.getByRole("heading", { name: "How Mend fits together", level: 1 }).waitFor();
  await button("Skip for now").click();
  await page.getByRole("heading", { name: "New session" }).waitFor();
  await text(`${big} is still cloning.`).waitFor();
  await capture("composer-cloning-desktop-light");
  const task = visible(page.getByRole("textbox", { name: "Task" }));
  await task.fill("Change nothing. Reply with done.");
  await task.press("Enter");
  await text(/^Queued\. The session starts when .* finishes cloning\./).waitFor();
  await capture("composer-queued-desktop-light");
  const queued = await waitFor(
    "the session queued on the clone",
    async () =>
      (await call("queuedSessions.list")).find((entry) => entry.projectName === big) ?? null,
    20,
  );
  note(
    `Continue, then Skip for now, opened the composer on ${big}; it queued ${queued.id} (state ${queued.state})`,
  );
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
  await refresh();
  await go("/welcome/first-project");
  await page.waitForURL((url) => url.pathname === "/welcome/how-mend-fits", { timeout: 15_000 });
  note(`with ${big} in sight, the step goes on to How Mend fits together again`);

  // The step failing to load: the route's error screen, and Try again.
  await forgetClone(me.userId);
  await page.unroute("**/trpc/**");
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
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go("/welcome/first-project");
  await page.getByRole("heading", { name: "This page didn't load" }).waitFor();
  await all("error");
  await page.unroute("**/trpc/**");
  note("the step failing to load shows the error screen with Try again");

  // Put back what this drive changed: the projects it made are purged, the defaults as before.
  await open("/");
  await forgetClone(me.userId);
  // The session the composer started holds its project until it has stopped, and its workspace is
  // saved first: with the big clone that took over two minutes on a loaded machine.
  await call("sessions.stop", { id: started }, "mutate").catch(() => undefined);
  for (const project of (await call("projects.list")).filter((entry) => made(entry.name)))
    await waitFor(
      `${project.name} removed`,
      () =>
        call("projects.remove", { id: project.id }, "mutate").then(
          () => true,
          () => null,
        ),
      300,
    );
  for (const project of (await call("projects.removed")).filter((entry) => made(entry.name)))
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
  await call("platform.setSessionDefaults", defaults, "mutate");
  note(`removed and purged the projects this drive made (suffix ${suffix}); defaults as before`);
};
