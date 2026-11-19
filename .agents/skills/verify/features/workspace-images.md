# Workspace images

Every session runs in a workspace built from an image definition: a managed OS family (Arch, Fedora,
Ubuntu or Nix) with a login shell and portable package names, or a custom OCI base with extra
packages and setup commands, plus a Docker service switch. Each project has its own image, a copy of
its organization's starting image taken when the project was created; an organization's starting
image is a copy of the instance's taken when it was created (SLNT-1155, docs/adr/0025). Nothing
follows a level above: changing the organization's starting image changes new projects only. A user
changes the project's on its Settings → Workspace tab, owners the organization's and the operator
the instance's in Settings. Mend asks the platform to resolve every managed OS-family package on
save and refuses the save naming each package it could not resolve. Custom bases keep package names
unchanged without catalog resolution. The next launch that needs a new image builds it, and the
session says so while it builds. Saving an image starts no build of its own (S17): for a project
with ready workspaces the save rewarms them, and `GET /api/projects/<id>/hot-sessions`
(`projects.hotSessionsStatus`) reads `warming`, then `ready` or `failed` with `error`; otherwise the
first launch after the save builds it.

## Sub-features

- `image-project-override` saves a project override from the Setup tab's `Workspace image` panel
  (`os family` or `custom image`).
- `image-packages` takes packages one per line, for a family or as a custom base's extra packages.
- `image-setup-commands` takes a custom base's setup commands, one per line, run when a new executor
  starts without a restored capture.
- `image-rejections` refuses a save and names each package Sealant could not resolve or does not
  support for the family.
- `image-use-default` (the field's `reset`) replaces a project's image with a copy of its
  organization's starting image as it is now; an old client's `{ "workspaceImage": null }` does the
  same.
- `image-organization-default` lets an owner set the organization's starting image in Settings,
  which new projects copy; existing projects keep their own. There is no "follow the instance".
- `image-instance-default` lets the operator set the image new organizations copy, with
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
- Each field of the project's `Image` section reads `set for <project> · reset`: the image is the
  project's own.
- `<package>` is a package id the platform's catalog resolves for Arch and no saved definition uses
  yet (for example `htop`, if the catalog has it). Launch confirms it.
- `const section = (name) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) })`.

- **Read the image.** Open `<project>`'s Settings tab, `Workspace` sub-tab
  (`<web>/projects/<id>/settings/workspace`). The heading `Image`
  (`page.getByRole("heading", { name: "Image", exact: true })`) reads
  `What the workspace is built from. New sessions wait for a rebuild.` and holds the groups `Base`
  (`OS family`, `Custom image`), `OS` (`Arch`, `Fedora`, `Ubuntu`, `Nix`) and `Login shell` (`bash`,
  `zsh`, `fish`), each a `page.getByRole("group", { name })` with the chosen button
  `aria-pressed="true"`, and the textbox `Packages` (placeholder `packages, separated by spaces`).
  Each field's source reads `set for <project> · reset` when the project overrides it (the box, 17
  Nov: all four, `OS family`, `Ubuntu`, `zsh`), else `from your organization` or
  `from the instance default`. A runtime that cannot use a choice disables its button and says why
  below the group (Boat: `Custom image`, `Arch`, `Fedora`). There is no
  `<os> · <n> packages · inherited` line and no `Edit…`.
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
- **Reset.** Choose a field's `reset`. The fields show the organization's starting image and the
  line
  `Reset to a copy of the organization's starting image · new sessions wait for the rebuilt image`.
- **Organization default.** Go to `<web>/settings/organization/environment`. An owner sees the
  editor at once, under
  `Set for <organization>. Each new project starts with a copy; existing projects keep their own.`;
  a member reads `<os> · <n> packages · set for <organization>`. The editor shows `OS family`,
  `Custom image`, one button per OS (`Arch`, `Fedora`, `Ubuntu`, `Nix`, each named with its
  description), `bash`/`zsh`/`fish`, the Docker toggle, the textbox `Packages`, the line
  `<n> packages · checked for Arch on save`, `Cancel` and `Save environment` (disabled until
  something changes). Add `<package>` to `Packages`; the status reads `Unsaved environment changes`.
  Choose `Save environment`: it reads `Checking packages…`, then
  `Saved · packages resolved by Sealant`. There is no `Follow the instance`.
- **Existing projects keep their own.** Back on `<project>`'s Workspace tab, its image is as it was;
  a project adopted after the save starts with the organization's new image.
- **Instance default.** As the operator, `section("Workspace environment")` (exact name) shows the
  same editor plus `Suggestions from this machine` with `Scan machine`. Choose `Scan machine`; it
  reads `Scanning…`, then lists observed tools or `No known tools observed.`. Do not save the
  instance default on a shared instance.
- **Proof.** ARIA snapshots and screenshots of the `Workspace image` panel inherited, with the
  rejection, as saved, and after `reset`; the Settings panel after its save; the `mend run`
  transcript with its launch lines; the TUI capture; the review page showing `IMAGE.txt`.

## Gotchas

- The project's image is edited in place in the `Image` section of the Settings → Workspace sub-tab
  (`apps/web-old/src/components/project/settings/workspace-image.tsx`); the steps here that open
  `Edit…`, `Save override` and `Use default` describe the older Setup-tab panel and need a rewrite
  against that section. Its save bar and `reset` were not driven on the box. The organization's
  `Workspace environment · <organization>` line (`<os> · <n> packages · from the instance`) is from
  `apps/web-old/src/components/settings/environment-organization.tsx`; the box run of 17 Nov looked
  for it on Defaults and did not read it.
- Both editors have a Docker service switch (`role="switch"`, named `Docker service` by its label):
  the project's `Workspace image` panel since mend#663
  (`apps/web-old/src/routes/projects.$projectId.setup.tsx:375-386`), and Settings. The live pass
  (2026-10-10) ran before mend#663, when the project editor had none.
- No choice button exposes its state: the mode, OS and shell buttons in both editors have no
  `aria-pressed`, so a snapshot cannot say which is chosen. Read the saved summary line instead.
- The Settings Docker toggle is a `switch` named `Docker service`
  (`apps/web-old/src/components/workspace-environment-editor.tsx:250-261`); before mend#663 it was
  named only by its state, `Enabled` or `Disabled`, as the live pass saw. The Settings OS buttons'
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
