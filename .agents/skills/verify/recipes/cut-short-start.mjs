// A start cut short (SLNT-1239): the tab that started a session closes, or reloads, after Mend got
// the start and before its answer reached the page. Mend must still launch the session with its
// first message, and a reloaded page must land on that session, never on an empty composer.
// Run the composer's CLI batch first: it gives the stack's account a (fake) Codex login.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/composer-setup.json
//   pnpm verify drive web --recipe cut-short-start
//
// The recipe lets the start's request reach Mend and holds back Mend's answer, as a slow server or
// a person quick on the reload key would, then closes the tab (or reloads it). On a build where
// the browser sent the launch as a second request once Mend answered the first, the closed tab's
// session never launches: it reads Starting for good and holds no message ("never launched"), and
// the reload lands on `/` with an empty composer ("an empty composer").
//
// Feature ids: start-session.md start-composer.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const STAMP = new Date().toISOString().slice(11, 19).replaceAll(":", "");
const CLOSED = `Change nothing. Reply with closed ${STAMP}.`;
const RELOADED = `Change nothing. Reply with reloaded ${STAMP}.`;
/** How long Mend has to launch a start whose tab went away. */
const LAUNCH_MS = 120_000;
const MADE = /\/sessions\/(?!starting-)[0-9a-f-]+$/;

/** The procedures a start's request calls, from a tRPC address such as `/trpc/a,b?batch=1`. */
const proceduresOf = (url) =>
  decodeURIComponent(new URL(url).pathname.replace(/^.*\/trpc\//, "")).split(",");

/** Whether a request is the one that starts a session: before SLNT-1239, `sessions.create`. */
const startsASession = (url) =>
  proceduresOf(url).some((name) => name === "sessions.create" || name === "sessions.start");

/** The first session in an answer: an object with a uuid `id` and a `worktreeId`. */
const sessionIn = (value) => {
  if (Array.isArray(value)) {
    for (const each of value) {
      const found = sessionIn(each);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id) && "worktreeId" in value)
    return value.id;
  for (const each of Object.values(value)) {
    const found = sessionIn(each);
    if (found !== null) return found;
  }
  return null;
};

/** Waits for the page's router and for React to own its controls. */
const hydrated = async (on) => {
  await on.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, undefined, {
    timeout: 90_000,
  });
  await on.waitForFunction(
    () =>
      [...document.querySelectorAll("textarea, button")].some((field) =>
        Object.keys(field).some((key) => key.startsWith("__reactProps")),
      ),
    undefined,
    { timeout: 90_000 },
  );
};

/** Calls a tRPC procedure from the page, as the page would. */
const client = (on, path, input, kind = "query") =>
  on.evaluate(
    ([at, args, verb]) => {
      const procedure = at
        .split(".")
        .reduce((node, key) => node[key], window["__TSR_ROUTER__"].options.context.trpcClient);
      return procedure[verb](args);
    },
    [path, input, kind],
  );

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  // Every check that fails, said at the end: a cut-short close doesn't hide what a reload does.
  const failures = [];
  const fail = (words) => {
    failures.push(words);
    note(`FAILED · ${words}`);
  };
  /** Open `/` in `on`, with verify-fixture and Codex picked, ready to write the first message. */
  const composer = async (on) => {
    await on.goto(`${web}/`);
    await hydrated(on);
    const pick = (name) => visible(on.getByRole("button", { name }));
    await visible(on.getByRole("textbox", { name: "Task" })).waitFor();
    if ((await pick(/^Project: verify-fixture$/).count()) === 0) {
      await pick(/^Project: /).click();
      await on.getByRole("option", { name: "verify-fixture", exact: true }).click();
    }
    await pick(/^Agent and model: Codex/).waitFor();
    return visible(on.getByRole("textbox", { name: "Task" }));
  };

  /**
   * Start a session with `words` in `on`, let the start reach Mend, and run `cut` once Mend has
   * answered and before the page sees that answer. Answers the session Mend made.
   */
  const startCutShort = async (on, words, cut) => {
    const task = await composer(on);
    let made = null;
    let cutDone;
    const cutOver = new Promise((resolve) => {
      cutDone = resolve;
    });
    await on.route("**/trpc/**", async (route) => {
      if (made !== null || !startsASession(route.request().url())) return route.continue();
      made = "pending";
      const answer = await route.fetch();
      made = sessionIn(await answer.json().catch(() => null));
      // Mend has answered; the page never hears it.
      await cut().catch(() => undefined);
      cutDone();
    });
    await task.fill(words);
    await task.press("Enter");
    await cutOver;
    if (made === null || made === "pending")
      throw new Error("Mend's answer to the start named no session");
    return made;
  };

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await hydrated(page);
  const defaults = await client(page, "platform.sessionDefaults", undefined);
  if (defaults.harness !== "codex")
    await client(page, "platform.setSessionDefaults", { ...defaults, harness: "codex" }, "mutate");

  // 1. The tab closes the moment Mend has the start.
  const tab = await page.context().newPage();
  await tab.setViewportSize(DESKTOP);
  const closedAt = Date.now();
  const closed = await startCutShort(tab, CLOSED, () => tab.close());
  note(`closed: Mend made ${closed}; the tab closed before the page saw Mend's answer`);
  let detail = await client(page, "sessions.detail", { id: closed });
  for (
    let left = LAUNCH_MS;
    left > 0 && detail.session.status === "starting" && detail.session.startedAt === null;
    left -= 2_000
  ) {
    await page.waitForTimeout(2_000);
    detail = await client(page, "sessions.detail", { id: closed });
  }
  const turns = await client(page, "sessions.historyTurns", {
    id: closed,
    cursor: null,
    limit: 50,
  }).catch(() => null);
  const holds = JSON.stringify(turns ?? {}).includes(CLOSED);
  note(
    `closed: ${Math.round((Date.now() - closedAt) / 1000)} s later it reads ${detail.session.status}, started ${detail.session.startedAt === null ? "never" : "yes"}, summary "${detail.session.summary ?? ""}"; the conversation ${holds ? "holds" : "does not hold"} the first message`,
  );
  await page.goto(`${web}/sessions/${closed}`);
  await hydrated(page);
  await page.waitForTimeout(1_500);
  await capture("closed-tab-session-desktop-light");
  if (detail.session.status === "starting" && detail.session.startedAt === null && !holds)
    fail(
      `Mend made ${closed} but it never launched: two minutes after its tab closed it still reads Starting and holds no message`,
    );
  else if (!holds) fail(`the first message of ${closed} is gone`);
  else {
    await visible(page.locator('[data-slot="user-message"]').filter({ hasText: CLOSED })).waitFor({
      timeout: 30_000,
    });
    note("closed: the session's page shows the first message");
  }

  // 2. The page reloads the moment Mend has the start.
  const reloaded = await startCutShort(page, RELOADED, async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.reload({ waitUntil: "commit" });
  });
  note(`reloaded: Mend made ${reloaded}; the page reloaded before it saw Mend's answer`);
  await hydrated(page);
  const landed = await page
    .waitForURL(MADE, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const at = new URL(page.url()).pathname;
  note(`reloaded: the page is at ${at}`);
  if (!landed) {
    await capture("reload-during-start-desktop-light");
    fail(
      `after a reload during the start the page is at ${at}, with an empty composer, not on the session Mend made`,
    );
  } else if (at !== `/sessions/${reloaded}`) {
    fail(`after the reload the page opened ${at}, not ${reloaded}`);
  } else {
    await visible(page.locator('[data-slot="user-message"]').filter({ hasText: RELOADED })).waitFor(
      { timeout: 30_000 },
    );
    note("reloaded: the page moved to the session and shows its first message");
    await capture("reload-during-start-desktop-light");
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(500);
    await capture("reload-during-start-phone-light");
    await page.setViewportSize(DESKTOP);
  }
  note(`stop both sessions when done: ${closed} ${reloaded}`);
  if (failures.length > 0) throw new Error(failures.join("; "));
};
