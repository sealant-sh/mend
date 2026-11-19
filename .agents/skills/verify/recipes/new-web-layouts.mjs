// Layouts in a workspace's sheet (apps/web, route PR 16, SLNT-1175, ADR 0026 "Layouts"; flow
// `session-page.new-web-layouts`): the layout button in the Workspace header, the four built-in
// layouts by click and by ⌥ shortcut, the check on the layout the sheet shows, nothing open lost
// when a layout has fewer places, "Save this layout…" and its saved state, a saved layout picked in
// another workspace and seen from a second browser, rename and remove, the menu's loading, none
// saved, couldn't load and couldn't save states, and no button under 1024px. Run the CLI batch
// first, once per stack: a fake Codex login, two sessions in `layouts-one`, one in `layouts-two`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-layouts-sessions.json
//   pnpm verify drive new-web --recipe new-web-layouts --account <account.json>
//
// Every save, rename and removal is real, against the stack. The loading, couldn't-load and
// couldn't-save-for-the-network states are recorded tRPC answers in the browser (captures named
// `fixture-…`). The recipe removes the layouts it saved, forgets the arrangements it made and
// stops its sessions.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 1000, height: 800 };
const SAVED_NAME = "Review with terminal";
const RENAMED = "Wide review";
const ENDED = ["completed", "stopped", "failed"];

const failure = (message) => ({
  error: {
    json: { message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } },
  },
});

/** React has taken the page over. */
const hydrated = async (on) => {
  await on.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  await on.waitForFunction(() =>
    [...document.querySelectorAll("a[href],button")].some((node) =>
      Object.keys(node).some((key) => key.startsWith("__reactProps")),
    ),
  );
};

export default async ({ page, web, capture: captureOnce, note, account }) => {
  if (account === null)
    throw new Error("this recipe signs in a second browser: run it with --account");
  // The driver withholds a picture while the page inserts a subtree as it looks: look again.
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(400);
    }
    note(
      `${name}: the driver kept no picture (a terminal's canvas is on screen); its ARIA snapshot stands`,
    );
  };
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
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated(page).catch(async () => {
      note("the page didn't hydrate; loading it again");
      await page.goto(`${web}${path}`);
      await hydrated(page);
    });
    await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const tabsByTile = () =>
    page
      .locator("[data-tile]")
      .filter({ visible: true })
      .evaluateAll((all) =>
        all.map((tile) => [...tile.querySelectorAll("[data-tab]")].map((tab) => tab.dataset.tab)),
      );
  const layoutButton = () =>
    page.getByRole("button", { name: "Layout", exact: true }).filter({ visible: true });
  const menu = () => page.getByRole("menu").filter({ visible: true });
  const item = (name) => menu().getByRole("menuitem", { name, exact: false });
  const openMenu = async () => {
    await page.mouse.move(2, 2);
    await layoutButton().click();
    await menu().waitFor();
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await menu().waitFor({ state: "hidden" });
  };
  const checked = async () =>
    (await menu().getByRole("menuitem").filter({ hasText: ", shown now" }).allInnerTexts()).map(
      (text) => text.split("\n")[0].trim(),
    );
  const toast = (text) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(text, { exact: false })
      .waitFor();
  const dialog = (title) => page.getByRole("dialog", { name: title });

  // tRPC answers the recipe writes, by procedure: `{ error }`, or `{ hold }` (a promise the real
  // answer waits on).
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((path) => path !== "");
    if (!paths.some((path) => stubs.has(path))) return route.continue();
    for (const path of paths) await stubs.get(path)?.hold;
    const faked = (path) => stubs.get(path)?.error !== undefined;
    const real = paths.every(faked) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    const answer = paths.map((path, index) =>
      faked(path) ? failure(stubs.get(path).error) : answers[index],
    );
    const batched = route.request().url().includes("batch=1");
    await route.fulfill({
      status: paths.some(faked) ? (paths.length === 1 ? 500 : 207) : 200,
      contentType: "application/json",
      body: JSON.stringify(batched ? answer : answer[0]),
    });
  });

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The batch's sessions: two in layouts-one, one in layouts-two.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const runningIn = (worktree) =>
    rows
      .filter((row) => row.worktreeName === worktree && !ENDED.includes(row.session.status))
      .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
      .map((row) => row.session.id);
  const [A, B] = runningIn("layouts-one");
  const [C] = runningIn("layouts-two");
  if (A === undefined || B === undefined || C === undefined)
    throw new Error("the batch's sessions aren't running: run the CLI batch first");
  await client(
    async (trpc, [a, b, c]) => {
      await trpc.sessions.setLabel.mutate({ id: a, label: "Fix flaky checkout retry" });
      await trpc.sessions.setLabel.mutate({ id: b, label: "Add a regression test for 409s" });
      await trpc.sessions.setLabel.mutate({ id: c, label: "Upgrade to React Router 8" });
    },
    [A, B, C],
  );
  // Start from no saved layouts of this recipe's and no kept arrangement.
  const removeOurs = () =>
    client(
      async (trpc, names) => {
        const { layouts } = await trpc.layouts.list.query();
        for (const layout of layouts.filter((each) => names.includes(each.name)))
          await trpc.layouts.remove.mutate({ id: layout.id });
      },
      [SAVED_NAME, RENAMED, SAVED_NAME.toLowerCase()],
    );
  await removeOurs();
  await page.context().clearCookies({ name: "mend-tiles" });
  const [tabA, tabB, tabC] = [`session:${A}`, `session:${B}`, `session:${C}`];

  // T18's start: one tile holding both sessions. The button sits before Open in VS Code.
  await open(`/sessions/${A}`);
  await page.locator(`[data-tab="${tabB}"]`).first().waitFor();
  const header = page.locator('[data-slot="workspace-header"]');
  const order = await header
    .locator("a, button")
    .evaluateAll((all) =>
      all.map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim()),
    );
  if (order.indexOf("Layout") === -1 || order.indexOf("Layout") > order.indexOf("Open in VS Code"))
    throw new Error(`the header's controls read ${order.join(", ")}`);
  note(`header: ${order.filter(Boolean).join(" · ")}`);
  await openMenu();
  const builtIns = await menu().getByRole("menuitem").allInnerTexts();
  note(`menu, nothing saved yet: ${builtIns.map((text) => text.replace(/\n/g, " ")).join(" | ")}`);
  if ((await menu().getByText("Your layouts").count()) !== 0)
    throw new Error("Your layouts shows with nothing saved");
  if ((await checked()).join() !== "Conversation only")
    throw new Error(`one tile of both sessions checks ${(await checked()).join()}`);
  await both("menu-none-saved");

  // Change over terminal: fewer conversation places than conversations, and nothing is lost.
  await item("Change over terminal").click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length)
        .length === 3,
  );
  const changeOverTerminal = await tabsByTile();
  if (
    JSON.stringify(changeOverTerminal) !==
    JSON.stringify([[tabA, tabB], ["view:change"], ["view:terminal"]])
  )
    throw new Error(`Change over terminal laid out ${JSON.stringify(changeOverTerminal)}`);
  note("Change over terminal: both sessions in the left tile, Change over Terminal on the right");
  await openMenu();
  if ((await checked()).join() !== "Change over terminal")
    throw new Error(`the check is on ${(await checked()).join()}`);
  await both("menu-change-over-terminal");
  await closeMenu();

  // ⌥2 by the keyboard: Conversation beside change; the Terminal tab stays, in the left tile.
  await page.keyboard.press("Alt+Digit2");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length)
        .length === 2,
  );
  const beside = await tabsByTile();
  if (JSON.stringify(beside) !== JSON.stringify([[tabA, tabB, "view:terminal"], ["view:change"]]))
    throw new Error(`⌥2 laid out ${JSON.stringify(beside)}`);
  note(`⌥2: two tiles, ${JSON.stringify(beside)}: the Terminal tab kept, not lost`);
  await page.keyboard.press("Alt+Digit3");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length)
        .length === 3,
  );
  note("⌥3: back to Change over terminal");

  // Save this layout…: an empty name is refused in place, then saved.
  await openMenu();
  await item("Save this layout").click();
  await dialog("Save this layout").waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  await both("save-dialog");
  await dialog("Save this layout").getByRole("button", { name: "Save layout" }).click();
  await dialog("Save this layout").getByText("Give the layout a name.").waitFor();
  note('an empty name: "Give the layout a name." under the field, nothing sent');
  await page.getByRole("textbox", { name: "Name" }).fill(SAVED_NAME);
  await both("save-dialog-named");
  await dialog("Save this layout").getByRole("button", { name: "Save layout" }).click();
  await toast(`Saved the layout “${SAVED_NAME}”.`);
  await menu().waitFor();
  await menu().getByText("Your layouts").waitFor();
  const yours = await menu().getByRole("menuitem").filter({ hasText: SAVED_NAME }).innerText();
  if (!yours.includes("5")) throw new Error(`the saved row reads ${yours}`);
  if (!(await checked()).includes(SAVED_NAME))
    throw new Error(`after saving, the check is on ${(await checked()).join()}`);
  note(
    `saved: the toast, and the menu again with "${yours.replace(/\n/g, " ")}" checked under Your layouts`,
  );
  await both("layout-saved");
  await closeMenu();

  // Couldn't save: the server's refusal of a name already used, then a failure on the way.
  const saveAgain = async (name) => {
    await openMenu();
    await item("Save this layout").click();
    await dialog("Save this layout").waitFor();
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await dialog("Save this layout").getByRole("button", { name: "Save layout" }).click();
  };
  await saveAgain(SAVED_NAME.toLowerCase());
  const taken = dialog("Save this layout").getByText(/^You already have a layout called/);
  await taken.waitFor();
  note(`a name already used: "${await taken.innerText()}" under the field, the dialog stays`);
  await both("save-name-taken");
  await page.keyboard.press("Escape");
  await dialog("Save this layout").waitFor({ state: "hidden" });
  stubs.set("layouts.save", { error: "fetch failed" });
  await saveAgain("Another review");
  const failed = dialog("Save this layout").getByText(/^Couldn't save the layout/);
  await failed.waitFor();
  note(`a save that fails on the way: "${await failed.innerText()}"`);
  await both("fixture-save-failed");
  stubs.delete("layouts.save");
  await page.keyboard.press("Escape");
  await dialog("Save this layout").waitFor({ state: "hidden" });

  // Another workspace: its own arrangement, and the saved layout to pick.
  await go(`/sessions/${C}`);
  await page.locator(`[data-tab="${tabC}"]`).first().waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length)
        .length === 1,
  );
  await openMenu();
  await item(SAVED_NAME).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length)
        .length === 3,
  );
  const elsewhere = await tabsByTile();
  if (JSON.stringify(elsewhere) !== JSON.stringify([[tabC], ["view:change"], ["view:terminal"]]))
    throw new Error(`the saved layout in layouts-two laid out ${JSON.stringify(elsewhere)}`);
  note(`layouts-two: one tile, then "${SAVED_NAME}" picked: ${JSON.stringify(elsewhere)}`);
  await both("other-workspace-applied");
  // The first workspace kept its own arrangement: a layout is applied, it doesn't follow.
  await go(`/sessions/${A}`);
  await page.locator(`[data-tab="${tabB}"]`).first().waitFor();
  const firstAgain = await tabsByTile();
  if (JSON.stringify(firstAgain) !== JSON.stringify(changeOverTerminal))
    throw new Error(`layouts-one now reads ${JSON.stringify(firstAgain)}`);
  note("layouts-one still has its own arrangement");

  // A second browser, the same person: the saved layout is there too.
  await page.waitForTimeout(11_000);
  const second = await page.context().browser().newContext({ viewport: DESKTOP });
  const other = await second.newPage();
  await other.goto(`${web}/login`);
  await other.getByRole("textbox", { name: "Email" }).fill(account.email);
  await account.typePassword(other.getByLabel("Password", { exact: true }));
  await other.getByRole("button", { name: "Sign in", exact: true }).click();
  await other.waitForURL((url) => url.pathname !== "/login", { timeout: 60_000 });
  await other.goto(`${web}/sessions/${C}`);
  await hydrated(other);
  await other
    .getByRole("button", { name: "Layout", exact: true })
    .filter({ visible: true })
    .click();
  await other.getByRole("menu").getByText(SAVED_NAME).waitFor();
  note(`a second browser signed in as ${account.email}: "${SAVED_NAME}" is under Your layouts`);
  await second.close();

  // The menu's own states, as recorded answers: loading, then couldn't load and Try again.
  const held = Promise.withResolvers();
  stubs.set("layouts.list", { hold: held.promise });
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.resetQueries({ queryKey: [["layouts"]] }),
  );
  await openMenu();
  await menu().getByText("Loading your layouts…").waitFor();
  note("while the list loads: Loading your layouts… under Your layouts");
  await both("fixture-menu-loading");
  stubs.set("layouts.list", { error: "fetch failed" });
  held.resolve();
  await menu().getByText("Couldn't load your layouts. Try again").waitFor();
  note("when it fails: Couldn't load your layouts. Try again");
  await both("fixture-menu-load-failed");
  stubs.delete("layouts.list");
  await item("Couldn't load your layouts").click();
  await menu().getByText(SAVED_NAME).waitFor();
  note("Try again: the saved layout is back in the menu");
  await closeMenu();

  // Rename or remove….
  await openMenu();
  await item("Rename or remove").click();
  await dialog("Your layouts").waitFor();
  await dialog("Your layouts")
    .getByRole("button", { name: `Rename ${SAVED_NAME}` })
    .click();
  await dialog("Your layouts").getByRole("textbox").fill(RENAMED);
  await dialog("Your layouts").getByRole("button", { name: "Save", exact: true }).click();
  await dialog("Your layouts").getByText(RENAMED, { exact: true }).waitFor();
  note(`renamed to "${RENAMED}"`);
  await both("your-layouts");
  await dialog("Your layouts")
    .getByRole("button", { name: `Remove ${RENAMED}` })
    .click();
  await toast(`Removed the layout “${RENAMED}”.`);
  await dialog("Your layouts").getByText("You have no saved layouts.").waitFor();
  note(`removed: the toast, and the dialog says you have none`);
  await page.keyboard.press("Escape");
  await openMenu();
  if ((await menu().getByText("Your layouts").count()) !== 0)
    throw new Error("Your layouts still shows after the last was removed");
  await closeMenu();

  // Under 1024px the tiles are one strip, and there is no layout button.
  await page.setViewportSize(NARROW);
  await settled();
  if ((await layoutButton().count()) !== 0) throw new Error("the layout button shows under 1024px");
  note("under 1024px: no layout button, one strip of tabs");
  await capture("narrow-light");
  await page.setViewportSize(DESKTOP);

  // Leave the stack as it was.
  await removeOurs();
  await page.context().clearCookies({ name: "mend-tiles" });
  await client(
    async (trpc, ids) => {
      for (const id of ids) await trpc.sessions.stop.mutate({ id }).catch(() => undefined);
    },
    [A, B, C],
  );
  note("removed the recipe's layouts, forgot its arrangements and stopped its three sessions");
};
