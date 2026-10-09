# Skills

A skill is a named bundle of instruction files, a `SKILL.md` plus support files, that the agent
loads when it applies. Mend keeps two libraries on the server: the person's own (the web app calls
these global skills), which follows them into every project, and each project's, which applies to
every session in it. A user pushes a local skills directory with `mend skills push`, or creates and
edits skills on the web. Each new workspace receives the person's library, unless the project turns
global skills off, plus the project's; a project skill replaces a global one of the same name.

## Sub-features

- `skills-list` lists a library: name, file count, size and description.
- `skills-push` uploads every bundle in a local directory (`~/.agents/skills` by default) and
  reports new, updated and unchanged counts.
- `skills-push-prune` also removes library skills the directory no longer has.
- `skills-push-project` pushes into, or lists, a project's library with `--project`.
- `skills-web-create` creates a one-file skill from the `New skill` form, in either library.
- `skills-web-edit` edits a skill's description and files, adds or removes a support file, and
  saves at the loaded revision.
- `skills-web-remove` removes a skill after a second confirming click.
- `skills-project-inherit` turns the project's `Use global skills` switch on or off and shows each
  global skill as `Inherited`, `Overridden here` or `Off`.
- `skills-delivery` writes the resolved skills into a new workspace's harness home.

## How to get to it (user POV)

- Web: `Skills` in the primary navigation opens `/skills` (`Your skill library`); a skill card opens
  `/skills/<skillId>`.
- Web: a project's `Setup` tab has a `Skills` section; `/projects/<id>/skills` redirects to
  `/projects/<id>/setup#skills`, which opens the section. Its `Manage global skills →` link opens
  `/skills`.
- CLI: `mend skills [list] [--project [p]]`,
  `mend skills push [--project [p]] [--prune] [--dir <path>]`.
- TUI, desktop, mobile, VS Code, Slack: no skills surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in as a person who can manage `<project>` (its
  creator or an organization owner), and `<project>` is adopted.
- The person's library and `<project>`'s are empty: `mend skills` prints
  `no skills in your library — push a local one: mend skills push`, and
  `mend skills --project <project>` prints `no skills in <project> — push a local one: mend skills push`.
- `<scratch>` is an empty directory the run made. Create
  `<scratch>/skills/verify-cli-skill/SKILL.md` holding
  `---\ndescription: Verify skill for Mend's map.\n---\nSay hello.\n`, and
  `<scratch>/skills/notes/README.md` holding anything.

- **CLI push.** Run `mend skills push --dir <scratch>/skills`. Stdout shows
  `  notes: no SKILL.md — skipped`, then
  `pushed 1 skill from <scratch>/skills to your library · 1 new · 0 updated · 0 unchanged` and
  `sessions receive them from the next launch`. Exit code `0`.
- **Unchanged push.** Run the same command again. The counts read
  `0 new · 0 updated · 1 unchanged`.
- **CLI list.** Run `mend skills`. One entry starts `  verify-cli-skill` with `1 file · <n> B`,
  followed by the line `    Verify skill for Mend's map.`
- **CLI refusal.** Run `mend skills push --dir <scratch>/missing`. Stderr is
  `mend: <scratch>/missing is not a readable directory`. Exit code `1`.
- **Web library.** Run `await page.goto("<web>/skills")`. The heading `Your skill library` is
  visible and a link whose name starts with `verify-cli-skill`
  (`page.getByRole("link", { name: /^verify-cli-skill/ })`) is listed.
- **Web create.** Run `await page.getByRole("button", { name: "New skill" }).click()`, then
  `await page.getByRole("textbox", { name: "name (lowercase, dashes — becomes the directory name)" }).fill("verify-web-skill")`
  and
  `await page.getByRole("textbox", { name: "description — when should an agent reach for this?" }).fill("Web-made skill.")`.
  Leave the `SKILL.md` template as it is. Run
  `await page.getByRole("button", { name: "Create", exact: true }).click()`. The button reads
  `Creating…`, the form closes, and a link whose name starts with `verify-web-skill` joins the list.
- **Open and add a file.** Run `await page.getByRole("link", { name: /^verify-web-skill/ }).click()`.
  The heading `verify-web-skill` is visible and the line reads
  `your library · revision 1 · 1 file · <n>B`. Run
  `await page.getByRole("textbox", { name: "add file (references/notes.md)" }).fill("references/notes.md")`
  and press `Enter`. The buttons `references/notes.md` and `Remove references/notes.md` appear and
  `unsaved changes` shows.
- **Save.** Run `await page.getByRole("button", { name: "Save", exact: true }).click()`. The button
  reads `Saving…`, then the line reads `revision 2 · 2 files`. Run `mend skills`:
  `verify-web-skill` shows `2 files`.
- **Remove.** Run `await page.getByRole("button", { name: "Remove", exact: true }).click()`. It now
  reads `Really remove?`. Run
  `await page.getByRole("button", { name: "Really remove?" }).click()`. The browser lands on
  `/skills` and `verify-web-skill` is no longer listed.
- **Project library.** Run `mend skills push --dir <scratch>/skills --project <project>`. Stdout
  shows `pushed 1 skill from <scratch>/skills to <project> · 1 new · 0 updated · 0 unchanged`. Run
  `mend skills --project <project>`: `verify-cli-skill` is listed.
- **Project section.** Run `await page.goto("<web>/projects/<id>/skills")`. The URL becomes
  `/projects/<id>/setup#skills` and the region `Skills`
  (`page.getByRole("region", { name: "Skills" })`) is expanded. The switch `Use global skills`
  (`page.getByRole("switch", { name: "Use global skills" })`) reports `aria-checked="true"`. Under
  `Global skills`, the row with the link `verify-cli-skill` (`exact: true`) reads `Overridden here`.
- **Turn global skills off.** Click the switch. It reports `aria-checked="false"`, the section's
  button is named `Skills Global skills off · 1 project skill`, and the global row reads `Off`.
  Click it again to restore `Inherited`/`Overridden here`.
- **Session receives them.** Run
  `mend run --project <project> -- sh -c 'ls ~/.claude/skills > SKILLS-SEEN.md'`. Exit code `0`.
  The change (see [Review a change](./review-change.md)) holds `SKILLS-SEEN.md` listing
  `verify-cli-skill`.
- **Prune.** Remove `<scratch>/skills/verify-cli-skill`, add
  `<scratch>/skills/verify-other/SKILL.md`, and run `mend skills push --dir <scratch>/skills --prune`.
  The counts end `· 1 removed`, and `mend skills` lists `verify-other` only.
- **Restore both libraries.** Open `<web>/skills` and click
  `await page.getByRole("link", { name: /^verify-other/ }).click()`. Remove it with
  `await page.getByRole("button", { name: "Remove", exact: true }).click()`, then
  `await page.getByRole("button", { name: "Really remove?" }).click()`. The browser returns to
  `/skills`. Open `<web>/projects/<id>/setup#skills` and click
  `await page.getByRole("link", { name: /^verify-cli-skill/ }).click()`, then use the same two
  removal clicks.
  The browser returns to `/projects/<id>/setup#skills`. Run `mend skills` and
  `mend skills --project <project>`; both print the empty-library lines from the preconditions.
- **Proof.** Keep every `mend skills` transcript with exit codes, the ARIA snapshot and screenshot
  of `/skills` after the create, of the skill page after the save, and of the project's `Skills`
  region with the switch on and off, and the `SKILLS-SEEN.md` diff.

## Gotchas

- The `New skill` form's name and description fields, and the skill page's description and
  add-file fields, have no label. Their names fall back to the placeholders quoted above, which
  change with the copy. A finding.
- The `SKILL.md` textarea in the `New skill` form, and the file editor textarea on the skill page,
  have no label, no placeholder and no accessible name. There is no stable handle to type a skill's
  contents. A finding; recipes leave the template as it is.
- A skill card's link name is the whole card: name, file count, size and description. Match with an
  anchored regex. On the project section, the global row link is named by the skill name alone; use
  `exact: true` to tell it from the project skill card below it.
- The skill page's `Remove` (the skill) and `Remove <path>` (a file) share a prefix: pass
  `exact: true`. The armed `Really remove?` resets when the button loses focus.
- File chips on the skill page are buttons named by path with no pressed state; the selected file is
  shown only by color.
- The project `Skills` section starts collapsed unless the URL hash is `#skills`; collapsed, its
  content is `hidden` and out of the accessibility tree. The section and its controls render only for
  a person who can manage the project.
- `--prune` removes every skill in that library the directory lacks, including ones made on the
  web. Run it only against a disposable library.
- `mend skills push --project` followed directly by another flag takes that flag as the project
  name: `mend skills push --project --prune` fails with `no adopted project named "--prune"`. Put
  `--project` last, or give it a name.
- Skill names are directory names lowercased. Binary files, files over 512 KB and bundles over 64
  files are skipped with a note line, not an error.
- Shared-home workspaces receive skills when created. Per-person homes receive them at the
  person's first process and every later agent start, including within an existing workspace.
  A launch never fails for skills; a delivery that fails is logged on the server only.
- Skills also land in `~/.codex/skills` and `~/.pi/agent/skills`. The docs' delivery table lists
  Claude Code and Codex only, not pi's directory.
