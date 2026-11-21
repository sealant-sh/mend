// A project's Workspace settings page in the web app (route PR 53, SLNT-1171):
// `/projects/<id>/settings/workspace`, the project's own image, its dependency install and its
// ready workspaces.
//
//   pnpm verify drive web --recipe project-workspace
//
// Feature ids: workspace-images.md `image-project-override` (Edit image…: the shell, a package,
// Docker), `image-rejections` (a package Sealant can't find is named and nothing is saved),
// `image-use-default` read as "start again from a copy of the organization's starting image";
// automatic-install.md `install-detected`, `install-custom`, `install-switch`, `install-colocated`
// (said when the server runs sessions beside the store); hot-sessions.md `hot-count`, `hot-status`,
// `hot-rewarm` (what the server reports while the ready workspaces start again after a save).
//
// What is real and what is rewritten:
// - Real: a project the recipe creates (no repository); the image saved with bash and a package,
//   refused for a package Sealant can't find, and started again from the organization's image; the
//   custom command saved, cleared and kept while install is off; the ready-workspace count raised
//   and lowered, with what the server reports.
// - Rewritten: the ready workspaces' status while they start again after an image save and when
//   one fails (a stack has no session in the project this week, so it keeps none ready), the page
//   as someone who may only read it, and a status read that fails.
//
// The recipe removes the project it made, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${String(JSON.stringify(seen)).slice(0, 400)}`);
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
  const noToasts = () =>
    page
      .waitForFunction(
        () =>
          document.querySelectorAll('[aria-label^="Notifications"] [role="dialog"]').length === 0,
        null,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
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
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words)).waitFor({
      timeout: 60_000,
    });
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const reopen = async (to) => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(to);
  };
  const detail = (id) => call("projects.detail", { id });
  /**
   * Save image, and wait until the server answers: the editor closes on a save, and stays open
   * naming the packages it refused. Resolving packages against Sealant can take a minute.
   */
  const saveImage = async (editor) => {
    await noToasts();
    await button("Save image").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Packages Mend didn\'t save"]') !== null ||
        ![...document.querySelectorAll('[role="dialog"]')].some((element) =>
          /^Edit .*'s image/.test(element.textContent ?? ""),
        ),
      null,
      { timeout: 180_000 },
    );
    return editor.isVisible();
  };

  // tRPC answers this recipe writes, by procedure: `{ json }`, `{ error }`, or a function of the
  // real answer.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p) && typeof stubs.get(p) !== "function")
      ? null
      : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (typeof stub === "function") return stub(answers[index]);
      if (stub.error !== undefined) {
        status = paths.length === 1 ? 500 : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
      }
      return { result: { data: { json: stub.json } } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await page.evaluate(async () => (await fetch("/api/organization")).json());
  const organization = me.organization.name;

  const LEFT = /^workspace-[a-z0-9]{4}$/;
  for (const left of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);
  for (const left of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: left.id, confirm: left.name }, "mutate").catch(
      () => undefined,
    );
  const name = `workspace-${Math.random().toString(36).slice(2, 6)}`;
  const project = await call("projects.createNew", { name }, "mutate");
  const home = `/projects/${project.id}/settings/workspace`;
  const startingImage = (await call("organization.settings")).organization.workspaceImage;
  note(`made ${name}; its image is a copy of ${organization}'s starting image`);

  try {
    // --- The page, from the settings sidebar ----------------------------------------------------
    await open(`/projects/${project.id}/settings/general`);
    await heading("General");
    await visible(
      page
        .locator('[data-slot="sidebar"][aria-label="Settings"]')
        .getByRole("list", { name })
        .getByRole("link", { name: "Workspace", exact: true }),
    ).click();
    await page.waitForURL((url) => url.pathname === home);
    await heading("Workspace");
    await visible(page.getByText(`${name} has its own image.`, { exact: false })).waitFor();
    await visible(page.getByRole("switch", { name: "Automatic install" })).waitFor();
    await visible(page.getByRole("status").filter({ hasText: "Off" })).waitFor();
    note(
      `the settings sidebar's ${name} → Workspace opens ${home}: the image's line, Automatic install on, ready workspaces Off`,
    );
    await shot("workspace-desktop-light");
    await paint("dark");
    await shot("workspace-desktop-dark");
    await paint("light");
    await page.setViewportSize(PHONE);
    await settled();
    await heading("Workspace");
    await shot("workspace-phone-light");
    await paint("dark");
    await shot("workspace-phone-dark");
    await paint("light");
    await page.setViewportSize(DESKTOP);
    await settled();
    for (const anchor of ["environment", "install-command", "hot-sessions"]) {
      await page.goto(`${web}/projects/${project.id}/configuration#${anchor}`);
      await page.waitForURL((url) => url.pathname === home, { timeout: 60_000 });
    }
    await hydrated();
    await heading("Workspace");
    note(
      "old /projects/<id>/configuration#environment, #install-command and #hot-sessions land here",
    );

    // --- image-rejections -----------------------------------------------------------------------
    await button("Edit image…").click();
    const editor = dialog(`Edit ${name}'s image`);
    await editor.waitFor();
    await editor.getByRole("textbox", { name: "Add package" }).fill("verify-no-such-package");
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    await shot("workspace-edit-image-desktop-light");
    const refusal = visible(editor.getByRole("alert", { name: "Packages Mend didn't save" }));
    const refused = await saveImage(editor);
    if (refused) {
      expect(
        "the refusal names the package",
        (await refusal.innerText()).includes("verify-no-such-package"),
        await refusal.innerText(),
      );
      note(`image-rejections: ${(await refusal.innerText()).replace(/\s+/g, " ")}`);
      await shot("workspace-image-refused-desktop-light");
      const after = await detail(project.id);
      expect(
        "nothing saved",
        !after.project.workspaceImage.packages.includes("verify-no-such-package"),
        after.project.workspaceImage.packages,
      );
    } else {
      const held = (await detail(project.id)).project.workspaceImage.packages;
      note(
        `image-rejections: this stack's Sealant took the name (saved: ${held.includes("verify-no-such-package")}); no refusal to show`,
      );
    }

    // --- image-project-override -----------------------------------------------------------------
    if (!(await editor.isVisible())) await button("Edit image…").click();
    await editor.waitFor();
    const remove = editor.getByRole("button", { name: "Remove verify-no-such-package" });
    if (await remove.isVisible()) await remove.click();
    await visible(
      editor.getByRole("group", { name: "Shell" }).getByRole("button", { name: "bash" }),
    ).click();
    const docker = editor.getByRole("switch", { name: "Docker inside workspaces" });
    const dockerBefore = (await docker.getAttribute("aria-checked")) === "true";
    await docker.click();
    expect("the save is taken", !(await saveImage(editor)), "the editor stayed open");
    await toastSays(`Saved ${name}'s image. Mend builds it when the next session starts.`);
    const saved = (await detail(project.id)).project.workspaceImage;
    expect(
      "the server holds bash and the Docker switch",
      saved.shell === "bash" && saved.services.docker === !dockerBefore,
      saved,
    );
    await visible(page.getByText(/, bash and \d+ packages?\./)).waitFor();
    note(
      `image-project-override: saved bash and Docker ${dockerBefore ? "off" : "on"}; the server holds them; no build started (S17)`,
    );
    await shot("workspace-image-saved-desktop-light");
    await open(home);
    await visible(page.getByText(/, bash and \d+ packages?\./)).waitFor();
    note("after a reload the Current image row still reads bash");

    // --- image-use-default: start again from the organization's image ---------------------------
    await button("Edit image…").click();
    await editor.waitFor();
    await visible(
      editor.getByRole("button", { name: `Start again from ${organization}'s image` }),
    ).click();
    await visible(editor.getByText(/The fields now hold a copy of/)).waitFor();
    await shot("workspace-start-again-desktop-light");
    expect("the save is taken", !(await saveImage(editor)), "the editor stayed open");
    await toastSays(`Saved ${name}'s image.`);
    const copied = (await detail(project.id)).project.workspaceImage;
    expect(
      "the project's image is a copy of the organization's",
      JSON.stringify(copied) === JSON.stringify(startingImage),
      { copied, startingImage },
    );
    note(`image-use-default: saved a copy of ${organization}'s starting image as it is now`);
    await noToasts();

    // --- install-custom, install-switch -----------------------------------------------------------
    const field = visible(page.getByLabel("Custom command", { exact: true }));
    await field.fill("pnpm install --frozen-lockfile && pnpm db:generate");
    await text(`New sessions in ${name} run this after you save.`).waitFor();
    await shot("workspace-unsaved-command-desktop-light");
    await button("Save").click();
    await toastSays(`Saved the custom command. New sessions in ${name} run it.`);
    expect(
      "the server holds the command",
      (await detail(project.id)).project.installCommand ===
        "pnpm install --frozen-lockfile && pnpm db:generate",
      "",
    );
    await text("Mend runs this instead of the command it found from the lockfile.").waitFor();
    note("install-custom: saved, and the line says Mend runs it instead of the detected one");
    await shot("workspace-command-saved-desktop-light");
    await open(home);
    expect(
      "the command after a reload",
      (await field.inputValue()) === "pnpm install --frozen-lockfile && pnpm db:generate",
      await field.inputValue(),
    );
    note("after a reload the custom command is still in the field");
    await visible(page.getByRole("switch", { name: "Automatic install" })).click();
    await visible(page.getByText(/Mend keeps your custom command\.$/)).waitFor();
    expect(
      "install off, command kept",
      (await detail(project.id)).project.installEnabled === false,
      "",
    );
    note("install-switch: off; the field is gone and the line says the command is kept");
    await visible(page.getByRole("switch", { name: "Automatic install" })).click();
    await field.waitFor();
    await field.fill("");
    await button("Save").click();
    await toastSays(`New sessions in ${name} run the command Mend finds from the lockfile.`);
    expect("the command cleared", (await detail(project.id)).project.installCommand === null, "");
    note("install-detected: a blank command goes back to the one Mend finds from the lockfile");
    await noToasts();

    // --- hot-count, hot-status ------------------------------------------------------------------
    await button("One more ready workspace").click();
    await visible(
      page.getByRole("status").filter({ hasText: /None ready yet|ready for you|starting/ }),
    ).waitFor();
    expect("the count saved", (await detail(project.id)).project.hotSessions === 1, "");
    note(
      `hot-count: raised to 1; the server reports "${(await visible(page.getByRole("status").filter({ hasText: /ready|starting|failed/ })).innerText()).trim()}"`,
    );
    await shot("workspace-ready-one-desktop-light");
    await open(home);
    await visible(page.getByLabel("Ready workspaces per person", { exact: true }).getByText("1"))
      .waitFor()
      .catch(() => undefined);
    expect(
      "the count after a reload",
      (await visible(
        page.locator('span[aria-label="Ready workspaces per person"]'),
      ).innerText()) === "1",
      "",
    );
    note("after a reload the count still reads 1");

    // --- hot-rewarm and a failure (rewritten) ---------------------------------------------------
    stubs.set("projects.hotSessionsStatus", {
      json: { hotSessions: 1, ready: 1, warming: 1, failed: 0, error: null },
    });
    await reopen(home);
    await visible(
      page.getByRole("status").filter({ hasText: "1 ready for you, 1 starting" }),
    ).waitFor();
    note("hot-rewarm (rewritten status): 1 ready for you, 1 starting while the image rebuilds");
    await shot("workspace-rewarming-desktop-light");
    stubs.set("projects.hotSessionsStatus", {
      json: {
        hotSessions: 1,
        ready: 0,
        warming: 0,
        failed: 1,
        error: "sealant: image build failed at step 4/9 (pacman: target not found: htop)",
      },
    });
    await reopen(home);
    await visible(page.getByText(/^Starting one failed: sealant: image build failed/)).waitFor();
    note("hot-status (rewritten): 1 failed, with the server's words");
    await shot("workspace-ready-failed-desktop-light");
    stubs.set("projects.hotSessionsStatus", { error: "Mend is unreachable." });
    await reopen(home);
    await visible(
      page.getByRole("status").filter({ hasText: "Mend couldn't read them." }),
    ).waitFor();
    note("a ready-workspaces read that fails says so in its row; the rest of the page shows");
    stubs.delete("projects.hotSessionsStatus");
    await reopen(home);
    await heading("Workspace");
    await button("One fewer ready workspace").click();
    await visible(page.getByRole("status").filter({ hasText: "Off" })).waitFor();
    expect("the count back to 0", (await detail(project.id)).project.hotSessions === 0, "");
    note("hot-count: lowered to 0, Off");

    // --- Someone who may only read it (rewritten) -----------------------------------------------
    stubs.set("projects.detail", (answer) => {
      const data = answer?.result?.data?.json;
      if (data === undefined) return answer;
      return {
        result: {
          data: {
            ...answer.result.data,
            json: {
              ...data,
              project: { ...data.project, createdByUserId: null },
              capabilities: { ...data.capabilities, manage: false },
            },
          },
        },
      };
    });
    await reopen(home);
    await visible(page.getByText(/can change these settings\. You can read them\./)).waitFor();
    expect(
      "no Edit image… for a reader",
      (await page.getByRole("button", { name: "Edit image…" }).count()) === 0,
      "",
    );
    expect(
      "no switch, no +/− and a read-only command for a reader",
      (await page.getByRole("switch").count()) === 0 &&
        (await page.getByRole("button", { name: "One more ready workspace" }).count()) === 0 &&
        (await visible(page.getByLabel("Custom command", { exact: true })).getAttribute(
          "readonly",
        )) !== null,
      "",
    );
    note(
      "as a reader (capabilities.manage false): who can change it; On instead of the switch, a read-only command, the count without +/−",
    );
    await noToasts();
    await shot("workspace-reader-desktop-light");
    stubs.delete("projects.detail");
  } finally {
    stubs.clear();
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
    note("removed the project the recipe made");
  }
};
