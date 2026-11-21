// A project's "Only you" settings page in the web app (route PR 57, SLNT-1171):
// `/projects/<id>/settings/only-you`, the person's own agent memory in the project (on the web for
// the first time, server gap S21: `memory.list | file | remove | clear` over the API's
// `/projects/:id/memory`) and the Doppler config the project uses for them.
//
//   pnpm verify drive web --recipe project-only-you
//
// Feature ids: agent-memory.md `memory-list`, `memory-show`, `memory-remove` (and Clear memory…,
// which removes each file through the API's own remove); doppler.md `doppler-use`.
//
// What is real and what is rewritten:
// - Real: a project the recipe creates; three memory files imported through the API's own import
//   (`POST /projects/:id/memory/import`, what `mend memory import` sends), listed, one shown, one
//   removed, the rest cleared; the Doppler row before a token is saved; a fake token from
//   `fakes.mjs` saved through the API (no part of it is ever on screen); the config dialog, where
//   the stack can't reach Doppler with a fake token, so it asks for typed names; a typed config
//   saved and read back; Stop using Doppler here; the token removed again.
// - Rewritten: Doppler's lists of projects and configs (recorded answers, since a stack has no real
//   Doppler account), a Clear memory where one file isn't removed, and a read that fails (a 500).
//
// The recipe removes the project it made and the Doppler token, so it can run again.
import { FAKES } from "../scripts/fakes.mjs";

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

/** The memory files the recipe imports, as `mend memory import` sends them. */
const MEMORY = [
  {
    path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
    encoding: "utf8",
    contents: "- Run `pnpm test` before pushing.\n- Ask before touching the payments fixtures.\n",
  },
  {
    path: ".claude/projects/-workspace-repo/memory/tests.md",
    encoding: "utf8",
    contents: "The integration tests need Postgres on 5432.\n",
  },
  {
    path: ".codex/memories/summary.md",
    encoding: "utf8",
    contents: "Retries live in src/retry.ts.\n",
  },
];

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
  /** A tRPC call from the page, as the signed-in person. */
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
    // No part of the Doppler token may be on the page in any picture.
    const words = await page.evaluate(() => document.body.innerText);
    expect("no part of the token on screen", !words.includes(FAKES.github.slice(-6)), name);
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
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  /** Read the page again through the router, so a rewritten answer reaches it. */
  const reopen = async (to) => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(to);
  };

  // tRPC answers this recipe writes, by procedure: `{ json }` or `{ error }`.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p)) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
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

  // What an earlier run left when it stopped partway goes first.
  const LEFT = /^only-you-[a-z0-9]{4}$/;
  for (const left of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);
  for (const left of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: left.id, confirm: left.name }, "mutate").catch(
      () => undefined,
    );
  await call("doppler.disconnect", undefined, "mutate").catch(() => undefined);

  const name = `only-you-${Math.random().toString(36).slice(2, 6)}`;
  const project = await call("projects.createNew", { name }, "mutate");
  const home = `/projects/${project.id}/settings/only-you`;
  const imported = await page.evaluate(
    async ({ id, files }) => {
      const response = await fetch(`/api/projects/${id}/memory/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      });
      return { status: response.status, body: await response.json() };
    },
    { id: project.id, files: MEMORY },
  );
  expect("the import", imported.status === 200 && imported.body.added.length === 3, imported);
  note(`made ${name}; imported 3 memory files through POST /api/projects/<id>/memory/import`);

  try {
    // --- memory-list ----------------------------------------------------------------------------
    await open(`/projects/${project.id}/settings/general`);
    await heading("General");
    await visible(
      page
        .locator('[data-slot="sidebar"][aria-label="Settings"]')
        .getByRole("list", { name })
        .getByRole("link", { name: "Only you", exact: true }),
    ).click();
    await page.waitForURL((url) => url.pathname === home);
    await heading("Only you");
    await heading("Agent memory");
    await visible(page.getByText(/^3 notes\. You last imported one today at /)).waitFor();
    await text("You haven't connected Doppler, so there's nothing to pick yet.").waitFor();
    note(
      `the settings sidebar's ${name} → Only you opens ${home}: 3 notes; Doppler not connected, with a link to Connected apps`,
    );
    await shot("only-you-not-connected-desktop-light");

    await button("View notes…").click();
    const notes = dialog(`Notes about ${name}`);
    await notes.waitFor();
    for (const file of ["MEMORY.md", "tests.md", "summary.md"])
      await visible(notes.getByRole("button", { name: new RegExp(`^${file}`) })).waitFor();
    note("memory-list: View notes… lists MEMORY.md, tests.md and summary.md with agent and size");
    await shot("only-you-notes-desktop-light");

    // --- memory-show ----------------------------------------------------------------------------
    await visible(notes.getByRole("button", { name: /^MEMORY\.md/ })).click();
    const shown = dialog("MEMORY.md");
    await visible(shown.getByText(/Ask before touching the payments fixtures/)).waitFor();
    note("memory-show: MEMORY.md shows its words");
    await shot("only-you-note-desktop-light");

    // --- memory-remove --------------------------------------------------------------------------
    await visible(shown.getByRole("button", { name: "Remove…" })).click();
    await dialog("Remove MEMORY.md?").waitFor();
    await shot("only-you-remove-note-desktop-light");
    await button("Remove note").click();
    await toastSays("Removed MEMORY.md. Mend keeps its last version.");
    const after = await call("memory.list", { id: project.id });
    expect("the server's list lost MEMORY.md", after.files.length === 2, after.files);
    note("memory-remove: MEMORY.md removed; the server lists 2 files");
    await page.keyboard.press("Escape");
    await visible(page.getByText(/^2 notes\. /)).waitFor();

    // --- Clear memory: one file not removed (rewritten), then all of them (real) ---------------
    stubs.set("memory.clear", {
      json: {
        removed: [{ path: MEMORY[2].path, name: "summary.md" }],
        failed: [
          {
            path: MEMORY[1].path,
            name: "tests.md",
            message: `${name} is being removed, so its memory can't change.`,
          },
        ],
      },
    });
    await button("Clear memory…").click();
    await dialog("Clear memory?").waitFor();
    await shot("only-you-clear-dialog-desktop-light");
    await button("Clear memory").click();
    await visible(page.getByText(/Mend removed 1 note but not 1 note: tests\.md/)).waitFor();
    note("Clear memory where one file isn't removed (rewritten): the dialog stays and names it");
    await shot("only-you-clear-partial-desktop-light");
    stubs.delete("memory.clear");
    await button("Clear memory").click();
    await toastSays("Cleared 2 notes.");
    const cleared = await call("memory.list", { id: project.id });
    expect("the server's memory is empty", cleared.files.length === 0, cleared.files);
    await visible(page.getByText(/^No notes yet\./)).waitFor();
    note("Clear memory: the server removed both files; the page says No notes yet");

    // --- doppler-use: a fake token, then the dialog ---------------------------------------------
    await call("doppler.connect", { token: FAKES.github }, "mutate");
    note("saved a fake Doppler token (fakes.mjs) through doppler.connect; it never shows");
    await reopen(home);
    await heading("Only you");
    await button("Choose…").click();
    const config = dialog("Doppler config");
    await config.waitFor();
    await visible(config.getByText("Doppler didn't list your projects.")).waitFor({
      timeout: 30_000,
    });
    note("with a fake token the stack can't list Doppler projects: the dialog asks for the names");
    await config.getByLabel("Doppler project", { exact: true }).fill("checkout");
    await config.getByLabel("Config", { exact: true }).fill("dev_personal");
    await shot("only-you-doppler-couldnt-list-desktop-light");
    await button("Save").click();
    await toastSays(
      `Saved. Sessions you start in ${name} from now on use checkout / dev_personal.`,
    );
    const status = await call("doppler.status");
    expect(
      "the server holds the config",
      status.mappings.some(
        (mapping) =>
          mapping.projectId === project.id &&
          mapping.dopplerProject === "checkout" &&
          mapping.config === "dev_personal",
      ),
      status.mappings,
    );
    expect("no token in the status", !JSON.stringify(status).includes(FAKES.github), "");
    await text("checkout / dev_personal").waitFor();
    note("doppler-use: typed checkout / dev_personal saved and read back from doppler.status");
    await shot("only-you-doppler-saved-desktop-light");
    await noToasts();
    await shot("only-you-desktop-light");
    await paint("dark");
    await shot("only-you-desktop-dark");
    await paint("light");
    await page.setViewportSize(PHONE);
    await settled();
    await heading("Only you");
    await shot("only-you-phone-light");
    await paint("dark");
    await shot("only-you-phone-dark");
    await paint("light");
    await page.setViewportSize(DESKTOP);
    await settled();

    // --- Picking from Doppler's lists (recorded answers) ----------------------------------------
    stubs.set("doppler.projects", {
      json: {
        projects: [
          { id: "checkout", name: "checkout" },
          { id: "billing", name: "billing" },
        ],
      },
    });
    stubs.set("doppler.configs", {
      json: { configs: [{ name: "dev" }, { name: "dev_personal" }, { name: "stg" }] },
    });
    await reopen(home);
    await heading("Only you");
    await button("Change…").click();
    await config.waitFor();
    await visible(
      config.getByText("These are the projects and configs your Doppler token can see."),
    ).waitFor();
    await config.locator("select#doppler-config-name").selectOption("dev");
    await shot("only-you-doppler-dialog-desktop-light");
    await button("Save").click();
    await toastSays(`Saved. Sessions you start in ${name} from now on use checkout / dev.`);
    await text("checkout / dev").waitFor();
    note("doppler-use: picked dev from the recorded list and saved it through the server");
    stubs.delete("doppler.projects");
    stubs.delete("doppler.configs");

    // --- Stop using Doppler here ----------------------------------------------------------------
    await button("Change…").click();
    await config.waitFor();
    await visible(config.getByRole("button", { name: "Stop using Doppler here" })).click();
    await toastSays(`Sessions you start in ${name} from now on don't use Doppler.`);
    await text("None").waitFor();
    await button("Choose…").waitFor();
    note("Stop using Doppler here: the row reads None with Choose…");
    await noToasts();
    await shot("only-you-no-config-desktop-light");

    // --- A read that fails (rewritten) ----------------------------------------------------------
    stubs.set("memory.list", { error: "Mend is unreachable." });
    await reopen(home);
    await visible(page.getByRole("button", { name: "Try again" })).waitFor({ timeout: 30_000 });
    note("a memory read that fails shows the error screen with Try again");
    await shot("only-you-failed-desktop-light");
    stubs.delete("memory.list");
    await visible(page.getByRole("button", { name: "Try again" })).click();
    await heading("Only you");
    note("Try again loads the page");
  } finally {
    stubs.clear();
    await call("doppler.disconnect", undefined, "mutate").catch(() => undefined);
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
    await call("projects.purge", { id: project.id, confirm: project.name }, "mutate").catch(
      () => undefined,
    );
    note("removed the Doppler token and the project the recipe made");
  }
};
