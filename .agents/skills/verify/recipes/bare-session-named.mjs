// A session started bare in a worktree that already has a named session is named from its first
// message (SLNT-1211). It needs a real agent turn and Mend's naming pass on the account's own
// login, so it runs on the box (or a stack with real logins), after `tiles` named the
// worktree `tiles-ws`'s two sessions.
//
//   web <out> bare-session-named          (the box run's driver, as the checker account)
//
// From the worktree's menu, New session in this worktree, Codex, with no message: its tab, its
// sidebar row, the browser tab and the project's Sessions table read "New session". Sent
// "tell me a joke", it reads that at once, then a name Mend made, which a reload keeps. With
// auto-naming switched off for the project, a second bare session sent a message keeps its
// message's first line. Every session it starts is stopped, and the project's switch put back.
const DESKTOP = { width: 1280, height: 900 };
const NAMED_WITHIN_MS = 4 * 60_000;
const ENDED = ["completed", "stopped", "failed"];

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
  const rowOf = async (id) => (await inbox())?.find((row) => row.session.id === id);
  const tabOf = (id) =>
    page.locator(`[data-tab="session:${id}"]`).filter({ visible: true }).getByRole("tab");
  const both = async (name) => {
    for (const dark of [false, true]) {
      await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
      await page.waitForTimeout(400);
      await capture(`${name}-${dark ? "dark" : "light"}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const started = [];

  /** New session in this worktree, Codex, from the worktree's menu; answers the session's id. */
  const startBare = async (projectId) => {
    await open(`/projects/${projectId}/worktrees`);
    const actions = page
      .getByRole("button", { name: "Actions for tiles-ws" })
      .filter({ visible: true })
      .first();
    await actions.scrollIntoViewIfNeeded();
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
    await page
      .getByRole("menuitem", { name: /^Codex/ })
      .first()
      .click();
    await page.waitForURL(/\/sessions\/(?!starting-)[^/]+$/, { timeout: 120_000 });
    const id = new URL(page.url()).pathname.split("/").at(-1);
    started.push(id);
    return id;
  };

  /** Waits for Codex to be ready, then sends `words` from the session's composer. */
  const send = async (words) => {
    const composer = page.getByRole("textbox", { name: "Message Codex" }).filter({ visible: true });
    await composer.waitFor({ timeout: 240_000 });
    await page
      .getByText("Codex is starting", { exact: false })
      .filter({ visible: true })
      .waitFor({ state: "hidden", timeout: 240_000 })
      .catch(() => undefined);
    await composer.fill(words);
    await composer.press("Enter");
  };

  /** Polls the inbox row until `ok(row)`, or throws `what` after `ms`. */
  const until = async (id, ok, ms, what) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const row = await rowOf(id);
      if (row !== undefined && ok(row)) return row;
      if (Date.now() > deadline)
        throw new Error(`${what}: the row reads ${JSON.stringify(row?.title)}`);
      await page.waitForTimeout(3_000);
    }
  };

  try {
    await page.setViewportSize(DESKTOP);
    await open("/no-such-page");
    await page.evaluate(() => localStorage.setItem("mend-theme", "light"));
    const rows = (await inbox()) ?? [];
    const siblings = rows.filter(
      (row) =>
        row.worktreeName === "tiles-ws" &&
        !ENDED.includes(row.session.status) &&
        row.session.label !== null,
    );
    if (siblings.length === 0)
      throw new Error("tiles-ws has no named running session: run tiles first");
    const projectId = siblings[0].session.projectId;
    note(`tiles-ws holds ${siblings.map((row) => `"${row.title}"`).join(", ")}`);

    // 1. A bare start: "New session" everywhere, never the worktree's or a sibling's name.
    const bare = await startBare(projectId);
    await tabOf(bare).waitFor();
    const row = await until(bare, () => true, 30_000, "the bare session is not listed");
    if (row.title !== "New session") throw new Error(`the bare session's row reads "${row.title}"`);
    const tabText = (await tabOf(bare).innerText()).trim();
    if (!tabText.includes("New session")) throw new Error(`its tab reads "${tabText}"`);
    const sidebar = (await page.locator(`[data-session-id="${bare}"]`).first().innerText()).trim();
    if (!sidebar.startsWith("New session")) throw new Error(`its sidebar row reads "${sidebar}"`);
    await page.waitForFunction(() => document.title === "New session · Mend");
    note(
      `bare start ${bare}: row "${row.title}", tab "${tabText}", sidebar "${sidebar.split("\n")[0]}", browser tab "New session · Mend"; worktree "${row.worktreeName}"`,
    );
    await both("bare-started");

    // 2. Its first message: its title at once, then a name Mend made.
    await send("tell me a joke");
    const sentAt = Date.now();
    await until(
      bare,
      (each) => each.title === "tell me a joke" || each.session.label !== null,
      60_000,
      "the message never titled it",
    );
    const early = (await rowOf(bare))?.title;
    note(
      `sent "tell me a joke": the row read "${early}" ${Math.round((Date.now() - sentAt) / 1000)} s later`,
    );
    await both("first-message-title");
    const named = await until(
      bare,
      (each) => each.session.label !== null,
      NAMED_WITHIN_MS,
      "Mend never named it",
    );
    const label = named.session.label;
    if (siblings.some((sibling) => sibling.title === label))
      throw new Error(`Mend named it "${label}", a sibling's name`);
    note(
      `Mend named it "${label}" ${Math.round((Date.now() - sentAt) / 1000)} s after the message`,
    );
    await page.reload();
    await hydrated();
    await tabOf(bare).waitFor();
    const reloaded = (await tabOf(bare).innerText()).trim();
    if (!reloaded.includes(label)) throw new Error(`after a reload its tab reads "${reloaded}"`);
    await page.waitForFunction((title) => document.title === title, `${label} · Mend`);
    note(`reload: its tab reads "${reloaded}", the browser tab "${label} · Mend"`);
    await both("named");

    // A name a person gives it stays through more messages.
    await client(
      (trpc, id) => trpc.sessions.setLabel.mutate({ id, label: "my own name for it" }),
      bare,
    );
    await open(`/sessions/${bare}`);
    await send("and another one");
    await page.waitForTimeout(60_000);
    const kept = await rowOf(bare);
    if (kept?.session.label !== "my own name for it")
      throw new Error(`after another message the label reads "${kept?.session.label}"`);
    note(
      `renamed by hand to "my own name for it", sent another message: 60 s later it still reads "${kept.title}"`,
    );

    // The project's Sessions table and the Stop dialog's list use the same title.
    // Stop on a sibling lists the other running sessions that keep the workspace up.
    const preview = await client(
      (trpc, id) => trpc.sessions.stopPreview.query({ id }),
      siblings[0].session.id,
    );
    const listed = (preview.runningSessions ?? []).map((each) => each.title);
    note(
      `Stop on "${siblings[0].title}" lists the workspace's other running sessions as ${JSON.stringify(listed)}`,
    );
    if (!listed.includes(kept.title))
      throw new Error("the Stop preview doesn't list it by its name");
    await open(`/projects/${projectId}`);
    const link = page
      .locator(`table a[href$="/sessions/${bare}"]`)
      .filter({ visible: true })
      .first();
    await link.waitFor();
    note(`the project's Sessions table names it "${(await link.innerText()).trim()}"`);
    await both("project-sessions");

    // A start from the home composer with a prompt is still named from that prompt.
    const defaults = await client((trpc) => trpc.platform.sessionDefaults.query());
    if (defaults.harness !== "codex")
      await client(
        (trpc, before) => trpc.platform.setSessionDefaults.mutate({ ...before, harness: "codex" }),
        defaults,
      );
    try {
      await open("/");
      const taskBox = page.getByRole("textbox", { name: "Task" }).filter({ visible: true });
      await taskBox.waitFor();
      const pick = (name) => page.getByRole("button", { name }).filter({ visible: true }).first();
      if ((await pick(/^Project: verify-fixture$/).count()) === 0) {
        await pick(/^Project: /).click();
        await page.getByRole("option", { name: "verify-fixture", exact: true }).click();
      }
      await pick(/^Agent and model: Codex/).waitFor();
      await taskBox.fill("Say in one sentence what this repository is for. Change nothing.");
      await page.getByRole("button", { name: "Start session" }).filter({ visible: true }).click();
      await page.waitForURL(/\/sessions\/(?!starting-)[^/]+$/, { timeout: 180_000 });
      const composed = new URL(page.url()).pathname.split("/").at(-1);
      started.push(composed);
      const composedAt = Date.now();
      const composedRow = await until(
        composed,
        (each) => each.session.label !== null,
        NAMED_WITHIN_MS,
        "the composed start was never named",
      );
      note(
        `home composer start ${composed}: named "${composedRow.session.label}" ${Math.round((Date.now() - composedAt) / 1000)} s after its page opened`,
      );
      await both("composed-named");
    } finally {
      await client(
        (trpc, before) => trpc.platform.setSessionDefaults.mutate(before),
        defaults,
      ).catch(() => undefined);
    }

    // 3. Auto-naming off for the project: a bare session sent a message keeps its first line.
    const project = (await client((trpc) => trpc.projects.list.query())).find(
      (each) => each.id === projectId,
    );
    const keys = ["autoTour", "autoSuggest", "autoName", "backgroundSessions", "autoLand"];
    const before = Object.fromEntries(
      keys.filter((key) => key in project).map((key) => [key, project[key]]),
    );
    if (!("autoName" in before)) {
      note("not run · the project list carries no automation choices to put back");
    } else {
      await client(
        (trpc, [id, choices]) => trpc.projects.setAutomation.mutate({ id, choices }),
        [projectId, { ...before, autoName: "off" }],
      );
      try {
        const quiet = await startBare(projectId);
        await send("check the 409 retry path\nand say what you find");
        await until(
          quiet,
          (each) => each.title === "check the 409 retry path",
          60_000,
          "its message never titled it",
        );
        await page.waitForTimeout(90_000);
        const after = await rowOf(quiet);
        if (after?.session.label !== null)
          throw new Error(`with auto-naming off it was named "${after?.session.label}"`);
        note(`auto-naming off: after 90 s the session still reads "${after.title}", no name`);
        await both("auto-name-off");
      } finally {
        await client(
          (trpc, [id, choices]) => trpc.projects.setAutomation.mutate({ id, choices }),
          [projectId, before],
        );
        note(`put the project's automation back: ${JSON.stringify(before)}`);
      }
    }
  } finally {
    for (const id of started)
      await client(async (trpc, each) => {
        await trpc.sessions.stop.mutate({ id: each }).catch(() => undefined);
      }, id).catch(() => undefined);
    note(`stopped ${started.length} session(s) this recipe started`);
  }
};
