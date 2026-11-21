// A project's Services settings page in the web app (route PR 54, SLNT-1171):
// `/projects/<id>/settings/services`, the default branch's `.mend/mend.toml` shown read-only, and
// the fixed preview address with Change worktree….
//
//   pnpm verify drive web --recipe project-services
//
// Feature ids: mend-toml.md (the file's Services, read-only; `toml-project-recipes` and
// `toml-shadowed` dropped by ruling D8), services.md (the fixed preview address).
//
// What is real and what is rewritten:
// - Real: verify-fixture's page as its owner, its `.mend/mend.toml` as the default branch holds it
//   (or the empty state when it has none), the banner, the preview line for a project whose file
//   names no fixed preview (no button); a project the recipe makes with no repository (the empty
//   state); two worktrees the recipe makes in verify-fixture, each with a named session, which the
//   dialog lists; the phone layout; a read that fails, and Try again.
// - Rewritten in the page: the file, when the fixture has none (a sample with Services and a
//   fixed preview); the fixed preview read (a stack's fixture declares no `[preview] fixed = true`
//   and has no preview site), so the address, the worktree it shows and Change worktree… can be
//   seen; the move (`previews.use`), refused once in the server's shape, then answered as the
//   server would; the read with `canManage` false, for someone who can't move it.
//
// The recipe removes the worktrees and the project it made, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOST = "verify-fixture.preview.verify.invalid";
/** A default branch's mend.toml, for a stack whose fixture has none. */
const SAMPLE = {
  path: ".mend/mend.toml",
  at: null,
  contents: [
    "[service.web]",
    'command = "pnpm dev"',
    "port = 3000",
    'browserScheme = "http"',
    "",
    "[service.worker]",
    'command = "pnpm --filter worker start"',
    "",
    "[preview]",
    'service = "web"',
    "fixed = true",
    "",
  ].join("\n"),
  size: 160,
  truncated: false,
  binary: false,
};
/** How the server refuses a move it can't make (ProjectPreviewRefused, 409). */
const REFUSAL = {
  message: "That worktree has no web Service to show. Start a session in it first.",
  code: -32009,
  data: { code: "CONFLICT", httpStatus: 409, path: "previews.use", tag: "ProjectPreviewRefused" },
};

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
      let refused = false;
      const body = paths.map((path, index) => {
        if (!(path in answers)) return fetched[index];
        const answer = answers[path]();
        if (answer?.refused === undefined) return { result: { data: { json: answer } } };
        refused = true;
        return { error: { json: answer.refused } };
      });
      await route.fulfill({
        status: refused ? (body.length === 1 ? 409 : 207) : 200,
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
  /** A worktree the recipe made goes with its never-launched session: stopped, removed, then it. */
  const clear = async (worktreeId) => {
    const detail = await call("projects.detail", { id: fixture.id });
    for (const session of detail.sessions.filter((each) => each.worktreeId === worktreeId)) {
      await call("sessions.stop", { id: session.id }, "mutate").catch(() => undefined);
      await call("sessions.remove", { id: session.id }, "mutate").catch(() => undefined);
    }
    await call("worktrees.remove", { id: worktreeId, force: true }, "mutate").catch(
      () => undefined,
    );
  };
  const leftovers = detail0.worktrees.filter((w) => /^svc-[ab]-[a-z0-9]{4}$/.test(w.name));
  for (const left of leftovers) await clear(left.id);
  for (let waited = 0; waited < 60 && leftovers.length > 0; waited += 2) {
    const now = await call("projects.detail", { id: fixture.id });
    if (!now.worktrees.some((w) => leftovers.some((left) => left.id === w.id))) break;
    await page.waitForTimeout(2_000);
  }
  for (const left of projects.filter((p) => /^services-[a-z0-9]{4}$/.test(p.name)))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);

  const made = [];
  let empty = null;
  try {
    // --- The page as verify-fixture's owner, as the stack has it ----------------------------------
    await open(servicesPage);
    await heading("Services");
    await text(`Everyone who can open ${fixture.name}`).waitFor();
    await visible(page.getByText("Read-only here.")).waitFor();
    const file = await call("projects.mendToml", { id: fixture.id });
    const preview = await call("previews.project", { id: fixture.id });
    note(
      `the real reads: ${fixture.name}'s mend.toml ${file === null ? "absent" : `${file.path}, ${file.size} bytes`}; preview configured ${preview.configured}, url ${preview.url}, canManage ${preview.canManage}`,
    );
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
      note(`${fixture.name}: ${file.path} on ${fixture.defaultBranch} shown read-only`);
    }
    if (!preview.configured) {
      await visible(page.getByText(/^The project has no fixed preview address\./)).waitFor();
      expect(
        "no Change worktree… without a fixed preview",
        (await page.getByRole("button", { name: "Change worktree…" }).count()) === 0,
        "",
      );
      note("no fixed preview declared: the row says how to declare one, with no button");
    }
    await shot("project-services-real-desktop-light");

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

    // --- The file and the fixed preview, rewritten: what a project with both shows ---------------
    let target = first;
    let manage = true;
    let refuseNext = true;
    let onDefault = false;
    const fixed = () => ({
      configured: true,
      fixed: {
        targetMode: onDefault ? "default" : "worktree",
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
      canManage: manage,
    });
    await rewrite({
      ...(file === null ? { "projects.mendToml": () => SAMPLE } : {}),
      "previews.project": fixed,
      "previews.use": () => {
        if (refuseNext) {
          refuseNext = false;
          return { refused: REFUSAL };
        }
        // The first move goes to the second worktree, the next to the default branch.
        if (target === first) target = second;
        else onDefault = true;
        return fixed();
      },
    });
    const reread = async () => {
      await clearCache();
      await navigate("/settings/profile");
      await heading("Profile");
      await navigate(servicesPage);
      await heading("Services");
    };
    await reread();
    await visible(page.getByLabel(".mend/mend.toml", { exact: true })).waitFor();
    await visible(
      page.getByText(`${HOST} always shows web from the worktree of "Fix flaky checkout retry".`, {
        exact: false,
      }),
    ).waitFor();
    note(
      `rewritten reads: the file shown with line numbers; "${HOST} always shows web from the worktree of "Fix flaky checkout retry"."`,
    );
    await shot("project-services-desktop-light");
    await paint("dark");
    await shot("project-services-desktop-dark");
    await paint("light");
    await button("Change worktree…").click();
    const dialog = visible(page.getByRole("dialog", { name: "Change preview worktree" }));
    await dialog.getByText("Current", { exact: false }).waitFor();
    const rows = await dialog.getByRole("radio").count();
    expect("the dialog lists the worktrees and the default branch", rows >= 3, rows);
    await dialog.getByText("Default branch", { exact: true }).waitFor();
    const submit = dialog.getByRole("button", { name: "Change worktree", exact: true });
    expect("Change worktree waits for another pick", await submit.isDisabled(), "enabled");
    note(
      `Change worktree… lists ${rows} choices, the current one marked, Default branch last; the button waits for another pick`,
    );
    // By the worktree's own branch: an earlier run's worktrees can carry the same session names.
    await dialog.getByRole("radio", { name: new RegExp(` ${second.branch} `) }).click();
    await shot("project-services-change-desktop-light");
    await submit.click();
    await dialog.getByText("The preview didn't move.", { exact: false }).waitFor();
    note(
      'a move the server refuses (rewritten answer) keeps the dialog open: "The preview didn\'t move." with its words',
    );
    await shot("project-services-change-refused-desktop-light");
    await submit.click();
    await toastSays('The preview address now shows "Add idempotency keys to refunds".');
    await visible(
      page.getByText(`from the worktree of "Add idempotency keys to refunds".`, { exact: false }),
    ).waitFor();
    note("Change worktree moves it: the toast, and the line names the new worktree");
    await shot("project-services-changed-desktop-light");
    await button("Change worktree…").click();
    const again = visible(page.getByRole("dialog", { name: "Change preview worktree" }));
    await again.getByRole("radio", { name: /^Default branch / }).click();
    await again.getByRole("button", { name: "Change worktree", exact: true }).click();
    await toastSays(`The preview address now shows the default branch, ${fixture.defaultBranch}.`);
    await visible(
      page.getByText(
        `from the default branch, ${fixture.defaultBranch}, in a worktree Mend keeps`,
        {
          exact: false,
        },
      ),
    ).waitFor();
    note("moved to Default branch: the toast, and the line says it shows the default branch");

    // --- Someone who can't manage it (a rewritten read: canManage false) --------------------------
    manage = false;
    await reread();
    await visible(page.getByText(/can change these settings\. You can read them\.$/)).waitFor();
    expect(
      "no Change worktree… for someone who can't manage it",
      (await page.getByRole("button", { name: "Change worktree…" }).count()) === 0,
      "",
    );
    note("with canManage false: no button, and the line names who can change it");
    await shot("project-services-read-only-desktop-light");
    manage = true;

    // --- The phone ------------------------------------------------------------------------------
    // The server renders a full load with the real reads: move in through the router instead.
    await page.setViewportSize(PHONE);
    await open("/settings/profile");
    await clearCache();
    await navigate(servicesPage);
    await visible(page.getByRole("heading", { name: "Services" })).waitFor();
    await visible(page.getByLabel(".mend/mend.toml", { exact: true })).waitFor();
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
    for (const worktree of made) await clear(worktree.id);
    if (empty !== null)
      await call("projects.remove", { id: empty.id }, "mutate").catch(() => undefined);
    note("removed the worktrees and the project the recipe made");
  }
};
