// Dialogs that list worktrees, in a project with 80 of them (SLNT-1242): each stays inside the
// window, its title and its buttons on screen, and its list scrolls inside it, at desktop and
// phone width. The owner's projects have 70 to 80 worktrees.
//
//   pnpm verify drive new-web --recipe new-web-long-dialogs
//
// The recipe makes real worktrees in verify-fixture until it has 80 (no sessions, nothing
// running), opens each dialog and cancels it, and removes the worktrees it made. Clear finished
// worktrees is only opened, never confirmed: on a shared server it would remove other checks'
// worktrees. Change preview worktree needs a project that declares a fixed preview: the recipe
// rewrites the preview read to say so (the list of worktrees in it is the server's own).
//
// On a build whose dialog had no maximum height the recipe fails with "runs past the window":
// the dialog's title and its button are off the screen (verify-fixture's 67 worktrees did it in a
// 1280 × 900 window on 21 Nov).
//
// Feature ids: worktrees.md (Clear finished worktrees), services.md (the fixed preview address).
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const WORKTREES = 80;
const HOST = "verify-fixture.preview.verify.invalid";

const visible = (locator) => locator.filter({ visible: true }).first();
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

/** Where a dialog sits, whether it or its body scrolls, and where its footer ends. */
const layout = (dialog) =>
  dialog.evaluate((element) => {
    const body = element.querySelector('[data-slot="dialog-body"]');
    // The footer's buttons: not the body's, which may be scrolled out of view, nor the close
    // button in the corner.
    const buttons = [...element.querySelectorAll("button")].filter(
      (button) => button.offsetParent !== null && (body === null || !body.contains(button)),
    );
    const lowest = Math.max(...buttons.map((button) => button.getBoundingClientRect().bottom));
    const box = element.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      dialogScrolls: element.scrollHeight > element.clientHeight + 1,
      bodyScrolls: body !== null && body.scrollHeight > body.clientHeight + 1,
      lastButton: buttons.length === 0 ? null : Math.round(lowest),
      window: window.innerHeight,
    };
  });

export default async ({ page, web, capture, note }) => {
  const failures = [];
  const fail = (words) => {
    failures.push(words);
    note(`FAILED · ${words}`);
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
  const open = async (to) => {
    await page.goto(`${web}${to}`);
    await hydrated();
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const call = (route, input, kind = "query") =>
    page.evaluate(
      ({ route: name, input: value, kind: verb }) => {
        const procedure = name
          .split(".")
          .reduce((node, key) => node[key], window["__TSR_ROUTER__"].options.context.trpcClient);
        return procedure[verb](value);
      },
      { route, input, kind },
    );

  /**
   * Whether `dialog` fits the window: its box inside the viewport, `title` and the button
   * `confirm` on screen and clickable, and `list` scrolling inside it down to its last row.
   */
  const measure = async (what, dialog, title, confirm, list, rows) => {
    const viewport = page.viewportSize();
    const box = await dialog.boundingBox();
    const titleBox = await visible(dialog.getByText(title, { exact: true })).boundingBox();
    const button = visible(dialog.getByRole("button", { name: confirm, exact: true }));
    const buttonBox = await button.boundingBox();
    const inside = (b) => b !== null && b.y >= 0 && b.y + b.height <= viewport.height + 1;
    // Nothing over it. A disabled button takes no pointer, so hit-testing skips it: look as if it
    // took one (Change worktree waits for another pick).
    const reachable = await button.evaluate((element) => {
      const before = element.style.pointerEvents;
      element.style.pointerEvents = "auto";
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      element.style.pointerEvents = before;
      return hit !== null && element.contains(hit);
    });
    const scroll = await list.evaluate((element) => ({
      scrolls: element.scrollHeight > element.clientHeight + 1,
      height: element.clientHeight,
    }));
    const count = await list.locator(rows).count();
    // Every row at its full height: none squeezed to fit the list (a phone row keeps 44 px or more).
    const squeezed = await list
      .locator(rows)
      .evaluateAll(
        (all) =>
          all.filter((row) => row.scrollHeight > row.getBoundingClientRect().height + 1).length,
      );
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(200);
    const last = await list.locator(rows).last().boundingBox();
    const listBox = await list.boundingBox();
    const lastShown =
      last !== null && listBox !== null && last.y + last.height <= listBox.y + listBox.height + 1;
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    const seen = `dialog ${Math.round(box?.y ?? -1)}…${Math.round((box?.y ?? 0) + (box?.height ?? 0))} in a ${viewport.width} × ${viewport.height} window; title at ${Math.round(titleBox?.y ?? -1)}; ${confirm} at ${Math.round(buttonBox?.y ?? -1)}${reachable ? "" : " (covered)"}; ${count} rows in a list ${scroll.height} px tall${scroll.scrolls ? " that scrolls" : ""}${lastShown ? ", its last row shown once scrolled" : ""}${squeezed > 0 ? `; ${squeezed} rows squeezed` : ""}`;
    note(`${what}: ${seen}`);
    if (!inside(box) || !inside(titleBox) || !inside(buttonBox) || !reachable)
      fail(`${what} runs past the window: ${seen}`);
    // A long list: only finished worktrees are in Clear finished's, a few of the 80 aren't.
    else if (count < WORKTREES / 2 || !scroll.scrolls || !lastShown || squeezed > 0)
      fail(`${what} doesn't scroll its list inside it: ${seen}`);
  };

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const fixture = (await call("projects.list")).find((each) => each.name === "verify-fixture");
  if (fixture === undefined) throw new Error("the stack has no verify-fixture project");

  // 1. Worktrees until the project has 80.
  const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  const listed = await call("worktrees.list", { projectId: fixture.id });
  const made = [];
  for (let at = listed.worktrees.length; at < WORKTREES; at += 8) {
    const batch = Array.from({ length: Math.min(8, WORKTREES - at) }, (_, i) =>
      call(
        "worktrees.create",
        {
          projectId: fixture.id,
          worktree: { name: `long-${stamp}-${String(at + i).padStart(2, "0")}`, base: null },
        },
        "mutate",
      ),
    );
    made.push(...(await Promise.all(batch)));
  }
  note(
    `verify-fixture had ${listed.worktrees.length} worktrees; the recipe made ${made.length}, so it has ${listed.worktrees.length + made.length}`,
  );

  try {
    // 2. Clear finished worktrees…, on the project's Worktrees tab.
    for (const [width, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      await open(`/projects/${fixture.id}/worktrees`);
      await visible(page.getByRole("button", { name: "Clear finished…" })).click();
      const dialog = visible(page.getByRole("dialog", { name: "Clear finished worktrees?" }));
      await dialog.waitFor();
      await page.waitForTimeout(500);
      await measure(
        `Clear finished worktrees at ${width} width`,
        dialog,
        "Clear finished worktrees?",
        "Clear finished worktrees",
        visible(dialog.getByRole("list", { name: "Finished worktrees" })),
        "li",
      );
      await capture(`clear-finished-${width}-light`);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }

    // 3. Change preview worktree, on the project's Services settings, with a fixed preview.
    const target = made[0] ?? listed.worktrees[0];
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("previews.project")) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const answers = Array.isArray(body) ? body : [body];
      const fixed = {
        configured: true,
        fixed: {
          targetMode: "worktree",
          preview: {
            id: "pv-verify",
            serviceName: "web",
            label: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
            scope: "worktree",
            projectId: fixture.id,
            worktreeId: target.id,
            state: "kept",
          },
        },
        url: `https://${HOST}/`,
        target: { id: target.id, name: target.name, branch: target.branch },
        status: [],
        open: null,
        canManage: true,
      };
      const out = paths.map((path, index) =>
        path === "previews.project" ? { result: { data: { json: fixed } } } : answers[index],
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
      });
    });
    for (const [width, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      // A full load is drawn on the server, from the real read: move there in the page instead.
      await open("/settings/profile");
      await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
      await page.evaluate(
        (href) => window["__TSR_ROUTER__"].navigate({ href }),
        `/projects/${fixture.id}/settings/services`,
      );
      await visible(page.getByRole("heading", { name: "Services", exact: true })).waitFor();
      await visible(page.getByRole("button", { name: "Change worktree…", exact: true })).click();
      const dialog = visible(page.getByRole("dialog", { name: "Change preview worktree" }));
      await dialog.waitFor();
      await page.waitForTimeout(500);
      await measure(
        `Change preview worktree at ${width} width`,
        dialog,
        "Change preview worktree",
        "Change worktree",
        visible(dialog.getByRole("radiogroup", { name: "Worktree" })),
        "label",
      );
      await capture(`change-preview-worktree-${width}-light`);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
    await page.unroute("**/trpc/**");

    // 4. Dialogs that were fine stay as they were: a short one shows no scrollbar; a large one
    //    in a short window keeps its title and buttons and scrolls only its body.
    await page.setViewportSize(DESKTOP);
    await open(`/projects/${fixture.id}/worktrees`);
    await visible(page.getByRole("button", { name: "New worktree…", exact: true })).click();
    const short = visible(page.getByRole("dialog", { name: "New worktree" }));
    await short.waitFor();
    await page.waitForTimeout(500);
    const shortLayout = await layout(short);
    note(`New worktree…: ${JSON.stringify(shortLayout)}`);
    if (shortLayout.dialogScrolls || shortLayout.bodyScrolls)
      fail(`the short New worktree dialog scrolls: ${JSON.stringify(shortLayout)}`);
    await capture("new-worktree-desktop-light");
    await page.keyboard.press("Escape");
    await short.waitFor({ state: "hidden" });

    await page.setViewportSize({ width: 1280, height: 560 });
    await open(`/projects/${fixture.id}/settings/workspace`);
    await visible(page.getByRole("button", { name: "Edit image…", exact: true })).click();
    const large = visible(page.getByRole("dialog", { name: /^Edit verify-fixture/ }));
    await large.waitFor();
    await page.waitForTimeout(500);
    const largeLayout = await layout(large);
    note(`Edit image… in a 1280 × 560 window: ${JSON.stringify(largeLayout)}`);
    if (
      largeLayout.top < 0 ||
      largeLayout.bottom > largeLayout.window + 1 ||
      largeLayout.lastButton === null ||
      largeLayout.lastButton > largeLayout.window ||
      largeLayout.dialogScrolls
    )
      fail(`the large Edit image dialog doesn't keep its buttons: ${JSON.stringify(largeLayout)}`);
    await capture("edit-image-short-window-desktop-light");
    await page.keyboard.press("Escape");
    await large.waitFor({ state: "hidden" });
  } finally {
    // 4. The worktrees the recipe made go again.
    await page.unroute("**/trpc/**").catch(() => undefined);
    await page.setViewportSize(DESKTOP);
    for (let at = 0; at < made.length; at += 8)
      await Promise.all(
        made
          .slice(at, at + 8)
          .map((worktree) =>
            call("worktrees.remove", { id: worktree.id }, "mutate").catch(() => undefined),
          ),
      );
    note(`removed the ${made.length} worktrees the recipe made`);
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
};
