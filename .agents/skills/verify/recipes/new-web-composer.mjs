// The New session composer, home of the new web app (apps/web, route PR 10, SLNT-1112). Run the CLI
// batch first: it gives the stack's account a (fake) Codex login, so Codex, opencode and pi read
// "Signed in" while Claude Code has none, and makes a worktree to start in. (The platform refuses the
// fake Claude login about a minute after it is connected, so Claude Code is the agent without a
// login here: "No login" on a fresh stack, "Login refused" once a Claude login was tried.)
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-composer-setup.json
//   pnpm verify drive new-web --recipe new-web-composer
//
// Feature ids: start-session.md start-composer (project, worktree, agent, task) and
// start-new-worktree (from the worktree picker); now-and-sessions.md home-composer; models.md
// web-picker (model, thinking and fast from the agent menu); land-change.md land-automatic (starts
// from the person's automation, sent with the session); pi in the agent menu (pi-profile.md). The
// stack has no real provider login, so the sessions started here run Codex on a fake login:
// they are made and start, and the agent fails its first call later. The states the stack can't
// reach (no agent login at all, no projects, a host refusing user namespaces) are drawn from
// answers the recipe gives the page's reads; every capture taken that way is named `fixture-…`.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

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
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  /**
   * The page has hydrated: React has taken the server's markup over, so typing, clicks and the
   * router reach it. Before then the server's markup takes text and drops it, as it would for a
   * person, and a navigation through the router draws a second page under the first.
   */
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], textarea")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
    if ((await page.locator("textarea").count()) === 0) return;
    await page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].every((field) =>
        Object.keys(field).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const heading = (name) =>
    page.getByRole("heading", { name, exact: true }).filter({ visible: true }).first();
  const text = (words) => page.getByText(words).filter({ visible: true }).first();
  const task = () => page.getByRole("textbox", { name: "Task" }).filter({ visible: true });
  const pick = (name) => page.getByRole("button", { name }).filter({ visible: true }).first();
  const start = () =>
    page.getByRole("button", { name: /^(Start session|Starting…)$/ }).filter({ visible: true });
  /** Answers one tRPC read with what `change` makes of the server's answer, until `unroute`. */
  const rewrite = async (path, change) =>
    page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      const at = paths.indexOf(path);
      if (at === -1) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const entry = Array.isArray(body) ? body[at] : body;
      entry.result.data.json = change(entry.result.data.json);
      await route.fulfill({ response, json: body });
    });
  /** Reads `keys` again in the browser through a page change, so the routes above answer them. */
  const readAgain = async (keys) => {
    await page.evaluate(
      (all) =>
        Promise.all(
          all.map((key) =>
            window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({ queryKey: [key] }),
          ),
        ),
      keys,
    );
  };
  /** Answers every tRPC call with a failure in `message`'s words, one per call of a batch. */
  const failAll = (message) =>
    page.route("**/trpc/**", (route) => {
      const url = new URL(route.request().url());
      const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      const failure = {
        error: {
          json: { message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } },
        },
      };
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(url.searchParams.has("batch") ? calls.map(() => failure) : failure),
      });
    });

  await page.addInitScript(() => {
    if (sessionStorage.getItem("composer-reset") !== null) return;
    sessionStorage.setItem("composer-reset", "1");
    document.cookie = "mend-last-project=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await page.setViewportSize(DESKTOP);
  await open("/");
  await heading("New session").waitFor();
  // What the person last used, put back at the end so the recipe can run again.
  const before = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.platform.sessionDefaults.query(),
  );
  if (before.harness !== "codex")
    await page.evaluate(
      (defaults) =>
        window["__TSR_ROUTER__"].options.context.trpcClient.platform.setSessionDefaults.mutate({
          ...defaults,
          harness: "codex",
        }),
      before,
    );
  await open("/");

  // home-composer: home is the composer on the sheet, beside the sidebar. The stack may hold
  // projects other drives adopted: start from verify-fixture, the one this recipe knows.
  await task().waitFor();
  if ((await pick(/^Project: verify-fixture$/).count()) === 0) {
    await pick(/^Project: /).click();
    await page.getByRole("option", { name: "verify-fixture", exact: true }).click();
  }
  if ((await task().getAttribute("placeholder")) !== "Describe a task or ask a question")
    throw new Error("the task field's placeholder is not the frame's");
  await pick(/^Project: verify-fixture$/).waitFor();
  await pick(/^Agent and model: Codex/).waitFor();
  await pick(/^Worktree: New worktree$/).waitFor();
  if (!(await start().isDisabled())) throw new Error("Start session is on with no task");
  await text("Press Enter to start. Shift+Enter adds a new line.").waitFor();
  note("home: the composer with verify-fixture, Codex and New worktree; Start session is off");
  await both("start-desktop");

  // `c` puts the cursor in the composer.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  if (!(await task().evaluate((field) => field === document.activeElement)))
    throw new Error("c did not focus the task");
  if ((await task().inputValue()) !== "") throw new Error("c typed into the task");
  note("c focuses the task field");

  // A task the agent would read as a command-line option is refused before it is sent.
  await task().fill("--help");
  await text('A task can\'t start with "-".').waitFor();
  if (!(await start().isDisabled()))
    throw new Error("Start session is on for a task starting with -");
  await capture("dash-refused-desktop-light");
  note('a task starting with "-" says why and keeps Start session off');

  // Pick a project: the popover finds a project by name.
  await task().fill("Add idempotency keys to refund requests.");
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").waitFor();
  await page.getByRole("option", { name: "verify-fixture" }).waitFor();
  await both("pick-project-desktop");
  await page.getByPlaceholder("Find a project").fill("no-such-project");
  await text("No project has that name.").waitFor();
  await page.getByPlaceholder("Find a project").fill("verify");
  await page.getByRole("option", { name: "verify-fixture" }).click();
  note("project picker: finds by name, says when nothing matches, picks verify-fixture");

  // web-picker: the agent and model menu. Codex is signed in (the batch's login), Claude Code not.
  await pick(/^Agent and model: /).click();
  const claude = page.getByRole("menuitemradio", { name: /^Claude Code/ });
  const codex = page.getByRole("menuitemradio", { name: /^Codex/ });
  await codex.waitFor();
  if (!/Signed in/.test(await codex.innerText())) throw new Error("Codex is not signed in");
  const claudeWord = (await claude.innerText()).match(/No login|Login refused/)?.[0];
  if (claudeWord === undefined) throw new Error(`Claude Code reads ${await claude.innerText()}`);
  for (const agent of ["opencode", "pi"]) {
    const row = page.getByRole("menuitemradio", { name: new RegExp(`^${agent}`) });
    if (!/Signed in/.test(await row.innerText())) throw new Error(`${agent} is not signed in`);
  }
  const models = page.getByRole("group", { name: "Model" }).getByRole("menuitemradio");
  const modelNames = await models.allInnerTexts();
  if (modelNames.length < 2) throw new Error(`the Model group lists ${modelNames.length} models`);
  await page.getByRole("menuitemcheckbox", { name: /^Fast/ }).waitFor();
  await page.getByRole("menuitemcheckbox", { name: "Land when a turn completes" }).waitFor();
  await both("pick-agent-desktop");
  note(
    `agent menu: Codex, opencode and pi Signed in (one Codex login), Claude Code ${claudeWord}; models ${modelNames.join(", ")}; Fast and Land when a turn completes`,
  );

  // The composer remembers the model on the account: pick another, read the page again.
  const shown = (await pick(/^Agent and model: /).getAttribute("aria-label")) ?? "";
  const picked = modelNames.find((name) => !shown.endsWith(` · ${name}`));
  await models.filter({ hasText: picked }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await pick(new RegExp(`^Agent and model: Codex · ${picked}$`)).waitFor();
  await page.waitForTimeout(1_000);
  await open("/");
  await pick(new RegExp(`^Agent and model: Codex · ${picked}$`)).waitFor();
  const saved = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.platform.sessionDefaults.query(),
  );
  if (saved.harness !== "codex" || saved.byHarness.codex?.model === undefined)
    throw new Error(`the account keeps ${JSON.stringify(saved)}`);
  note(
    `picked ${picked}; after a reload the composer opens on it (the account keeps ${saved.byHarness.codex.model})`,
  );

  // Pick an agent without a login: the band says why, Start stays off, the action leads to logins.
  await task().fill("Add idempotency keys to refund requests.");
  await pick(/^Agent and model: /).click();
  await claude.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await text("Claude Code can't start.").waitFor();
  const add = page
    .getByRole("link", { name: /^(Add Claude Code login|Connect Claude Code again)$/ })
    .filter({ visible: true })
    .first();
  if ((await add.getAttribute("href")) !== "/settings/agent-logins")
    throw new Error(`the login action leads to ${await add.getAttribute("href")}`);
  await text(/^You can start the session once Claude Code has a login/).waitFor();
  if (!(await start().isDisabled()))
    throw new Error("Start session is on for Claude Code with no login");
  await both("agent-no-login-desktop");
  note(
    `Claude Code picked: the band says it can't start and offers "${await add.innerText()}" (/settings/agent-logins); Start is off`,
  );
  await pick(/^Agent and model: /).click();
  await codex.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await text("Claude Code can't start.").waitFor({ state: "hidden" });

  // Pick a worktree: a new one from main, or the batch's worktree by its branch.
  await pick(/^Worktree: /).click();
  await page.getByRole("menuitemradio", { name: /^New worktree from / }).waitFor();
  const existing = page.getByRole("option", { name: /composer-existing/ });
  await existing.waitFor();
  await both("pick-worktree-desktop");
  await existing.click();
  await pick(/^Worktree: mend\/composer-existing$/).waitFor();
  note("worktree picker: New worktree from main, then mend/composer-existing by its branch");

  // Phone: home is the inbox; its New session opens the composer as its own screen.
  await page.setViewportSize(PHONE);
  await open("/");
  await page.getByRole("heading", { name: "Inbox" }).filter({ visible: true }).waitFor();
  await page.getByRole("link", { name: "New session" }).filter({ visible: true }).first().click();
  await page.waitForURL((url) => url.pathname === "/new");
  await heading("New session").waitFor();
  await task().waitFor();
  for (const row of [
    /^Project: verify-fixture$/,
    /^Agent: Codex/,
    /^Worktree: New worktree from /,
  ]) {
    await pick(row).waitFor();
    const height = (await pick(row).boundingBox())?.height ?? 0;
    if (height < 44) throw new Error(`the ${row} row is ${height}px tall, under 44px`);
  }
  await both("start-phone");
  await pick(/^Project: /).click();
  await page.getByRole("dialog", { name: "Project" }).waitFor();
  await both("pick-project-phone");
  await page.keyboard.press("Escape");
  await pick(/^Agent: /).click();
  await page.getByRole("dialog", { name: "Agent and model" }).waitFor();
  await both("pick-agent-phone");
  await page.getByRole("menuitemradio", { name: /^Claude Code/ }).click();
  await page.keyboard.press("Escape");
  await text("Claude Code can't start.").waitFor();
  await both("agent-no-login-phone");
  await pick(/^Agent: /).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape");
  await pick(/^Worktree: /).click();
  await page.getByRole("dialog", { name: "Worktree" }).waitFor();
  await both("pick-worktree-phone");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Close" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByRole("heading", { name: "Inbox" }).filter({ visible: true }).waitFor();
  note(
    "phone: New session opens /new full screen, each picker is a sheet, Close goes back to the inbox",
  );
  await page.setViewportSize(DESKTOP);
  await open("/");
  await pick(/^Worktree: /).click();
  await page.getByRole("option", { name: /composer-existing/ }).click();
  await pick(/^Worktree: mend\/composer-existing$/).waitFor();

  // A start that fails says so, and the task comes back into the field.
  await page.route("**/trpc/**", (route) => {
    if (!route.request().url().includes("worktrees.createSession")) return route.continue();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message: "The verify recipe refused this start on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        },
      ]),
    });
  });
  await task().fill("Change nothing. Reply with done.");
  await task().press("Enter");
  await text(/^The session didn't start\. .*refused this start on purpose/).waitFor();
  if ((await task().inputValue()) !== "Change nothing. Reply with done.")
    throw new Error("the task did not come back after the failed start");
  await both("start-failed-desktop");
  await page.unroute("**/trpc/**");
  note("a refused start says so under the composer, and the task is back in the field");

  // start-composer, in the worktree picked: the button reads Starting… while the session is made
  // (the recipe holds the request a moment to see it), then the session page opens.
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("worktrees.createSession"))
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await task().press("Enter");
  await page.getByRole("button", { name: "Starting…" }).filter({ visible: true }).waitFor();
  note("Enter: the button reads Starting… while the session is made");
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 60_000 });
  await page.unroute("**/trpc/**");
  const joined = new URL(page.url()).pathname.split("/").at(-1);
  await heading("Page not found").waitFor();
  const detail = await page.evaluate(
    (id) => window["__TSR_ROUTER__"].options.context.trpcClient.sessions.detail.query({ id }),
    joined,
  );
  const branch = detail.session.branch;
  if (branch !== "mend/composer-existing")
    throw new Error(`the session runs on ${branch}, not mend/composer-existing`);
  note(
    `Enter started ${joined} in mend/composer-existing and opened /sessions/${joined} (not found until route PR 11)`,
  );

  // start-new-worktree and the landing choice: a new worktree, automatic landing as picked.
  await open("/");
  await pick(/^Worktree: New worktree$/).waitFor();
  const automation = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.platform.automation.query(),
  );
  await pick(/^Agent and model: /).click();
  const land = page.getByRole("menuitemcheckbox", { name: "Land when a turn completes" });
  const startsOn = (await land.getAttribute("aria-checked")) === "true";
  if (startsOn !== automation.effective.autoLand)
    throw new Error(
      `landing starts ${startsOn}, the person's automation is ${automation.effective.autoLand}`,
    );
  await land.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await task().fill("Change nothing. Reply with done.");
  await start().click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 60_000 });
  const fresh = new URL(page.url()).pathname.split("/").at(-1);
  const made = await page.evaluate(
    (id) => window["__TSR_ROUTER__"].options.context.trpcClient.sessions.detail.query({ id }),
    fresh,
  );
  if (made.session.autoLand !== !startsOn)
    throw new Error(`the session records autoLand ${made.session.autoLand}, not ${!startsOn}`);
  if (made.session.branch === "mend/composer-existing")
    throw new Error("Start session joined the old worktree, not a new one");
  note(
    `Start session made ${fresh} on ${made.session.branch}, a new worktree; landing started ${startsOn} from the automation, was picked ${!startsOn}, and the session records autoLand ${made.session.autoLand}`,
  );
  // It shows in the sidebar's inbox, under Running while it starts (or To review once it ends).
  const inbox = page.getByRole("navigation", { name: "Inbox" });
  for (const label of ["Running", "To review"]) {
    const fold = inbox
      .getByRole("region", { name: label, exact: true })
      .getByRole("button", { name: new RegExp(`^${label}`) });
    if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  }
  await inbox.locator(`[data-session-id="${fresh}"]`).first().waitFor({ timeout: 30_000 });
  await capture("started-desktop-light");
  note("the new session shows in the sidebar inbox");

  // The page's read failing: the error screen, and Try again recovers.
  await open("/no-such-page");
  await failAll("The verify recipe failed this read on purpose.");
  await readAgain([["projects", "list"]]);
  await page.evaluate(() => window["__TSR_ROUTER__"].navigate({ to: "/" }));
  await heading("This page didn't load").waitFor();
  await text("The verify recipe failed this read on purpose.").waitFor();
  await both("failed-desktop");
  await page.unroute("**/trpc/**");
  await page.getByRole("button", { name: "Try again" }).click();
  await heading("New session").waitFor();
  note("a failed read shows the error screen; Try again shows the composer");

  // fixture: no agent login at all (frame "First run · agent login skipped").
  await rewrite("platform.sealantIdentity", (identity) => ({ ...identity, accounts: [] }));
  await readAgain([["platform", "sealantIdentity"]]);
  await text("Add a Claude Code or Codex login to start a session.").waitFor();
  await pick(/^Agent and model: No agent login$/).waitFor();
  await both("fixture-no-agent-login-desktop");
  await page.unroute("**/trpc/**");
  await readAgain([["platform", "sealantIdentity"]]);
  note(
    "fixture, no login at all: the card asks for an agent login, the agent pick reads No agent login",
  );

  // fixture: a host that refuses user namespaces.
  await rewrite("platform.machine", (machine) => ({
    ...machine,
    userNamespaces: { allowed: false, setting: "kernel.apparmor_restrict_unprivileged_userns=0" },
  }));
  await readAgain([["platform", "machine"]]);
  await text("No session can start on this server.").waitFor();
  await both("fixture-userns-desktop");
  await page.unroute("**/trpc/**");
  await readAgain([["platform", "machine"]]);
  note("fixture, the host refuses user namespaces: the band says so, with the command");

  // fixture: no projects yet.
  await rewrite("projects.list", () => []);
  await open("/no-such-page");
  await readAgain([["projects", "list"]]);
  await page.evaluate(() => window["__TSR_ROUTER__"].navigate({ to: "/" }));
  await heading("No projects yet").waitFor();
  await both("fixture-no-projects-desktop");
  await page.unroute("**/trpc/**");
  await readAgain([["projects", "list"]]);
  note("fixture, no projects: the composer says to adopt one on the Projects page");

  // Stop the sessions this drive started: their agent keeps using the fake login, and the
  // provider's refusals would make it refused before the next drive's batch could reconnect it.
  await page.evaluate(
    (ids) =>
      Promise.all(
        ids.map((id) =>
          window["__TSR_ROUTER__"].options.context.trpcClient.sessions.stop
            .mutate({ id })
            .catch(() => undefined),
        ),
      ),
    [joined, fresh],
  );
  note(`stopped the two sessions this drive started (${joined}, ${fresh})`);

  // Put back what the person last used.
  await page.evaluate(
    (defaults) =>
      window["__TSR_ROUTER__"].options.context.trpcClient.platform.setSessionDefaults.mutate(
        defaults,
      ),
    before,
  );
  note("the account's session defaults are as they were before the recipe");
};
