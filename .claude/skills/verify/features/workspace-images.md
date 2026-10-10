# Workspace images

Every session runs in a workspace built from an image definition: a managed OS family (Arch, Fedora,
Ubuntu or Nix) with a login shell and portable package names, or a custom OCI base with extra
packages and setup commands, plus a Docker service switch. The definition resolves project override,
then organization default, then instance default. A user overrides it on the project's Setup tab,
owners set the organization's default and the operator the instance's in Settings. Mend asks the
platform to resolve every managed OS-family package on save and refuses the save naming each package
it could not resolve. Custom bases keep package names unchanged without catalog resolution. The next
launch that needs a new image builds it, and the session says so while it builds.

## Sub-features

- `image-project-override` saves a project override from the Setup tab's `Workspace image` panel
  (`os family` or `custom image`).
- `image-packages` takes packages one per line, for a family or as a custom base's extra packages.
- `image-setup-commands` takes a custom base's setup commands, one per line, run when a new executor
  starts without a restored capture.
- `image-rejections` refuses a save and names each package Sealant could not resolve or does not
  support for the family.
- `image-use-default` returns a project to what it inherits.
- `image-organization-default` lets an owner set the organization's default in Settings, or follow
  the instance.
- `image-instance-default` lets the operator set the instance default in Settings, with
  `Scan machine` suggestions.
- `image-build-state` shows a launch building its image: the session page summary, the CLI's start
  lines and the TUI row.

## How to get to it (user POV)

- Web: a project's Setup tab, section `Workspace image` (anchor `#environment`), for the project's
  creator and organization owners.
- Web: `/settings`, panel `Workspace environment · <organization>` (owners edit, members read) and,
  for the operator only, panel `Workspace environment` under `instance · operator`.
- Web: a starting session's page (`/sessions/<id>`) shows the build phase.
- CLI: no command edits the image. `mend codex|claude|run` print the launch phase while a workspace
  starts.
- TUI: a starting session's row and detail pane in the dashboard (`mend ui`) name the phase.
- Desktop, mobile, VS Code, Slack: no image editor.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, signed in as the instance's first account (the operator and the
  organization's owner), and `<project>` is adopted.
- The project and the organization have no override: the project's panel line ends `· inherited` and
  the organization panel's line ends `· instance`.
- `<package>` is a package id the platform's catalog resolves for Arch and no saved definition uses
  yet (for example `htop`, if the catalog has it). Launch confirms it.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Read the inherited image.** Open `<project>`'s Setup tab. `section("Workspace image")` reads
  `<os> · <n> packages · inherited` (the default install reads `arch · 17 packages`) and shows the
  button `Edit…`.
- **Open the editor.** Run
  `await section("Workspace image").getByRole("button", { name: "Edit…" }).click()`. Buttons
  `os family` and `custom image`, OS buttons `arch`, `fedora`, `ubuntu`, `nix`, shell buttons
  `bash`, `zsh`, `fish`, the textbox `Packages` prefilled with the inherited packages one per line,
  and buttons `Save override` and `Cancel` appear.
- **Refused package.** Append a line `verify-no-such-package` to `Packages`
  (`fill((await packages.inputValue()) + "\nverify-no-such-package")`) and choose `Save override`.
  It reads `Saving…`, then a line reads
  `verify-no-such-package · Sealant could not find this package.` and the editor stays open. Nothing
  is saved: reload, and the panel still ends `· inherited`.
- **Save an override.** Open `Edit…` again, append `<package>`, choose `zsh`, and choose
  `Save override`. The editor closes and the line reads `arch · <n+1> packages · project override`.
- **Custom base.** Open `Edit…`, choose `custom image`. The textboxes `Base image reference`
  (placeholder `node:22-bookworm`) and `Setup commands` appear and `Save override` is disabled while
  the base is empty. Fill `Base image reference` with `node:22-bookworm` and `Setup commands` with
  `echo setup-ran > /tmp/setup-ran`. Clear the textbox `Packages` with
  `await section("Workspace image").getByRole("textbox", { name: "Packages", exact: true }).fill("")`
  before saving; switching modes kept the Arch package list. The line reads
  `custom · node:22-bookworm · project override`.
- **Build state.** Start a session that needs the new image:
  `mend run --project <project> -- sh -c 'cat /tmp/setup-ran > IMAGE.txt'` with stdout not a TTY.
  While the platform builds, stdout prints `  starting · building the workspace image`, with
  ` · step <n>/<m>` appended only when the platform reports the step (a local builder reported
  none); the session page's summary paragraph reads `building the workspace image · step <n>/<m>`,
  and its `Terminal` pane reads
  `provisioning workspace — a first launch builds the harness image (can take minutes)…`. The run
  ends with `✓ exited · code 0 · recorded`, and its change adds `IMAGE.txt` holding `setup-ran`,
  which only the setup command wrote.
- **TUI build state.** Start another cold launch after an image change and, while it builds, run
  `tmux new-session -d -s img -x 200 -y 50 'mend ui'` and read `tmux capture-pane -p -t img`. The
  session's row reads `building the image`; with that row selected the detail pane reads
  `starting · building the workspace image · the agent starts once it is built and booted` (with
  ` · step <n>/<m>` after `image` when the platform reports the step). Close with
  `tmux kill-session -t img`.
- **Use default.** Open `Edit…` and choose `Use default`. The line ends `· inherited` again.
- **Organization default.** Go to `<web>/settings`.
  `section("Workspace environment · <organization>")` reads `<summary> · instance` and the button
  `Set for <organization>`. Choose it. The editor shows `OS family`, `Custom image`, one button per
  OS (`Arch`, `Fedora`, `Ubuntu`, `Nix`, each named with its description), `bash`/`zsh`/`fish`, the
  Docker toggle, the textbox `Packages`, the line `<n> packages · checked for Arch on save`,
  `Cancel` and `Save environment` (disabled until something changes). Add `<package>` to `Packages`;
  the status reads `Unsaved environment changes`. Choose `Save environment`: it reads
  `Checking packages…`, then `Saved · packages resolved by Sealant`, and `Cancel` becomes
  `Follow the instance`.
- **Project follows the organization.** Back on `<project>`'s Setup tab (no project override), the
  `Workspace image` line counts the organization's packages and ends `· inherited`.
- **Follow the instance.** In Settings choose `Follow the instance`. The organization panel's line
  ends `· instance` again.
- **Instance default.** As the operator, `section("Workspace environment")` (exact name) shows the
  same editor plus `Suggestions from this machine` with `Scan machine`. Choose `Scan machine`; it
  reads `Scanning…`, then lists observed tools or `No known tools observed.`. Do not save the
  instance default on a shared instance.
- **Proof.** ARIA snapshots and screenshots of the `Workspace image` panel inherited, with the
  rejection, as an override, and after `Use default`; the Settings panel after its save; the
  `mend run` transcript with its launch lines; the TUI capture; the review page showing `IMAGE.txt`.

## Gotchas

- The project editor has no Docker service switch: it keeps whatever the inherited definition says.
  The docs describe a Docker switch for custom images on the project level
  (`guides/project-environment.md`, `guides/workspace-images.md`); only the Settings editors offer
  it (`apps/web/src/routes/projects.$projectId.setup.tsx:263-423`). A product gap.
- No choice button exposes its state: the mode, OS and shell buttons in both editors have no
  `aria-pressed`, so a snapshot cannot say which is chosen. Read the saved summary line instead.
- The Settings Docker toggle is named only by its state, `Enabled` or `Disabled`
  (`apps/web/src/components/workspace-environment-editor.tsx:254-265`). The Settings OS buttons'
  names include their description (`Arch Rolling packages; Mend’s default.`); match `/^Arch/`.
- The Settings editor uses fixed element ids for `Base image`, `Setup commands` and `Packages`
  (`workspace-environment-editor.tsx:164`, `188`, `271`). An operator who is also the owner sees two
  editors on `/settings` once the organization has its own image, and the second editor's labels
  then point at the first editor's fields. Scope by panel and use `getByRole("textbox")` inside it,
  and treat a label-based miss as this finding.
- The project editor checks package syntax only on the server; the Settings editors refuse bad
  syntax before saving (`Unsupported package syntax: <entry>`).
- A managed OS-family definition stores each package as the catalog id it resolved to, so an alias
  can come back renamed. Custom-image packages keep their names and are checked only when the
  platform builds the image. Clear `Packages` when switching from a family to a custom base, or
  supply packages valid for that base's package manager.
- A newly provisioned executor skips non-empty custom setup commands only when it restores a
  worktree capture numbered `1` or later. The launch summary then includes
  `setup skipped · restored from capture <n>`; the CLI can show
  `running · setup skipped · restored from capture <n>`. A resume or a new session in that worktree
  can take this path. Outside capture mode, another executor runs setup again even in an existing
  worktree. A resume that reuses a retained workspace does not provision another executor or rerun
  its setup. Use a fresh worktree to prove setup execution.
- A build happens only when no image for the definition exists yet; it can take minutes ("about 8
  minutes" after an update). Wait for the phase words, never a fixed sleep, and expect a second
  launch with the same definition to skip the build.
- Saving changes the hot-workspace fingerprint: ready standbys drain and rewarm (see
  [Hot sessions](./hot-sessions.md)).
- Custom images skip dotfiles and the default shell profile; the Setup `Dotfiles` section says
  `custom image · dotfiles and default shell profile not applied`.
