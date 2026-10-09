# Secret files

A secret file is a file a person keeps in Mend, encrypted at rest, with a path under the workspace's
home directory: `~/.aws/credentials`, a kubeconfig, an `.npmrc` token file. Every session the person
owns receives their secret files before its agent starts, in every project. The content goes in
once and never comes back out: every surface lists path, size and dates only. A path under a
directory sessions capture (`.claude`, `.codex`, `.pi`, `.mend` and the like) is refused, and a file
that is not written at launch is named on the session page.

## Sub-features

- `secrets-list` lists each file's workspace path, size and last change.
- `secrets-add-cli` keeps a file from `--from <file>` or stdin with `mend secrets add`, or replaces
  the one at that path.
- `secrets-add-web` keeps a file from a chosen file or pasted text on Settings → Secret files.
- `secrets-path-refused` refuses a path outside the home or under a captured directory before
  anything is sent. The web also refuses raw `..` segments; the CLI validates the normalized path.
- `secrets-remove` removes one by path, from the CLI or the web.
- `secrets-delivery` writes the files into each new workspace home. In a per-person workspace,
  delivery runs at the person's first process and every later agent start. A file not written is
  named in the session's line.
- `secrets-mobile-list` shows the list on the phone.

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`; the `Secret files` panel lists, adds
  and removes.
- CLI: `mend secrets [list]`, `mend secrets add <path> [--from <file>]`, `mend secrets rm <path>`.
- Mobile: the `Settings` tab shows
  `Secret files · written into every session you launch, never captured` and the list, once the
  phone is paired. No add or remove.
- TUI, desktop, VS Code, Slack: no secret files surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in, and `<project>` is adopted.
- `mend secrets` prints `no secret files · mend secrets add <path> --from <file> keeps one`.
- `<scratch>` is an empty directory the run made. Run
  `printf 'verify-token\n' > <scratch>/token`. The value is disposable; it is not a real credential.
- For the mobile step, the Expo web app is paired to `<web>` (see
  [Pairing devices](./pairing-devices.md)).

- **CLI add.** Run `mend secrets add .verify-mend/token --from <scratch>/token`. Stdout is
  `created ~/.verify-mend/token · 13 B · sessions launched from now on receive it`. Exit code `0`.
- **CLI add from stdin.** Run `printf 'two\n' | mend secrets add .verify-mend/stdin`. Stdout starts
  `created ~/.verify-mend/stdin · 4 B`.
- **CLI replace.** Run the first add again. Stdout starts `replaced ~/.verify-mend/token`.
- **CLI list.** Run `mend secrets`. Two lines: `~/.verify-mend/stdin` and `~/.verify-mend/token`,
  each with its size and `YYYY-MM-DD HH:MM`; the token line ends `· replaced 1 time`. No content
  appears.
- **CLI refusal.** Run `mend secrets add .claude/verify --from <scratch>/token`. Stderr is
  `mend: .claude/verify is under .claude, which sessions capture`. Exit code `1`. Run
  `mend secrets add /etc/verify --from <scratch>/token`. Stderr starts
  `mend: /etc/verify is outside your home directory`. Exit code `1`. `mend secrets` still lists two
  files.
- **Web list.** Run `await page.goto("<web>/settings")`. Under the heading `Secret files`, the list
  holds `~/.verify-mend/stdin` and `~/.verify-mend/token`, the latter with
  `13 B · <date> · replaced 1×`. The footer reads `2 kept · up to 64 · each at most 256 KB`.
- **Web refusal.** Run
  `await page.getByRole("textbox", { name: /^Path in the workspace/ }).fill(".codex/verify")`. The
  line `.codex/verify is under .codex, which sessions capture` appears and
  `Add secret file` is disabled.
- **Web add from text.** Run
  `await page.getByRole("textbox", { name: /^Path in the workspace/ }).fill("~/.verify-mend/web")`,
  then `await page.getByRole("textbox", { name: "Or paste its text" }).fill("web\n")`, then
  `await page.getByRole("button", { name: "Add secret file" }).click()`. The button reads
  `Saving…`, then the footer reads `created ~/.verify-mend/web · 4 B` and the list gains
  `~/.verify-mend/web`.
- **Web add from a file.** Fill the path with `.verify-mend/file`, then run
  `await page.getByRole("button", { name: "Choose file" }).setInputFiles({ name: "token", mimeType: "text/plain", buffer: Buffer.from("file\n") })`.
  The line beside it reads `token · 5 B`, and `Or paste its text` is disabled. Add it; the list
  gains `~/.verify-mend/file`.
- **Web remove.** Run
  `await page.getByRole("listitem").filter({ hasText: "~/.verify-mend/web" }).getByRole("button", { name: "Remove" }).click()`.
  The button reads `Removing…`, the row leaves, and the footer reads `removed ~/.verify-mend/web`.
- **Session receives them.** Run
  `mend run --project <project> -- sh -c 'wc -c < ~/.verify-mend/token > SECRET-SEEN.md'`. Exit
  code `0`. The change (see [Review a change](./review-change.md)) holds `SECRET-SEEN.md` with
  `13`, and nothing under `.verify-mend` appears among the changed files.
- **Mobile list.** In the Expo web app at 390x844, run
  `await page.getByRole("tab", { name: "Settings" }).click()`. The text
  `Secret files · written into every session you launch, never captured` is visible, then
  `~/.verify-mend/token` with a line `13 B · <date>`.
- **CLI remove.** Run `mend secrets rm .verify-mend/token`. Stdout is
  `removed ~/.verify-mend/token · sessions launched from now on do not receive it`. Run it again:
  stdout is `~/.verify-mend/token: not kept`. Remove the rest the same way; `mend secrets` then
  prints the empty line from the preconditions.
- **Proof.** Keep every `mend secrets` transcript with exit codes, the ARIA snapshot and screenshot
  of the Secret files panel before and after the web add and remove, the mobile screenshot, and the
  `SECRET-SEEN.md` diff. No artifact may contain a file's content beyond its byte count.

## Gotchas

- The path field's accessible name is its whole wrapping label, including the hint below it:
  `Path in the workspace relative to the home directory · a path already kept is replaced`. Match
  with `/^Path in the workspace/`.
- `Choose file` is a visually hidden file input labelled by a styled `<label>`. Playwright exposes
  the input as a button named `Choose file`; call `setInputFiles` on it, not `click`.
- Each list row's `Remove` button is named only `Remove`. Scope it to the row (`listitem` filtered
  by the path text). A finding: no row-scoped name. The settings page also has dotfiles `Remove`
  buttons.
- The footer status (`created …`, `removed …`) and the red error line are plain text, not
  `role="status"` or `role="alert"`.
- The web form trims whitespace and a leading `~/`, then validates the path without normalizing
  it. It refuses `a/../token`. The CLI maps an absolute path under the CLI machine's home to a
  workspace path and normalizes before validation, so `a/../token` becomes `token`. A normalized
  path that still escapes the home or names a captured directory is refused.
- Never write a secret file's content into the worktree in a recipe: the worktree is captured. Prove
  delivery with a byte count or a `test -f`, as above, and use disposable values only.
- A file is at most 256 KB, at most 64 files per person. Shared-home workspaces receive files at
  launch. In per-person homes, delivery runs at the person's first process and every later agent
  start, including within an existing workspace. A saved change reaches that home at the next
  delivery.
- A session that joins a workspace someone else launched (shared home) receives none of the
  joiner's files. Its summary line reads
  `secret files · <n> not written · this workspace is another person's · ~/<path>`. A disposable
  instance with one account avoids that branch.
- The mobile list appears only when the phone is paired, and is plain text with no list role.
