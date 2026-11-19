// The new web app's first load (SLNT-1178): a page no longer downloads the workspace views' code
// (the terminal, the diff viewer, the screen) before it draws. Each view's body is fetched when its
// tab first shows, or a moment earlier while a pointer rests on its tab or "+" item; the tile shows
// its loading line meanwhile, and never again once the code is here. A fetch that fails (Mend
// updated under an open page) leaves the tile's error with Try again. A view's own address still
// opens from a fresh load, and the pages whose address helpers moved out of the route tree still
// read their addresses. Run the Details CLI batch first, once per stack (two sessions in a
// `details-ws-<time>` worktree):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-details-sessions.json
//   pnpm verify drive new-web --recipe new-web-first-load
//
// The drive serves the app with `vite dev`, which serves each module as its own file, so the
// network log names what a page loaded: `views/terminal-view.tsx`, `ghostty-web`, `@pierre/diffs`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** What a page must not fetch before a view's tab shows: each view's body and its heavy code. */
const VIEW_CODE = [
  /\/components\/change\/change-view\.tsx/,
  /\/workspace\/views\/(checks|preview|terminal|screen|record)-view\.tsx/,
  /\/workspace\/details-view\.tsx/,
  /ghostty-web/,
  /@pierre[_/]diffs/,
  /novnc/i,
];

const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.evaluate(() => {
        const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
        if (wrapper instanceof HTMLElement) wrapper.style.maxHeight = "100dvh";
        document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove());
      });
      await page.mouse.move(2, 2);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(500);
    }
  };
  const settled = () => page.waitForTimeout(500);
  const shoot = async (name, themes = ["light", "dark"]) => {
    for (const theme of themes) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href],button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 60_000 },
    );
  };
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const tabOf = (key) => visible(page.locator(`[data-tab="${key}"]`).getByRole("tab"));
  const plus = () => visible(page.getByRole("button", { name: "Open a view" }));
  const menuItem = (name) => visible(page.getByRole("menuitem", { name: new RegExp(`^${name}`) }));

  // Every script the page fetched, from the moment it is cleared.
  let fetched = [];
  page.on("request", (request) => {
    if (["script", "fetch", "other"].includes(request.resourceType())) fetched.push(request.url());
  });
  const viewCodeFetched = () =>
    fetched.filter((url) => VIEW_CODE.some((pattern) => pattern.test(decodeURIComponent(url))));

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await page.goto(`${web}/no-such-page`);
  await hydrated();

  const rows = await call("sessions.inbox");
  const live = rows.filter(
    (row) =>
      /^details-ws-\d+$/.test(row.worktreeName ?? "") &&
      !["completed", "stopped", "failed"].includes(row.session.status),
  );
  const worktree = live
    .map((row) => row.worktreeName)
    .toSorted()
    .at(-1);
  const session = live.find((row) => row.worktreeName === worktree)?.session;
  if (session === undefined)
    throw new Error("no running details-ws session: run new-web-details-sessions.json first");
  note(`session ${session.id} in ${worktree}`);

  // 1. The sign-in page, the inbox and a session page load no view's code. A fresh load of each.
  for (const [name, path] of [
    ["inbox", "/"],
    ["session", `/sessions/${session.id}`],
  ]) {
    fetched = [];
    await page.goto(`${web}${path}`);
    await hydrated();
    await settled();
    const loaded = viewCodeFetched();
    note(`${name} page (${path}): ${fetched.length} requests, view code fetched: ${loaded.length}`);
    if (loaded.length > 0) throw new Error(`${name} page fetched view code: ${loaded.join(", ")}`);
  }
  await shoot("session-page-no-view-code");

  // 2. Resting the pointer on Terminal in the tile's "+" fetches its code; opening it shows the
  //    tile's loading line while it arrives (held back 2 s here), then the terminal.
  const gate = Promise.withResolvers();
  await page.route(/\/workspace\/views\/terminal-view\.tsx/, async (route) => {
    await gate.promise;
    await route.continue();
  });
  fetched = [];
  await plus().click();
  await menuItem("Terminal").hover();
  await page.waitForTimeout(300);
  const onHover = viewCodeFetched().filter((url) => url.includes("terminal-view"));
  note(`hovering Terminal in "+" fetched its code: ${onHover.length > 0}`);
  if (onHover.length === 0) throw new Error("hovering Terminal didn't start fetching its code");
  await menuItem("Terminal").click();
  await visible(page.getByText("Opening Terminal…")).waitFor({ timeout: 10_000 });
  note("Terminal's tile says Opening Terminal… while its code is held back");
  await capture("terminal-opening-light");
  gate.resolve();
  await page.unroute(/\/workspace\/views\/terminal-view\.tsx/);
  await page.getByText("Opening Terminal…").first().waitFor({ state: "detached", timeout: 30_000 });
  const terminalWords = (
    await visible(page.locator("[data-tile]").filter({ has: tabOf("view:terminal") })).innerText()
  )
    .replace(/\s+/g, " ")
    .slice(0, 160);
  note(`Terminal's body: ${terminalWords}`);
  await capture("terminal-shown-light");

  // 3. Back to the conversation and to Terminal again: no loading line, not even for a frame.
  await page.evaluate(() => {
    window["__openingSeen"] = [];
    new MutationObserver(() => {
      for (const element of document.querySelectorAll("[role=status]"))
        if ((element.textContent ?? "").startsWith("Opening "))
          window["__openingSeen"].push(element.textContent);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await tabOf(`session:${session.id}`).click();
  await settled();
  await tabOf("view:terminal").click();
  await settled();
  const flashed = await page.evaluate(() => window["__openingSeen"]);
  note(`Terminal shown again: loading lines seen ${JSON.stringify(flashed)}`);
  if (flashed.length > 0) throw new Error("a view already loaded showed its loading line again");

  // 4. A view whose code doesn't arrive: the tile's error with Try again, which fetches it again.
  await page.route(/\/workspace\/views\/record-view\.tsx/, (route) => route.abort("failed"));
  await plus().click();
  await menuItem("Record").click();
  await visible(page.getByText("This didn't load.")).waitFor({ timeout: 20_000 });
  const failure = (await visible(page.getByRole("alert")).innerText()).replace(/\s+/g, " ");
  note(`Record with its code blocked: ${failure}`);
  await shoot("record-code-failed");
  await page.unroute(/\/workspace\/views\/record-view\.tsx/);
  await visible(page.getByRole("button", { name: "Try again" })).click();
  const recordBack = await visible(page.getByText(/newest first/))
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  note(`Try again with the code reachable shows the Record: ${recordBack}`);
  if (!recordBack) throw new Error("Try again didn't fetch the Record view's code again");
  await capture("record-after-try-again-light");

  // 5. A view's own address from a fresh load: the server draws the page, the Details tab focused
  //    and its body there; a name that is no view is not found.
  const html = await (await page.request.get(`${web}/sessions/${session.id}/details`)).text();
  note(
    `server render of /details holds the Details tab: ${html.includes('data-tab="view:details"')}`,
  );
  await page.goto(`${web}/sessions/${session.id}/details`);
  await hydrated();
  await visible(page.getByRole("region", { name: "Workspace", exact: true })).waitFor({
    timeout: 30_000,
  });
  note("/details on a fresh load shows the Details view's Workspace group");
  await shoot("details-direct-address");
  await page.setViewportSize(PHONE);
  await settled();
  await capture("details-direct-address-phone-light");
  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/sessions/${session.id}/nope`);
  await hydrated();
  await visible(page.getByText("Page not found")).waitFor({ timeout: 20_000 });
  note("/sessions/<id>/nope says Page not found");
  await capture("view-not-found-light");

  // 6. The addresses whose helpers moved out of the route tree read as before.
  await page.goto(`${web}/sessions/${session.id}#checkpoint-1`);
  await hydrated();
  await page.waitForURL(/\/record#checkpoint-1$/, { timeout: 20_000 });
  await visible(page.getByText(/checkpoint 1/)).waitFor({ timeout: 20_000 });
  note(`#checkpoint-1 lands on ${new URL(page.url()).pathname}${new URL(page.url()).hash}`);
  await capture("checkpoint-link-light");

  const project = (await call("projects.list")).find((entry) => entry.name === "verify-fixture");
  await page.goto(`${web}/projects/${project.id}?q=details&who=mine`);
  await hydrated();
  const searchField = visible(page.getByRole("searchbox"));
  await searchField.waitFor({ timeout: 20_000 });
  note(
    `the project's Sessions tab keeps ?q=details: field reads "${await searchField.inputValue()}"`,
  );
  await capture("project-sessions-search-light");

  const name = `first-load-${Date.now().toString(36)}`;
  const skill = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name,
      description: "A skill the first-load recipe opens.",
      files: [
        {
          path: "SKILL.md",
          contents: `---\nname: ${name}\ndescription: A skill the first-load recipe opens.\n---\n\n# Notes\n`,
        },
        { path: "notes.md", contents: "# Notes\n" },
      ],
    },
    "mutate",
  );
  try {
    await page.goto(`${web}/skills/${skill.id}?file=notes.md&edit=1`);
    await hydrated();
    await visible(page.getByRole("button", { name: /^Save/ })).waitFor({ timeout: 20_000 });
    note("/skills/<id>?file=notes.md&edit=1 opens the editor");
    await capture("skill-edit-address-light");
  } finally {
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  }

  await page.context().clearCookies();
  for (const [what, path] of [
    ["invitation", "/join#not-a-real-invitation"],
    ["Slack link", "/slack/link#not-a-real-code"],
  ]) {
    await page.goto(`${web}${path}`);
    await page.waitForTimeout(2_000);
    note(
      `${what} page ${path}: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
    );
    await capture(`${what === "invitation" ? "join" : "slack-link"}-handed-secret-light`);
  }
  await go("/");
};
