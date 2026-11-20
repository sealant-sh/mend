// Starting a session from the new web app's composer (SLNT-1196, the owner's pass of 20 Nov 2026,
// items 1 and 11): the session's page opens at once, a message written while it starts waits and
// goes once the agent runs, and a refused start comes back to the composer. Run the composer's CLI
// batch first: it gives the stack's account a (fake) Codex login and makes a worktree.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-composer-setup.json
//   pnpm verify drive new-web --recipe new-web-instant-start
//
// Feature ids: start-session.md start-composer (the instant start) and session-conversation.md
// send-follow-up (a message written while the session starts). The stack's Codex login is fake, so
// the agent starts and its first call fails later: enough for it to run and take the message.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const PROMPT = "Change nothing. Reply with done.";
const FOLLOW_UP = "Then list the top-level folders.";
const DRAFT = /\/sessions\/starting-[^/]+$/;
const MADE = /\/sessions\/(?!starting-)[^/]+$/;

/** What the server holds as said in a session: each turn's words and the words steered into it. */
const inputsOf = (held) =>
  held.turns.flatMap((turn) => [
    turn.input,
    ...(turn.steers ?? []).map((steer) => steer.input ?? ""),
  ]);

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
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].every((field) =>
        Object.keys(field).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const text = (words) => page.getByText(words).filter({ visible: true }).first();
  const task = () => page.getByRole("textbox", { name: "Task" }).filter({ visible: true });
  const pick = (name) => page.getByRole("button", { name }).filter({ visible: true }).first();
  const message = () =>
    page.getByRole("textbox", { name: "Message Codex" }).filter({ visible: true });
  const trpc = (path, input) =>
    page.evaluate(
      ([at, args]) =>
        at
          .split(".")
          .reduce((node, key) => node[key], window["__TSR_ROUTER__"].options.context.trpcClient)
          .query(args),
      [path, input],
    );
  const made = [];
  /** Picks verify-fixture, Codex and a new worktree in the composer on screen. */
  const ready = async () => {
    await task().waitFor();
    if ((await pick(/^Project: verify-fixture$/).count()) === 0) {
      await pick(/^Project: /).click();
      await page.getByRole("option", { name: "verify-fixture", exact: true }).click();
    }
  };

  await page.addInitScript(() => {
    if (sessionStorage.getItem("instant-reset") !== null) return;
    sessionStorage.setItem("instant-reset", "1");
    localStorage.setItem("mend-theme", "light");
  });
  await page.setViewportSize(DESKTOP);
  await open("/");
  const defaults = await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.platform.sessionDefaults.query(),
  );
  if (defaults.harness !== "codex")
    await page.evaluate(
      (before) =>
        window["__TSR_ROUTER__"].options.context.trpcClient.platform.setSessionDefaults.mutate({
          ...before,
          harness: "codex",
        }),
      defaults,
    );
  await open("/");
  await ready();
  await pick(/^Agent and model: Codex/).waitFor();
  await pick(/^Worktree: New worktree$/).waitFor();
  // Running starts folded: open it, so the start's row is in view.
  const inbox = page.getByRole("navigation", { name: "Inbox" });
  const running = inbox
    .getByRole("region", { name: "Running", exact: true })
    .getByRole("button", { name: /^Running/ });
  if ((await running.getAttribute("aria-expanded")) === "false") await running.click();

  // Before: what the old start waited for before its page showed the message: Mend making the
  // session, then the page reading it. Timed here on the same stack, with a session made for it.
  const before = await page.evaluate(async () => {
    const client = window["__TSR_ROUTER__"].options.context.trpcClient;
    const projects = await client.projects.list.query();
    const project = projects.find((each) => each.name === "verify-fixture");
    const t0 = performance.now();
    const session = await client.sessions.create.mutate({
      projectId: project.id,
      session: { harness: "codex", mode: "protocol", label: null, name: null, base: null },
    });
    const createMs = performance.now() - t0;
    await client.sessions.detail.query({ id: session.id });
    const totalMs = performance.now() - t0;
    // Made only to be timed: it never starts, so it goes again at once.
    await client.sessions.remove.mutate({ id: session.id }).catch(() => undefined);
    return { id: session.id, createMs, totalMs };
  });
  note(
    `before (main's flow, timed on this stack): Mend made the session in ${Math.round(before.createMs)} ms and the page read it ${Math.round(before.totalMs - before.createMs)} ms later: ${Math.round(before.totalMs)} ms from Start to the page with the message`,
  );

  // start-composer: Start opens the session's page at once, the message on it, the row in Running.
  // The recipe holds Mend's answer 3 s, as a slow server would, to see the page before it.
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("sessions.create"))
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await task().fill(PROMPT);
  const pressed = Date.now();
  await task().press("Enter");
  await page.waitForURL(DRAFT);
  await page.getByText(PROMPT).filter({ visible: true }).first().waitFor();
  const shown = Date.now() - pressed;
  const draftId = new URL(page.url()).pathname.split("/").at(-1);
  await inbox.locator(`[data-session-id="${draftId}"]`).first().waitFor();
  await text("Getting the session ready").waitFor();
  note(
    `after: Enter opened /sessions/${draftId} with the message in ${shown} ms, before Mend answered (held 3 s); the sidebar lists it under Running`,
  );
  await capture("instant-start-desktop-light");

  // send-follow-up while the session starts: the composer takes it, the message waits.
  await message().waitFor();
  if (await message().isDisabled()) throw new Error("the composer is locked while starting");
  await text("Codex is starting. What you send now goes to it once it's ready.").waitFor();
  await message().fill(FOLLOW_UP);
  await message().press("Enter");
  await text("Waits for Codex to start.").waitFor();
  await both("follow-up-waiting-desktop");
  note("on the start's page the composer is open; a message sent there waits for Codex to start");

  // Mend answers: the address moves to the session's id, the page stays, the message moves along.
  await page.waitForURL(MADE, { timeout: 60_000 });
  await page.unroute("**/trpc/**");
  const sessionId = new URL(page.url()).pathname.split("/").at(-1);
  made.push(sessionId);
  await page.getByText(PROMPT).filter({ visible: true }).first().waitFor();
  await page.getByText(FOLLOW_UP).filter({ visible: true }).first().waitFor();
  await inbox.locator(`[data-session-id="${sessionId}"]`).first().waitFor();
  if ((await inbox.locator(`[data-session-id="${draftId}"]`).count()) !== 0)
    throw new Error("the start's own row is still listed beside the session's");
  const history = await page.evaluate(() => window.history.length);
  note(
    `Mend made ${sessionId}: the address moved to /sessions/${sessionId} in place (history ${history}), the message and the waiting one stayed, one row in Running`,
  );

  // Item 1: while the session starts, the composer takes messages, never the terminal lock.
  const detail = await trpc("sessions.detail", { id: sessionId });
  if (detail.session.status === "starting") {
    if ((await text(/runs in a terminal in this session/).count()) > 0)
      throw new Error("the composer reads as a terminal while the session starts");
    await text("Codex is starting. What you send now goes to it once it's ready.").waitFor();
    await both("composer-while-starting-desktop");
    note(`the session reads ${detail.session.status}; its composer is open and says so`);
  } else note(`the session already read ${detail.session.status} when its page settled`);

  // Once Codex runs and its opening turn is in, the waiting message goes after it.
  // The server holds it as a turn after the opening one (or a steer into it): proof it was sent.
  let held = { turns: [] };
  for (let wait = 0; wait < 120; wait += 1) {
    held = await trpc("sessions.historyTurns", { id: sessionId, cursor: null, limit: 50 });
    if (inputsOf(held).some((input) => input.includes(FOLLOW_UP))) break;
    if ((await text(/^Not sent\./).count()) > 0)
      throw new Error(`the waiting message reads ${await text(/^Not sent\./).innerText()}`);
    await page.waitForTimeout(2_000);
  }
  const inputs = inputsOf(held);
  if (!inputs.some((input) => input.includes(FOLLOW_UP)))
    throw new Error(
      `the server holds no turn or steer with the message: ${JSON.stringify(inputs)}`,
    );
  await text("Waits for Codex to start.").waitFor({ state: "hidden", timeout: 30_000 });
  if (!(held.turns[0]?.input ?? "").includes(PROMPT))
    throw new Error(`the first turn is not the opening one: ${JSON.stringify(inputs)}`);
  await settled();
  await both("follow-up-sent-desktop");
  note(
    `Codex ran: the waiting message was sent after the opening turn; the server holds ${JSON.stringify(inputs)}`,
  );

  // From a worktree's menu: the same instant start, and nothing red while the session gets ready.
  const fixture = (await trpc("projects.list")).find((each) => each.name === "verify-fixture");
  await open(`/projects/${fixture.id}/worktrees`);
  const actions = page
    .getByRole("button", { name: "Actions for composer-existing" })
    .filter({ visible: true })
    .first();
  await actions.scrollIntoViewIfNeeded();
  // The list reads again as sessions move, which can close a menu just opened: open it again.
  for (let tries = 0; tries < 3; tries += 1) {
    await actions.click();
    const opened = await page
      .getByRole("menuitem", { name: /^New session in/ })
      .first()
      .waitFor({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
  }
  await page
    .getByRole("menuitem", { name: /^New session in/ })
    .first()
    .click();
  const menuPressed = Date.now();
  await page
    .getByRole("menuitem", { name: /^Codex/ })
    .first()
    .click();
  await page.waitForURL(/\/sessions\/[^/]+$/);
  await text("Getting the session ready").waitFor();
  const menuShown = Date.now() - menuPressed;
  const seen = new Set();
  for (let look = 0; look < 20; look += 1) {
    for (const words of await page.getByRole("alert").allInnerTexts())
      if (words.trim() !== "") seen.add(words.trim());
    if (look === 1) await capture("menu-start-desktop-light");
    await page.waitForTimeout(1_000);
  }
  if (seen.size > 0)
    throw new Error(`the page showed an alert while starting: ${[...seen].join(" | ")}`);
  const menuSession = new URL(page.url()).pathname.split("/").at(-1);
  if (menuSession.startsWith("starting-")) await page.waitForURL(MADE, { timeout: 60_000 });
  made.push(new URL(page.url()).pathname.split("/").at(-1));
  await capture("menu-started-desktop-light");
  note(
    `worktree menu, New session in this worktree, Codex: the session's page and "Getting the session ready" in ${menuShown} ms; no alert in the 20 s it was watched`,
  );

  // A refused start: back at the composer, the words in the field, Mend's reason in an alert.
  await open("/");
  await ready();
  await page.route("**/trpc/**", (route) => {
    if (!route.request().url().includes("sessions.create")) return route.continue();
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
  await task().fill(PROMPT);
  await task().press("Enter");
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await page
    .getByRole("alert")
    .filter({ hasText: /The session didn't start\. .*refused this start on purpose/ })
    .filter({ visible: true })
    .first()
    .waitFor();
  if ((await task().inputValue()) !== PROMPT)
    throw new Error("the words did not come back after the refused start");
  await page.unroute("**/trpc/**");
  await both("refused-desktop");
  note(
    "a refused start goes back to the composer, the words in the field, Mend's reason in an alert",
  );

  // Phone: /new starts the same way.
  await page.setViewportSize(PHONE);
  await open("/new");
  await ready();
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("sessions.create"))
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await task().fill(PROMPT);
  await pick(/^Start session$/).click();
  await page.waitForURL(DRAFT);
  await page.getByText(PROMPT).filter({ visible: true }).first().waitFor();
  await both("instant-start-phone");
  await page.waitForURL(MADE, { timeout: 60_000 });
  await page.unroute("**/trpc/**");
  made.push(new URL(page.url()).pathname.split("/").at(-1));
  await page.getByText(PROMPT).filter({ visible: true }).first().waitFor();
  await both("started-phone");
  note("phone: Start session opens the session's page at once; it settles on the session's id");
  await page.setViewportSize(DESKTOP);

  // Stop what this drive started, and put the person's agent back.
  await page.evaluate(
    (ids) =>
      Promise.all(
        ids.map((id) =>
          window["__TSR_ROUTER__"].options.context.trpcClient.sessions.stop
            .mutate({ id })
            .catch(() => undefined),
        ),
      ),
    made,
  );
  await page.evaluate(
    (back) =>
      window["__TSR_ROUTER__"].options.context.trpcClient.platform.setSessionDefaults.mutate(back),
    defaults,
  );
  note(`stopped ${made.join(", ")}`);
};
