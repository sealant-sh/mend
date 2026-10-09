# Automatic install

In capture mode (the default session store), Mend installs a project's dependencies before the agent
starts when the session's saved state has no dependency tree for the workspace's platform, and fills
the project's shared cache that standby workspaces start from. The command is detected from the
lockfile at the root of the base tree (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`,
`package-lock.json` → `npm ci`, `Cargo.lock` → `cargo fetch --locked`, and so on), or a custom
command replaces it. A per-project switch turns it off; a tree already saved or cached is restored
either way. The user sets both on the project's Setup tab, in the card titled `Dependencies`.

## Sub-features

- `install-detected` shows the command a launch would detect, read from the base ref.
- `install-custom` saves a custom command that replaces the detected one; an empty save returns to
  detection.
- `install-switch` turns automatic install on or off (`on`/`off`), keeping the custom command.
- `install-in-session` runs the install in a fresh worktree's workspace before the agent starts.
- `install-colocated` says the card applies to capture mode only on a co-located server.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Dependencies` (anchor `#install-command`), for the project's
  creator and organization owners.
- CLI, TUI, desktop, mobile, VS Code, Slack: no surface. The effect shows in a session's worktree
  and in the server's log.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` in capture mode (the `Dependencies` card does not read
  `Capture mode only. …`), signed in as the creator of `<project>` or an owner.
- `<repo-url>`'s default branch has `package.json` and `package-lock.json` at its root, with at
  least one dependency, and `node_modules` is in its `.gitignore`.
- Automatic install is on for `<project>` (the default) and no custom command is saved.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Read the card.** Open `<project>`'s Setup tab. `section("Dependencies")` reads
  `automatic install`, the `on` button reports `aria-pressed="true"`, and the line reads
  `detected · npm ci · from package-lock.json on origin/<branch>`. The textbox
  `Custom install command` is empty and its `save` button is disabled.
- **Install in a session.** Run
  `mend run --project <project> -- sh -c 'if test -d node_modules; then echo present; else echo absent; fi > INSTALL.txt'`.
  Exit code `0`. The change adds `INSTALL.txt` holding `present`. On a local server,
  `mend server logs` shows a line starting `session engine: dependency install ·`.
- **Custom command.** Run
  `await section("Dependencies").getByRole("textbox", { name: "Custom install command" }).fill("npm install --no-audit")`
  and `await section("Dependencies").getByRole("button", { name: "save" }).click()`. The line reads
  `runs · npm install --no-audit · custom` and `save` is disabled again.
- **Back to detected.** Clear the textbox and choose `save`. The line reads
  `detected · npm ci · from package-lock.json on origin/<branch>` again.
- **Turn it off.** Set the custom command again, then run
  `await section("Dependencies").getByRole("button", { name: "off" }).click()`. `off` reports
  `aria-pressed="true"`, the textbox is gone, and the line reads
  `off · no install runs, in sessions or for the shared cache · custom command kept`.
- **No install when off.** Run the same `mend run` command again (it makes a new worktree). The
  change adds `INSTALL.txt` holding `absent`, unless the project's shared cache already holds a
  tree, which a standby restores even when off (see Gotchas).
- **Turn it on.** Choose `on`. The custom command line returns as
  `runs · npm install --no-audit · custom`. Clear it and save to restore the precondition.
- **Proof.** ARIA snapshots and screenshots of `section("Dependencies")` in each state (detected,
  custom, off), the two `mend run` transcripts, and both review pages showing `INSTALL.txt`.

## Gotchas

- On a co-located server the card reads
  `Capture mode only. This server runs sessions co-located with the store, where a worktree keeps its own dependencies and Mend runs no install. …`
  and the switch changes nothing a session can observe. Report the in-session steps unreachable
  there.
- The `on`/`off` buttons are named only `on` and `off`, with no group name tying them to
  `automatic install` (`apps/web/src/components/on-off-switch.tsx:156-172`). The `Dotfiles` section
  on the same page has two more pairs with the same names. Scope to the `Dependencies` section.
- The card's heading is `Dependencies`, not "Automatic install"; the switch label
  `automatic install` is plain text.
- The detected line reads `origin/<branch>` as last fetched; it says
  `not read · detected from the lockfile at launch` when the store could not read that tree, and
  `no lockfile recognised on <ref> · detected again at launch` when none matched.
- Turning the switch on from off, or changing the command, queues an install session that fills the
  shared cache. A standby workspace starts from that cache, so with hot sessions on, a session can
  find `node_modules` even with the switch off. Set the project's hot sessions to `0` for the
  `absent` step.
- A worktree that already has a saved dependency tree restores it and runs no install. Every proof
  step needs a fresh worktree; `mend run` makes one per run.
- A plain `pnpm install` gets shortened network waits and one retry with pnpm's defaults; the log
  line ends `fetch retries <n>`, and a rerun logs `dependency install · retried with defaults`.
