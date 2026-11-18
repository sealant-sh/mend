// The Change view in the new web app (apps/web, route PR 23, SLNT-1147): the workspace's change
// read file by file, as a view in a tile. Driven by review-change.md's `review-open`,
// `review-diff`, `review-files` and `review-pinned`, and repositories-in-session.md's
// `repo-review-line` where a session holds another repository. Run the CLI batch first, once per
// stack; while the recipe waits on "waiting for the worktree to change", run the second batch:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-change-sessions.json
//   pnpm verify drive new-web --recipe new-web-change
//   # when steps.log reads "waiting for the worktree to change", from another terminal:
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-change-moves.json
//
// The first batch makes three worktrees with `mend run` (no agent): `change-small`, three files in
// one folder and the README, written by one session and added to by a second; `change-big`, 37
// files with a lock file, a picture, a rename and a 3,000-line file; `change-empty`, a session that
// changed nothing. The second batch edits a file in `change-small` while the page shows it.
//
// What it shows, light and dark, at 1280px and at 390px: nothing to review yet; the first look
// with the tab's counts, the file list, and "This workspace's change, from 2 sessions"; a file
// picked from the list; split view kept over a reload; a file marked viewed, folded and kept over
// a reload; the files changing while you read, and the new version, where the changed file reads
// unviewed again; the big change, with the lock file folded, the picture, the rename, the filter,
// and only the lines in view drawn; `/sessions/<id>/change` and `/changes/<id>#land`; the view
// in a narrow tile beside the conversation, with its file picker; the phone's file sheet; and a
// review that fails to load, with Try again.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const TITLES = {
  small: "Fix flaky checkout retry",
  second: "Write tests for retry",
  big: "Upgrade to React Router 8",
  empty: "Look at the retry wrapper",
};

/** Where an element is on screen; the recipe can't go on without it. */
const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("an element the recipe needs isn't on screen");
  return box;
};

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const visible = (locator) => locator.filter({ visible: true }).first();
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** How many times the page's DOM gained or lost nodes in one second. */
  const changesInASecond = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let changes = 0;
          const observer = new MutationObserver((records) => {
            changes += records.length;
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(changes);
          }, 1_000);
        }),
    );
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  // The driver withholds a picture when the page changes while it looks (rows the diff draws as
  // it settles): look again until it keeps one.
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await still();
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(600);
    }
  };
  const both = async (name) => {
    // The sidebar's wrapper is 2px taller than the window: clip it, or a capture resizes the
    // window and the driver withholds every later picture.
    await page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
    await page.mouse.move(1, 1);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    // The dev server may reload the page once as it bundles a module it hadn't seen.
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const path = () => new URL(page.url()).pathname;
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const fileRow = (name) =>
    visible(page.getByRole("list", { name: "Changed files" }).getByRole("button", { name }));
  const changeTab = () => visible(page.locator('[data-tab="view:change"]'));
  const filesFact = () =>
    visible(page.getByRole("complementary", { name: "Files" }).locator("h3").first()).innerText();

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The sessions the CLI batch made, by worktree.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const of = (worktree) =>
    rows
      .filter((row) => row.worktreeName === worktree)
      .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
      .map((row) => row.session);
  const smallSessions = of("change-small");
  const [small, second] = smallSessions;
  const [big] = of("change-big");
  const [empty] = of("change-empty");
  if (small === undefined || second === undefined || big === undefined || empty === undefined)
    throw new Error("run new-web-change-sessions.json first: a worktree it makes is missing");
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [small.id, TITLES.small],
      [second.id, TITLES.second],
      [big.id, TITLES.big],
      [empty.id, TITLES.empty],
    ],
  );
  const smallChange = await client(
    async (trpc, id) => (await trpc.sessions.detail.query({ id })).change?.id ?? null,
    small.id,
  );
  if (smallChange === null) throw new Error("change-small has no change");
  // Start clean: no kept arrangement, layout or viewed marks from an earlier run.
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.context().clearCookies({ name: "mend-diff-layout" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("mend-viewed-files-")) localStorage.removeItem(key);
    sessionStorage.clear();
  });

  // Nothing to review yet.
  await open(`/sessions/${empty.id}/change`);
  await visible(page.getByText("No changes yet", { exact: true })).waitFor();
  await visible(page.getByText("Branch", { exact: true })).waitFor();
  if ((await changeTab().innerText()).includes("+"))
    throw new Error("the Change tab of a change with no lines shows counts");
  note("nothing to review: 'No changes yet', the branch and the base, and a tab with no counts");
  await both("nothing-yet-desktop");

  // The first look: the view's own address opens the session with the Change tab focused.
  await open(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await visible(page.getByRole("heading", { name: /^Files/ })).waitFor();
  if ((await changeTab().getByRole("tab").getAttribute("aria-selected")) !== "true")
    throw new Error("/sessions/<id>/change didn't focus the Change tab");
  await page.waitForFunction(
    () => /\+\d/.test(document.querySelector('[data-tab="view:change"]')?.textContent ?? ""),
    null,
    { timeout: 20_000 },
  );
  const counts = (await changeTab().innerText()).replace(/\s+/g, " ").trim();
  note(`/sessions/<id>/change: the Change tab is focused and reads "${counts}"`);
  // Each run of the moves batch adds a session to the workspace.
  const from = `This workspace's change, from ${smallSessions.length} sessions.`;
  await visible(page.getByText(from)).waitFor();
  await visible(page.getByRole("link", { name: new RegExp(TITLES.second) })).waitFor();
  note(`the toolbar says '${from}'; Sessions lists them`);
  note(`files column: "${(await filesFact()).replace(/\s+/g, " ")}"`);
  await both("first-look-desktop");

  // A file picked from the list comes to the top of the diffs and reads selected.
  await fileRow(/charge\.test\.ts/).click();
  await page.waitForTimeout(800);
  if ((await fileRow(/charge\.test\.ts/).getAttribute("aria-current")) !== "true")
    throw new Error("the picked file isn't the selected row");
  note("picking charge.test.ts from Files brings its diff to the top and selects its row");

  // Split view, kept over a reload.
  await button("Split").click();
  await page.waitForTimeout(800);
  await visible(page.getByText(/^Checkpoint \d+ · [0-9a-f]{7}$/)).waitFor();
  await page.reload();
  await hydrated();
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  if ((await button("Split").getAttribute("aria-pressed")) !== "true")
    throw new Error("Split didn't stay picked over a reload");
  note("Split: old and new side by side under each side's checkpoint; kept over a reload");
  await both("split-desktop");
  await button("Unified").click();
  await settled();

  // Marking a file viewed folds it, counts it, and is kept over a reload.
  await page.getByRole("checkbox", { name: "Viewed: src/payments/retry.ts" }).first().click();
  await settled();
  const folded = section("src/payments/retry.ts").getByRole("button", { expanded: false });
  await folded.waitFor();
  if (!(await filesFact()).includes("1 of 4 viewed"))
    throw new Error(`the Files column reads "${await filesFact()}" after one mark`);
  await page.reload();
  await hydrated();
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await section("src/payments/retry.ts").getByRole("button", { expanded: false }).waitFor();
  note("Viewed on retry.ts folds it, Files reads '1 of 4 viewed', and both hold over a reload");
  await both("viewed-desktop");

  // The files change while the page shows them.
  note("waiting for the worktree to change: run new-web-change-moves.json now");
  await visible(page.getByText("Files changed since you opened this.")).waitFor({
    timeout: 600_000,
  });
  note("the banner reads 'Files changed since you opened this. You're reading checkpoint N.'");
  await both("files-changed-desktop");
  await button("Show the new version").click();
  await page
    .getByText("Files changed since you opened this.")
    .waitFor({ state: "hidden", timeout: 30_000 });
  await section("src/payments/retry.ts").getByRole("button", { expanded: true }).waitFor();
  if (
    await page.getByRole("checkbox", { name: "Viewed: src/payments/retry.ts" }).first().isChecked()
  )
    throw new Error("retry.ts changed since its mark but still reads viewed");
  note(
    "Show the new version: the banner goes, and retry.ts, changed since its mark, reads unviewed",
  );
  await both("new-version-desktop");

  // The big change.
  await open(`/sessions/${big.id}/change`);
  await section("pnpm-lock.yaml").waitFor({ timeout: 60_000 });
  await visible(
    page.getByText(
      "Mend folded this file because a tool generated it. You rarely need to read it.",
    ),
  ).waitFor();
  await visible(page.getByText("37 files changed. Mend folds generated files.")).waitFor();
  await section("docs/README.md").getByText("Renamed").waitFor();
  await section("public/og/checkout.png").getByText("Binary").waitFor();
  note("big change: 37 files; pnpm-lock.yaml folded as generated; README renamed; the png binary");
  await both("big-desktop");
  await fileRow(/rows\.ts/).click();
  await page.waitForTimeout(1_500);
  const drawn = await page.evaluate(() => {
    let lines = 0;
    for (const host of document.querySelectorAll("diffs-container"))
      lines += host.shadowRoot?.querySelectorAll("[data-line]").length ?? 0;
    return lines;
  });
  if (drawn >= 3000) throw new Error(`the page drew ${drawn} lines for a 3,000-line file`);
  note(
    `src/data/rows.ts (3,000 lines) picked: the page holds ${drawn} drawn lines, not every line`,
  );
  await both("big-rows-desktop");
  await visible(page.getByRole("searchbox", { name: "Filter files" })).fill("cart");
  await settled();
  const listed = await page
    .getByRole("list", { name: "Changed files" })
    .first()
    .getByRole("button")
    .allInnerTexts();
  note(`the filter 'cart' leaves: ${listed.map((text) => text.split("\n")[0]).join(", ")}`);
  await both("big-filter-desktop");
  await button("Show diff").click();
  await section("pnpm-lock.yaml").locator("diffs-container").waitFor();
  note("Show diff on the lock file draws its lines");

  // `/changes/<id>` goes to the session's Change view and keeps the hash.
  await open(`/changes/${smallChange}#land`);
  await page.waitForURL(/\/sessions\/[^/]+\/change/, { timeout: 30_000 });
  const hash = new URL(page.url()).hash;
  if (hash !== "#land") throw new Error(`/changes/<id>#land arrived with hash "${hash}"`);
  note(`/changes/<id>#land went to ${path()}${hash}`);

  // A narrow tile: the Change view beside the conversation.
  // The session's own page first, then its Change view: the view's tab opens beside the
  // conversation's, in one tile.
  await page.context().clearCookies({ name: "mend-tiles" });
  await open(`/sessions/${small.id}`);
  await visible(page.locator(`[data-tab="session:${small.id}"]`)).waitFor();
  await go(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  const tile = await boxOf(visible(page.locator("[data-tile]")));
  const tab = await boxOf(changeTab());
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(tile.x + tile.width * 0.92, tile.y + tile.height * 0.5, { steps: 14 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const picker = visible(page.getByRole("button", { name: /^File \d+ of \d+: / }));
  await picker.waitFor();
  note("in a tile beside the conversation the view drops its file column for a picker");
  await both("narrow-tile-desktop");
  await picker.click();
  await visible(page.getByRole("dialog")).waitFor();
  await both("narrow-picker-desktop");
  await page.keyboard.press("Escape");
  await settled();

  // The phone.
  await page.setViewportSize(PHONE);
  await open(`/sessions/${empty.id}/change`);
  await visible(page.getByText("No changes yet", { exact: true })).waitFor();
  await both("nothing-yet-phone");
  await open(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await both("first-look-phone");
  await open(`/sessions/${big.id}/change`);
  await section("pnpm-lock.yaml").waitFor({ timeout: 60_000 });
  await both("big-phone");
  await visible(page.getByRole("button", { name: /^File \d+ of 37: / })).click();
  await visible(page.getByRole("dialog")).waitFor();
  await page.waitForTimeout(600);
  note("on a phone the picker opens the files as a sheet from the bottom");
  await both("file-sheet-phone");
  await page.keyboard.press("Escape");
  await settled();
  await page.setViewportSize(DESKTOP);

  // A review that fails to load, with Try again.
  await page.route("**/trpc/**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!calls.some((call) => call.startsWith("changes.reviewDiff"))) return route.fallback();
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
  await go("/no-such-page");
  await page.evaluate(() => {
    window["__TSR_ROUTER__"].options.context.queryClient.clear();
    sessionStorage.clear();
  });
  await go(`/sessions/${small.id}/change`);
  await visible(page.getByText("This didn't load.")).waitFor({ timeout: 30_000 });
  await both("failed-desktop");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  note("a review whose read fails says so with Try again, which reads it again");
};
