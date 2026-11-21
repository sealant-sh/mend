// SLNT-1211: a session nobody has named, in a worktree whose other sessions are named, reads "New
// session" in its tab, its sidebar row and the project's Sessions table, never the worktree's name
// or a sibling's. Run after the tiles batch (two labelled sessions in `tiles-ws`).
const DESKTOP = { width: 1280, height: 900 };

export default async ({ page, web, capture, note }) => {
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const inbox = () =>
    page.evaluate(async () => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
      return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
        .data;
    });
  const both = async (name) => {
    for (const dark of [false, true]) {
      await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
      await page.waitForTimeout(400);
      await capture(`${name}-${dark ? "dark" : "light"}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
  const rows = await inbox();
  const named = rows
    .filter(
      (row) =>
        row.worktreeName === "tiles-ws" &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)));
  if (named.length < 2) throw new Error("run the tiles batch first: tiles-ws has no two sessions");
  const [first] = named;
  note(`tiles-ws holds ${named.map((row) => `"${row.title}"`).join(", ")}`);

  // A second session in the worktree, started bare: no label, nothing sent.
  const bare = await client(
    async (trpc, id) =>
      (await trpc.worktrees.createSession.mutate({ id, session: { harness: "run" } })).id,
    first.session.worktreeId,
  );
  const listed = (await inbox()).find((row) => row.session.id === bare);
  if (listed?.title !== "New session")
    throw new Error(`the bare session's row title reads "${listed?.title}"`);
  note(
    `the bare session ${bare}: the server titles its row "New session", worktree "${listed.worktreeName}"`,
  );

  await open(`/sessions/${bare}`);
  const tab = page
    .locator(`[data-tab="session:${bare}"]`)
    .filter({ visible: true })
    .getByRole("tab");
  await tab.waitFor();
  const tabText = (await tab.innerText()).trim();
  if (!tabText.includes("New session")) throw new Error(`its tab reads "${tabText}"`);
  const row = page.locator(`[data-session-id="${bare}"]`).first();
  await row.waitFor();
  const rowText = (await row.innerText()).trim();
  if (!rowText.startsWith("New session")) throw new Error(`its sidebar row reads "${rowText}"`);
  for (const sibling of named) {
    const siblingTab = page
      .locator(`[data-tab="session:${sibling.session.id}"]`)
      .filter({ visible: true })
      .getByRole("tab");
    if (await siblingTab.count()) {
      const text = (await siblingTab.innerText()).trim();
      if (!text.includes(sibling.title)) throw new Error(`a sibling's tab reads "${text}"`);
    }
  }
  await page.waitForFunction(() => document.title === "New session · Mend");
  note(
    `its tab reads "${tabText}", its sidebar row "${rowText.split("\n")[0]}", the browser tab "New session · Mend"; its siblings keep their names`,
  );
  await both("bare-session-page");

  // The project's Sessions table names it the same way.
  await open(`/projects/${first.session.projectId}`);
  const link = page.locator(`table a[href$="/sessions/${bare}"]`).filter({ visible: true }).first();
  await link.waitFor();
  const linkText = (await link.innerText()).trim();
  if (linkText !== "New session") throw new Error(`the project's table reads "${linkText}"`);
  note(`the project's Sessions table names it "${linkText}"`);
  await both("project-sessions");

  await client(async (trpc, id) => {
    await trpc.sessions.stop.mutate({ id }).catch(() => undefined);
  }, bare);
  note("stopped the bare session");
};
