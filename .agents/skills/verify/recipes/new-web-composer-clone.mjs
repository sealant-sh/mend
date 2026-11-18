// A session started while its project still clones, in the new web app (route PR 10 part 2,
// SLNT-1112). Run the composer's CLI batch first (a fake Codex login, so Codex can be picked):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-composer-setup.json
//   pnpm verify drive new-web --recipe new-web-composer-clone
//
// The recipe starts a real clone the way the setup step and Projects' Adopt will (they aren't in
// the new app yet): `projects.adopt` with a key it keeps in this browser for the account. The
// clone is of a public repository on GitHub big enough to take about 40 seconds (godotengine/godot);
// the stack reaches GitHub. Then: the composer offers the cloning project, a session queued on it
// waits under Running as "Waiting for the clone" and starts by itself when the clone finishes. A
// clone of a repository that doesn't exist fails, and the session queued on it shows Failed under
// To review with why, and is cancelled from its "…". The first run's notice with no other project
// is drawn by answering the project list with none: its capture is named `fixture-…`.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const BIG_REPOSITORY = "https://github.com/godotengine/godot.git";
const MISSING_REPOSITORY = "https://github.com/sealant-sh/mend-verify-no-such-repository.git";

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
      [...document.querySelectorAll("a[href], textarea")].some((element) =>
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
  /** A page change through the router, which renders the page again with what the browser keeps. */
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const text = (words) => page.getByText(words).filter({ visible: true }).first();
  const pick = (name) => page.getByRole("button", { name }).filter({ visible: true }).first();
  const task = () => page.getByRole("textbox", { name: "Task" }).filter({ visible: true });
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const unfold = async (label) => {
    const fold = inbox()
      .getByRole("region", { name: label, exact: true })
      .getByRole("button", { name: new RegExp(`^${label}`) });
    if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  };
  /** A tRPC call from the page, as the signed-in person. */
  const call = async (path, input, kind = "query") => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await evaluateCall(path, input, kind);
      } catch (error) {
        if (attempt >= 2 || !String(error).includes("Execution context was destroyed")) throw error;
        await hydrated();
      }
    }
  };
  const evaluateCall = (path, input, kind) =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  /**
   * Start a clone under a new key, kept for the account as the setup step will keep it. The
   * request runs on in the page; the clone runs on on the server whatever becomes of it.
   */
  const adopt = (source, name, userId) =>
    page.evaluate(
      ({ source: from, name: called, userId: owner }) => {
        const adoptionId = crypto.randomUUID();
        void window["__TSR_ROUTER__"].options.context.trpcClient.projects.adopt
          .mutate({ name: called, source: from, adoptionId })
          .catch(() => undefined);
        localStorage.setItem(
          `mend-adoption.${owner}`,
          JSON.stringify({ id: adoptionId, name: called, startedAt: Date.now() }),
        );
        return adoptionId;
      },
      { source, name, userId },
    );
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("clone-reset") !== null) return;
    sessionStorage.setItem("clone-reset", "1");
    localStorage.setItem("mend-theme", "light");
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
  });
  await open("/");
  const me = (await call("organization.current")).userId;
  const before = await call("platform.sessionDefaults");
  await call("platform.setSessionDefaults", { ...before, harness: "codex" }, "mutate");
  const suffix = Math.random().toString(36).slice(2, 6);

  // A real clone: the composer offers its project while it runs.
  const name = `godot-${suffix}`;
  const adoptionId = await adopt(BIG_REPOSITORY, name, me);
  await go("/no-such-page");
  await go("/");
  await pick(/^Project: /).click();
  const cloning = page.getByRole("option", { name: new RegExp(`^${name}.*Cloning`) });
  await cloning.waitFor({ timeout: 20_000 });
  note(`started cloning ${BIG_REPOSITORY} as ${name} (key ${adoptionId.slice(0, 8)})`);
  await cloning.click();
  await text(`${name} is still cloning.`).waitFor();
  if (!(await pick(/^Worktree: New worktree$/).isDisabled()))
    throw new Error("the worktree pick is on for a project still cloning");
  await both("clone-start-desktop");
  note(`picked ${name}: the band says it is still cloning and the session can start now`);

  // The first run: the cloning project is the only one (the list answered with none).
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
  await text(/is still cloning\. You can write your task now\./).waitFor();
  await both("fixture-first-run-clone-desktop");
  await page.unroute("**/trpc/**");
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({
      queryKey: [["projects", "list"]],
    }),
  );
  note("fixture, the cloning project the only one: the card says the task can be written now");

  // Queue a session on the clone: it waits under Running.
  await text(`${name} is still cloning.`).waitFor();
  await task().fill("Change nothing. Reply with done.");
  await task().press("Enter");
  await text(/^Queued\. The session starts when .* finishes cloning\./).waitFor();
  await unfold("Running");
  const waiting = inbox()
    .locator("[data-queued-session-id]")
    .filter({ hasText: "Waiting for the clone" });
  await waiting.first().waitFor({ timeout: 10_000 });
  const queuedId = await waiting.first().getAttribute("data-queued-session-id");
  await both("queued-desktop");
  note(
    `queued ${queuedId}: under Running, "Waiting for the clone"; the composer says it starts when the clone finishes`,
  );

  // The phone: the inbox's band and the waiting row, and the composer on the clone.
  await page.setViewportSize(PHONE);
  await go("/");
  await text(new RegExp(`^${name} is still cloning`)).waitFor();
  await unfold("Running");
  await inbox().locator(`[data-queued-session-id="${queuedId}"]`).waitFor();
  await both("queued-phone");
  await go("/new");
  await pick(/^Project: /).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await text(`${name} is still cloning.`).waitFor();
  if (!/Cloning/.test(await pick(/^Project: /).innerText()))
    throw new Error("the phone's project row doesn't say the project is cloning");
  if (!(await pick(/^Worktree: /).isDisabled()))
    throw new Error("the phone's worktree row is on for a project still cloning");
  await both("clone-start-phone");
  await page.setViewportSize(DESKTOP);
  await go("/");
  note(
    "phone: the inbox says the project is still cloning and lists the waiting session; /new offers the clone",
  );

  // A composer left on the cloning project moves onto it once the clone finishes.
  await pick(/^Project: /).click();
  const stillCloning = page.getByRole("option", { name: new RegExp(`^${name}.*Cloning`) });
  if ((await stillCloning.count()) > 0) {
    await stillCloning.click();
    await text(`${name} is still cloning.`).waitFor({ state: "hidden", timeout: 300_000 });
    await pick(new RegExp(`^Project: ${name}$`)).waitFor();
    if (await pick(/^Worktree: /).isDisabled())
      throw new Error("the worktree pick stayed off once the project was cloned");
    await capture("cloned-composer-desktop-light");
    note(
      `left on ${name}, the composer moved onto the cloned project: no band, the worktree pick on`,
    );
  } else {
    await page.keyboard.press("Escape");
    note(`${name} had finished cloning before the composer was back on it: not seen moving`);
  }

  // The clone finishes: the session starts by itself, and the inbox lists it in the row's place.
  const started = await waitFor(
    "the queued session starting",
    async () => {
      const row = await call("queuedSessions.read", { id: queuedId });
      if (row.state === "failed")
        throw new Error(`the queued session failed: ${row.failure?.message}`);
      return row.state === "started" ? row.sessionId : null;
    },
    300,
  );
  for (const label of ["Running", "To review"]) await unfold(label);
  await inbox().locator(`[data-session-id="${started}"]`).first().waitFor({ timeout: 30_000 });
  await inbox().locator(`[data-queued-session-id="${queuedId}"]`).waitFor({ state: "detached" });
  await capture("started-after-clone-desktop-light");
  note(
    `the clone finished and ${queuedId} started by itself as session ${started}; the inbox lists the session in its place`,
  );

  // A clone that fails: the session queued on it fails too, with why, and is cancelled.
  const missing = `missing-${suffix}`;
  const failedClone = await adopt(MISSING_REPOSITORY, missing, me);
  await waitFor(
    "the clone failing",
    async () => {
      // Until the adopt request reaches the server, it doesn't know the key yet.
      const progress = await call("projects.adoption", { id: failedClone }).catch(() => null);
      return progress?.state === "failed" ? progress : null;
    },
    120,
  );
  const failedId = await page.evaluate(() => crypto.randomUUID());
  await call(
    "queuedSessions.queue",
    {
      id: failedId,
      adoptionId: failedClone,
      session: { harness: "codex", mode: "protocol", label: null, name: null, base: null },
      launch: { prompt: "This waits for a clone that fails.", mode: "protocol" },
    },
    "mutate",
  );
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
      queryKey: [["queuedSessions", "list"]],
    }),
  );
  await unfold("To review");
  const failedRow = inbox().locator(`[data-queued-session-id="${failedId}"]`);
  await failedRow.waitFor({ timeout: 20_000 });
  const failedWords = await failedRow.innerText();
  if (!failedWords.includes("Failed")) throw new Error(`the failed row reads ${failedWords}`);
  await both("clone-failed-desktop");
  note(
    `a clone of a missing repository failed; the session queued on it reads: ${failedWords.replace(/\s+/g, " ")}`,
  );
  await page.setViewportSize(PHONE);
  await go("/");
  await unfold("To review");
  await inbox().locator(`[data-queued-session-id="${failedId}"]`).waitFor();
  await both("clone-failed-phone");
  await page.setViewportSize(DESKTOP);
  await go("/");
  await unfold("To review");
  await failedRow.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Cancel session" }).click();
  await failedRow.waitFor({ state: "detached", timeout: 20_000 });
  note("Cancel session from the failed row's … removes it");

  // Put back what this drive changed: the session it started stops, the browser forgets the
  // clone, the person's defaults are as before.
  await call("sessions.stop", { id: started }, "mutate").catch(() => undefined);
  await page.evaluate((owner) => localStorage.removeItem(`mend-adoption.${owner}`), me);
  await call("platform.setSessionDefaults", before, "mutate");
  note(`stopped ${started}; the projects ${name} and its clone stay on the stack`);
};
