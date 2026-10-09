# mend.toml and declared Services

A repository declares its Services once, in a `mend.toml` at its root: one `[service.<name>]`
table per Service with a `port`, an optional `command` (none means adopt a port something else
listens on), an optional `protocol` (`tcp` or `udp`) and an optional `browserScheme` (`http` or
`https`). Mend reads the file from the session's own worktree, so an agent can add a recipe in its
change. A project can also declare recipes on its Setup tab; sessions offer both as one-tap
launchers, and on a name collision the file wins and the project's recipe shows as `Shadowed`.
`mend service init` scaffolds the file from `package.json` scripts and Compose ports; nothing runs
until a user starts a recipe.

## Sub-features

- `toml-init` proposes a `mend.toml` from the repository's manifests and writes it on confirmation.
- `toml-recipes-card` lists the session's declared recipes on the session page's `Services` card,
  each with `Run` and its source (`mend.toml` or `project`).
- `toml-run-cli` starts a declared recipe with `mend service run [session] <name>` (shorthand
  `mend service <name>`).
- `toml-project-recipes` declares and removes project recipes in Setup's `Services` section.
- `toml-shadowed` shows a project recipe whose name the file also declares as `Shadowed`, not
  runnable.
- `toml-parse-error` reports a malformed file as a named error, never a guess.

## How to get to it (user POV)

- Repository: `mend.toml` at the root of the session's worktree.
- CLI: `mend service init [--yes]` in a checkout; `mend service run [session] <name> [--no-connect]`
  and `mend service <name>`.
- Web: a session page's `Services` card (recipe rows and `Shadowed` rows); a project's Setup tab,
  section `Services` (anchor `#services`), for the project's creator and organization owners.
- Desktop: the session's `Services <n>` button opens the Services sheet, whose `Recipes` list has
  `Run` per recipe.
- TUI, mobile, VS Code, Slack: no recipe list.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the creator of `<project>` (or an owner), in capture
  mode or co-located.
- `<repo-url>`'s default branch has this `mend.toml` at its root, where `<serve-cmd>` listens on TCP
  port `8000` and answers HTTP in the workspace image (as in [Services](./services.md)):

  ```toml
  [service.web]
  command = "<serve-cmd>"
  port = 8000
  browserScheme = "http"

  [service.db]
  port = 5432
  ```

- A live session in `<project>`: run `mend run --project <project> -- sleep 1800` in its own PTY
  and note `<id>` and `<id8>`.
- `<project>` declares no recipes on its Setup tab.
- A scratch directory `/tmp/verify-init`, outside any Git repository, holds only `package.json`
  with `{"scripts":{"dev":"vite --port 5173"}}`.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Init, non-interactive.** In `/tmp/verify-init` run `mend service init < /dev/null`. Stdout shows
  `proposed /tmp/verify-init/mend.toml:`, a blank line, then
  `# package.json "dev": vite --port 5173`, `[service.web]`, `command = "npm run dev"`,
  `port = 5173`. Exit code `1`, stderr `mend: non-interactive — pass --yes to write the file`, and
  no file is written.
- **Init, written.** Run `mend service init --yes`. After the proposal, stdout reads
  `✓ wrote /tmp/verify-init/mend.toml — commit it, then: mend service run web`. Exit code `0`. Run
  it again: exit code `1`, stderr
  `mend: /tmp/verify-init/mend.toml already exists — edit it directly (init never merges)`.
- **Recipes on the card.** Go to `<web>/sessions/<id>`. The `Services` card shows a row `web` with
  a `Run` button and the line `<serve-cmd> · :8000 · mend.toml`, and a row `db` with
  `adopt · :5432 · mend.toml`.
- **Run from the CLI.** Run `mend service run <id8> web --no-connect`. Exit code `0`. Stdout shows
  `✓ Service web · <status>`, the address lines, and `  logs: mend service logs web`. On the card,
  `web` becomes a Service row and its recipe row goes away.
- **CLI miss.** Run `mend service run <id8> nope --no-connect`. Exit code `1`, stderr
  `mend: no recipe named "nope" — declared: web, db`.
- **Declare a project recipe.** Open `<project>`'s Setup tab. In `section("Services")` choose
  `+ declare service…`, fill the textboxes by placeholder: `name (web)` = `verify-proj`,
  `pnpm dev (empty = adopt a listening port)` = `<serve-cmd with port 8001>`, `port (3000)` =
  `8001`, pick `http` in the combobox `Browser behavior`, and choose `declare service`. It reads
  `declaring…`, then the section lists `verify-proj` with `<serve-cmd with port 8001> · :8001 · http`
  and a `remove` button.
- **Refusals.** Declare `verify-proj` again: a line reads
  `Already declared on this project: verify-proj`. Declare the name `Bad Name`: a line reads
  `"Bad Name" is not a usable Service name (lowercase letters, digits, ".", "_", "-").` Choose
  `cancel`.
- **Shadowed.** Declare a project recipe named `web` (port `9000`, empty command). Back on the
  session page, the card shows a faded row `web` with the word `Shadowed` and the line
  `project declaration · overridden by file`, and no `Run` in it.
- **Run a project recipe.** The card now lists `verify-proj` with `Run` and the line
  `<serve-cmd with port 8001> · :8001 · project`. Choose that row's `Run` (scope it as in Gotchas).
  It reads `Starting…`, then `verify-proj` joins the card as a Service.
- **Parse error.** Start a second live session that breaks the file in its own worktree:
  `mend run --project <project> -- sh -c 'echo "[service" > mend.toml; sleep 1800'` in its own PTY,
  noting `<id2>`/`<id8b>`. Its session page's `Services` card reads
  `mend.toml did not parse — fix it in the worktree`. Run `mend service run <id8b> web --no-connect`:
  exit code `1`, stderr starts `mend: mend.toml is not valid TOML:`.
- **Desktop.** With the first session open as a tab in the desktop app (see
  [Desktop app](./desktop.md)), choose `getByRole("button", { name: /^Services \d+$/ })`. Under the
  paragraph `Recipes`, rows read `web` with `<serve-cmd> · :8000`, `db` with `adopt · :5432`, and
  the project's `web` with `adopt · :9000 · overridden by file` and a disabled `Run`.
- **Cleanup.** Run `mend service stop web` and `mend service stop verify-proj`, choose `remove` on
  both project recipes in `section("Services")` (it acts on the first click), and stop both
  `sleep` sessions by id.
- **Proof.** The `mend service init` and `mend service run` transcripts with exit codes; ARIA
  snapshots and screenshots of the session's `Services` card with recipe rows, with the `Shadowed`
  row, and with the parse error; the Setup `Services` section with both project recipes.

## Gotchas

- `mend.toml` declares Services only. It has no setup or preview key: setup commands live in the
  workspace image ([Workspace images](./workspace-images.md)), and live preview is not built. The
  README's `mend-toml-setup-preview` row records the gap.
- In capture mode Mend reads `/workspace/repo/mend.toml` from the live workspace. A session with no
  live workspace lists only the project's recipes, and running a file recipe asks for a resume.
  Keep a session alive for every card and CLI step.
- The card shows recipe rows only to someone who may start Services in that workspace, while it is
  live. A recipe whose name already shows as a live or recently ended Service has no recipe row;
  restart that Service from its own row instead.
- The parse-error line appears only when the card is otherwise empty. A session that already has a
  Service shows no error for a broken file; use the CLI, which always names it.
- `Run` names every recipe row's button, every ended Service's restart button and the run form's
  submit. Recipe rows are plain `div`s with no list role. Scope a row by its name and its button:
  `page.locator("div").filter({ has: page.getByText("verify-proj", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Run", exact: true }) }).last()`.
  `Shadowed` is plain text, not a status.
- The Setup `Services` form has no labels: its inputs are named only by placeholders
  (`apps/web/src/components/project-setup.tsx:964-982`); only `Browser behavior` and `udp` have
  names. The placeholder `pnpm dev (empty = adopt a listening port)` is the same text the session
  card's run form uses.
- The shorthand `mend service <name>` cannot reach a recipe named like a `service` verb (`run`,
  `add`, `init`, `connect`, `list`, `logs`, `restart`, `stop`). Use `mend service run <name>`.
- With no session argument the CLI takes the one live session, or opens a picker with several.
  Pass `<id8>` in a scripted drive.
- `mend service init` reads the current Git top level (or the current directory), proposes at most
  one Service from the root `package.json` scripts (`dev`, `start`, `serve`, `preview`, the first
  with a port it can name), one per workspace package, and one per Compose service with a published
  port. A port it guessed from a tool default is written with `# guessed — verify`. It never merges
  into an existing file, and needs no server.
- A project recipe with the same name as a file recipe is accepted when declared; the collision
  shows only on a session whose worktree has the file.
