# Project environment

A project holds two lanes of environment input that every future workspace process starts with:
Configuration (plaintext names and values a user can read back) and Secrets (encrypted on the
machine, write-only, shown only as `value set`). A user adds entries on the project's Setup tab with
the `Add variables` composer, edits or removes them in the `Configuration` and `Secrets` panels, or
loads a `.env` file with `mend env load` and lists names with `mend env show`. Secret-looking names
route to Secrets on their own. Changes apply from the next workspace launch, a resume included;
running workspaces keep what they started with. Variables and secrets belong to one project: no
organization or instance default supplies them.

## Sub-features

- `env-composer` adds Key/Value rows on the web, with live lane hints, `Sensitive` on or off, and a
  per-name save report.
- `env-import` expands a pasted or imported `.env` into composer rows.
- `env-routing` sends secret-looking names to Secrets and refuses reserved names with a reason.
- `env-configuration` lists, edits, renames, copies and removes plaintext variables.
- `env-secrets` lists secret names, replaces or renames a secret, and removes it; values never come
  back.
- `env-load-cli` loads a `.env` with `mend env load`, with `--secret` for all names or named ones.
- `env-show-cli` lists stored names per lane with `mend env show`, never a value.
- `env-delivery` hands both lanes to the next launched workspace as environment variables.
- `env-not-inherited` keeps variables per project: Settings holds no variable or secret defaults.

## How to get to it (user POV)

- Web: a project's Setup tab (`/projects/<id>/setup`, the `Setup` link in the `Project` navigation),
  sections `Add variables`, `Configuration` and `Secrets` (anchors `#variables`, `#secrets`). Only
  the project's creator and organization owners see them; other members read a note in their place.
- CLI: `mend env load [file] [--project <p>] [--secret [A,B]]`, `mend env show [--project <p>]`
  (bare `mend env` is `show`).
- TUI, desktop, mobile, VS Code, Slack: no surface for project variables.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in as the creator of `<project>` (or an
  organization owner), and `<project>` is adopted.
- `mend env show --project <project>` prints `  nothing stored — load a file: mend env load`.
- A scratch file `/tmp/verify-env/verify.env` holds three lines: `CLI_MODE=from-cli`,
  `CLI_API_TOKEN=cli-secret` and `MEND_X=1`.
- `/tmp/verify-env/import.env` holds `IMPORT_MODE=from-file` and `IMPORT_API_TOKEN=import-secret`,
  one per line. The paste step needs a Chromium context with clipboard permissions on `<web>`. These
  are disposable fixture values.
- Steps below scope controls to one Setup section, because sections have no region role (see
  Gotchas):
  `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Open Setup.** From `<web>/projects`, open `<project>` and choose
  `page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Setup" })`. The
  heading `Setup` and the headings `Add variables`, `Configuration` and `Secrets` are visible.
  `Configuration` reads `No variables yet. …`; `Secrets` reads `No secrets yet. …`.
- **Refused name.** Run
  `await section("Add variables").getByRole("textbox", { name: "Key 1" }).fill("MEND_X")`. The line
  under the key reads `The MEND_ prefix is reserved for Mend itself.`, the composer reads
  `Fix or remove the row marked above to save.`, and its `Save` button is disabled.
- **Two rows, plaintext.** Run
  `await section("Add variables").getByRole("textbox", { name: "Key 1" }).fill("APP_MODE")` and
  `await section("Add variables").getByLabel("Value 1", { exact: true }).fill("verify-mode")`, then
  `await section("Add variables").getByRole("button", { name: "+ Add another" }).click()`, then
  `getByRole("textbox", { name: "Key 2" })` = `STRIPE_API_KEY` and
  `getByLabel("Value 2", { exact: true })` = `sk-verify`. Both key lines read `→ secret`, because
  `Sensitive` starts on. Run `await section("Add variables").getByRole("switch").click()`. The
  switch reports `aria-checked="false"` and reads `Disabled`; the `APP_MODE` line now reads
  `→ configuration · plaintext` and `STRIPE_API_KEY` still reads `→ secret`.
- **Reveal a value.** Run
  `await section("Add variables").getByRole("button", { name: "Show value 1" }).click()`. The button
  is renamed `Hide value 1` and reports `aria-pressed="true"`, and the value field
  (`getByLabel("Value 1", { exact: true })`) shows `verify-mode` in clear.
- **Save.** Run `await section("Add variables").getByRole("button", { name: "Save 2" }).click()`.
  The button reads `Saving…`, then the report under the composer reads `Saved 2` with list items
  `APP_MODE · configuration · plaintext · created` and `STRIPE_API_KEY · secret · created`. The
  saved rows leave the composer.
- **Read back.** In `section("Configuration")`, a list item holds `APP_MODE` and `verify-mode` with
  buttons `Copy`, `Edit` and `Remove`. In `section("Secrets")`, a list item holds `STRIPE_API_KEY`
  and `value set · updated <time>` with `Replace` and `Remove`, and no value.
- **Paste a .env (`env-import`).** Reload Setup so the composer has one blank row. Run
  `await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })`,
  `await page.evaluate(() => navigator.clipboard.writeText("PASTE_MODE=from-paste\nPASTE_API_TOKEN=paste-secret\n"))`,
  then
  `await section("Add variables").getByRole("textbox", { name: "Key 1", exact: true }).press("ControlOrMeta+V")`.
  The keys `Key 1` and `Key 2` read `PASTE_MODE` and `PASTE_API_TOKEN`; the fields labelled
  `Value 1` and `Value 2` hold `from-paste` and `paste-secret` and remain password inputs. Both rows
  read `→ secret`. Click the composer's only `switch`; it reports `aria-checked="false"`, and only
  `PASTE_MODE` changes to `→ configuration · plaintext`. Choose
  `getByRole("button", { name: "Save 2", exact: true })` in the composer. The report reads
  `Saved 2`, with `PASTE_MODE · configuration · plaintext · created` and
  `PASTE_API_TOKEN · secret · created`; the rows clear. Reload Setup. `Configuration` lists
  `PASTE_MODE` with `from-paste`; `Secrets` lists `PASTE_API_TOKEN` with `value set` and no value.
- **Import a .env file (`env-import`).** Reload Setup for a blank composer. Start
  `const imported = page.waitForEvent("filechooser")`, click
  `await section("Add variables").getByRole("button", { name: "Import .env", exact: true }).click()`,
  then `await (await imported).setFiles("/tmp/verify-env/import.env")`. Wait until `Key 1` and
  `Key 2` read `IMPORT_MODE` and `IMPORT_API_TOKEN`; `Value 1` and `Value 2` hold `from-file` and
  `import-secret` and remain password inputs. Both rows read `→ secret`. Click the composer's
  `switch` to turn `Sensitive` off and choose `Save 2`. The report reads `Saved 2`, with
  `IMPORT_MODE · configuration · plaintext · created` and `IMPORT_API_TOKEN · secret · created`; the
  rows clear. Reload Setup. `Configuration` lists `IMPORT_MODE` with `from-file`; `Secrets` lists
  `IMPORT_API_TOKEN` with `value set` and no value.
- **Rename a variable.** Run
  `await section("Configuration").getByRole("listitem").filter({ hasText: "APP_MODE" }).getByRole("button", { name: "Edit" }).click()`,
  then `getByRole("textbox", { name: "Name" })` = `APP_STAGE` and
  `getByRole("button", { name: "Save", exact: true }).click()`, all inside
  `section("Configuration")`. Its status (`section("Configuration").getByRole("status")`) reads
  `Renamed APP_MODE to APP_STAGE.`
- **Replace a secret.** In `section("Secrets")`, choose `Replace` on the `STRIPE_API_KEY` item. The
  form shows the textbox `Name` and the password field `New value` (`getByLabel("New value")`), with
  placeholder `leave empty to keep the stored value`. Fill `New value` with `sk-verify-2` and choose
  `Save`. The status reads `Replaced secret STRIPE_API_KEY.`
- **Remove takes two clicks.** In `section("Configuration")`, choose `Remove` on `APP_STAGE`. The
  same button now reads `Remove? Running workspaces keep it`. Choose it again. The status reads
  `Removed APP_STAGE.` and the item is gone. Recreate it for the delivery step with the composer
  (`APP_MODE` = `verify-mode`, `Sensitive` off).
- **CLI load.** Run `mend env load /tmp/verify-env/verify.env --project <project>`. Exit code `0`.
  Stdout reads `✓ loaded verify.env into <project>`, then one line per name:
  `  CLI_MODE  configuration · created · plaintext`, `  CLI_API_TOKEN  secret · created`,
  `  MEND_X  rejected · The MEND_ prefix is reserved for Mend itself.` (names padded to one width),
  and last
  `  configuration r<n> · secrets r<n> — applies from the next workspace launch, including resume; running workspaces keep what they started with`.
- **CLI load, all secret.** Run
  `mend env load /tmp/verify-env/verify.env --project <project> --secret`. `CLI_MODE` now reads
  `secret · moved`: the plaintext copy is gone and the secret owns the name.
- **CLI show.** Run `mend env show --project <project>`. Exit code `0`. The first line reads
  `<project> · configuration r<n> · secrets r<n> · cluster r<n>`. Then `APP_MODE` reads
  `configuration · plaintext`, and `STRIPE_API_KEY`, `CLI_API_TOKEN` and `CLI_MODE` read
  `secret · value set, never shown`. No value appears anywhere in stdout.
- **Second view on the web.** Reload Setup. `section("Secrets")` lists `CLI_API_TOKEN` and
  `CLI_MODE`; `section("Configuration")` lists `APP_MODE` and no `CLI_MODE`.
- **Delivery to a session.** Run
  `mend run --project <project> -- sh -c 'printf "%s\n" "$APP_MODE" > ENV.txt; test -n "$STRIPE_API_KEY" && echo "secret present" >> ENV.txt'`.
  Exit code `0`. Open its `review · <web>/sessions/<id>` page and choose `Review the change`. The
  change adds `ENV.txt` with the lines `verify-mode` and `secret present`.
- **Not inherited.** Go to `<web>/settings`. No panel there holds variables or secrets; the
  `Workspace environment` panels are the image (see [Workspace images](./workspace-images.md)).
- **Proof.** Save `await page.locator("body").ariaSnapshot()` and a screenshot of Setup showing the
  `Configuration` and `Secrets` lists and the composer report, the expanded paste and file-import
  rows before saving and both saved lists after reload, plus the `mend env load`, `mend env show`
  and `mend run` transcripts with exit codes, and the review page showing `ENV.txt`.

## Gotchas

- The Setup sections are `section` elements without `aria-labelledby`, so none has the region role.
  Scope by their `h2` heading as above. Every panel has its own `Save`, `Cancel` and `Remove`, and
  the composer's `Save` changes its name with the row count (`Save`, `Save 2`, …).
- The `Sensitive` switch has no accessible name of its own: its name is its state text, `Enabled` or
  `Disabled` (`apps/web/src/routes/projects.$projectId.setup.tsx:1545`). It is the only `switch` on
  the page today; ask for the role, not the name.
- Composer values and the secret editor's `Value`/`New value` are password inputs until revealed, so
  they have no `textbox` role. Use `getByLabel("Value 1", { exact: true })`, not
  `getByRole("textbox")`. The configuration editor's `Value` is a textarea and is a textbox.
- `Sensitive` starts on, so a composer save with default settings stores every row as a secret. A
  later plaintext load of the same name is refused per name:
  `Already stored as a secret. Load it with --secret to replace the secret, or remove the secret first to store it as plaintext configuration.`
- The edit form's title (`Edit <name>`) is a paragraph and the form has no name. Scope it by its
  section and its `Name` textbox.
- Opening an editor disables every row's buttons in that panel until `Save` or `Cancel`.
- `mend env load --secret <word>` reads `<word>` as a comma list of names unless it contains `.` or
  `/`. Put the file first: `mend env load <file> --secret`.
- Secret values are masked in recorded output. Prove delivery with a presence test, never by
  printing a secret into the change.
- Names that look secret but carry no marker (`DATABASE_URL`) land as plaintext. The CLI warns for
  names ending `_URL`, `_URI` or `_DSN` and suggests `--secret <names>`; the web composer does not.
- `mend env` with no `--project` resolves the project from the current directory and exits `1` with
  `mend: no adopted project matches <cwd> — …` elsewhere. Pass `--project` in a drive.
- Secret files (whole files placed in the home directory) are a separate feature:
  [Secret files](./secret-files.md).
