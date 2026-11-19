// Settings → Account → Dotfiles in the new web app (route PR 40, SLNT-1159):
//
//   pnpm verify drive new-web --recipe new-web-dotfiles
//
// Feature ids: dotfiles.md `dotfiles-repo-web`, `dotfiles-repo-refused`, `dotfiles-manager`,
// `dotfiles-web-files`; secret-files.md `secrets-list`, `secrets-add-web`, `secrets-path-refused`,
// `secrets-remove` (and replacing one). Removed by the owner's rulings, so nowhere here: the
// per-project "Apply my dotfiles" switch and "Default shell profile".
//
// - Old `/settings/workspace#<section>` links land on the page that holds the section now:
//   Dotfiles, Devices and access keys, or Connected apps (no anchor: Executor's link).
// - The repository: a repository the server can't clone is refused with nothing saved; one it
//   can clone (a tiny public repository on GitHub) saves, with its manager; then it is put back.
// - Home files: a file added from the browser, its target edited, listed, then all removed.
// - Secret files: a path outside the home folder and one sessions capture are refused before
//   anything is sent; a file is added from pasted text, replaced from a chosen file, and removed.
//   Its content is never on the page after it is saved, and no picture is taken while it is typed.
//
// The recipe puts the repository, home files and secret files back as it found them.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** A public repository small enough to clone in a moment. */
const CLONABLE = "https://github.com/octocat/Hello-World.git";
/** An address on GitHub with no repository behind it. */
const UNCLONABLE = "https://github.com/sealant-sh/mend-verify-no-such-dotfiles.git";

const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note, registerSecret }) => {
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const text = (value) => visible(page.getByText(value, { exact: false }));
  const settled = () => page.waitForTimeout(500);
  const path = () => new URL(page.url()).pathname;
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
    // A cold dev server can leave the first load unhydrated: load it once more.
    await hydrated().catch(async () => {
      note(`${to} didn't hydrate in 90s; loading it again`);
      await page.reload();
      await hydrated();
    });
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  /** One picture; on the desk, in a window tall enough to hold the whole page. */
  const shot = async (name, whole = false) => {
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    const size = page.viewportSize();
    const tall = whole && size !== null && size.width >= 1024;
    if (tall) await page.setViewportSize({ width: size.width, height: 1500 });
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
    if (tall) {
      await page.setViewportSize(size);
      await settled();
    }
  };
  const paint = (dark) =>
    page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  const api = (method, url, body) =>
    page.evaluate(
      async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
        const raw = await response.text();
        return { status: response.status, body: raw === "" ? null : JSON.parse(raw) };
      },
      { method, url, body },
    );
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words, { exact: false })
      .first()
      .waitFor({ timeout: 10_000 });
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const closed = (name) =>
    page.getByRole("dialog", { name }).waitFor({ state: "detached", timeout: 30_000 });
  const stamp = Date.now().toString(36);

  // --- Before: what the run will put back ---------------------------------------------------------
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  await open("/settings/profile");
  const before = {
    dotfiles: (await api("GET", "/api/dotfiles")).body,
    secrets: (await api("GET", "/api/me/secret-files")).body,
  };
  note(
    `before: repository ${before.dotfiles?.repository?.url ?? "none"}, ${before.dotfiles?.snapshot?.files?.length ?? 0} home files, ${before.secrets?.files?.length ?? "?"} secret files`,
  );

  // --- Old addresses ----------------------------------------------------------------------------
  for (const [from, to] of [
    ["/settings/workspace#secret-files", "/settings/dotfiles"],
    ["/settings/workspace#dotfiles-repo-url", "/settings/dotfiles"],
    ["/settings/workspace#workspace-ssh", "/settings/devices"],
    ["/settings/workspace#doppler", "/settings/connected-apps"],
    ["/settings/workspace", "/settings/connected-apps"],
    ["/settings#secret-files", "/settings/dotfiles"],
  ]) {
    await page.goto("about:blank");
    await page.goto(`${web}${from}`);
    await page.waitForURL((url) => url.pathname === to, { timeout: 90_000 });
    note(`${from} → ${path()}`);
  }

  // --- The page, from the settings sidebar ------------------------------------------------------
  await open("/settings/profile");
  await page
    .locator('[data-slot="sidebar"][aria-label="Settings"]')
    .getByRole("link", { name: "Dotfiles", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === "/settings/dotfiles");
  note("the settings sidebar's Dotfiles entry opened /settings/dotfiles");
  await open("/settings/dotfiles");
  await heading("Dotfiles");
  await text("Only you").waitFor();
  for (const gone of ["Apply my dotfiles", "Default shell profile", "shell profile"])
    if ((await page.getByText(gone, { exact: false }).count()) > 0)
      throw new Error(`the page offers "${gone}"`);
  await visible(page.getByRole("link", { name: "Skills page", exact: true })).waitFor();
  note(
    "Dotfiles: 'Only you', 'follow you into every session …', skills on the Skills page (a link); no Apply my dotfiles, no Default shell profile",
  );
  await shot("dotfiles-desktop-light", true);
  await paint(true);
  await shot("dotfiles-desktop-dark", true);
  await page.setViewportSize(PHONE);
  await shot("dotfiles-phone-dark");
  await paint(false);
  await shot("dotfiles-phone-light");
  await page.setViewportSize(DESKTOP);
  await settled();

  // --- dotfiles-repo-refused --------------------------------------------------------------------
  const url = page.getByLabel("Dotfiles repository", { exact: true });
  await url.fill(UNCLONABLE);
  await text("Mend clones the repository to check it before saving.").waitFor();
  note(
    "a new address: 'Unsaved changes' with 'Mend clones the repository to check it before saving.', Cancel and Save",
  );
  await shot("repository-unsaved-desktop-light", true);
  await button("Save").click();
  await text(`Mend couldn't clone ${UNCLONABLE}, so it didn't save it.`).waitFor({
    timeout: 120_000,
  });
  await text("Your sessions keep using the repository you saved before.").waitFor();
  const after = (await api("GET", "/api/dotfiles")).body;
  if ((after?.repository?.url ?? null) !== (before.dotfiles?.repository?.url ?? null))
    throw new Error("a repository that didn't clone was saved");
  note(
    `Save on an address with no repository: '${(await page.getByRole("alert").first().textContent())?.trim()}', and the server still holds what it held`,
  );
  await shot("repository-refused-desktop-light", true);
  await open("/settings/dotfiles");
  const reread = await page.getByLabel("Dotfiles repository", { exact: true }).inputValue();
  if (reread !== (before.dotfiles?.repository?.url ?? ""))
    throw new Error(`after a reload: ${reread}`);
  note("after a reload the saved repository is unchanged");

  // --- dotfiles-repo-web and dotfiles-manager ---------------------------------------------------
  await page.getByLabel("Dotfiles repository", { exact: true }).fill(CLONABLE);
  await button("Copy").click();
  await text("Copies the tree into the home directory as it is.").waitFor();
  await button("Save").click();
  await text("Saved. Sessions you start from now on apply it.").waitFor({ timeout: 180_000 });
  const saved = (await api("GET", "/api/dotfiles")).body;
  if (saved?.repository?.url !== CLONABLE || saved?.repository?.manager !== "copy")
    throw new Error(`the server holds ${JSON.stringify(saved?.repository)}`);
  note(
    `${CLONABLE} with the manager Copy: cloned and saved; the server holds it with manager copy`,
  );
  await shot("repository-saved-desktop-light", true);
  await open("/settings/dotfiles");
  if ((await page.getByLabel("Dotfiles repository", { exact: true }).inputValue()) !== CLONABLE)
    throw new Error("the saved address didn't come back after a reload");
  if ((await button("Copy").getAttribute("aria-pressed")) !== "true")
    throw new Error("Copy isn't chosen after a reload");
  note("after a reload: the address and Copy are still chosen");

  // --- dotfiles-web-files -----------------------------------------------------------------------
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "settings.ini",
    mimeType: "text/plain",
    buffer: Buffer.from(`# written by the verify recipe ${stamp}\n`),
  });
  const target = page.getByLabel("Where settings.ini lands in your home folder", { exact: true });
  await target.waitFor();
  await target.fill(`.config/mend-verify-${stamp}/settings.ini`);
  await shot("home-file-staged-desktop-light", true);
  await button("Add 1 file").click();
  await page
    .getByRole("list", { name: "Home files" })
    .getByText(`~/.config/mend-verify-${stamp}/settings.ini`)
    .waitFor();
  note(
    `Add files… settings.ini, its target edited: listed as '~/.config/mend-verify-${stamp}/settings.ini'`,
  );
  if ((before.dotfiles?.snapshot?.files?.length ?? 0) === 0) {
    await button("Remove all…").click();
    await dialog("Remove every home file?").waitFor();
    await button("Remove all").click();
    await closed("Remove every home file?");
    await text("No home files yet.").waitFor();
    note("Remove all…: 'Remove every home file?', then 'No home files yet.'");
  } else {
    note("the account had home files of its own: Remove all… not pressed");
  }

  // --- Put the repository back ------------------------------------------------------------------
  await api("PUT", "/api/dotfiles/repository", { repository: before.dotfiles?.repository ?? null });
  await open("/settings/dotfiles");

  // --- secrets-path-refused ---------------------------------------------------------------------
  await visible(page.getByRole("button", { name: "Add secret file…" })).click();
  await dialog("Add a secret file").waitFor();
  const secretPath = page.getByLabel("Path in your home folder", { exact: true });
  await secretPath.fill("~/../etc/passwd");
  await text("~/../etc/passwd leaves your home folder.").waitFor();
  await secretPath.fill("~/.claude/settings.json");
  await text("which sessions capture").waitFor();
  note(
    "'~/../etc/passwd' is refused ('leaves your home folder') and '~/.claude/settings.json' too ('… which sessions capture'), before anything is sent",
  );
  await shot("secret-path-refused-desktop-light");
  const secretName = `.config/mend-verify-${stamp}/registry.conf`;
  await secretPath.fill(`~/${secretName}`);
  await shot("secret-add-desktop-light");
  await page.setViewportSize(PHONE);
  await dialog("Add a secret file").waitFor();
  await shot("secret-add-phone-light");
  await page.setViewportSize(DESKTOP);
  await settled();

  // --- secrets-add-web, from pasted text --------------------------------------------------------
  const pasted = `mend-verify-secret-file-text-${stamp}-0000000000`;
  registerSecret("secret-file-text", pasted);
  await page.getByLabel("Or paste its text", { exact: true }).fill(pasted);
  await button("Save file").click();
  await closed("Add a secret file");
  await toastSays(`Saved ~/${secretName}.`);
  const list = page.getByRole("list", { name: "Secret files" });
  await list.getByText(`~/${secretName}`, { exact: true }).waitFor();
  if ((await page.getByText(pasted).count()) > 0) throw new Error("the content is on the page");
  note(
    `pasted text saved as '~/${secretName}': a toast, the path listed with 'Added …', no content anywhere`,
  );
  await shot("secret-listed-desktop-light", true);

  // --- replace, from a chosen file --------------------------------------------------------------
  await page.getByRole("button", { name: `Replace ~/${secretName}` }).click();
  await dialog(`Replace ~/${secretName}`).waitFor();
  const chosen = `mend-verify-secret-file-chosen-${stamp}-0000000000`;
  registerSecret("secret-file-chosen", chosen);
  await page.getByLabel("Choose a file", { exact: true }).setInputFiles({
    name: "registry.conf",
    mimeType: "text/plain",
    buffer: Buffer.from(chosen),
  });
  await dialog(`Replace ~/${secretName}`).getByText("registry.conf", { exact: true }).waitFor();
  await shot("secret-replace-desktop-light");
  await button("Replace file").click();
  await closed(`Replace ~/${secretName}`);
  await toastSays(`Replaced ~/${secretName}.`);
  await list
    .locator("li")
    .filter({ hasText: secretName })
    .getByText(/^Replaced /)
    .waitFor();
  note(`Replace… with a chosen file: a toast, and the row reads 'Replaced …'`);

  // --- secrets-remove ---------------------------------------------------------------------------
  await page.getByRole("button", { name: `Remove ~/${secretName}` }).click();
  await dialog(`Remove ~/${secretName}?`).waitFor();
  await shot("secret-remove-desktop-light");
  await button("Remove file").click();
  await closed(`Remove ~/${secretName}?`);
  await toastSays(`Removed ~/${secretName}.`);
  await page.getByText(`~/${secretName}`, { exact: true }).waitFor({ state: "detached" });
  note(`Remove… names the file; Remove file: a toast, the row gone`);
  const left = (await api("GET", "/api/me/secret-files")).body;
  if ((left?.files?.length ?? 0) === 0) {
    await text("No secret files yet.").waitFor();
    await shot("no-secret-files-desktop-light", true);
  }

  // --- A page whose reads fail ------------------------------------------------------------------
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  await page.route("**/trpc/**", (route) => {
    const calls = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    ).split(",");
    const batch = new URL(route.request().url()).searchParams.has("batch");
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(batch ? calls.map(() => failure) : failure),
    });
  });
  await page.evaluate(() => {
    const router = window["__TSR_ROUTER__"];
    router.options.context.queryClient.clear();
    return router.invalidate();
  });
  await heading("This page didn't load");
  note("every read failed: 'This page didn't load' with Try again");
  await shot("error-desktop-light");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Dotfiles");
  note("Try again with the server back shows the page");
};
