// Tiles in a session's sheet (apps/web, route PR 15, SLNT-1137, ADR 0026): two sessions of one
// workspace as tabs, split by dragging a tab onto a tile's edge and by the keyboard, added to a
// tile by dropping it in the middle, resized, maximised and restored, a tile's last tab closed,
// the arrangement kept over a reload, `?full=1`, a New session tab, a session that starts in the
// workspace opening as a tab, a tab's body kept while it moves, and the one strip under 1024px.
// Run the CLI batch first, once per stack: it starts two sessions in the worktree `tiles-ws`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-tiles-sessions.json
//   pnpm verify drive new-web --recipe new-web-tiles
//
// A local stack runs no agent: the line naming a session waiting on you is drawn from a fixture
// answer to the inbox read, and that capture is named `fixture-…`.
const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 1000, height: 800 };
const PHONE = { width: 390, height: 844 };

const TITLE_A = "Fix flaky checkout retry";
const TITLE_B = "Add a regression test for 409s";

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Captures the page as it stands, light then dark. */
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const router = () => page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  const hydrated = async () => {
    await router();
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

  const tiles = () => page.locator("[data-tile]").filter({ visible: true });
  const tabOf = (key) =>
    page.locator(`[data-tab="${key}"]`).filter({ visible: true }).getByRole("tab");
  const tileOf = (key) =>
    page.locator("[data-tile]").filter({ has: page.locator(`[data-tab="${key}"]`) });
  const boxOf = async (locator) => {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("an element the recipe needs isn't on screen");
    return box;
  };
  const said = () => page.locator('p[role="status"].sr-only').innerText();
  const expectTiles = async (count, what) => {
    await page.waitForFunction(
      (n) =>
        [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length > 0)
          .length === n,
      count,
      { timeout: 5_000 },
    ).catch(async () => {
      throw new Error(`${what}: ${await tiles().count()} tiles on screen, not ${count}`);
    });
  };
  /** Drags a tab by the mouse to (x, y); `during` runs while it is held there. */
  const drag = async (key, x, y, during) => {
    const from = await boxOf(tabOf(key));
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 14 });
    await page.waitForTimeout(150);
    if (during !== undefined) await during();
    await page.mouse.up();
    await page.waitForTimeout(200);
  };

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The two sessions the CLI batch started in `tiles-ws`, the older first.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const running = rows
    .filter(
      (row) =>
        row.worktreeName === "tiles-ws" &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)));
  if (running.length < 2)
    throw new Error("tiles-ws has fewer than two running sessions: run the CLI batch first");
  const [A, B] = [running[0].session.id, running[1].session.id];
  const worktreeId = running[0].session.worktreeId;
  const tabA = `session:${A}`;
  const tabB = `session:${B}`;
  // Titles a person would give them, so the tabs read like the frames.
  await client(
    async (trpc, [a, b, ta, tb]) => {
      await trpc.sessions.setLabel.mutate({ id: a, label: ta });
      await trpc.sessions.setLabel.mutate({ id: b, label: tb });
    },
    [A, B, TITLE_A, TITLE_B],
  );
  // Start from no arrangement for the workspace: one tile.
  await page.context().clearCookies({ name: "mend-tiles" });

  // T01: one tile, both running sessions of the workspace as its tabs, the opened one first.
  await open(`/sessions/${A}`);
  await tabOf(tabB).waitFor();
  await expectTiles(1, "one tile");
  const order = await page
    .locator("[data-tile] [data-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab));
  if (order[0] !== tabA || order[1] !== tabB)
    throw new Error(`the tile's tabs read ${order.join(", ")}`);
  if ((await tabOf(tabA).getAttribute("aria-selected")) !== "true")
    throw new Error("the opened session's tab is not the active one");
  note(`one tile: tabs ${TITLE_A}, ${TITLE_B}; the opened session's is active`);
  await both("one-tile");

  // T04/T05: drag B onto the right edge of the tile: "Split right", then two tiles side by side.
  const one = await boxOf(tiles().first());
  await drag(tabB, one.x + one.width * 0.9, one.y + one.height * 0.5, async () => {
    await page.getByText("Split right", { exact: true }).waitFor();
    await both("drag-split-right");
  });
  await expectTiles(2, "after a drop on the right edge");
  const [left, right] = [await boxOf(tileOf(tabA)), await boxOf(tileOf(tabB))];
  if (!(right.x > left.x + 100)) throw new Error("B's tile isn't to the right of A's");
  if ((await tileOf(tabB).getAttribute("data-focus")) !== "true")
    throw new Error("the new tile hasn't the focus");
  note("drag right: the drop mark read Split right; two tiles side by side, the new one focused");
  await both("side-by-side");

  // T08: resize by the divider.
  const divider = page.locator('[data-separator]').filter({ visible: true }).first();
  const line = await boxOf(divider);
  const before = left.width;
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x - 160, line.y + line.height / 2, { steps: 10 });
  await both("resizing");
  await page.mouse.up();
  await page.waitForTimeout(300);
  const resized = (await boxOf(tileOf(tabA))).width;
  if (!(resized < before - 100)) throw new Error(`A's tile is ${resized}px wide, was ${before}px`);
  note(`resize: A's tile went from ${Math.round(before)}px to ${Math.round(resized)}px`);

  // Kept over a reload.
  await page.reload();
  await hydrated();
  await tabOf(tabB).waitFor();
  await expectTiles(2, "after a reload");
  const reloaded = (await boxOf(tileOf(tabA))).width;
  if (Math.abs(reloaded - resized) > 4)
    throw new Error(`after a reload A's tile is ${reloaded}px wide, not ${resized}px`);
  note(`reload: two tiles, A's still ${Math.round(reloaded)}px wide`);

  // Keep: mark B's body, then move B between tiles; the same element must still be there.
  await page.locator(`[data-tab-body="${tabB}"]`).waitFor({ state: "attached" });
  await page.evaluate((key) => {
    const body = document.querySelector(`[data-tab-body="${key}"]`);
    body.firstElementChild.dataset.keptMark = "before-move";
  }, tabB);

  // Keyboard: Alt+Shift+Left takes B into A's tile; Alt+Shift+Down splits it underneath (T06/T07).
  await tabOf(tabB).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expectTiles(1, "after Alt+Shift+Left");
  note(`keyboard left: one tile; the page said "${await said()}"`);
  await tabOf(tabB).focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expectTiles(2, "after Alt+Shift+Down");
  const [top, bottom] = [await boxOf(tileOf(tabA)), await boxOf(tileOf(tabB))];
  if (!(bottom.y > top.y + 100)) throw new Error("B's tile isn't under A's");
  note(`keyboard down: B's tile is under A's; the page said "${await said()}"`);
  await both("split-below");

  // The body B had at the start is the one it shows now: moved, never drawn again.
  await tabOf(tabB).click();
  const mark = await page.evaluate(
    (key) => document.querySelector(`[data-tab-body="${key}"]`)?.firstElementChild?.dataset.keptMark,
    tabB,
  );
  if (mark !== "before-move") throw new Error("B's body was drawn again when its tab moved");
  note("kept: B's conversation is the element marked before its tab moved twice by the keyboard");

  // T09: drag B into the middle of A's tile: "Add to this tile", then one tile.
  const upper = await boxOf(tileOf(tabA));
  await drag(tabB, upper.x + upper.width * 0.5, upper.y + upper.height * 0.55, async () => {
    await page.getByText("Add to this tile", { exact: true }).waitFor();
    await both("drag-add-to-tile");
  });
  await expectTiles(1, "after a drop in the middle");
  note("drag to the middle: the mark read Add to this tile; one tile holds both tabs");

  // T11: maximise. Split again, then maximise A's tile; B's tile leaves the screen.
  await tabOf(tabB).focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expectTiles(2, "split right by keyboard");
  await tileOf(tabA).getByRole("button", { name: "Maximise tile" }).click();
  await expectTiles(1, "maximised");
  await page.getByRole("button", { name: "Restore layout" }).waitFor();
  note("maximise: A's tile fills the sheet, with Restore layout");
  await both("maximised");

  // The line naming the other session that waits on you, from a fixture inbox answer.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!paths.includes("sessions.inbox")) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      if (path !== "sessions.inbox") return;
      for (const row of answers[index]?.result?.data?.json ?? [])
        if (row.session.id === B) row.session.status = "waiting";
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.refetchQueries({
      queryKey: [["sessions", "inbox"]],
    }),
  );
  await page.getByText(`${TITLE_B} is waiting on you`).waitFor();
  note(`maximised: the strip reads "${TITLE_B} is waiting on you"`);
  await both("fixture-maximised-waiting");
  await page.unroute("**/trpc/**");
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.refetchQueries({
      queryKey: [["sessions", "inbox"]],
    }),
  );
  await page.getByRole("button", { name: "Restore layout" }).click();
  await expectTiles(2, "restored");
  note("Restore layout: both tiles back");

  // T20: close the last tab of a tile; its neighbour takes the space.
  await tabOf(tabB).hover();
  await page.getByRole("button", { name: `Close ${TITLE_B}` }).waitFor();
  await both("close-hover");
  await page.getByRole("button", { name: `Close ${TITLE_B}` }).click();
  await expectTiles(1, "after closing B's tab");
  const full = await boxOf(tiles().first());
  note(`close: B's tile closed, A's is ${Math.round(full.width)}px wide`);

  // "+" lists B, closed, and New session in this workspace (T02).
  await tileOf(tabA).getByRole("button", { name: "Open a view" }).click();
  await page.getByRole("menuitem", { name: TITLE_B }).waitFor();
  await page.getByRole("menuitem", { name: "New session in this workspace" }).waitFor();
  await both("open-menu");
  await page.getByRole("menuitem", { name: TITLE_B }).click();
  await tabOf(tabB).waitFor();
  note("+ listed the closed session and New session in this workspace; B's tab came back");

  // T22: New session in this workspace opens a tab beside the active session tab.
  await tabOf(tabA).click();
  await tileOf(tabA).getByRole("button", { name: "Open a view" }).click();
  await page.getByRole("menuitem", { name: "New session in this workspace" }).click();
  await page.getByRole("heading", { name: "New session", level: 2 }).waitFor();
  const withNew = await page
    .locator("[data-tile] [data-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab));
  if (withNew[0] !== tabA || !withNew[1]?.startsWith("new:"))
    throw new Error(`the tabs read ${withNew.join(", ")}`);
  note(`new session: a New session tab opened beside ${TITLE_A}, with its composer`);
  await both("new-session-tab");
  const draft = withNew[1];
  await tabOf(draft).focus();
  await page.keyboard.press("Delete");
  await page.locator(`[data-tab="${draft}"]`).waitFor({ state: "detached" });
  note("Delete on the New session tab closed it");

  // A session that starts in the workspace from elsewhere opens beside the active session tab.
  await tabOf(tabA).click();
  const started = await client(
    async (trpc, id) =>
      (
        await trpc.worktrees.createSession.mutate({
          id,
          session: { harness: "run", label: "Check the 409 path by hand" },
        })
      ).id,
    worktreeId,
  );
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.refetchQueries({
      queryKey: [["sessions", "inbox"]],
    }),
  );
  await page.locator(`[data-tab="session:${started}"]`).first().waitFor({ timeout: 15_000 });
  const arrived = await page
    .locator("[data-tile] [data-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab));
  if (arrived[arrived.indexOf(tabA) + 1] !== `session:${started}`)
    throw new Error(`the started session's tab isn't beside A's: ${arrived.join(", ")}`);
  note("a session started in tiles-ws from outside the page opened as a tab beside the active one");
  await both("session-arrives");

  // ?full=1 (T30): the session's tile maximised; Restore layout drops it from the address.
  await open(`/sessions/${A}?full=1`);
  await page.getByRole("button", { name: "Restore layout" }).waitFor();
  await both("full");
  await page.getByRole("button", { name: "Restore layout" }).click();
  await page.waitForFunction(() => !location.search.includes("full"));
  note("?full=1: maximised with Restore layout; Restore layout drops ?full from the address");

  // T23: under 1024px, one strip of every tab.
  await page.setViewportSize(NARROW);
  await settled();
  const strip = page.getByRole("tablist", { name: "Tabs" });
  await strip.waitFor();
  const stripTabs = await strip.getByRole("tab").count();
  note(`under 1024px: one strip of ${stripTabs} tabs, no tile strips`);
  await both("narrow");

  // T19/T27/T28: the phone. Picking a tab in the strip shows its body; "+" opens a sheet.
  await page.setViewportSize(PHONE);
  await settled();
  await both("phone");
  await strip.getByRole("tab", { name: new RegExp(TITLE_B) }).click();
  await page.locator(`[data-tab-body="${tabB}"]`).filter({ visible: true }).waitFor();
  await both("phone-second-tab");
  await page.getByRole("button", { name: "Open a view" }).filter({ visible: true }).click();
  await page.getByRole("dialog").getByText("New session in this workspace").waitFor();
  await both("phone-open-a-view");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  note("phone: the strip shows B's conversation when picked; + opens the Open a view sheet");

  // Leave the stack as the batch left it: the extra session goes, the arrangement too.
  await page.setViewportSize(DESKTOP);
  await client(async (trpc, id) => {
    await trpc.sessions.stop.mutate({ id }).catch(() => undefined);
  }, started);
  await page.context().clearCookies({ name: "mend-tiles" });
};
