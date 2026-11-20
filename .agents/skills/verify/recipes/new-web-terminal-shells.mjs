// The Terminal view's shells (apps/web, SLNT-1197): the list holds the shells you can type into.
// A shell that exits leaves it with one line that says so (its code when it isn't 0), and that
// line opens what it printed. A shell you close leaves it with no line. The next shell is shown,
// and with none left the view says so and offers New shell. The tab's count and the list's
// heading count the same shells. A shell's row has a right-click menu, a "…" menu and a long
// press with Rename…, Copy working directory and Close shell…; closing always asks. Run the CLI
// batch first, once per drive: it starts a `sleep` session in the worktree `term-ws`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-terminal-sessions.json
//   pnpm verify drive new-web --recipe new-web-terminal-shells
//
// The session's own terminal (its `sleep`) is hidden from the shells' reads by a fixture, so the
// list holds only shells, as a conversation session's does (the owner's case). The driver
// withholds every picture with a canvas in it, so before each picture the terminal's canvas is
// swapped for an empty box of the same size, and put back after: the pictures show the list, the
// counts, the lines, the menus and the dialogs, not the terminal's text, which is read through
// Copy instead. The recipe stops the batch session at the end.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Fix flaky checkout retry";
const VIEW = "view:terminal";

export default async ({ page, web, capture: captureOnce, note }) => {
  const settled = () => page.waitForTimeout(500);
  const dismissOverlay = () =>
    page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
  /** Swaps every terminal canvas for an empty box of its size, for the length of `then`. */
  const withoutCanvas = async (then) => {
    await page.evaluate(() => {
      window["__swapped"] = [...document.querySelectorAll("canvas")].map((canvas) => {
        const box = document.createElement("div");
        const rect = canvas.getBoundingClientRect();
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        canvas.replaceWith(box);
        return [canvas, box];
      });
    });
    try {
      await then();
    } finally {
      await page.evaluate(() => {
        for (const [canvas, box] of window["__swapped"] ?? []) box.replaceWith(canvas);
        window["__swapped"] = [];
      });
    }
  };
  const capture = async (name) => {
    await dismissOverlay();
    await withoutCanvas(() => captureOnce(name));
  };
  const theme = async (dark) => {
    await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
    await settled();
  };
  /** Light, then dark, then light again. */
  const both = async (name) => {
    await capture(`${name}-light`);
    await theme(true);
    await capture(`${name}-dark`);
    await theme(false);
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
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

  const body = page.locator(`[data-tab-body="${VIEW}"]`);
  const list = body.getByRole("navigation", { name: "This workspace's shells" });
  const tab = () => page.locator(`[data-tab="${VIEW}"]`).filter({ visible: true }).getByRole("tab");
  /** The list's shell rows (not their "…" buttons), by name. */
  const rowNames = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('ul[aria-label="Open shells"] > li > button')].map(
        (button) => button.querySelector("span span")?.textContent ?? "",
      ),
    );
  const row = (name) => list.locator("li").filter({ has: page.getByText(name, { exact: true }) });
  const rowButton = (name) => row(name).locator("xpath=./button").first();
  const shown = () =>
    page.evaluate(
      () =>
        document
          .querySelector('ul[aria-label="Open shells"] > li > button[aria-current="true"]')
          ?.querySelector("span span")?.textContent ?? null,
    );
  const waitRows = (want, what) =>
    page
      .waitForFunction(
        (names) => {
          const now = [
            ...document.querySelectorAll('ul[aria-label="Open shells"] > li > button'),
          ].map((button) => button.querySelector("span span")?.textContent ?? "");
          return JSON.stringify(now) === JSON.stringify(names);
        },
        want,
        { timeout: 60_000 },
      )
      .catch(async () => {
        throw new Error(`${what}: the list holds ${JSON.stringify(await rowNames())}`);
      });
  /** The tab's count and the list heading's, which must agree with the rows. */
  const counts = async (what) => {
    const rows = (await rowNames()).length;
    const tabText = (await tab().innerText()).replace(/\s+/g, " ").trim();
    const heading = await list
      .locator("h2 + span")
      .textContent()
      .then((text) => Number((text ?? "").replace(/\D/g, "")));
    const fact = tabText.match(/(\d+) shells?/);
    const tabCount = fact === null ? 0 : Number(fact[1]);
    if (heading !== rows || tabCount !== rows)
      throw new Error(`${what}: ${rows} rows, the heading says ${heading}, the tab "${tabText}"`);
    note(`${what}: ${rows} rows; the heading says ${heading}; the tab reads "${tabText}"`);
  };
  const keepCopies = () =>
    page.evaluate(() => {
      window["__copied"] = [];
      navigator.clipboard.writeText = async (text) => {
        window["__copied"].push(text);
      };
    });
  const live = async () => {
    await body.getByRole("textbox", { name: "Terminal input" }).first().waitFor();
    await page.waitForFunction(
      (key) => {
        const view = document.querySelector(`[data-tab-body="${key}"]`);
        return view !== null && !/Connecting…|Reconnecting…/.test(view.textContent ?? "");
      },
      VIEW,
      { timeout: 30_000 },
    );
  };
  const typeLine = async (line) => {
    await dismissOverlay();
    await body.getByRole("textbox", { name: "Terminal input" }).first().click();
    await page.keyboard.type(`${line}\n`, { delay: 15 });
    await page.waitForTimeout(900);
  };
  const terminalText = async () => {
    await keepCopies();
    await body.getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window["__copied"].length > 0);
    return page.evaluate(() => window["__copied"].at(-1));
  };
  const newShell = async (want, what) => {
    await body.getByRole("button", { name: "New shell" }).first().click();
    await waitRows(want, what);
    await live();
  };

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The session the CLI batch started in `term-ws`.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const running = rows
    .filter(
      (each) =>
        each.worktreeName === "term-ws" &&
        !["completed", "stopped", "failed"].includes(each.session.status),
    )
    .toSorted((a, b) => String(b.session.createdAt).localeCompare(String(a.session.createdAt)));
  if (running.length === 0)
    throw new Error("term-ws has no running session: run the CLI batch first");
  const A = running[0].session.id;
  const worktreeId = running[0].session.worktreeId;
  const inWorkspace = new Set(
    rows.filter((each) => each.session.worktreeId === worktreeId).map((each) => each.session.id),
  );
  note(`the batch session is ${A}; the recipe stops it at the end`);
  await client(
    async (trpc, [id, label]) => trpc.sessions.setLabel.mutate({ id, label }),
    [A, TITLE],
  );
  await page.context().clearCookies({ name: "mend-tiles" });

  // Fixture: the shells' reads leave out the session's own terminal, so the list holds shells only.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!paths.includes("sessions.processes")) return route.continue();
    const inputs = JSON.parse(route.request().postData() ?? "{}");
    const response = await route.fetch();
    const answers = await response.json();
    paths.forEach((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      const data = answers[index]?.result?.data;
      if (path !== "sessions.processes" || !inWorkspace.has(id) || data === undefined) return;
      const kept = data.json.flatMap((each, at) => (each.kind === "agent-pty" ? [] : [at]));
      const values = data.meta?.values ?? {};
      const moved = {};
      kept.forEach((from, to) => {
        for (const [key, kind] of Object.entries(values))
          if (key.startsWith(`${from}.`)) moved[`${to}${key.slice(String(from).length)}`] = kind;
      });
      data.json = kept.map((at) => data.json[at]);
      if (data.meta !== undefined) data.meta.values = moved;
    });
    await route.fulfill({ response, json: answers });
  });
  note(
    "fixture: the shells' reads leave out the session's own terminal (its `sleep`), so the list holds only shells",
  );

  await page.goto(`${web}/sessions/${A}/terminal`);
  await hydrated();
  await list.waitFor({ timeout: 20_000 });
  // The view opens a shell by itself when none is open; open shells until there are two.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('ul[aria-label="Open shells"] > li > button').length > 0 ||
      [...document.querySelectorAll("button")].some((button) => button.textContent === "New shell"),
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(2_000);
  for (let guard = 0; guard < 3 && (await rowNames()).length < 2; guard += 1) {
    const before = (await rowNames()).length;
    await body.getByRole("button", { name: "New shell" }).first().click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('ul[aria-label="Open shells"] > li > button').length > n,
      before,
      { timeout: 60_000 },
    );
  }
  await waitRows(["Shell 1", "Shell 2"], "two shells");
  await live();
  await counts("two shells");
  await both("shells-two");

  // Where a shell opens: the shell itself prints it.
  await typeLine("clear; pwd");
  const pwd = (await terminalText()).match(/^\/\S+$/m)?.[0] ?? null;
  note(`\`pwd\` in a new shell printed ${pwd}`);
  if (pwd !== "/workspace/repo")
    throw new Error(`a new shell opens in ${pwd}, not the /workspace/repo the menu copies`);

  // The right-click menu on a row.
  await rowButton("Shell 1").click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const items = await menu.getByRole("menuitem").allInnerTexts();
  note(`right-click on Shell 1: ${JSON.stringify(items.map((each) => each.replace(/\n/g, " ")))}`);
  for (const want of ["Rename…", "Copy working directory", "Close shell…"])
    if (!items.some((each) => each.startsWith(want)))
      throw new Error(`the right-click menu has no ${want}`);
  await both("shells-menu-open");

  // Rename…: a dialog with the name selected; Save renames the row.
  await menu.getByRole("menuitem", { name: /^Rename…/ }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename Shell 1" });
  await renameDialog.waitFor();
  await page.keyboard.type("build");
  await capture("shells-rename-dialog-light");
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await renameDialog.waitFor({ state: "hidden", timeout: 20_000 });
  await waitRows(["build", "Shell 2"], "after Rename");
  note('Rename… → typed "build" → Save: the first row reads "build"');

  // The "…" button on hover: the same items; Copy working directory copies /workspace/repo.
  await rowButton("Shell 2").hover();
  await keepCopies();
  await list.getByRole("button", { name: "Actions for Shell 2" }).click();
  await menu.waitFor();
  await capture("shells-dots-menu-light");
  await menu.getByRole("menuitem", { name: /^Copy working directory/ }).click();
  await page.waitForFunction(() => window["__copied"].length > 0);
  const copiedDir = await page.evaluate(() => window["__copied"].at(-1));
  if (copiedDir !== "/workspace/repo")
    throw new Error(`Copy working directory copied ${copiedDir}`);
  note(`"…" on Shell 2 → Copy working directory: copied ${copiedDir}`);

  // F2 on a focused row renames it too; Esc leaves it.
  await rowButton("Shell 2").focus();
  await page.keyboard.press("F2");
  const renameTwo = page.getByRole("dialog", { name: "Rename Shell 2" });
  await renameTwo.waitFor();
  await page.keyboard.press("Escape");
  await renameTwo.waitFor({ state: "hidden" });
  note("F2 on the focused Shell 2 row opened Rename Shell 2; Esc closed it");

  // `exit` in Shell 2: it leaves the list, one line says it exited, and the next shell shows.
  await rowButton("Shell 2").click();
  await live();
  await typeLine("exit");
  await waitRows(["build"], "after exit");
  await body.getByText("Shell 2 exited.", { exact: true }).waitFor({ timeout: 20_000 });
  if ((await shown()) !== "build")
    throw new Error(`after Shell 2 exited, ${await shown()} shows, not build`);
  await live();
  note('typed `exit` in Shell 2: it left the list, "Shell 2 exited." shows, build is shown');
  await counts("after exit");
  await both("shells-exited-0");

  // A crash: Shell 3 exits with code 3; its line gives the code and opens what it printed.
  await newShell(["build", "Shell 3"], "a third shell");
  if ((await shown()) !== "Shell 3") throw new Error("the new shell isn't the one shown");
  await typeLine("echo about-to-crash; exit 3");
  await waitRows(["build"], "after the crash");
  const crashLine = body.getByText("Shell 3 exited with code 3.", { exact: true });
  await crashLine.waitFor({ timeout: 20_000 });
  note('`exit 3` in Shell 3: it left the list; "Shell 3 exited with code 3." shows');
  await counts("after the crash");
  await both("shells-crashed");
  await body
    .getByRole("listitem")
    .filter({ has: crashLine })
    .getByRole("button", { name: "What it printed" })
    .click();
  const output = page.getByRole("dialog", { name: "What Shell 3 printed" });
  await output.waitFor();
  await output.getByText("about-to-crash", { exact: false }).first().waitFor({ timeout: 20_000 });
  note('"What it printed" on that line: a dialog with Shell 3\'s output, about-to-crash in it');
  await capture("shells-crash-output-light");
  await output.getByRole("button", { name: "Close" }).last().click();
  await output.waitFor({ state: "hidden" });

  // A busy shell: Close shell… from the menu asks first.
  await live();
  await typeLine("sleep 600");
  await rowButton("build").click({ button: "right" });
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Close shell…" }).click();
  const confirm = page.getByRole("dialog", { name: "Close build?" });
  await confirm.waitFor();
  note(
    `Close shell… on build while \`sleep 600\` runs: "${(await confirm.innerText()).replace(/\n+/g, " / ")}"`,
  );
  await both("shells-busy-confirm");
  await confirm.getByRole("button", { name: "Close shell" }).click();
  await confirm.waitFor({ state: "hidden", timeout: 30_000 });

  // The last shell closed: no rows, no line for it, and the view offers New shell.
  await waitRows([], "after closing the last shell");
  await body.getByText("No shells are open in this workspace.").waitFor({ timeout: 20_000 });
  await body.getByRole("button", { name: "New shell" }).waitFor();
  if ((await body.getByText("build exited", { exact: false }).count()) > 0)
    throw new Error("closing build said it exited");
  note(
    'closed build: no rows, no line for it, "No shells are open in this workspace." and New shell',
  );
  await counts("none left");
  await both("shells-none-left");

  // A long press on a row opens its menu on a touch screen.
  await newShell(["Shell 4"], "a shell after none");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true });
  await settled();
  const target = await rowButton("Shell 4").boundingBox();
  if (target === null) throw new Error("the Shell 4 row isn't on screen");
  const point = { x: target.x + 40, y: target.y + target.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await menu.waitFor({ timeout: 5_000 });
  note("a long press on the Shell 4 row (touch emulation) opened its menu");
  await capture("shells-long-press-light");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // The phone: the picker holds the shown shell's actions, 44px tall.
  await page.setViewportSize(PHONE);
  await settled();
  const picker = body.getByRole("button", { name: / shells?$/ });
  await picker.waitFor();
  note(`390px: the picker reads "${(await picker.innerText()).replace(/\n/g, " ")}"`);
  await both("shells-phone");
  await picker.click();
  await menu.waitFor();
  const phoneItems = await menu.getByRole("menuitem").allInnerTexts();
  const heights = await menu
    .getByRole("menuitem")
    .evaluateAll((each) => each.map((item) => Math.round(item.getBoundingClientRect().height)));
  note(
    `390px picker items: ${JSON.stringify(phoneItems.map((each) => each.replace(/\n/g, " ")))}; heights ${JSON.stringify(heights)}`,
  );
  if (heights.some((height) => height < 44)) throw new Error("a picker item is under 44px");
  await both("shells-phone-menu");
  await page.keyboard.press("Escape");
  await page.setViewportSize(DESKTOP);
  await settled();

  await page.unroute("**/trpc/**");
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), A);
  note(`stopped the batch session ${A}`);
};
