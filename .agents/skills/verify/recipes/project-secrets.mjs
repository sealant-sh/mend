// A project's Variables and secrets settings page in the web app (route PR 55, SLNT-1171):
// `/projects/<id>/settings/secrets`, its environment variables and its secrets, and Import .env.
//
//   pnpm verify drive web --recipe project-secrets
//
// Feature ids (project-environment.md): `env-composer` and `env-import` (Import .env file…: rows
// from a pasted file, each saying where it goes, values hidden, a per-name report), `env-routing`
// (a secret-looking name goes to Secrets, a reserved one is refused with the reason),
// `env-configuration` (add, edit, rename, remove a variable), `env-secrets` (add, replace, remove a
// secret; the value never comes back), `env-not-inherited` (the page is the project's own).
//
// What is real and what is rewritten:
// - Real: a project the recipe makes, every write to its variables and secrets and the server's
//   answers; the empty state; refusals before sending; the phone layout.
// - Rewritten in the page: the project read with `capabilities.manage` false, for someone who can
//   only read the page; a read that fails, for the error screen and Try again.
//
// Secret values are the published fakes in `scripts/fakes.mjs`, typed with `typeSecret`, and no
// picture is taken while a password field holds one. The secret kept on the page is SENTRY_DSN (the
// frame's): the evidence scrubber reads a button named "Replace <…_TOKEN>" as a token and value,
// and withholds the picture. The recipe removes the project it made.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

export default async ({ page, web, capture, note, typeSecret }) => {
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
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  // Several toasts stack up in a run; one behind another doesn't count as visible, so wait for it
  // to be in the Notifications region.
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words)
      .first()
      .waitFor({ state: "attached" });
  // Exact names: the project is called secrets-…, and the sidebar lists its pages under that name.
  const variables = () =>
    visible(page.getByRole("list", { name: "Environment variables", exact: true }));
  const secrets = () => visible(page.getByRole("list", { name: "Secrets", exact: true }));
  const closed = (name) => page.getByRole("dialog", { name }).waitFor({ state: "hidden" });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  // Projects an earlier run left go first.
  for (const left of (await call("projects.list")).filter((p) =>
    /^secrets-[a-z0-9]{4}$/.test(p.name),
  ))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);
  const name = `secrets-${Math.random().toString(36).slice(2, 6)}`;
  const project = await call("projects.createNew", { name }, "mutate");
  const home = `/projects/${project.id}/settings/secrets`;
  note(`made ${name} (${project.id}) with no variables or secrets`);

  try {
    // --- Empty -------------------------------------------------------------------------------------
    await navigate(home);
    await heading("Variables and secrets");
    await text(`Everyone who can open ${name}`).waitFor();
    await text("No variables yet.").waitFor();
    await text("No secrets yet.").waitFor();
    note("env-not-inherited: a new project's page starts empty; nothing comes from elsewhere");
    await shot("project-secrets-empty-desktop-light");

    // --- env-configuration: add, a refused name, edit and rename, remove -------------------------
    const addVariable = async (key, value) => {
      await button("Add variable…").click();
      const form = dialog("Add variable");
      await form.getByLabel("Name", { exact: true }).fill(key);
      await form.getByLabel("Value", { exact: true }).fill(value);
      await form.getByRole("button", { name: "Add variable", exact: true }).click();
      await toastSays(`Saved ${key}.`);
      await closed("Add variable");
    };
    await addVariable("NODE_ENV", "development");
    await addVariable("STRIPE_API_BASE", "https://api.stripe.com");
    await addVariable("LOG_LEVEL", "debug");
    await variables().getByText("https://api.stripe.com").waitFor();
    note("env-configuration: added NODE_ENV, STRIPE_API_BASE and LOG_LEVEL; each toast says Saved");

    await button("Add variable…").click();
    const refused = dialog("Add variable");
    await refused.getByLabel("Name", { exact: true }).fill("DB_PASSWORD");
    await refused.getByLabel("Value", { exact: true }).fill("not-a-secret");
    await refused.getByRole("button", { name: "Add variable", exact: true }).click();
    const reason = await visible(refused.locator('[data-slot="field-error"]')).innerText();
    note(
      `env-routing: DB_PASSWORD as a variable is refused beside the field before sending: "${reason}"`,
    );
    await shot("project-secrets-variable-refused-desktop-light");
    await page.keyboard.press("Escape");
    await closed("Add variable");

    await button("Edit NODE_ENV").click();
    const edit = dialog("Edit NODE_ENV");
    await edit.getByLabel("Value", { exact: true }).fill("test");
    await shot("project-secrets-edit-desktop-light");
    await edit.getByRole("button", { name: "Save variable", exact: true }).click();
    await toastSays("Saved NODE_ENV.");
    await variables().getByText("test", { exact: true }).waitFor();
    await button("Edit LOG_LEVEL").click();
    const rename = dialog("Edit LOG_LEVEL");
    await rename.getByLabel("Name", { exact: true }).fill("LOG_FORMAT");
    await rename.getByLabel("Value", { exact: true }).fill("json");
    await rename.getByRole("button", { name: "Save variable", exact: true }).click();
    await toastSays("Saved LOG_FORMAT.");
    await variables().getByText("LOG_FORMAT", { exact: true }).waitFor();
    note("env-configuration: Edit NODE_ENV saved test; LOG_LEVEL renamed to LOG_FORMAT");
    await shot("project-secrets-variable-saved-desktop-light");

    // --- env-secrets: add, replace; the value never comes back --------------------------------------
    await button("Add secret…").click();
    const add = dialog("Add secret");
    // The driver withholds a picture of a dialog whose fields look like a credential: take it empty.
    await add.getByLabel("Name", { exact: true }).waitFor();
    await shot("project-secrets-add-secret-desktop-light");
    await add.getByLabel("Name", { exact: true }).fill("SENTRY_DSN");
    await typeSecret(add.getByLabel("Value", { exact: true }), "project-secret", FAKES.github);
    await add.getByRole("button", { name: "Add secret", exact: true }).click();
    await closed("Add secret");
    await toastSays("Added SENTRY_DSN.");
    await secrets().getByText("SENTRY_DSN", { exact: true }).waitFor();
    const listed = await call("environment.secrets", { projectId: project.id });
    expect(
      "the secret's value never comes back",
      !JSON.stringify(listed).includes(FAKES.github),
      Object.keys(listed.secrets[0] ?? {}),
    );
    const html = await page.content();
    expect("nor is it in the page", !html.includes(FAKES.github), "");
    note(
      "env-secrets: added SENTRY_DSN; the secrets read and the page hold its name, never its value",
    );
    await shot("project-secrets-secret-added-desktop-light");

    await button("Replace SENTRY_DSN").click();
    const replace = dialog("Replace SENTRY_DSN");
    await replace.getByText("You won't be able to see it again after you save.").waitFor();
    await shot("project-secrets-replace-desktop-light");
    await typeSecret(
      replace.getByLabel("New value", { exact: true }),
      "project-secret-2",
      FAKES.boatKey,
    );
    await replace.getByRole("button", { name: "Replace secret", exact: true }).click();
    await toastSays("Replaced SENTRY_DSN.");
    await closed("Replace SENTRY_DSN");
    note("env-secrets: Replace SENTRY_DSN saved a new value");

    // --- env-import, env-composer, env-routing -------------------------------------------------------
    await button("Import .env file…").click();
    const importing = dialog("Import .env file");
    await importing
      .getByLabel(".env contents", { exact: true })
      .fill(
        [
          "# from a teammate's checkout",
          "FEATURE_FLAGS=checkout,refunds",
          `SENTRY_AUTH_TOKEN=${FAKES.github}`,
          "PATH=/usr/bin",
          "this line is not NAME=value",
          "",
        ].join("\n"),
      );
    // The textarea's contents hold a fake token: empty it before any picture.
    await importing.getByRole("button", { name: "Read it", exact: true }).click();
    const rows = visible(importing.getByRole("list", { name: "Names to import" }));
    await rows.getByText("FEATURE_FLAGS", { exact: true }).waitFor();
    await importing.getByRole("switch").click();
    const lanes = await rows.innerText();
    note(
      `env-composer: rows read from the paste, Save everything as secrets off: ${lanes.replace(/\s+/g, " ").slice(0, 300)}`,
    );
    await shot("project-secrets-import-desktop-light");
    await importing.getByRole("button", { name: /^Save \d+ names?$/ }).click();
    const summary = await visible(
      page.getByRole("region", { name: /Notifications/ }).getByText(/^Saved \d|^Nothing was saved/),
    ).innerText();
    note(`env-import: saved in one request; the toast says "${summary}"`);
    await shot("project-secrets-imported-desktop-light");
    if (await importing.isVisible()) {
      await importing.getByRole("button", { name: "Close", exact: true }).first().click();
    }
    await closed("Import .env file");
    await variables().getByText("FEATURE_FLAGS", { exact: true }).waitFor();
    await secrets().getByText("SENTRY_AUTH_TOKEN", { exact: true }).waitFor();
    note(
      "env-routing: FEATURE_FLAGS landed in Environment variables, SENTRY_AUTH_TOKEN in Secrets",
    );

    // --- Remove --------------------------------------------------------------------------------------
    await button("Remove STRIPE_API_BASE").click();
    const remove = dialog("Remove STRIPE_API_BASE?");
    await shot("project-secrets-remove-desktop-light");
    await remove.getByRole("button", { name: "Remove variable", exact: true }).click();
    await toastSays("Removed STRIPE_API_BASE.");
    await button("Remove SENTRY_AUTH_TOKEN").click();
    await dialog("Remove SENTRY_AUTH_TOKEN?")
      .getByRole("button", { name: "Remove secret", exact: true })
      .click();
    await toastSays("Removed SENTRY_AUTH_TOKEN.");
    note(
      "env-configuration and env-secrets: removed STRIPE_API_BASE and SENTRY_AUTH_TOKEN after asking",
    );
    await shot("project-secrets-desktop-light");
    await paint("dark");
    await shot("project-secrets-desktop-dark");
    await paint("light");

    // --- Someone who can only read it (the project read rewritten: manage false) -------------------
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("projects.detail")) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const list = Array.isArray(answers) ? answers : [answers];
      for (const [index, path] of paths.entries()) {
        const json = list[index]?.result?.data?.json;
        if (path === "projects.detail" && json?.capabilities !== undefined)
          json.capabilities.manage = false;
      }
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? list : list[0]),
      });
    });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate(home);
    await heading("Variables and secrets");
    await visible(page.getByText(/can change these settings\. You can read them\.$/)).waitFor();
    expect(
      "no Add variable… for someone who can't change it",
      (await page.getByRole("button", { name: "Add variable…" }).count()) === 0,
      "",
    );
    note(
      "read-only (rewritten read): names and variable values shown, no buttons, who can change it named",
    );
    await shot("project-secrets-read-only-desktop-light");
    await page.unroute("**/trpc/**");

    // --- The phone ------------------------------------------------------------------------------------
    await page.setViewportSize(PHONE);
    await open(home);
    await visible(page.getByRole("heading", { name: "Variables and secrets" })).waitFor();
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`project-secrets-phone-${theme}`);
    }
    await paint("light");
    await visible(page.getByRole("button", { name: "SENTRY_DSN actions" })).click();
    await visible(page.getByRole("menuitem", { name: "Replace…" })).waitFor();
    note('on a phone each row\'s "…" holds its actions');
    await shot("project-secrets-row-menu-phone-light");
    await page.keyboard.press("Escape");
    await page.setViewportSize(DESKTOP);

    // --- A read that fails ------------------------------------------------------------------------------
    await open("/settings/profile");
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("environment.secrets")) return route.continue();
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
      const changed = paths.map((p, index) =>
        p === "environment.secrets" ? failure : list[index],
      );
      await route.fulfill({
        status: paths.length === 1 ? 500 : 207,
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });
    await clearCache();
    await navigate(home);
    await heading("This page didn't load");
    note("the secrets read failing shows the error screen with Try again");
    await shot("project-secrets-error-desktop-light");
    await page.unroute("**/trpc/**");
    await button("Try again").click();
    await heading("Variables and secrets");
    note("Try again reads again and the page draws");
  } finally {
    await page.unroute("**/trpc/**").catch(() => undefined);
    await call("projects.remove", { id: project.id }, "mutate").catch(() => undefined);
    note(`removed ${name}`);
  }
};
