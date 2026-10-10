# References, folders and linked projects

Beside its worktree, a session can see three kinds of extra material, each chosen per project on the
Setup tab. References are read-only clones of upstream repositories that belong to the organization;
a selected one appears at `/workspace/ref/<name>`. Folders are directories Mend keeps for the
organization, created and filled by owners in Settings or with `mend folder`; a selected one appears
at `/workspace/home/<name>`, read-only unless the project lets sessions write. Linked projects are
other adopted projects whose worktree a session reads and writes at `/workspace/repos/<name>`. On a
single-organization install the operator also has `Mounted folders`, host paths mapped into
sessions. None of these is part of the reviewed change.

## Sub-features

- `ref-add` adds a reference (name, URL, optional ref) from a project's Setup tab; it is selected
  for that project.
- `ref-select` checks or unchecks a reference for a project's next sessions.
- `ref-refresh-remove` fetches a reference again, or removes it from the organization.
- `folder-cli` lists, creates, fills and removes organization folders with `mend folder`.
- `folder-web` creates a folder, uploads files or a directory, deletes files and removes the folder
  in `Settings → Folders`.
- `folder-select` selects a folder for a project, and `sessions may write` for it.
- `link-project` links another adopted project, with an optional worktree name, and removes the
  link.
- `host-mounts` maps a server path into sessions (`Mounted folders`; operator of a single install
  only).
- `extras-delivery` shows the selected material inside the next launched workspace.

## How to get to it (user POV)

- Web: a project's Setup tab, sections `References` (anchor `#references`), `Folders` (`#folders`),
  `Mounted folders` (`#mounts`, operator of a single install only) and `Linked projects` (`#links`).
- Web: `/settings`, panel `Folders` (anchor `#folders`): `New folder` for owners, each folder's file
  list, `Add files…`, `Add a folder…`, `Delete`, `Remove…`.
- CLI: `mend folder list`, `mend folder create <name>`, `mend folder push <name> <dir> [--replace]`,
  `mend folder rm <name>`. References, folder selection and links have no CLI.
- TUI, desktop, mobile, VS Code, Slack: no surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the instance's first account (organization owner and
  operator), and `<project>` and a second project `<other>` are adopted.
- `<ref-url>` is a small public repository the server can clone over HTTPS.
- A local directory `/tmp/verify-folder` holds `a.txt`, `sub/b.txt` and a `node_modules` directory
  with one file.
- `mend folder list` does not list `verify-fixtures` or `verify-web-fixtures`.
- The directory upload step needs a browser file chooser that accepts a directory path.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Create a folder.** Run `mend folder create verify-fixtures`. Exit code `0`, stdout
  `✓ created folder verify-fixtures`. Run it again: exit code `1`, stderr
  `mend: A folder named "verify-fixtures" already exists.`
- **Fill it.** Run `mend folder push verify-fixtures /tmp/verify-folder`. Stdout
  `✓ pushed 2 files to verify-fixtures · 1 skipped (skipped)`. Run
  `mend folder push verify-fixtures /tmp/verify-folder --replace`: the same count, and the folder
  holds exactly those two files.
- **List.** Run `mend folder list`. A line reads `verify-fixtures  created <YYYY-MM-DD>`.
- **See it in Settings.** Go to `<web>/settings`. In `section("Folders")`, the button whose name
  starts with `verify-fixtures` (`getByRole("button", { name: /^verify-fixtures/ })`) reports
  `aria-expanded="false"`. Choose it: it reports `true` and the list shows `a.txt · <size>` and
  `sub/b.txt · <size>`.
- **Create on the web (`folder-web`).** In `section("Folders")` on `<web>/settings`, run
  `await section("Folders").getByRole("textbox", { name: "Folder name", exact: true }).fill("verify-web-fixtures")`,
  then `await section("Folders").getByRole("button", { name: "New folder", exact: true }).click()`.
  Wait for the button `getByRole("button", { name: /^verify-web-fixtures/ })`. Reload Settings; that
  button still appears, initially `aria-expanded="false"`. Click it; it reports `true` and the file
  list reads `empty`.
- **Upload a file on the web.** Start `const filePick = page.waitForEvent("filechooser")`, then
  `await section("Folders").getByText("Add files…", { exact: true }).click()` and
  `await (await filePick).setFiles("/tmp/verify-folder/a.txt")`. The open folder reports
  `added 1 file` and lists `a.txt · <size>`. Reload and expand `verify-web-fixtures` again; `a.txt`
  is still listed. Keep only this folder expanded so the upload labels are unique.
- **Upload a directory on the web.** Start `const directoryPick = page.waitForEvent("filechooser")`,
  then `await section("Folders").getByText("Add a folder…", { exact: true }).click()` and
  `await (await directoryPick).setFiles("/tmp/verify-folder")`. The open folder reports
  `added 2 files · 1 left out (skipped)`. It lists `a.txt` and `sub/b.txt`, with no `node_modules`
  file or `verify-folder/` prefix. Reload and expand the folder; those two paths remain.
- **Delete a file on the web.** In the expanded folder, locate the file row with
  `const fileRow = section("Folders").locator("div").filter({ has: page.getByText(/^sub\/b\.txt ·/) }).filter({ has: page.getByRole("button", { name: "Delete", exact: true }) }).last()`.
  Run `await fileRow.getByRole("button", { name: "Delete", exact: true }).click()`. Wait until
  `sub/b.txt` is absent, then reload and expand the folder. Only `a.txt` remains.
- **Remove a folder on the web.** Locate the folder row with
  `const webFolder = section("Folders").locator("div").filter({ has: page.getByRole("button", { name: /^verify-web-fixtures/ }) }).filter({ has: page.getByRole("button", { name: "Remove…", exact: true }) }).last()`.
  Run `await webFolder.getByRole("button", { name: "Remove…", exact: true }).click()`. Buttons
  `Remove verify-web-fixtures` and `Cancel` appear. Click
  `await section("Folders").getByRole("button", { name: "Remove verify-web-fixtures", exact: true }).click()`.
  The folder button disappears. Reload Settings; it remains absent, and `mend folder list` no longer
  lists `verify-web-fixtures`.
- **Select the folder.** Open `<project>`'s Setup tab. In `section("Folders")`, run
  `await section("Folders").getByRole("checkbox", { name: "verify-fixtures" }).click()`. Once the
  save returns the checkbox reads checked (`toBeChecked()`) and a second checkbox
  `sessions may write` appears beside it, unchecked.
- **Add a reference.** In `section("References")` choose `+ add reference…`. Fill the textboxes by
  their placeholders: `name (effect)` = `verify-ref`, `https://github.com/Effect-TS/effect.git` =
  `<ref-url>`, and leave `ref (optional)` empty. Choose `add reference`. It reads `cloning…`, then
  the form closes and a row shows the checked checkbox `verify-ref`, buttons `refresh` and `remove`,
  and a line with the short head sha and `fetched <date>`.
- **Link a project.** In `section("Linked projects")` choose `+ link a project…`. In the form's
  combobox pick `<other>` (`selectOption({ label: "<other>" })`), fill `name (api)` = `verify-link`,
  leave `worktree (blank = the default branch's)` empty, and choose `link project`. A row reads
  `verify-link read-write` with the line `<other> · worktree <worktree>` and a `remove` button.
- **Delivery in capture mode.** Run
  `mend run --project <project> -- sh -c 'set -e; test -f /workspace/home/verify-fixtures/a.txt; test -f /workspace/home/verify-fixtures/sub/b.txt; test -d /workspace/ref/verify-ref; ls -R /workspace/home/verify-fixtures > EXTRAS.txt; ls /workspace/ref/verify-ref >> EXTRAS.txt'`.
  Exit code `0`. The change adds `EXTRAS.txt` listing `a.txt`, `sub` and `b.txt` and the top level
  of `<ref-url>`. Report linked-project delivery unreachable in capture mode; this command makes no
  `/workspace/repos` check.
- **Delivery on a co-located server with bind mounts.** Run
  `mend run --project <project> -- sh -c 'set -e; test -f /workspace/home/verify-fixtures/a.txt; test -f /workspace/home/verify-fixtures/sub/b.txt; test -d /workspace/ref/verify-ref; test -d /workspace/repos/verify-link; ls -R /workspace/home/verify-fixtures > EXTRAS.txt; ls /workspace/ref/verify-ref >> EXTRAS.txt; ls /workspace/repos >> EXTRAS.txt'`.
  Exit code `0`. `EXTRAS.txt` also lists `verify-link`. Both commands fail on a missing required
  path or failed listing; capture mode does not qualify for the bind-mount recipe.
- **Folder in use.** Run `mend folder rm verify-fixtures`. Exit code `1`, stderr
  `mend: A project mounts this folder. Deselect it there first.`
- **Refresh a reference.** Scope to the `verify-ref` row in `section("References")` and click
  `getByRole("button", { name: "refresh", exact: true })`. Wait for its `working…` state to end and
  its enabled `refresh` button to return; record the short head SHA and `fetched <date>`, then
  reload and read the row again. The calendar date can stay the same after a same-day refresh.
  Require a changed SHA only with a fixture whose upstream selected ref advanced before this
  refresh; an unchanged upstream can keep the same SHA.
- **Clean up.** Uncheck `verify-fixtures` in `section("Folders")`, choose `remove` on `verify-ref`
  and on `verify-link`. Run `mend folder rm verify-fixtures`: stdout
  `✓ removed folder verify-fixtures`, and `mend folder list` no longer lists it.
- **Mounted folders.** As the operator of a `MEND_TENANCY=single` install,
  `section("Mounted folders")` shows `+ add folder…`. It opens textboxes by placeholder
  `name (experiments)` and `/home/you/Developer/experiments`, the checkbox `read-only` (checked) and
  `add folder`. A saved row shows the name, `read-write` when unchecked, the host path and `remove`.
  Remove it again.
- **Proof.** Every `mend folder` transcript with exit codes; ARIA snapshots and screenshots of the
  `Folders`, `References` and `Linked projects` sections with the selections made; the review page
  showing `EXTRAS.txt`; web folder creation, upload reports, file deletion and folder removal with
  their reload readbacks; the reference row after refresh and reload.

## Gotchas

- The add forms for references, linked projects and mounted folders have no labels. Their inputs are
  named only by placeholders (`apps/web/src/components/project-setup.tsx:644-654`, `816-825`,
  `1174-1189`), and the linked-project picker is a `select` with no accessible name at all
  (`project-setup.tsx:800-815`): find it as the only combobox in `section("Linked projects")`.
- Rows in these sections are plain `div`s, not list items. `refresh` and `remove` repeat per row,
  and `remove` also appears in `Services`, `Mounted folders` and `Linked projects`. Scope to the
  section, then to the row by its name text.
- `remove` on a reference or a link acts on the first click: no confirmation. Removing a reference
  removes it from the organization, for every project that selected it.
- Owners add, refresh and remove references, cloning with their own Git access; a project's creator
  who is not an owner can only select them. `+ add reference…` is still shown to them, and the add
  is refused.
- `sessions may write` repeats once per selected folder with the same name. Scope it to the folder's
  row.
- In capture mode (the default store) a folder or reference arrives as a copy: writes to
  `/workspace/home/<name>` stay in that workspace and never reach the folder. Linked projects and
  host mounts are not delivered to captured workspaces at all, although `Linked projects` shows no
  note saying so (`Folders` does). Report the link and host-mount delivery unreachable in capture
  mode.
- In Settings, `Add files…` and `Add a folder…` are labels around hidden file inputs, not buttons
  (`apps/web/src/components/organization-settings.tsx:680-700`). Drive them through Playwright's
  file chooser after clicking the text; they have no role to ask for.
- The `Folders` and `References` checkboxes are controlled by the saved selection, which updates
  after a server round trip. Use `click()` and then wait for `toBeChecked()`; Playwright's `check()`
  can report that the click did not change the state.
- A folder row's button name is its whole text, `<name> created <date> · files`; match it with an
  anchored regular expression. Folder and file rows have no group role or accessible name. `Delete`
  repeats for every file and `Remove…` for every folder
  (`apps/web/src/components/organization-settings.tsx:571-600`, `666-676`); scope to the row by its
  folder button or file path text before choosing the action. File deletion has no confirm. Web
  folder removal requires `Remove…`, then `Remove <name>`; a selected folder is refused.
- `mend folder push` skips `.git`, `node_modules`, symlinks and files over 1 MiB and counts them;
  the skip reason for directories reads `skipped`. Without `--replace` files add beside what the
  folder holds.
- Changes apply to sessions launched afterwards; a running workspace keeps what it started with.
