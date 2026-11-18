// A project's Worktrees tab in the new web app (route PR 29, SLNT-1143): the list, New worktree,
// a worktree's menu, Remove with its refusals and Remove anyway, Clear finished, the empty state
// and the phone sheets. Run its CLI batch first (a worktree whose change was never landed, and a
// clean finished one, in verify-fixture):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-worktrees-setup.json
//   pnpm verify drive new-web --recipe new-web-worktrees
//
// Feature ids (worktrees.md): `worktrees-tab` (the region Worktrees, its count, each worktree with
// its sessions), `worktrees-new` (New worktree… makes one), `worktrees-menu` (a worktree's "…":
// open its session or change, start a session or a shell in it, copy its names, remove it),
// `worktrees-remove` (a refusal in words, with Remove anyway when force lifts it),
// `worktrees-clear-settled` (Clear finished… removes the finished worktrees and names the ones it
// kept), `worktrees-hidden-ended` (said only when the server hides ended sessions; noted when it
// hides none). `worktrees-toggle` is gone: the frames list every session in its row.
// capture-and-save.md `capture-removal-hold` and repositories-in-session.md `repo-removal-hold`
// are worded by `lib/worktree-removal.ts` (its tests); this stack mounts worktrees in place, so a
// save rarely holds one long enough to see.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();

// The CLI batch names its worktrees with the time (a removed worktree's branch keeps its name), so
// each run reads the newest of each.
const newest = (worktrees, prefix) =>
  worktrees
    .filter((w) => w.name.startsWith(`${prefix}-`))
    .toSorted((a, b) => b.name.localeCompare(a.name))[0]?.name;

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  // A capture is withheld when the page changes during it: let live reads land first.
  const quiet = () => page.waitForTimeout(2_500);
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
  /**
   * The driver withholds a picture when the page changes while it is taken (a toast leaving):
   * wait for a quiet second, for at most ten.
   */
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  const both = async (name) => {
    // The desktop sidebar's wrapper is 2px taller than the window, so a full-page capture resizes
    // the window, and the driver then withholds every later picture ("screenshot inspection
    // unavailable"). Clip it to the window for the capture.
    await page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
    // Hovering what was last clicked changes the page under the driver's check: park the mouse.
    await page.mouse.move(1, 1);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await still();
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  /** React has taken the page over, so clicks, typing and the router reach it. */
  // The dev server's first bundle of the app can take longer than a click's timeout.
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
    // The dev server may reload the page once as it bundles a module it hadn't seen: wait it out.
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const dialog = () => visible(page.getByRole("dialog"));
  const menuitem = (name) => visible(page.getByRole("menuitem", { name }));
  const path = () => new URL(page.url()).pathname;
  const toast = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words));
  /** A tRPC call from the page, as the signed-in person. */
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: at, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of at.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined && answer !== false) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  /** The desktop table's row of a worktree. */
  const tableRow = (name) =>
    page
      .getByRole("table", { name: "Worktrees" })
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
  const menuOf = async (name) => {
    await tableRow(name)
      .getByRole("button", { name: `Actions for ${name}` })
      .click();
    await menuitem("Remove worktree…").waitFor();
  };
  const closeDialog = async (name) => {
    await dialog().getByRole("button", { name }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  };
  const started = [];
  const stopAll = async () => {
    for (const id of started.splice(0))
      await call("sessions.stop", { id }, "mutate").catch(() => undefined);
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/projects");
  const me = await call("organization.current");
  const fixture = (await call("projects.list")).find((entry) => entry.name === "verify-fixture");
  if (fixture === undefined) throw new Error("no project verify-fixture on this stack");
  const tab = `/projects/${fixture.id}/worktrees`;
  const suffix = Math.random().toString(36).slice(2, 6);
  const fresh = `wt-new-${suffix}`;
  // Worktrees and projects an earlier run left when it stopped partway go first.
  const LEFT = /^wt-new-[a-z0-9]{4}$/;
  for (const worktree of (await call("projects.detail", { id: fixture.id })).worktrees)
    if (LEFT.test(worktree.name))
      await call("worktrees.remove", { id: worktree.id, force: true }, "mutate").catch(
        () => undefined,
      );
  const seeded = (await call("projects.detail", { id: fixture.id })).worktrees;
  const unlanded = newest(seeded, "wt-unlanded");
  const clean = newest(seeded, "wt-clean");
  if (unlanded === undefined || clean === undefined)
    throw new Error("run new-web-worktrees-setup.json first: its worktrees are missing");

  // worktrees-tab: the tab's link, the region, its count, each worktree with its sessions.
  await go(`/projects/${fixture.id}`);
  const nav = page.getByRole("navigation", { name: "verify-fixture project" }).first();
  await nav.getByRole("link", { name: /^Worktrees/ }).click();
  await page.waitForURL(`**${tab}`);
  if ((await nav.getByRole("link", { name: /^Worktrees/ }).getAttribute("aria-current")) !== "page")
    throw new Error("Worktrees isn't the open tab");
  const region = visible(page.getByRole("region", { name: "Worktrees" }));
  await region.getByRole("heading", { name: "Worktrees in verify-fixture" }).waitFor();
  await tableRow(unlanded).waitFor();
  await both("worktrees-desktop");
  note(
    `worktrees-tab: ${tab} opens from the tab "${(await nav.getByRole("link", { name: /^Worktrees/ }).innerText()).replace(/\s+/g, " ")}"; ${unlanded}'s row reads "${(await tableRow(unlanded).innerText()).replace(/\s+/g, " ")}"`,
  );
  const hidden = (await call("projects.detail", { id: fixture.id })).hiddenEndedSessions;
  note(
    `worktrees-hidden-ended: the server hides ${hidden} ended session(s) here${hidden === 0 ? ", so the tab says nothing" : ""}`,
  );

  // worktrees-new: New worktree… with a name, from the default branch.
  await button("New worktree…").click();
  await dialog().getByRole("heading", { name: "New worktree" }).waitFor();
  await dialog().getByRole("textbox", { name: /^Name/ }).fill(fresh);
  await dialog().getByText(`mend/${fresh}`).waitFor();
  // Start from suggests the project's branches as you type, and takes any ref typed whole.
  await dialog().getByRole("combobox", { name: "Start from" }).fill("ma");
  await visible(page.getByRole("option", { name: "main" })).waitFor();
  await settled();
  await both("new-desktop");
  await visible(page.getByRole("option", { name: "main" })).click();
  if ((await dialog().getByRole("combobox", { name: "Start from" }).inputValue()) !== "main")
    throw new Error("picking main didn't fill Start from");
  await dialog().getByRole("button", { name: "Create worktree" }).click();
  await toast(`Created ${fresh} on mend/${fresh}.`).waitFor({ timeout: 60_000 });
  await tableRow(fresh).waitFor();
  await both("created-desktop");
  note(
    `worktrees-new: New worktree… → ${fresh} → "Created ${fresh} on mend/${fresh}." and its row`,
  );

  // A name already used in the project is refused in the dialog, which keeps what was typed.
  await button("New worktree…").click();
  await dialog().getByRole("textbox", { name: /^Name/ }).fill(fresh);
  await dialog().getByRole("button", { name: "Create worktree" }).click();
  const taken = dialog().getByText(/already used in this project|already exists/);
  await taken.waitFor({ timeout: 60_000 });
  await both("name-taken-desktop");
  note(`worktrees-new, a name in use: "${(await taken.innerText()).replace(/\s+/g, " ")}"`);
  await closeDialog("Cancel");

  // worktrees-menu: the "…", then a shell started in the new worktree.
  await menuOf(fresh);
  await menuitem("New session in this worktree").waitFor();
  await both("menu-desktop");
  const items = await page.getByRole("menuitem").allInnerTexts();
  note(`worktrees-menu on ${fresh}: ${items.map((item) => item.replace(/\s+/g, " ")).join(" | ")}`);
  await menuitem("Open shell in this worktree").click();
  const shell = await waitFor(
    "the shell opening its session",
    () => /^\/sessions\/([^/]+)$/.exec(path())?.[1],
    60,
  );
  started.push(shell);
  note(`worktrees-menu: Open shell in this worktree opened /sessions/${shell}`);
  await go(tab);
  await tableRow(fresh).getByText("Running").waitFor({ timeout: 60_000 });

  // worktrees-remove while the shell runs: asked first, then refused in words with no override.
  await menuOf(fresh);
  await menuitem("Remove worktree…").click();
  await dialog()
    .getByRole("heading", { name: `Remove ${fresh}?` })
    .waitFor();
  await dialog().getByText("Its checkpoints").waitFor();
  await settled();
  await both("remove-desktop");
  await dialog().getByRole("button", { name: "Remove worktree" }).click();
  await dialog().getByRole("heading", { name: "Not removed" }).waitFor();
  const running = (await dialog().innerText()).replace(/\s+/g, " ");
  if ((await dialog().getByRole("button", { name: "Remove anyway" }).count()) !== 0)
    throw new Error("Remove anyway is offered while a session runs");
  await both("cant-running-desktop");
  note(`worktrees-remove, running: ${running}`);
  await closeDialog("Keep worktree");

  // Stop the shell (the last running session, so its workspace stops too), then remove.
  await stopAll();
  await waitFor(
    "the shell to stop",
    async () =>
      (await call("projects.detail", { id: fixture.id })).sessions.find((s) => s.id === shell)
        ?.status !== "running",
    90,
  );
  await page.reload();
  await hydrated();
  let removed = false;
  for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
    await menuOf(fresh);
    await menuitem("Remove worktree…").click();
    await dialog().getByRole("button", { name: "Remove worktree" }).click();
    const outcome = await Promise.race([
      toast(new RegExp(`^Removed ${fresh}`))
        .waitFor({ timeout: 30_000 })
        .then(() => "removed"),
      dialog()
        .getByRole("heading", { name: "Not removed" })
        .waitFor({ timeout: 30_000 })
        .then(() => "refused"),
    ]);
    if (outcome === "removed") {
      removed = true;
      break;
    }
    const why = (await dialog().innerText()).replace(/\s+/g, " ");
    note(`after the stop, attempt ${attempt + 1} was refused: ${why}`);
    if (why.includes("still saving")) await both("cant-saving-desktop");
    await closeDialog("Keep worktree");
    await page.waitForTimeout(6_000);
  }
  if (!removed) throw new Error(`${fresh} was never removed after its shell stopped`);
  await tableRow(fresh).waitFor({ state: "detached" });
  await both("removed-desktop");
  // The list `mend worktrees` reads no longer has it.
  const listed = await call("worktrees.list", { projectId: fixture.id });
  const names = JSON.stringify(listed).includes(`"${fresh}"`);
  if (names) throw new Error(`worktrees.list still lists ${fresh}`);
  note(
    `worktrees-remove: once the shell stopped, Remove worktree took ${fresh} and its session; worktrees.list (what mend worktrees reads) no longer lists it`,
  );

  // worktrees-remove, never landed: the files not on origin, and Remove anyway offered.
  await menuOf(unlanded);
  await menuitem("Remove worktree…").click();
  await dialog().getByRole("button", { name: "Remove worktree" }).click();
  await dialog().getByRole("heading", { name: "Not removed" }).waitFor();
  await dialog().getByRole("list", { name: "Not on origin" }).waitFor();
  await dialog().getByRole("button", { name: "Remove anyway" }).waitFor();
  await both("cant-unlanded-desktop");
  note(`worktrees-remove, never landed: ${(await dialog().innerText()).replace(/\s+/g, " ")}`);
  await closeDialog("Keep worktree");

  // worktrees-clear-settled: the finished worktrees, then what went and what stayed.
  await button("Clear finished…").click();
  await dialog().getByRole("heading", { name: "Clear finished worktrees?" }).waitFor();
  await dialog().getByText(unlanded, { exact: true }).waitFor();
  await both("clear-desktop");
  const finishedList = await dialog().getByRole("list", { name: "Finished worktrees" }).innerText();
  await dialog().getByRole("button", { name: "Clear finished worktrees" }).click();
  const cleared = toast(/^(Removed \d+ worktrees?\.|Kept )/);
  await cleared.waitFor({ timeout: 120_000 });
  const clearedWords = await cleared.innerText();
  if (!clearedWords.includes(unlanded)) throw new Error(`the toast read ${clearedWords}`);
  await tableRow(clean).waitFor({ state: "detached" });
  await tableRow(unlanded).waitFor();
  await both("cleared-desktop");
  note(
    `worktrees-clear-settled: listed ${finishedList.replace(/\s+/g, " ")}; the toast read "${clearedWords}"`,
  );

  // The phone: the list, a worktree's actions, New worktree, and Remove anyway.
  await page.setViewportSize(PHONE);
  await go(tab);
  await settled();
  const phoneRow = visible(page.getByRole("listitem", { name: `Worktree ${unlanded}` }));
  await phoneRow.waitFor();
  await quiet();
  await both("worktrees-phone");
  await phoneRow.getByRole("button", { name: `Actions for ${unlanded}` }).click();
  await visible(page.getByRole("menuitem", { name: "Remove worktree…" })).waitFor();
  await both("menu-phone");
  await page.keyboard.press("Escape");
  await settled();
  await button("New worktree…").click();
  await dialog().getByRole("heading", { name: "New worktree" }).waitFor();
  const touch =
    (await dialog().getByRole("button", { name: "Create worktree" }).boundingBox())?.height ?? 0;
  if (touch < 44) throw new Error(`Create worktree is ${touch}px tall on a phone`);
  await both("new-phone");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await phoneRow.getByRole("button", { name: `Actions for ${unlanded}` }).click();
  await visible(page.getByRole("menuitem", { name: "Remove worktree…" })).click();
  await dialog()
    .getByRole("heading", { name: `Remove ${unlanded}?` })
    .waitFor();
  await settled();
  await both("remove-phone");
  await dialog().getByRole("button", { name: "Remove worktree" }).click();
  await dialog().getByRole("heading", { name: "Not removed" }).waitFor();
  await both("cant-unlanded-phone");
  await dialog().getByRole("button", { name: "Remove anyway" }).click();
  await toast(`Removed ${unlanded} and its session. Its change was discarded.`).waitFor({
    timeout: 60_000,
  });
  await both("removed-phone");
  note(`worktrees-remove, phone: Remove anyway discarded ${unlanded}'s change and said so`);
  await page.setViewportSize(DESKTOP);

  // No worktrees yet, on a project made for it.
  const empty = await call("projects.createNew", { name: `wt-empty-${suffix}` }, "mutate");
  await go(`/projects/${empty.id}/worktrees`);
  await page.getByRole("heading", { name: "No worktrees yet" }).waitFor();
  await both("none-desktop");
  await page.setViewportSize(PHONE);
  await settled();
  await both("none-phone");
  await page.setViewportSize(DESKTOP);
  note(`an empty project (wt-empty-${suffix}): No worktrees yet, with New worktree…`);

  // A project that fails to load.
  await page.route("**/trpc/**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
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
  await go("/projects");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  await go(tab);
  await page.getByRole("heading", { name: "This page didn't load" }).waitFor();
  await both("error-desktop");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  // Clear finished and Remove anyway may have left the project with no worktrees.
  await visible(
    page
      .getByRole("region", { name: "Worktrees" })
      .or(page.getByRole("heading", { name: "No worktrees yet" })),
  ).waitFor();
  note("a project that fails to load shows the error screen; Try again reads it again");

  // Put back what this drive changed.
  await stopAll();
  await call("projects.remove", { id: empty.id }, "mutate").catch(() => undefined);
  const gone = (await call("projects.removed")).find((p) => p.name === `wt-empty-${suffix}`);
  if (gone !== undefined)
    await call("projects.purge", { id: gone.id, confirm: gone.name }, "mutate").catch(
      () => undefined,
    );
  note(`removed the project this drive made (wt-empty-${suffix}); signed in as ${me.userId}`);
};
