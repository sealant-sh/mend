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
- `install-switch` turns automatic install on or off (the switch `Automatic install`), keeping the
  custom command.
- `install-in-session` runs the install in a fresh worktree's workspace before the agent starts.
- `install-colocated` says the card applies to capture mode only on a co-located server.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Dependencies` (anchor `#install-command`), for the project's
  creator and organization owners.
- CLI, TUI, desktop, mobile, VS Code, Slack: no surface. The effect shows in a session's worktree
  and in the server's log.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` in capture mode (the `Dependencies` section does not read
  `Capture mode only. …`), signed in as the creator of `<project>` or an owner.
- `<repo-url>`'s default branch has `package.json` and `package-lock.json` at its root, with at
  least one dependency, and `node_modules` is in its `.gitignore`.
- Automatic install is on for `<project>` (the default) and no custom command is saved.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Read the section.** Open `<project>`'s Settings tab, `Workspace` sub-tab
  (`<web>/projects/<id>/settings/workspace`). Under the heading `Dependencies`, the line
  `Installs dependencies in every new worktree before the agent starts.`, the switch
  `page.getByRole("switch", { name: "Automatic install" })` reports `aria-checked="true"`, the
  textbox `Custom command` (marked `optional · replaces the detected one`) is empty with the
  detected command as its placeholder, and the line under it reads
  `detected · npm ci · from package-lock.json on origin/<branch>`. A project whose default branch
  has no lockfile Mend knows reads
  `no lockfile recognised on origin/<branch> · detected again at launch` instead (the box's
  `boat-check-ubuntu`, branch `master`, on 17 Nov). No `Save` button shows until the textbox
  changes.
- **Install in a session.** Run
  `mend run --project <project> -- sh -c 'if test -d node_modules; then echo present; else echo absent; fi > INSTALL.txt'`.
  Exit code `0`. The change adds `INSTALL.txt` holding `present`. On a local server,
  `mend server logs` shows a line starting `session engine: dependency install ·`.
- **Custom command.** Run
  `await section("Dependencies").getByRole("textbox", { name: "Custom command" }).fill("npm install --no-audit")`
  and `await section("Dependencies").getByRole("button", { name: "Save", exact: true }).click()`. It
  reads `Saving…`, then the line reads `runs · npm install --no-audit · custom`, the field is marked
  `set for <project> · reset`, and `Save` is gone.
- **Back to detected.** Choose that `reset`. The line reads
  `detected · npm ci · from package-lock.json on origin/<branch>` again.
- **Turn it off.** Set the custom command again, then run
  `await page.getByRole("switch", { name: "Automatic install" }).click()`. The switch reports
  `aria-checked="false"`, the textbox is gone, and the switch's detail reads
  `No install runs, in sessions or for the shared cache · custom command kept`.
- **No install when off.** Run the same `mend run` command again (it makes a new worktree). The
  change adds `INSTALL.txt` holding `absent`, unless the project's shared cache already holds a
  tree, which a standby restores even when off (see Gotchas).
- **Turn it on.** Click the switch again. The custom command line returns as
  `runs · npm install --no-audit · custom`. Choose `reset` to restore the precondition.
- **Proof.** ARIA snapshots and screenshots of `section("Dependencies")` in each state (detected,
  custom, off), the two `mend run` transcripts, and both review pages showing `INSTALL.txt`.

## Gotchas

- On the box (17 Nov) the section read the switch `Automatic install` checked, the textbox
  `Custom command` and `no lockfile recognised on origin/master · detected again at launch`. The
  `Save`, `reset` and off-state wording here is from
  `apps/web-old/src/components/project/settings/workspace.tsx`, not confirmed by a capture. The
  switch's checked state is read as `aria-checked` on the assumption that the kit `SwitchRow` is a
  `role="switch"` (the snapshot shows `switch "Automatic install" [checked]`).
- On a co-located server the section reads
  `Capture mode only. Sessions here run beside the store, where a worktree keeps its own dependencies, so Mend runs no install. The setting is kept for capture mode.`
  and the switch changes nothing a session can observe. Report the in-session steps unreachable
  there.
- The section's heading is `Dependencies`; `Automatic install` is a named `switch`, not an
  `on`/`off` pair. The `Dotfiles` section on the same sub-tab has two more switches
  (`Apply my dotfiles`, `Use the default shell profile`).
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
