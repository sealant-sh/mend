// Settings → the organization → Folders and references in the new web app (route PR 50,
// SLNT-1164): the organization's folders (new, upload files, show and delete files, rename,
// delete) and its reference repositories (add, fetch again, remove).
//
//   pnpm verify drive new-web --recipe new-web-settings-folders
//
// Feature ids: references-folders.md `folder-web` (create, upload, delete files, remove, plus the
// rename the server gained in this PR, S19) and `ref-refresh-remove`. Everything is real on the
// stack: the folder and its files go to the stack's store, and the reference is a real clone of a
// small public repository (the stack reaches GitHub). Recorded answers (tRPC answers the recipe
// writes): a member's role, a delete the server refuses because a project picks the folder, and a
// read that fails. The recipe deletes the folder and the reference it made.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const REFERENCE_URL = "https://github.com/octocat/Hello-World";

const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const stamp = String(Date.now()).slice(-6);
  const folder = `verify-notes-${stamp}`;
  const renamed = `verify-runbooks-${stamp}`;
  const reference = `verify-hello-${stamp}`;
  const other = `verify-other-${stamp}`;
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
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization/folders");
    await heading("Folders and references");
  };
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor({
      timeout: 120_000,
    });
  const dialog = visible(page.getByRole("dialog"));
  const folders = () => visible(page.getByRole("table", { name: "Folders" }));
  const row = (name) => folders().getByRole("row", { name, exact: true });
  const menu = async (name) => {
    await visible(page.getByRole("button", { name: `Actions for ${name}` })).click();
    await visible(page.getByRole("menu")).waitFor();
  };
  const choose = (item) => visible(page.getByRole("menuitem", { name: item })).click();

  // tRPC answers this recipe writes, by procedure: `{ error }`, or `{ edit }` on the real answer.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    // A recorded refusal must never reach the server: only fetch when a call needs the real answer.
    const needsReal = paths.some((p) => !stubs.has(p) || stubs.get(p).edit !== undefined);
    const real = needsReal ? await route.fetch() : null;
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = real === null ? 200 : real.status();
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.edit !== undefined) {
        const data = answers[index]?.result?.data;
        return data === undefined ? answers[index] : { result: { data: stub.edit(data) } };
      }
      status = paths.length === 1 ? 422 : 207;
      return {
        error: {
          json: {
            message: stub.error,
            code: -32603,
            data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422 },
          },
        },
      };
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
  await navigate("/settings/organization/folders");
  await heading("Folders and references");
  await visible(page.getByText(/^Everyone in /)).waitFor();
  note("the page under Everyone in <organization>, opened from the settings sidebar's address");
  await shot("folders-start-desktop-light");

  try {
    // --- folder-web: new folder, upload, files, delete a file, rename ---------------------------
    await visible(page.getByRole("button", { name: "New folder…" })).click();
    await heading("New folder");
    await dialog.getByLabel("Name").fill("Not OK");
    await dialog.getByRole("button", { name: "Make folder" }).click();
    await dialog.getByText(/is not a usable folder name/).waitFor();
    note("a name the server refuses is said under the field");
    await shot("folders-new-refused-desktop-light");
    await dialog.getByLabel("Name").fill(folder);
    await dialog.getByRole("button", { name: "Make folder" }).click();
    await toast(`Made the folder ${folder}.`);
    await row(folder).waitFor();
    note(`folder-web: made ${folder}; its row reads 0 files`);

    await page
      .locator(`input[data-upload-to="${folder}"][data-upload-kind="files"]`)
      .setInputFiles([
        { name: "a.md", mimeType: "text/markdown", buffer: Buffer.from("# Runbook A\n") },
        { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("restart the worker\n") },
      ]);
    await toast(`Added 2 files to ${folder}.`);
    const files = visible(page.getByRole("region", { name: `Files in ${folder}` }));
    await files.getByText("a.md", { exact: true }).waitFor();
    await files.getByText("b.txt", { exact: true }).waitFor();
    await row(folder).getByText("2", { exact: true }).waitFor();
    note("folder-web: uploaded two files; the files show under the row and the row counts 2");
    await shot("folders-uploaded-desktop-light");
    await paint("dark");
    await shot("folders-uploaded-desktop-dark");
    await paint("light");

    await files.getByRole("button", { name: "Delete b.txt" }).click();
    await files.getByText("b.txt", { exact: true }).waitFor({ state: "detached" });
    note("folder-web: deleted b.txt; the list keeps a.md");

    await menu(folder);
    await shot("folders-menu-desktop-light");
    // A second folder, to rename onto: the server refuses a name another folder has.
    const made = await page.evaluate(
      async (name) =>
        (
          await fetch("/api/organization/folders", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          })
        ).status,
      other,
    );
    expect(`made ${other}`, made === 200);
    await reopen();
    await row(other).waitFor();
    await menu(folder);
    await choose("Rename…");
    await heading(`Rename ${folder}`);
    await dialog.getByLabel("New name").fill(other);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await dialog.getByText(`A folder named "${other}" already exists.`).waitFor();
    note(`renaming onto ${other}, which another folder has, is refused under the field (real)`);
    await shot("folders-rename-taken-desktop-light");
    await dialog.getByLabel("New name").fill(renamed);
    await shot("folders-rename-dialog-desktop-light");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await toast(`Renamed the folder to ${renamed}.`);
    await row(renamed).waitFor();
    note(`S19: renamed ${folder} to ${renamed} (real, the server's new rename)`);
    await shot("folders-renamed-desktop-light");
    await navigate("/settings/organization/audit-log");
    await heading("Audit log");
    await visible(page.getByText(`Renamed the folder ${folder} to ${renamed}`)).waitFor();
    note(`the Audit log reads "Renamed the folder ${folder} to ${renamed}"`);
    await shot("folders-renamed-audit-desktop-light");
    await navigate("/settings/organization/folders");
    await heading("Folders and references");

    // --- ref-refresh-remove: add a reference, fetch it again ------------------------------------
    await visible(page.getByRole("button", { name: "Add reference…" })).click();
    await heading("Add reference");
    await dialog.getByLabel("Repository").fill(REFERENCE_URL);
    await dialog.getByLabel("Name").fill(reference);
    await shot("folders-add-reference-dialog-desktop-light");
    await dialog.getByRole("button", { name: "Add reference" }).click();
    await toast(`Added the reference ${reference}.`);
    const refRow = visible(
      page.getByRole("table", { name: "References" }).getByRole("row", { name: reference }),
    );
    await refRow.getByRole("cell", { name: "github.com/octocat/Hello-World" }).waitFor();
    note(`added the reference ${reference}, a real clone of ${REFERENCE_URL}`);
    await refRow.getByRole("button", { name: "Fetch again" }).click();
    await toast(`Fetched ${reference} again.`);
    note("ref-refresh-remove: Fetch again fetched it (real)");
    await shot("folders-references-desktop-light");
    await page.setViewportSize(PHONE);
    await settled();
    await visible(page.getByText(reference, { exact: true })).waitFor();
    // The Fetch again toast would cover the reference's row.
    await page
      .getByRole("region", { name: /Notifications/ })
      .getByText(`Fetched ${reference} again.`)
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => undefined);
    await shot("phone-folders-rows-light");
    await page.setViewportSize(DESKTOP);
    await settled();
    note("phone: each folder and reference is one row with its facts under the name and a … menu");

    // --- A member: everything to read, nothing to change (recorded role) ------------------------
    stubs.set("organization.current", {
      edit: (data) => ({ ...data, json: { ...data.json, role: "member" } }),
    });
    await reopen();
    await row(renamed).waitFor();
    expect(
      "a member sees no button that changes a folder or a reference",
      (await page
        .getByRole("button", { name: /New folder|Add reference|Upload files|Fetch again/ })
        .count()) === 0,
    );
    note("a member (recorded role) reads both lists with no button that changes them");
    await shot("folders-member-desktop-light");
    stubs.delete("organization.current");
    await reopen();

    // --- Delete: refused while a project picks it (recorded), then deleted ----------------------
    await menu(renamed);
    await choose("Delete folder…");
    await heading(`Delete the ${renamed} folder?`);
    await dialog.getByText("Mend deletes its 1 file").waitFor();
    await shot("folders-delete-dialog-desktop-light");
    stubs.set("folders.remove", {
      error: "A project mounts this folder. Deselect it there first.",
    });
    await dialog.getByRole("button", { name: "Delete folder" }).click();
    await dialog
      .getByText(/^Mend didn't delete the folder\. A project mounts this folder/)
      .waitFor();
    note("a delete the server refuses (recorded) is said in the dialog, which stays open");
    stubs.delete("folders.remove");
    await dialog.getByRole("button", { name: "Delete folder" }).click();
    await toast(`Deleted the folder ${renamed}.`);
    await row(renamed).waitFor({ state: "detached" });
    note("folder-web: deleted the folder (real); its row is gone");

    // --- Remove the reference -------------------------------------------------------------------
    await menu(reference);
    await choose("Remove reference…");
    await heading(`Remove the ${reference} reference?`);
    await shot("folders-remove-reference-dialog-desktop-light");
    await dialog.getByRole("button", { name: "Remove reference" }).click();
    await toast(`Removed the reference ${reference}.`);
    note("ref-refresh-remove: removed the reference (real)");
  } finally {
    stubs.clear();
    const api = (method, url, body) =>
      page.evaluate(
        async ({ verb, address, payload }) =>
          (
            await fetch(address, {
              method: verb,
              headers: { "content-type": "application/json" },
              ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            })
          ).status,
        { verb: method, address: url, payload: body },
      );
    // Whatever the run made goes, however far it got.
    {
      const listed = await page.evaluate(async () => ({
        folders: await (await fetch("/api/organization/folders")).json(),
        references: await (await fetch("/api/references")).json(),
      }));
      for (const one of listed.folders)
        if (one.name === folder || one.name === renamed || one.name === other)
          note(
            `cleanup: deleted ${one.name}: ${await api("DELETE", `/api/organization/folders/${one.id}`)}`,
          );
      for (const one of listed.references)
        if (one.name === reference)
          note(`cleanup: removed ${one.name}: ${await api("DELETE", `/api/references/${one.id}`)}`);
    }
  }

  // --- Empty, and a read that fails --------------------------------------------------------------
  await reopen();
  const empty = await page.getByText(/^No folders yet\./).count();
  if (empty > 0) {
    note("with no folder on the stack, the Folders list says so");
    await shot("folders-empty-desktop-light");
  }
  stubs.set("folders.list", { error: "The verify recipe failed this read on purpose." });
  await clearCache();
  await navigate("/settings/profile");
  await heading("Profile");
  await navigate("/settings/organization/folders");
  await heading("This page didn't load");
  note("a read that fails shows the error screen with Try again");
  await shot("folders-error-desktop-light");
  stubs.delete("folders.list");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Folders and references");

  // --- Phone ------------------------------------------------------------------------------------
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await navigate("/settings/organization/folders");
  await visible(page.getByRole("button", { name: "New folder…" })).waitFor();
  const add = visible(page.getByRole("button", { name: "New folder…" }));
  const height = (await add.boundingBox())?.height ?? 0;
  if (height < 44) throw new Error(`New folder… is ${height}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-folders-${theme}`);
  }
  await paint("light");
  await add.click();
  await visible(page.getByText("New folder", { exact: true })).waitFor();
  await shot("phone-folders-new-sheet-light");
  await page.keyboard.press("Escape");
  await page.setViewportSize(DESKTOP);
  note("phone: the actions fill the width at 44px, New folder opens as a sheet");
};

function expect(what, ok) {
  if (!ok) throw new Error(what);
}
