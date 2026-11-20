// Which group a session sits in, the words its row says, its glyph, and how rows move (SLNT-1199):
// the groups follow the session's life, not the agent's turn. Run the CLI batch first, once per
// stack:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-session-states.json
//   pnpm verify drive new-web --recipe new-web-session-states
//
// Real sessions (commands) prove what a local stack can: a live session under Running with the
// server's new facts (`turnOpen`, `lastNewAt`), ended ones under To review (files, or failed) and
// Done (no files), the row menu by group, Stop session… from a row moving it to To review or Done,
// and the project's Sessions tab saying the same words with the same glyphs. A local stack runs no
// provider's agent, so the agent's own moves (asks, answered, replied, a snoozed one asking, a
// done one resumed) are fixture rows the recipe answers the inbox read with, changed step by step
// and read again so the sidebar moves them live; every capture taken that way is named `fixture-…`.
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
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const group = (label) => inbox().getByRole("region", { name: label, exact: true });
  const heading = (label) => group(label).getByRole("button", { name: new RegExp(`^${label}`) });
  const isOpen = async (label) => (await heading(label).getAttribute("aria-expanded")) === "true";
  const setOpen = async (label, open) => {
    if ((await isOpen(label)) !== open) await heading(label).click();
    await group(label)
      .getByRole("button", { name: new RegExp(`^${label}`), expanded: open })
      .waitFor({ timeout: 5_000 });
  };
  // A whole title: "states-live" must not match "states-live-files".
  const rows = (label, title) =>
    group(label).getByRole("link", { name: new RegExp(`^${title}(?!-)`) });
  const row = (label, title) => rows(label, title).first();
  const showAll = async (label) => {
    const more = group(label).getByRole("button", { name: /^Show \d+ more$/ });
    if ((await more.count()) > 0) await more.click();
  };
  const openAll = async () => {
    for (const label of ["Waiting on you", "To review", "Running", "Snoozed", "Done"]) {
      await setOpen(label, true);
      await showAll(label);
    }
  };
  const router = () => page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  const hydrated = async () => {
    await router();
    await page.waitForFunction(() => {
      const control = document.querySelector("[data-slot=collapsible-trigger]");
      return control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"));
    });
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const navigate = (to) =>
    page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const readAgain = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions"]],
      }),
    );
  /** Opens a row's "…" menu and reads its items. */
  const menuOf = async (label, title) => {
    const target = row(label, title);
    await target.hover();
    await group(label)
      .getByRole("button", { name: `Actions for ${title}`, exact: true })
      .click();
    const menu = page.getByRole("menu").filter({ visible: true });
    await menu.waitFor();
    return (await menu.getByRole("menuitem").allInnerTexts()).map((text) => text.split("\n")[0]);
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("menu").filter({ visible: true }).waitFor({ state: "detached" });
  };
  /** A burst of captures while a row moves: in place, sliding, lit, settled. */
  const burst = async (name, frames) => {
    for (let index = 0; index < frames; index += 1)
      await capture(`${name}-${String(index).padStart(2, "0")}`);
  };
  const waitFor = async (what, check, seconds = 60) => {
    for (let waited = 0; !(await check()); waited += 1) {
      if (waited > seconds * 2) throw new Error(`gave up waiting: ${what}`);
      await page.waitForTimeout(500);
    }
  };

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await open("/");
  await openAll();

  // Real sessions where their life puts them.
  await row("Running", "states-live").waitFor();
  await row("Running", "states-live-files").waitFor();
  await row("To review", "states-files").waitFor();
  await row("To review", "states-failed").getByText("Failed", { exact: true }).waitFor();
  await row("Done", "states-none").waitFor();
  const facts = await page.evaluate(() => {
    const listed = window["__TSR_ROUTER__"].options.context.queryClient
      .getQueryCache()
      .findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state.data;
    const live = listed?.find((each) => each.title === "states-live");
    return live === undefined
      ? null
      : { status: live.session.status, turnOpen: live.turnOpen, lastNewAt: String(live.lastNewAt) };
  });
  if (facts?.turnOpen !== true || facts.lastNewAt === "undefined" || facts.lastNewAt === "null")
    throw new Error(`the server didn't send states-live's new facts: ${JSON.stringify(facts)}`);
  note(`server: states-live reads ${JSON.stringify(facts)}`);
  const glyphs = {
    live: await glyphOf(row("Running", "states-live")),
    files: await glyphOf(row("To review", "states-files")),
    failed: await glyphOf(row("To review", "states-failed")),
    none: await glyphOf(row("Done", "states-none")),
  };
  note(
    `desktop: states-live "${await wordOf(row("Running", "states-live"))}" glyph ${glyphs.live}; states-files under To review "${await wordOf(row("To review", "states-files"))}" glyph ${glyphs.files}; states-failed (no files) under To review glyph ${glyphs.failed}; states-none under Done "${await wordOf(row("Done", "states-none"))}" glyph ${glyphs.none}`,
  );
  if (glyphs.live !== "run" || glyphs.files !== "done" || glyphs.failed !== "fail")
    throw new Error(`glyphs don't follow the group: ${JSON.stringify(glyphs)}`);
  await both("states-desktop");

  // The row menu by group: Running offers Stop session…, not Snooze or Mark done; To review
  // offers Snooze and Mark done, not Stop.
  const runningMenu = await menuOf("Running", "states-live");
  note(`Running row menu: ${runningMenu.join(", ")}`);
  if (!runningMenu.includes("Stop session…") || runningMenu.includes("Mark done"))
    throw new Error(`a Running row's menu is wrong: ${runningMenu.join(", ")}`);
  if (runningMenu.includes("Snooze") || !runningMenu.includes("Open project"))
    throw new Error(`a Running row's menu is wrong: ${runningMenu.join(", ")}`);
  await capture("menu-running");
  await closeMenu();
  const reviewMenu = await menuOf("To review", "states-files");
  note(`To review row menu: ${reviewMenu.join(", ")}`);
  if (!reviewMenu.includes("Mark done") || !reviewMenu.includes("Snooze"))
    throw new Error(`a To review row's menu is wrong: ${reviewMenu.join(", ")}`);
  if (reviewMenu.includes("Stop session…"))
    throw new Error(`a To review row offers Stop: ${reviewMenu.join(", ")}`);
  await capture("menu-review");
  await closeMenu();

  // Stop from the row: the dialog, then the row moves Running → Done (it changed no files).
  await menuOf("Running", "states-live");
  await page.getByRole("menuitem", { name: "Stop session…" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop session?" });
  await dialog.waitFor();
  await dialog
    .getByText(/moves to Done|resume it later/)
    .first()
    .waitFor({ timeout: 20_000 });
  await capture("stop-dialog");
  await dialog.getByRole("button", { name: "Stop session", exact: true }).click();
  await burst("move-stop-to-done", 8);
  await waitFor(
    "states-live in Done",
    async () => (await rows("Done", "states-live").count()) > 0,
    120,
  );
  note(`states-live after Stop: Done, "${await wordOf(row("Done", "states-live"))}"`);
  await capture("stopped-to-done");

  // Stop the one with a file: it moves to To review.
  await menuOf("Running", "states-live-files");
  await page.getByRole("menuitem", { name: "Stop session…" }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Stop session", exact: true }).click();
  await waitFor(
    "states-live-files in To review",
    async () =>
      (await rows("Running", "states-live-files").count()) === 0 &&
      (await rows("To review", "states-live-files").count()) > 0,
    120,
  );
  note(
    `states-live-files after Stop: To review, "${await wordOf(row("To review", "states-live-files"))}"`,
  );
  await both("stopped-to-review");

  // Phone width.
  await page.setViewportSize(PHONE);
  await open("/");
  await openAll();
  await row("To review", "states-live-files").waitFor();
  await both("states-phone");
  await page.setViewportSize(DESKTOP);

  // The project's Sessions tab says the same words with the same glyphs.
  const projectId = await page.evaluate(() => {
    const listed = window["__TSR_ROUTER__"].options.context.queryClient
      .getQueryCache()
      .findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state.data;
    return listed?.find((each) => each.title === "states-files")?.session.projectId ?? null;
  });
  if (projectId === null) throw new Error("no project for states-files");
  await navigate(`/projects/${projectId}`);
  const table = page.getByRole("region", { name: /^Sessions in / });
  await table.waitFor();
  const tableRow = (title) => table.getByRole("row").filter({ hasText: title }).first();
  await tableRow("states-files").getByText("Completed").waitFor();
  const sidebarWord = (await wordOf(row("To review", "states-files"))).split(" · ")[1];
  note(
    `project table: states-files reads "Completed" with glyph ${await glyphOf(tableRow("states-files"))}; the sidebar says "${sidebarWord}"`,
  );
  await page.getByRole("tab", { name: /^Stopped/ }).click();
  await tableRow("states-none").getByText("Completed").waitFor();
  await both("project-sessions");
  await navigate("/");
  await hydrated();

  // Fixture rows: the agent's own moves, one step at a time.
  const me = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  if (typeof me !== "string") throw new Error("the page holds no signed-in account");
  const world = startingWorld(me);
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inboxAt = paths.indexOf("sessions.inbox");
    const marksAt = paths.indexOf("sessions.inboxMarks");
    const rowAt = paths.indexOf("sessions.inboxRow");
    if (inboxAt === -1 && marksAt === -1 && rowAt === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answer = (at, value) => {
      if (at === -1) return;
      const data = { result: { data: superjson(value) } };
      if (Array.isArray(body)) body[at] = data;
      else Object.assign(body, data);
    };
    answer(inboxAt, world.rows());
    answer(marksAt, world.marks);
    // A live re-read of a real row while the fixture stands: keep the fixture's list as it is.
    if (rowAt !== -1) {
      const missing = {
        error: {
          json: { message: "fixture", code: -32004, data: { code: "NOT_FOUND", httpStatus: 404 } },
        },
      };
      if (Array.isArray(body)) body[rowAt] = missing;
    }
    await route.fulfill({ response, json: body });
  });
  const step = async (change) => {
    change(world);
    await readAgain();
  };
  await readAgain();
  await openAll();
  await row("Running", "Explain the checkout flow").getByText("Thinking").waitFor();
  await row("Running", "Marked done, then it ran again").waitFor();
  note("fixture: a running session someone marked done stays under Running (the owner's case)");
  await both("fixture-start");

  // The agent asks: in place, then into Waiting on you, lit.
  await step((w) => w.ask("explain"));
  await burst("fixture-move-ask", 6);
  await row("Waiting on you", "Explain the checkout flow").getByText("Asked a question").waitFor();
  note(
    `fixture: asked → Waiting on you, glyph ${await glyphOf(row("Waiting on you", "Explain the checkout flow"))}`,
  );
  // Answered: back to Running.
  await step((w) => w.answer("explain"));
  await row("Running", "Explain the checkout flow").waitFor();
  // The reply ends: still Running, "Replied".
  await step((w) => w.reply("explain"));
  await row("Running", "Explain the checkout flow").getByText("Replied").waitFor();
  note(
    `fixture: reply ended → still Running, "${await wordOf(row("Running", "Explain the checkout flow"))}", glyph ${await glyphOf(row("Running", "Explain the checkout flow"))}`,
  );
  await both("fixture-replied");
  // The idle stop ends it with files: To review.
  await step((w) => w.end("explain", 3));
  await burst("fixture-move-end", 6);
  await row("To review", "Explain the checkout flow").getByText("Stopped").waitFor();
  // A snoozed session asks something new: Waiting on you at once.
  await row("Snoozed", "Snoozed, then it asked").waitFor();
  await step((w) => w.ask("snoozed"));
  await row("Waiting on you", "Snoozed, then it asked").waitFor();
  note("fixture: a snoozed session that asked something new → Waiting on you");
  // A done session resumed by a message: Running.
  await row("Done", "Done, then a message resumed it").waitFor();
  await step((w) => w.resume("done"));
  await row("Running", "Done, then a message resumed it").waitFor();
  note("fixture: a session marked done, resumed by a message → Running");
  await both("fixture-after");
  // Into a folded group: Done folded, a session ends with no files; its heading lights.
  await setOpen("Done", false);
  await step((w) => w.end("quiet", 0));
  await page.waitForTimeout(250);
  await capture("fixture-folded-lit");
  note(
    `fixture: into folded Done, heading lit: ${await heading("Done").evaluate((el) => el.className.includes("animate-row-lit"))}`,
  );
  // Phone: a row that just moved stays lit.
  await page.setViewportSize(PHONE);
  await open("/");
  await readAgain();
  await step((w) => w.ask("phone"));
  await page.waitForTimeout(250);
  await both("fixture-phone-moved");
  await page.unroute("**/trpc/**");
  await page.setViewportSize(DESKTOP);
};

/** The text of a row's lines under its title, as a person reads them. */
const wordOf = async (locator) => (await locator.innerText()).split("\n").slice(1).join(" | ");

/** The shape of the first session glyph inside a locator. */
const glyphOf = (locator) =>
  locator.locator("[data-slot=lump]").first().getAttribute("data-status");

/** A minute ago, by `minutes`. */
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

/** The fixture's sessions and the person's marks, which each step changes. */
const startingWorld = (me) => {
  const sessions = {
    explain: {
      title: "Explain the checkout flow",
      status: "running",
      turnOpen: true,
      activity: { kind: "thinking", subject: null },
      files: 0,
      minutes: 1,
      newAt: 2,
    },
    marked: {
      title: "Marked done, then it ran again",
      status: "running",
      turnOpen: true,
      activity: { kind: "command", subject: "pnpm test" },
      files: 1,
      minutes: 2,
      newAt: 3,
    },
    // Asked 40 minutes ago, snoozed 20 minutes ago: the snooze holds until something new.
    snoozed: {
      title: "Snoozed, then it asked",
      status: "waiting",
      ask: { kind: "command", subject: "rm -rf dist" },
      turnOpen: false,
      files: 2,
      minutes: 30,
      newAt: 40,
    },
    done: {
      title: "Done, then a message resumed it",
      status: "completed",
      turnOpen: false,
      files: 0,
      minutes: 50,
      newAt: 60,
    },
    quiet: {
      title: "Tidy the coupon migrations",
      status: "running",
      turnOpen: true,
      activity: { kind: "edit", subject: null },
      files: 0,
      minutes: 4,
      newAt: 5,
    },
    phone: {
      title: "Add idempotency keys to refunds",
      status: "running",
      turnOpen: true,
      activity: { kind: "command", subject: "pnpm db:migrate" },
      files: 0,
      minutes: 6,
      newAt: 7,
    },
  };
  const marks = [
    { sessionId: idOf("marked"), state: "settled", snoozedUntil: null, markedAt: ago(10) },
    { sessionId: idOf("snoozed"), state: "snoozed", snoozedUntil: ago(-600), markedAt: ago(20) },
    { sessionId: idOf("done"), state: "settled", snoozedUntil: null, markedAt: ago(45) },
  ];
  const touch = (key, change) => {
    sessions[key] = {
      ...sessions[key],
      ...change,
      minutes: 0,
      newAt: change.newAt ?? sessions[key].newAt,
    };
  };
  return {
    marks,
    rows: () => Object.entries(sessions).map(([key, each]) => fixtureRow(key, me, each)),
    ask: (key) =>
      touch(key, {
        status: "waiting",
        ask: { kind: "question", subject: "Back off on a 409?" },
        activity: null,
        newAt: 0,
      }),
    answer: (key) =>
      touch(key, {
        status: "running",
        ask: null,
        turnOpen: true,
        activity: { kind: "writing", subject: null },
        newAt: 0,
      }),
    reply: (key) => touch(key, { status: "running", turnOpen: false, activity: null }),
    end: (key, files) => touch(key, { status: "stopped", turnOpen: false, activity: null, files }),
    resume: (key) =>
      touch(key, {
        status: "running",
        turnOpen: true,
        activity: { kind: "thinking", subject: null },
        newAt: 0,
      }),
  };
};

const KEYS = ["explain", "marked", "snoozed", "done", "quiet", "phone"];
const idOf = (key) => `00000000-0000-4000-8000-${String(KEYS.indexOf(key) + 1).padStart(12, "0")}`;

/** One inbox row as the server answers it. */
const fixtureRow = (key, owner, each) => {
  const index = KEYS.indexOf(key) + 1;
  const ended = ["completed", "failed", "stopped"].includes(each.status);
  return {
    session: {
      id: idOf(key),
      projectId: "fixture-web",
      worktreeId: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
      harness: "codex",
      label: each.title,
      branch: `mend/fixture-${index}`,
      status: each.status,
      ownerUserId: owner,
      sharedControlEnabledAt: null,
      sharedControlUserIds: [],
      startedAt: ago(each.minutes + 30),
      settledAt: ended ? ago(each.minutes) : null,
      createdAt: ago(each.minutes + 30),
      updatedAt: ago(each.minutes),
      importedConversationWaiting: false,
    },
    projectName: "web",
    title: each.title,
    annotation: {
      changeId: `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      totalComments: 0,
      pendingFollowUp: false,
      liveServices: 0,
      currentAgent: { kind: "agent-protocol" },
      fileCount: each.files,
      pullRequestState: key === "marked" ? "open" : null,
    },
    ask: each.ask ?? null,
    worktreeName: `fixture-${index}`,
    failure: null,
    activity: each.activity ?? null,
    sharedControlAsks: [],
    turnOpen: each.turnOpen,
    lastNewAt: ago(each.newAt),
  };
};

/** A value as tRPC answers it through superjson: dates as ISO strings, their paths named. */
const superjson = (value) => {
  const values = {};
  const walk = (node, path) => {
    if (node instanceof Date) {
      values[path.join(".")] = ["Date"];
      return node.toISOString();
    }
    if (Array.isArray(node)) return node.map((each, index) => walk(each, [...path, String(index)]));
    if (node !== null && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node).map(([key, each]) => [key, walk(each, [...path, key])]),
      );
    return node;
  };
  const json = walk(value, []);
  return Object.keys(values).length === 0 ? { json } : { json, meta: { values, v: 1 } };
};
