// What the sidebar inbox's rows know from the server's inbox read (SLNT-1113): a finished session
// goes under To review when its change has files and under Done when it has none, an Idle one
// (finished its reply, still up) stays under Running saying Replied (SLNT-1199), sessions sharing a workspace name it, a failed session says why on
// a phone, and a running one says what its agent is doing. Run the CLI batch first, once per stack:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-inbox-facts.json
//   pnpm verify drive new-web --recipe new-web-inbox-facts
//
// The stack runs commands, not a provider's agent, so it has no Idle session and no conversation
// to say what an agent is doing: those are drawn from fixture rows the recipe answers the inbox
// read with, and every capture taken that way is named `fixture-…`.
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
  const rows = (label, title) => group(label).getByRole("link", { name: new RegExp(`^${title}`) });
  const row = (label, title) => rows(label, title).first();
  const showAll = async (label) => {
    const more = group(label).getByRole("button", { name: /^Show \d+ more$/ });
    if ((await more.count()) > 0) await more.click();
  };
  const openAll = async () => {
    for (const label of ["To review", "Running", "Done"]) {
      await setOpen(label, true);
      await showAll(label);
    }
  };
  const router = () => page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  /** React has taken the inbox's controls over, so a click reaches them. */
  const hydrated = async () => {
    await router();
    await page.waitForFunction(() => {
      const control = document.querySelector("[data-slot=collapsible-trigger]");
      return control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"));
    });
  };
  const open = async (path) => {
    if (path === undefined) await page.reload();
    else await page.goto(`${web}${path}`);
    await hydrated();
  };
  const readAgain = () =>
    page.evaluate(() => {
      void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions", "inbox"]],
      });
    });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  // Every change read the inbox makes: none should be a change's stats.
  const statsReads = [];
  page.on("request", (request) => {
    if (decodeURIComponent(request.url()).includes("changes.stats")) statsReads.push(request.url());
  });
  await open("/");
  await openAll();

  // The stack's own sessions, where their change puts them.
  await row("To review", "facts-files").waitFor();
  await row("Done", "facts-none").waitFor();
  await row("To review", "facts-failed").getByText("Failed", { exact: true }).waitFor();
  if ((await rows("To review", "facts-none").count()) > 0)
    throw new Error("facts-none, which changed no file, is under To review");
  note(
    `desktop: facts-files (wrote FACTS.md) under To review, "${await lines(row("To review", "facts-files"))}"; facts-none (ran true) under Done, "${await lines(row("Done", "facts-none"))}"; facts-failed under To review, "${await lines(row("To review", "facts-failed"))}"`,
  );
  // Two sessions in one workspace: each row's note names the worktree.
  const shared = rows("Running", "facts-shared");
  for (let waited = 0; (await shared.count()) < 2; waited += 1) {
    if (waited > 30) throw new Error("fewer than two facts-shared sessions under Running");
    await page.waitForTimeout(1_000);
  }
  await shared
    .first()
    .getByText(/^facts-shared · \d+ sessions$/)
    .waitFor();
  note(`desktop: a facts-shared row reads "${await lines(shared.first())}"`);
  await both("facts-desktop");

  // Phone: the failed session says why.
  await page.setViewportSize(PHONE);
  await open("/");
  await openAll();
  const failedLine = row("To review", "facts-failed").getByText(/^Failed · .+/);
  await failedLine.waitFor();
  note(`phone: facts-failed reads "${await failedLine.innerText()}"`);
  await row("Done", "facts-none").waitFor();
  await both("facts-phone");
  await page.setViewportSize(DESKTOP);

  // Fixture rows: Idle sessions with and without files, and running ones saying what they do.
  const me = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  if (typeof me !== "string") throw new Error("the page holds no signed-in account");
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const at = paths.indexOf("sessions.inbox");
    if (at === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const data = { result: { data: serialized(fixture(me)) } };
    if (Array.isArray(body)) body[at] = data;
    await route.fulfill({ response, json: Array.isArray(body) ? body : data });
  });
  await open("/");
  await readAgain();
  await openAll();
  await row("Running", "Idle with changed files").getByText("Replied").waitFor();
  await row("Running", "Idle with no changes").getByText("Replied").waitFor();
  await row("Done", "Finished with no changes").waitFor();
  await row("To review", "Finished with changes").waitFor();
  await row("Running", "Add idempotency keys to refunds").getByText("Running a command").waitFor();
  await row("Running", "Cache product images at the edge").getByText("Editing files").waitFor();
  note(
    `fixture desktop: Idle sessions under Running saying Replied, finished with none under Done; running rows read "${await lines(row("Running", "Add idempotency keys to refunds"))}" and "${await lines(row("Running", "Cache product images at the edge"))}"`,
  );
  await both("fixture-facts-desktop");
  await page.setViewportSize(PHONE);
  await open("/");
  await readAgain();
  await openAll();
  await row("Running", "Add idempotency keys to refunds").getByText("Running pnpm test").waitFor();
  await row("To review", "Upgrade to React Router 8")
    .getByText("Failed · Type check found 12 errors")
    .waitFor();
  note('fixture phone: "Running pnpm test", and "Failed · Type check found 12 errors"');
  await both("fixture-facts-phone");
  await page.unroute("**/trpc/**");
  await page.setViewportSize(DESKTOP);

  if (statsReads.length > 0)
    throw new Error(`the desktop inbox read a change's stats: ${statsReads.join(", ")}`);
  note("no change's stats were read to place a row (the phone reads them for a row's +/− only)");
};

/** The text of a row's lines under its title, as a person reads them. */
const lines = async (locator) => (await locator.innerText()).split("\n").slice(1).join(" | ");

/** A minute ago, by `minutes`. */
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

/** One inbox row as the server answers it, for the fixture. */
const fixtureRow = (
  index,
  owner,
  { title, status, minutes, files = null, failure = null, activity = null },
) => ({
  session: {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    projectId: "fixture-web",
    worktreeId: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
    harness: "claude",
    label: title,
    branch: `mend/fixture-${index}`,
    status,
    ownerUserId: owner,
    sharedControlEnabledAt: null,
    startedAt: ago(minutes + 30),
    settledAt: null,
    createdAt: ago(minutes + 30),
    updatedAt: ago(minutes),
    importedConversationWaiting: false,
  },
  projectName: "web",
  title,
  annotation: {
    changeId: `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    totalComments: 0,
    pendingFollowUp: false,
    liveServices: 0,
    currentAgent: null,
    fileCount: files,
  },
  ask: null,
  worktreeName: `fixture-${index}`,
  failure,
  activity,
});

const fixture = (me) =>
  [
    { title: "Idle with changed files", status: "idle", minutes: 3, files: 3 },
    { title: "Idle with no changes", status: "idle", minutes: 4, files: 0 },
    { title: "Finished with changes", status: "completed", minutes: 8, files: 4 },
    { title: "Finished with no changes", status: "completed", minutes: 9, files: 0 },
    {
      title: "Upgrade to React Router 8",
      status: "failed",
      minutes: 22,
      files: 2,
      failure: "Type check found 12 errors",
    },
    {
      title: "Add idempotency keys to refunds",
      status: "running",
      minutes: 1,
      activity: { kind: "command", subject: "pnpm test" },
    },
    {
      title: "Cache product images at the edge",
      status: "running",
      minutes: 6,
      activity: { kind: "edit", subject: null },
    },
  ].map((each, index) => fixtureRow(index + 1, me, each));

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
