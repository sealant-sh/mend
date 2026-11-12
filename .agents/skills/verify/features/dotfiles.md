# Dotfiles

Dotfiles belong to a person and follow them into every project. A user points the server at a
dotfiles repository, which the server clones as them when applying it, and adds a snapshot of home
files captured on the machine that has them, from the terminal (`mend dotfiles sync`) or the web
Settings page. A project's Setup page decides whether its sessions apply the launching person's
dotfiles. Each session page then says what was sent at launch, or which source was not applied and
why.

## Sub-features

- `dotfiles-show` prints the saved repository (with its branch, subdirectory, manager and
  `install.sh` facts) and the snapshot's files.
- `dotfiles-repo-web` saves or clears the repository from Settings → Dotfiles; the server clones it
  once before saving.
- `dotfiles-repo-cli` sets the whole repository with `mend dotfiles repo`, or clears it with
  `--clear`.
- `dotfiles-repo-refused` refuses a repository the server cannot clone, or bad options, with the
  reason, and saves nothing.
- `dotfiles-manager` picks how the tree lands in the home directory: auto, copy, stow or chezmoi.
- `dotfiles-sync-preview` lists the known config files under `~` without uploading.
- `dotfiles-sync` replaces the snapshot with named files, or every known one (`--all`).
- `dotfiles-web-files` adds files to the snapshot from the browser, with an editable target path,
  and removes the snapshot.
- `dotfiles-project-switch` turns dotfiles, and the default shell profile, on or off per project.
- `dotfiles-session-line` shows on the session page what the launch sent, or what it left out.
- `dotfiles-dir-modes` sets the mode of each directory the copy makes in a person's home (see
  Directory modes below).

## How to get to it (user POV)

- Web: `Settings` in the primary navigation opens `/settings`; the `Dotfiles` panel holds the
  repository form and the home files.
- Web: a project's `Setup` tab (`/projects/<id>/setup`) has a `Dotfiles` card with the per-project
  switches.
- Web: a session page (`/sessions/<id>`) shows a `dotfiles · …` line under its facts once launched.
- CLI: `mend dotfiles [show]`,
  `mend dotfiles repo <url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]`,
  `mend dotfiles repo --clear`, `mend dotfiles sync [--all | paths...]`.
- TUI, desktop, mobile, VS Code, Slack: no dotfiles surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in as the project creator or an organization
  owner, and `<project>` is adopted with its workspace image on a managed OS family (not a custom
  image). This role is required for the project switches.
- `<dotfiles-repo-url>` is a disposable public HTTPS repository whose root holds a file
  `.verify-dotfile`; HTTPS clones without a credential, so it must be public.
- `<scratch>` is an empty directory the run made. `<xdg>` is the directory that holds the signed-in
  CLI's `mend/cli.json` (`~/.config` unless `XDG_CONFIG_HOME` says otherwise). Run
  `printf 'verify\n' > <scratch>/.verify-mendrc`.
- `mend dotfiles` prints `repo      none` and
  `snapshot  none — sync from this machine: mend dotfiles sync --all`.

- **Open the panel.** Run `await page.goto("<web>/settings")`. The heading `Settings` (level 1) and
  the heading `Dotfiles` are visible. The panel's footer reads `repo · none — snapshot · none`.
- **Enter a repository.** Run
  `await page.getByRole("textbox", { name: "Dotfiles repository" }).fill("<dotfiles-repo-url>")`.
  The textboxes `Branch` and `Subdirectory`, the checkbox `Run ./install.sh when present` (checked)
  and the group `Manager` appear. In the group, the button whose name starts with `Auto` reports
  `aria-pressed="true"`.
- **Pick a manager.** Run
  `await page.getByRole("group", { name: "Manager" }).getByRole("button", { name: /^Copy/ }).click()`.
  That button now reports `aria-pressed="true"`.
- **Save.** Run `await page.getByRole("button", { name: "Save repository" }).click()`. The button
  reads `Cloning…` while the server clones, then the footer reads
  `Saved · applies from the next launch`.
- **Second view.** Run `mend dotfiles`. Stdout's first line is
  `repo      <dotfiles-repo-url> (default branch · manager copy · install.sh on)`. Exit code `0`.
- **Add a file from the web.** Run
  `await page.getByLabel("Add files…").setInputFiles({ name: ".verify-web", mimeType: "text/plain", buffer: Buffer.from("web\n") })`.
  A `staged · edit the target path before adding` list appears with the textbox
  `Target path, relative to the home directory` holding `.verify-web`. Run
  `await page.getByRole("textbox", { name: "Target path, relative to the home directory" }).fill(".config/verify-mend/web")`,
  then `await page.getByRole("button", { name: "Add to snapshot" }).click()`. The button reads
  `Adding…`, then the panel shows `1 file · synced just now from web · <sha7>` and a row
  `.config/verify-mend/web` with `4 B`.
- **CLI view of the web file.** Run `mend dotfiles`. Stdout shows
  `snapshot  1 file · from web · <sha7>` and a line starting `  .config/verify-mend/web`.
- **Sync preview.** Run `HOME=<scratch> XDG_CONFIG_HOME=<xdg> mend dotfiles sync`. With no known
  config file in `<scratch>`, stdout is `no known config files found under ~` and nothing uploads.
  Exit code `0`.
- **Sync a named file.** Run
  `HOME=<scratch> XDG_CONFIG_HOME=<xdg> mend dotfiles sync .verify-mendrc`. Stdout is
  `synced 1 file from <hostname> · <sha7> — applies from the next session launch`. Run
  `mend dotfiles`: the snapshot now reads `1 file · from <hostname>` and lists `.verify-mendrc`
  only. The web-added file is gone: a CLI sync replaces the snapshot.
- **Sync refusal.** Run `HOME=<scratch> XDG_CONFIG_HOME=<xdg> mend dotfiles sync /etc/hostname`.
  Stderr is `mend: /etc/hostname is not under <scratch> — only files in your home directory sync`.
  Exit code `1`.
- **CLI repository.** Run `mend dotfiles repo <dotfiles-repo-url> --manager copy --no-bootstrap`.
  Stdout shows `cloning <dotfiles-repo-url> on the server to check it…`,
  `✓ saved · the server cloned it once to check`,
  `repo      <dotfiles-repo-url> (default branch · manager copy · install.sh off)` and
  `applies from the next session launch`. Exit code `0`.
- **Option refusal.** Run `mend dotfiles repo <dotfiles-repo-url> --manager rsync`. Stderr starts
  `mend: --manager must be one of auto, copy, stow, chezmoi`, followed by the two `usage:` lines.
  Exit code `1`. `mend dotfiles` still shows `install.sh off`.
- **Project switch.** Open `<web>/projects/<id>/setup`. The card headed `Dotfiles` reads
  `your dotfiles · applied at launch · set up in Settings` and
  `default shell profile · written where dotfiles left no file`. Leave both on.
- **Session receives them.** Run
  `mend run --project <project> -- sh -c 'cat ~/.verify-dotfile ~/.verify-mendrc > DOTFILES-SEEN.md'`.
  Exit code `0`. On its session page the line
  `dotfiles · repo <dotfiles-repo-url> · snapshot <sha7> · sent at launch` is visible
  (`page.getByText(/^dotfiles · repo /)`), and the change (see
  [Review a change](./review-change.md)) holds `DOTFILES-SEEN.md` with both files' contents.
- **Switch off.** In the `Dotfiles` card choose the first `off` button (see Gotchas). The line reads
  `dotfiles · off · set up in Settings`. A new `mend run` session shows no `dotfiles ·` line. Turn
  it back `on`.
- **Clear.** Run `mend dotfiles repo --clear`. Stdout is
  `✓ cleared the dotfiles repository — applies from the next session launch`. On the web, reload
  Settings and choose `Remove snapshot` (`page.getByRole("button", { name: "Remove snapshot" })`).
  The panel reads `no snapshot · nothing rides along yet`, and `mend dotfiles` prints
  `repo      none` and `snapshot  none — …`.
- **Proof.** Keep the ARIA snapshot and screenshot of the Dotfiles panel after each save, of the
  project's Dotfiles card, and of the session page with its `dotfiles ·` line; keep every `mend`
  transcript with exit codes.

## Directory modes in a person's home

Added from sealantd#186 and its verifier's drive
(https://github.com/sealant-sh/sealantd/pull/186#issuecomment-6238698981). A directory the copy
makes in a person's home takes the tree's mode intersected with the mode a new directory gets there.
Both Mend dotfiles sources pack with `git archive` (`packages/store/src/dotfiles-store.ts:277`,
`packages/sessions/src/dotfiles.ts:444`), whose default `tar.umask 002` stages directories at `0775`
and files at `0664`. A `0700` tree directory, a set-id directory and a two-archive `0555` merge
cannot reach sealantd through Mend; sealantd's root tests cover them. What a stack can show is the
ceiling a default ACL on `/home` puts on a new directory. The decisive case is `o::rwx`: a new
directory takes `0777`. Expected for the created directories, parent vs head of #186: `777` vs
`775`. Under `o::rx` both give `775`. Files are `664` on both.

Preconditions: [per-person-homes.md](./per-person-homes.md) (two accounts, `<owner>` and `<member>`,
as in [organization.md](./organization.md)), `<wt>-shared` a `shared` project on the fixture image
(`stack.mjs project-image`; `setfacl` is present), and `<scratch>/.verify-modes/inner/file` holding
`modes`.

- **Throwaway launch first.** After any image change, start one launch on the image in a worktree
  you will not measure, for example `mend run --name verify-probe --project <wt>-shared -- true`,
  and let it end. An image's first launch runs on the shared layout while Mend probes whether the
  image supports per-person homes (`executor_layouts.reason`:
  `per-person users not yet known for this image`). Without it the member's launch runs as root in
  `/root`, not in a per-person home, and the modes below describe nothing. The rule is in
  [per-person-homes.md](./per-person-homes.md) Gotchas.
- **Hold the executor.** As `<owner>`:
  `mend run --name verify-pp --project <wt>-shared --detach -- sleep 900`. A `mend run` with no live
  session gets a fresh executor, so an ACL set in a session that has ended is gone before the member
  joins.
- **Set the ACL.** As `<owner>`:
  `mend run --worktree verify-pp --project <wt>-shared -- sh -c 'sudo setfacl -d -m u::rwx,g::rwx,o::rwx /home && getfacl -p /home'`.
  The output ends with three `default:` lines. For the `o::rx` pass use `o::rx`.
- **Snapshot.** As `<member>`:
  `HOME=<scratch> XDG_CONFIG_HOME=<member-config> mend dotfiles sync .verify-modes/inner/file`.
  `mend dotfiles` lists that one file.
- **Join while the owner's session runs.** As `<member>`:
  `XDG_CONFIG_HOME=<member-config> mend run --worktree verify-pp --project <wt>-shared -- sh -c 'getfacl -p $HOME | grep default; stat -c "%a %U %n" $HOME $HOME/.verify-modes $HOME/.verify-modes/inner $HOME/.verify-modes/inner/file'`.
  Dotfiles apply at a person's first process in a per-person workspace, so this launch makes the
  directories. The home is `700` with three `default:` lines and the file is `664`. Under `o::rwx`,
  `.verify-modes` and `.verify-modes/inner` read `777 777` at the parent and `775 775` at the head.
  Under `o::rx` both read `775 775`.
- **Proof.** Keep `getfacl` and `stat` output for both ACLs on both stacks, the daemon's `Umask`
  (`0022` in the drive), and the staged copy under `~/.local/share/sealant-dotfiles/0/.verify-modes`
  (`775` with a `664` file, from `git archive`).

## Gotchas

- Under `o::rwx`, other directories in a member's home that this copy does not make read `0777` at
  the parent and the head of #186 (`.claude`, `.codex`, `.local`, `.local/share`,
  `.local/share/sealant-dotfiles`, `.local/state`, `.pi`, `.pi/agent`, `.config/git`). Do not count
  them against a dotfiles change.
- `Add files…` is a `<label>` styled as a button around a file input with `display: none`. It has no
  button role and no keyboard focus, so `getByRole` cannot reach it. Use
  `page.getByLabel("Add files…").setInputFiles(…)`. A finding: the control is unreachable by
  keyboard and by role.
- The `Manager` buttons are named by their label and their description run together
  (`Copy Copies the tree into the home directory as it is.`). Match with an anchored regex
  (`/^Copy/`); `Auto` also prefixes nothing else today, but anchor it anyway.
- The panel's `Saved · applies from the next launch` line and its error line are plain text, not
  `role="status"` or `role="alert"`. Wait for the text.
- The project Setup `Dotfiles` card is a `section` with no accessible name, so it is not a region,
  and its two switches are each a pair of buttons named only `on` and `off`. Scope with
  `page.locator("section").filter({ has: page.getByRole("heading", { name: "Dotfiles" }) })`; the
  first `on`/`off` pair is dotfiles, the second the default shell profile. A finding: neither pair
  has a stable name.
- The settings page's sections are not regions either. Scope by their `h2` heading as above.
- `mend dotfiles sync` replaces the snapshot; the web `Add to snapshot` merges into it. A CLI sync
  after a web add drops the web files.
- `mend dotfiles sync` takes no flag but `--all`. `mend dotfiles sync --dry-run .zshrc` exits `1`
  with `mend: unknown flag --dry-run · usage: mend dotfiles sync [--all | paths...]` and uploads
  nothing. Preview is the bare command with no paths.
- `mend dotfiles sync` reads the CLI machine's real home. Point `HOME` at `<scratch>` and keep
  `XDG_CONFIG_HOME` on the real config, or the CLI loses its sign-in (it keeps `cli.json` under
  `$XDG_CONFIG_HOME/mend`, defaulting under `$HOME`).
- `mend dotfiles repo` sets the whole repository: an option left out reverts to its default.
- Saving a repository counts as a launch against the account's launch budget; a save can be refused
  while launches are in flight.
- The CLI has no command to remove the snapshot; only the web `Remove snapshot` does. Product gap.
- The docs and the API describe a per-person setting `Start my agents after install.sh`
  (`PUT /dotfiles/start-after-install`). Neither Settings nor the CLI offers it. Product gap; not
  drivable.
- In a shared-home workspace, dotfiles resolve when the workspace is created. In a per-person
  workspace, they apply at that person's first process, including when the person joins an existing
  workspace. Later processes in that home do not reapply them. Custom-image projects never apply
  dotfiles; their card reads `custom image · dotfiles and default shell profile not applied`.
- The session page's `dotfiles ·` lines say what Mend sent, not what the workspace applied. A source
  that failed shows `dotfiles · repo not applied · <reason>` in the warning color, still as plain
  text.
