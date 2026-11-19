// A project's Services settings page in the new web app (route PR 54, SLNT-1171):
// `/projects/<id>/settings/services`, the default branch's `.mend/mend.toml` shown read-only, and
// the fixed preview address with Change worktree….
//
//   pnpm verify drive new-web --recipe new-web-project-services
//
// Feature ids: mend-toml.md (the file's Services, read-only; `toml-project-recipes` and
// `toml-shadowed` dropped by ruling D8), services.md (the fixed preview address).
//
// What is real and what is rewritten:
// - Real: verify-fixture's page as its owner, its `.mend/mend.toml` as the default branch holds it
//   (or the empty state when it has none), the banner, the preview line for a project whose file
//   names no fixed preview; a project the recipe makes with no repository (the empty state); two
//   worktrees the recipe makes in verify-fixture, each with a named session, which the dialog lists;
//   the phone layout; a read that fails, and Try again.
// - Rewritten in the page: the fixed preview read (a stack's fixture declares no `[preview]
//   fixed = true` and has no preview site), so the address, the worktree it shows and Change
//   worktree… can be seen; the move itself (`previews.use`) answers as the server would.
//
// The recipe removes the worktrees and the project it made, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOST = "verify-fixture.preview.verify.invalid";

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
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
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const clearCache = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: name, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of name.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const text = (words) => visible(page.getByText(words, { exact: true }));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const toastSays = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words)).waitFor();
  /** Answers each tRPC call named in `answers` with what its function returns, in a batch or not. */
  const rewrite = (answers) =>
    page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.some((path) => path in answers)) return route.continue();
      const others = paths.filter((path) => !(path in answers));
      let fetched = [];
      if (others.length > 0) {
        const response = await route.fetch();
        const body = await response.json();
        fetched = Array.isArray(body) ? body : [body];
      }
      const body = paths.map((path, index) =>
        path in answers ? { result: { data: { json: answers[path]() } } } : fetched[index],
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(route.request().url().includes("batch=1") ? body : body[0]),
      });
    });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const projects = await call("projects.list");
  const fixture = projects.find((project) => project.name === "verify-fixture");
  expect(
    "the stack's verify-fixture project",
    fixture !== undefined,
    projects.map((p) => p.name),
  );
  const servicesPage = `/projects/${fixture.id}/settings/services`;
  const suffix = Math.random().toString(36).slice(2, 6);

  // Worktrees and a project an earlier run left go first.
  const detail0 = await call("projects.detail", { id: fixture.id });
  for (const left of detail0.worktrees.filter((w) => /^svc-[ab]-[a-z0-9]{4}$/.test(w.name)))
    await call("worktrees.remove", { id: left.id, force: true }, "mutate").catch(() => undefined);
  for (const left of projects.filter((p) => /^services-[a-z0-9]{4}$/.test(p.name)))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);

  const made = [];
  let empty = null;
  try {
    // --- The page as verify-fixture's owner: the file, the banner, the preview line ----------
    await open(servicesPage);
    await heading("Services");
    await text(`Everyone who can open ${fixture.name}`).waitFor();
    await visible(page.getByText("Read-only here.")).waitFor();
    const file = await call("projects.mendToml", { id: fixture.id });
    if (file === null) {
      await visible(
        page.getByText("A branch without .mend/mend.toml starts no services."),
      ).waitFor();
      note(`${fixture.name}'s default branch has no .mend/mend.toml: the page says so`);
    } else {
      const shown = await visible(page.getByLabel(file.path, { exact: true })).innerText();
      expect(
        "the file as the branch holds it",
        shown.includes(file.contents.split("\n")[0]),
        shown,
      );
      note(
        `${fixture.name}: ${file.path} on ${fixture.defaultBranch} shown read-only (${file.size} bytes)`,
      );
    }
    const preview = await call("previews.project", { id: fixture.id });
    note(
      `the real preview read: configured ${preview.configured}, url ${preview.url}, canManage ${preview.canManage}`,
    );
    await shot("project-services-desktop-light");
    await paint("dark");
    await shot("project-services-desktop-dark");
    await paint("light");

    // --- A project with no repository: no file --------------------------------------------------
    empty = await call("projects.createNew", { name: `services-${suffix}` }, "mutate");
    await navigate(`/projects/${empty.id}/settings/services`);
    await heading("Services");
    await visible(page.getByText("A branch without .mend/mend.toml starts no services.")).waitFor();
    note(`services-${suffix} (no repository): "main has no .mend/mend.toml" and what that means`);
    await shot("project-services-no-file-desktop-light");

    // --- Two worktrees with named sessions, for the dialog --------------------------------------
    for (const [letter, label] of [
      ["a", "Fix flaky checkout retry"],
      ["b", "Add idempotency keys to refunds"],
    ]) {
      const worktree = await call(
        "worktrees.create",
        { projectId: fixture.id, worktree: { name: `svc-${letter}-${suffix}`, base: null } },
        "mutate",
      );
      made.push(worktree);
      await call(
        "worktrees.createSession",
        { id: worktree.id, session: { harness: "shell", label } },
        "mutate",
      );
    }
    const [first, second] = made;
    note(
      `made worktrees ${made.map((w) => w.name).join(", ")} in ${fixture.name}, each with a named session`,
    );

    // --- The fixed preview (rewritten): shows the first worktree; move it to the second --------
    let target = first;
    const fixed = () => ({
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
    });
    await rewrite({
      "previews.project": fixed,
      "previews.use": () => {
        target = second;
        return fixed();
      },
    });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(servicesPage);
    await heading("Services");
    await visible(
      page.getByText(`${HOST} always shows web from the worktree of "Fix flaky checkout retry".`, {
        exact: false,
      }),
    ).waitFor();
    note(
      `fixed preview (rewritten read): "${HOST} always shows web from the worktree of "Fix flaky checkout retry"."`,
    );
    await button("Change worktree…").click();
    const dialog = visible(page.getByRole("dialog", { name: "Change preview worktree" }));
    await dialog.getByText("Current", { exact: false }).waitFor();
    const rows = await dialog.getByRole("radio").count();
    expect("the dialog lists the worktrees and the default branch", rows >= 3, rows);
    await dialog.getByText("Default branch", { exact: true }).waitFor();
    note(
      `Change worktree… lists ${rows} choices: the project's worktrees, the current one marked, and Default branch`,
    );
    await shot("project-services-change-desktop-light");
    await dialog.getByText("Add idempotency keys to refunds", { exact: true }).click();
    await dialog.getByRole("button", { name: "Change worktree", exact: true }).click();
    await toastSays('The preview address now shows "Add idempotency keys to refunds".');
    await visible(
      page.getByText(`from the worktree of "Add idempotency keys to refunds".`, { exact: false }),
    ).waitFor();
    note("Change worktree moves it: the toast, and the line names the new worktree");
    await shot("project-services-changed-desktop-light");

    // --- The phone ------------------------------------------------------------------------------
    await page.setViewportSize(PHONE);
    await open(servicesPage);
    await visible(page.getByRole("heading", { name: "Services" })).waitFor();
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`project-services-phone-${theme}`);
    }
    await paint("light");
    await button("Change worktree…").click();
    await visible(page.getByRole("dialog", { name: "Change preview worktree" })).waitFor();
    note("on a phone, Change worktree… opens a sheet");
    await shot("project-services-change-phone-light");
    await page.keyboard.press("Escape");
    await page.unroute("**/trpc/**");
    await page.setViewportSize(DESKTOP);

    // --- A read that fails ----------------------------------------------------------------------
    await open("/settings/profile");
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("projects.mendToml")) return route.continue();
      const failure = {
        error: {
          json: {
            message: "The verify recipe failed this read on purpose.",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
      const response = await route.fetch();
      const answers = await response.json();
      const list = Array.isArray(answers) ? answers : [answers];
      const changed = paths.map((p, index) => (p === "projects.mendToml" ? failure : list[index]));
      await route.fulfill({
        status: paths.length === 1 ? 500 : 207,
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });
    await clearCache();
    await navigate(servicesPage);
    await heading("This page didn't load");
    note("the file's read failing shows the error screen with Try again");
    await shot("project-services-error-desktop-light");
    await page.unroute("**/trpc/**");
    await button("Try again").click();
    await heading("Services");
    note("Try again reads again and Services draws");
  } finally {
    await page.unroute("**/trpc/**").catch(() => undefined);
    for (const worktree of made)
      await call("worktrees.remove", { id: worktree.id, force: true }, "mutate").catch(
        () => undefined,
      );
    if (empty !== null)
      await call("projects.remove", { id: empty.id }, "mutate").catch(() => undefined);
    note("removed the worktrees and the project the recipe made");
  }
};
