// A project's Resources tab in the web app (route PR 30, SLNT-1148), on verify-fixture: no
// resources yet; Add a resource… writes a Postgres table into a worktree's .mend/mend.toml; Start
// from that worktree as the project's resource; how each worktree uses it (Shared, Own, Off); Load
// data… from a dump file; Stop and Start; Remove… keeps the volumes; the New session composer's
// resource line; the phone width; and the 2px desktop overflow, gone.
//
//   pnpm verify drive web --recipe resources
//
// ADR 0019's stories, as the tab shows them: `resources-list` (one panel per resource, each
// worktree's choice), `resources-add` (the table written into a worktree, starting nothing),
// `resources-start-stop` (Start reads a worktree's file, at project or worktree level; Stop holds),
// `resources-start-failed` (a failed start says why, with Start again), `resources-load` (a dump
// replaces the database's data after Mend saves it), `resources-remove` (the container goes, the
// volumes stay), `resources-none`, `resources-composer-line`, `resources-new-worktrees` (the
// project switch). A failed start and a load caught half-way are rewritten answers: a stack makes
// neither on demand. Everything else is the stack's own.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
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
  /** The driver withholds a picture when the page changes while it is taken: wait for a quiet second. */
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  /** The document is exactly the window: nothing scrolls the page itself. */
  const fits = () =>
    page.evaluate(() => ({
      scroll: document.scrollingElement?.scrollHeight ?? 0,
      window: window.innerHeight,
    }));
  const both = async (name) => {
    // Hovering what was last clicked changes the page under the driver's check: park the mouse.
    await page.mouse.move(1, 1);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await still();
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
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const dialog = () => visible(page.getByRole("dialog"));
  const toast = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words));
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: at, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of at.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 2) {
      const answer = await check();
      if (answer !== null && answer !== undefined && answer !== false) return answer;
      await page.waitForTimeout(2_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };

  /**
   * Rewrites the project's `resources.list` answers while a state is captured: `patch` gets each
   * answer's json and returns the new one. tRPC batches calls, so only that call's slot changes.
   */
  const rewriteList = async (patch) => {
    await page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      if (!calls.includes("resources.list")) return route.continue();
      const answer = await route.fetch();
      const body = await answer.json();
      const slots = Array.isArray(body) ? body : [body];
      calls.forEach((path, index) => {
        const json = slots[index]?.result?.data?.json;
        if (path === "resources.list" && json !== undefined)
          slots[index].result.data.json = patch(json);
      });
      return route.fulfill({ response: answer, json: Array.isArray(body) ? slots : slots[0] });
    });
    await page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
    );
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/projects");
  const fixture = (await call("projects.list")).find((entry) => entry.name === "verify-fixture");
  if (fixture === undefined) throw new Error("no project verify-fixture on this stack");
  const tab = `/projects/${fixture.id}/resources`;
  const suffix = Math.random().toString(36).slice(2, 6);
  const name = `vdb${suffix}`;

  // Two worktrees: one the table is written into and started from, one that only uses it.
  // What an earlier run left when it stopped partway goes first: its resources, shells, worktrees.
  const LEFT = /^res-[ab]-[a-z0-9]{4}$/;
  const left = await call("resources.list", {
    projectId: fixture.id,
    timeZone: zone,
    worktreeId: null,
    allInstances: true,
  });
  for (const entry of left.settings)
    if (/^vdb[a-z0-9]{4}$/.test(entry.spec.name))
      await call(
        "resources.remove",
        {
          projectId: fixture.id,
          name: entry.spec.name,
          level: entry.level,
          worktreeId: entry.worktreeId,
        },
        "mutate",
      ).catch(() => undefined);
  const earlier = await call("projects.detail", { id: fixture.id });
  for (const worktree of earlier.worktrees)
    if (LEFT.test(worktree.name)) {
      for (const session of earlier.sessions)
        if (session.worktreeId === worktree.id)
          await call("sessions.stop", { id: session.id }, "mutate").catch(() => undefined);
      // A stopped session saves before its worktree can go: try until it has gone.
      await waitFor(
        `${worktree.name} removed`,
        async () => {
          await call("worktrees.remove", { id: worktree.id, force: true }, "mutate").catch(
            () => undefined,
          );
          return !(await call("projects.detail", { id: fixture.id })).worktrees.some(
            (each) => each.id === worktree.id,
          );
        },
        180,
      );
    }
  const a = await call(
    "worktrees.create",
    { projectId: fixture.id, worktree: { name: `res-a-${suffix}`, base: null } },
    "mutate",
  );
  const b = await call(
    "worktrees.create",
    { projectId: fixture.id, worktree: { name: `res-b-${suffix}`, base: null } },
    "mutate",
  );
  // Add writes into a worktree's live files: a shell keeps res-a's workspace up for the drive.
  const shell = await call(
    "worktrees.createSession",
    { id: a.id, session: { harness: "shell", label: null } },
    "mutate",
  );
  await call("sessions.launch", { id: shell.id, request: {} }, "mutate");
  await waitFor(
    `the shell in ${a.name} running`,
    async () =>
      (await call("projects.detail", { id: fixture.id })).sessions.find(
        (session) => session.id === shell.id,
      )?.status === "running",
    180,
  );
  note(`made worktrees ${a.name} and ${b.name} in verify-fixture; a shell runs in ${a.name}`);

  // The tab, from the project's tabs. What verify-fixture declares decides what shows first.
  await go(`/projects/${fixture.id}`);
  const nav = page.getByRole("navigation", { name: "verify-fixture project" }).first();
  await nav.getByRole("link", { name: /^Resources/ }).click();
  await page.waitForURL(`**${tab}`);
  const before = await call("resources.list", {
    projectId: fixture.id,
    timeZone: zone,
    worktreeId: null,
    allInstances: true,
  });
  if (
    before.settings.length === 0 &&
    (before.file.kind !== "read" || before.file.tables.length === 0)
  ) {
    await page.getByRole("heading", { name: "No resources yet" }).waitFor();
    await both("none-desktop");
    await page.setViewportSize(PHONE);
    await settled();
    await both("none-phone");
    await page.setViewportSize(DESKTOP);
    note(
      `resources-none: ${await visible(page.getByRole("heading", { name: "No resources yet" })).innerText()}, with Add a resource…`,
    );
  } else
    note(`verify-fixture already lists ${before.settings.length} instance(s); no empty state here`);

  // resources-add: Postgres, written into res-a's .mend/mend.toml.
  await button("Add a resource…").click();
  await dialog().getByRole("heading", { name: "Add a resource" }).waitFor();
  await dialog().getByRole("combobox", { name: "Write into" }).selectOption({ label: a.name });
  await dialog().getByRole("textbox", { name: "Name" }).fill(name);
  await dialog().getByLabel("The table Mend writes").getByText(`[resource.${name}]`).waitFor();
  await both("add-desktop");
  const table = await dialog().getByLabel("The table Mend writes").innerText();
  await dialog().getByRole("button", { name: "Write to mend.toml" }).click();
  await toast(new RegExp(`^Wrote @${name} into .*${a.name}\\.$`)).waitFor({ timeout: 60_000 });
  note(`resources-add: wrote into ${a.name}:\n${table}`);
  const declared = visible(page.getByRole("list", { name: "Declared only in a worktree" }));
  await declared.getByText(`@${name}`).waitFor({ timeout: 30_000 });
  note(
    `resources-add: nothing started; the tab reads "${(await declared.innerText()).replace(/\s+/g, " ")}"`,
  );

  // resources-start-stop: Start as the project's resource, from res-a.
  await declared.getByRole("button", { name: `Start @${name}` }).click();
  await visible(
    page.getByRole("menuitem", { name: new RegExp(`^${a.name}\\s*project`) }),
  ).waitFor();
  await both("start-menu-desktop");
  await visible(page.getByRole("menuitem", { name: new RegExp(`^${a.name}\\s*project`) })).click();
  const panel = visible(page.getByRole("region", { name: `@${name}` }));
  // The first start pulls postgres:17: give it time.
  await panel.getByText("Running", { exact: true }).waitFor({ timeout: 300_000 });
  const uses = (worktree) =>
    panel
      .getByRole("radiogroup", { name: `How ${worktree} uses @${name}` })
      .or(panel.getByRole("group", { name: `How ${worktree} uses @${name}` }));
  await visible(uses(b.name)).waitFor();
  const count = (await nav.getByRole("link", { name: /^Resources/ }).innerText()).replace(
    /\s+/g,
    " ",
  );
  note(`resources-list: the tab reads "${count}" once @${name} runs`);
  await both("list-desktop");
  note(`resources-list: the panel reads "${(await panel.innerText()).replace(/\s+/g, " ")}"`);

  // resources-list: res-a turns its database off, then back to Shared. Only the owner of a
  // worktree's change chooses for it: res-b has no session yet, so nobody owns it and its choice
  // is read-only.
  await visible(uses(a.name)).getByRole("button", { name: "Off" }).click();
  await waitFor(
    `${a.name} off`,
    async () =>
      (
        await call("resources.list", { projectId: fixture.id, timeZone: zone, worktreeId: a.id })
      ).settings.find((entry) => entry.spec.name === name)?.choice === "off",
    30,
  );
  await visible(panel.getByText("No database")).waitFor();
  if (!(await visible(uses(b.name)).getByRole("button", { name: "Off" }).isDisabled()))
    throw new Error(`${b.name}, with no change owner, offers a choice`);
  // The choice is the server's: it is still there after a reload.
  await open(tab);
  await visible(panel.getByText("No database")).waitFor({ timeout: 30_000 });
  await both("off-desktop");
  await visible(uses(a.name)).getByRole("button", { name: "Shared" }).click();
  await visible(panel.getByText("No database")).waitFor({ state: "detached" });
  note(
    `resources-list: ${a.name} chose Off ("No database"), then Shared again; the server stored each`,
  );

  // resources-load: a plain SQL dump into the shared database.
  await panel.getByRole("button", { name: "Load data…" }).click();
  await dialog()
    .getByRole("heading", { name: `Load data into @${name}` })
    .waitFor();
  await dialog()
    .getByLabel("Dump file")
    .setInputFiles({
      name: "verify-seed.sql",
      mimeType: "application/sql",
      buffer: Buffer.from(
        "CREATE TABLE verify_seed (id integer PRIMARY KEY, word text);\nINSERT INTO verify_seed VALUES (1, 'resources');\n",
      ),
    });
  await dialog().getByText("verify-seed.sql").waitFor();
  await both("load-desktop");
  // While this route is in place each read of the load answers as a load under way, for the
  // capture; the page reads it every second, so the real end arrives once it goes.
  await page.route("**/api/projects/*/resource-loads/*?*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const answer = await route.fetch();
    const live = await answer.json();
    return route.fulfill({
      response: answer,
      json: {
        ...live,
        phase: "restoring",
        bytesDone: 21_000_000,
        bytesTotal: 38_000_000,
        statusLine: `@${name} · loading checkout-staging.dump · restoring 21 MB of 38 MB · shared database`,
      },
    });
  });
  await dialog().getByRole("button", { name: "Load data" }).click();
  await panel.getByText("Loading data", { exact: true }).waitFor({ timeout: 30_000 });
  await panel.getByRole("progressbar").waitFor({ timeout: 30_000 });
  await both("loading-desktop");
  note(
    `resources-load, under way (a held answer): "${(await panel.getByRole("status").first().innerText()).replace(/\s+/g, " ")}"`,
  );
  await page.unroute("**/api/projects/*/resource-loads/*?*");
  await page.getByText(/loaded .* from verify-seed\.sql/).waitFor({ timeout: 120_000 });
  note(
    `resources-load, done: "${await visible(page.getByText(/loaded .* from verify-seed\.sql/)).innerText()}"`,
  );

  // resources-start-stop: Stop holds until someone starts it.
  await panel.getByRole("button", { name: "Stop", exact: true }).first().click();
  await panel.getByText("Stopped", { exact: true }).waitFor({ timeout: 120_000 });
  await both("stopped-desktop");
  note(
    `resources-start-stop: Stop → "${(await panel.innerText()).split("\n").slice(0, 3).join(" ")}"`,
  );

  // resources-start-failed: the server's answer for a start that failed, rewritten on this read.
  await rewriteList((json) => ({
    ...json,
    settings: json.settings.map((entry) =>
      entry.spec.name === name
        ? {
            ...entry,
            instance: "failed",
            statusLine: `@${name} · postgres:17 · failed · Postgres exited with code 1: it couldn't bind to port 5432 · project · observed 2 s ago`,
          }
        : entry,
    ),
  }));
  await panel.getByText(`@${name} didn't start.`).waitFor({ timeout: 30_000 });
  await both("failed-desktop");
  note(
    `resources-start-failed (rewritten answer): "${(await panel.getByRole("alert").first().innerText()).replace(/\s+/g, " ")}"`,
  );
  await page.setViewportSize(PHONE);
  await settled();
  await both("failed-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries(),
  );
  await panel.getByText("Stopped", { exact: true }).waitFor({ timeout: 30_000 });

  // Start it again, from res-a, as the project's resource.
  await panel.getByRole("button", { name: `Start @${name}` }).click();
  await visible(page.getByRole("menuitem", { name: new RegExp(`^${a.name}\\s*project`) })).click();
  await panel.getByText("Running", { exact: true }).waitFor({ timeout: 180_000 });
  note("resources-start-stop: Start from the menu brought it back: Running");

  // resources-composer-line: the home composer, with res-a picked.
  await go("/");
  await page.getByRole("heading", { name: "New session" }).first().waitFor();
  await visible(page.getByRole("button", { name: /^Project: / })).click();
  await visible(
    page
      .getByRole("option", { name: /verify-fixture/ })
      .or(page.getByRole("menuitemradio", { name: /verify-fixture/ })),
  ).click();
  await settled();
  await visible(page.getByRole("button", { name: /^Worktree: / })).click();
  await visible(page.getByText(`mend/${a.name}`, { exact: false })).click();
  const line = visible(page.locator("[data-slot=composer-resources]"));
  await line.getByText(`@${name} shared database`).waitFor({ timeout: 30_000 });
  await both("composer-desktop");
  await line.getByRole("button", { name: "change" }).click();
  await line.getByRole("group", { name: `How this worktree uses @${name}` }).waitFor();
  await both("composer-change-desktop");
  note(`resources-composer-line: "${(await line.innerText()).replace(/\s+/g, " ")}"`);
  const home = await fits();
  note(`2px overflow, home: the document is ${home.scroll}px for a ${home.window}px window`);
  if (home.scroll > home.window) throw new Error("the home page scrolls");

  // The phone: the list, the start sheet, Load data as a sheet.
  await go(tab);
  await page.setViewportSize(PHONE);
  await settled();
  await panel.getByText("Running", { exact: true }).waitFor();
  await both("list-phone");
  await panel.getByRole("button", { name: "Load data…" }).click();
  await dialog()
    .getByRole("heading", { name: `Load data into @${name}` })
    .waitFor();
  await both("load-phone");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.setViewportSize(DESKTOP);
  await settled();
  const project = await fits();
  note(
    `2px overflow, project page: the document is ${project.scroll}px for a ${project.window}px window`,
  );
  if (project.scroll > project.window) throw new Error("the project page scrolls");

  // resources-remove: the project's instance goes, its volumes stay.
  await panel.getByRole("button", { name: "Remove…" }).click();
  await dialog()
    .getByRole("heading", { name: `Remove the project's @${name}?` })
    .waitFor();
  await both("remove-desktop");
  note(`resources-remove: "${(await dialog().innerText()).replace(/\s+/g, " ")}"`);
  await dialog()
    .getByRole("button", { name: `Remove @${name}` })
    .click();
  await toast(new RegExp(`@${name} · project · archived · volumes kept`)).waitFor({
    timeout: 120_000,
  });
  // The table is in res-a's file, not on the default branch, so @name is listed as declared
  // there again, with what the removal kept.
  await visible(page.getByText("Removed, volumes kept")).waitFor();
  await visible(
    page.getByText(`Until someone starts @${name} again, no worktree has it.`),
  ).waitFor();

  await both("removed-desktop");
  note(
    `resources-remove: the toast and the tab read "${(await visible(page.getByRole("region", { name: "Resources" })).innerText()).replace(/\s+/g, " ").slice(0, 400)}"`,
  );

  // resources-new-worktrees: the project switch, off and on again.
  const toggle = visible(page.getByRole("switch", { name: "New worktrees use project resources" }));
  if ((await toggle.count()) > 0) {
    const was = (await toggle.getAttribute("aria-checked")) === "true";
    await toggle.click();
    await waitFor(
      "the switch to save",
      async () =>
        (await call("projects.detail", { id: fixture.id })).project
          .newWorktreesUseProjectResources !== was,
      30,
    );
    await toggle.click();
    await waitFor(
      "the switch to save back",
      async () =>
        (await call("projects.detail", { id: fixture.id })).project
          .newWorktreesUseProjectResources === was,
      30,
    );
    note(`resources-new-worktrees: turned ${was ? "off" : "on"} and back; the project stored each`);
  }

  // A session page, for the overflow.
  const session = (await call("projects.detail", { id: fixture.id })).sessions[0];
  if (session !== undefined) {
    await go(`/sessions/${session.id}`);
    await page.waitForTimeout(3_000);
    const sheet = await fits();
    note(
      `2px overflow, session page: the document is ${sheet.scroll}px for a ${sheet.window}px window`,
    );
    if (sheet.scroll > sheet.window) throw new Error("the session page scrolls");
  } else note("2px overflow, session page: verify-fixture has no session to open");

  // Resources that fail to load, while the project still reads.
  await go(tab);
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!calls.includes("resources.list")) return route.continue();
    const answer = await route.fetch();
    const body = await answer.json();
    const slots = Array.isArray(body) ? body : [body];
    calls.forEach((path, index) => {
      if (path === "resources.list")
        slots[index] = {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
    });
    return route.fulfill({ response: answer, json: Array.isArray(body) ? slots : slots[0] });
  });
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.resetQueries());
  await page.getByText("Resources didn't load.").waitFor({ timeout: 30_000 });
  await both("error-desktop");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await visible(
    page
      .getByRole("region", { name: "Resources" })
      .or(page.getByRole("heading", { name: "No resources yet" })),
  ).waitFor();
  note("a failed read shows Resources didn't load. with Try again, which reads it again");

  // Put back what this drive changed: the worktrees go, with the table written into res-a.
  await call("sessions.stop", { id: shell.id }, "mutate").catch(() => undefined);
  for (const worktree of [a, b])
    await waitFor(
      `${worktree.name} removed`,
      async () => {
        await call("worktrees.remove", { id: worktree.id, force: true }, "mutate").catch(
          () => undefined,
        );
        return !(await call("projects.detail", { id: fixture.id })).worktrees.some(
          (each) => each.id === worktree.id,
        );
      },
      180,
    );
  note(
    `removed ${a.name} and ${b.name}; @${name}'s project instance was removed above, its volumes kept`,
  );
};
