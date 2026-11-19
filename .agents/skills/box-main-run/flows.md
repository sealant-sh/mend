# Flows on the box

Runs: every flow below, once a day (the owner's choice on SLNT-1050, 17 Nov). To run fewer, name the
set on this line, for example "the flows marked `Sample: yes`"; a run reports each flow outside it
as `not run · not in this run's set`.

Every flow one run of [SKILL.md](SKILL.md) can use on the box (VM 131), as its signed-in owner,
after the preview of `main` is deployed. Each flow comes from the feature map
(`.agents/skills/verify/features/`, written "the map"); the feature file holds the exact handles,
commands and strings, and a flow points at it instead of copying them. Every feature in the map has
at least one flow here or a line in [Not on the box](#not-on-the-box). A PR that adds or changes a
feature adds or updates its flow here in the same PR, and its judge names that flow
(`pnpm verify judge`, which refuses an id this file does not have). Ids are stable: reports, tickets
and PRs name flows by id, so rename one only with a note in the PR that does it. A flow's `Areas`
line names the paths it passes through: an entry ending in `/` holds everything under it, and a
judge cannot answer "no flow" for a change inside one. A flow for a route only the new web app
(`apps/web`) has carries `- **Box:** after cut-over`, and runs once the box serves that app.

`M` is the CLI under test, signed in as the box's owner account (never `mend login` or `mend logout`
it). `<p>` is the project `boat-check-ubuntu` (Ubuntu, branch `master`). `<sha8>` is the first 8
characters of the commit under test. `$E/<flow id>` is the flow's evidence directory. `<scratch>` is
a fresh `mktemp -d` directory of this run. Web flows run through
`.agents/skills/verify/scripts/drive-web.mjs`; `scripted` flows name their recipe, `agent` flows are
driven by the run's agent from the feature file.

Box facts the flows depend on: sessions run on Boat by default, and Docker is offered beside it; the
runtime is chosen per organization and a worktree keeps the runtime it was made on. One organization
(Default), one account, single tenancy. Provider logins on 16 Nov: codex and claude connected,
GitHub not. Flows use codex only: the box's Claude login stays unused until SLNT-905 is decided.
Five flows run a real agent turn, each with one-line prompts: `start-session.boat-turn`,
`start-session.composer`, `start-session.web-write`, `start-session.web-answer` and
`send-review-back.deliver`. They use codex: the owner has far more Codex capacity than Claude (17
Nov).

For the flows that use the fixtures `fixtures.sh` makes: `<git>` is `git://<git host>`, the box's
git service; `<land>` is the project `main-run-land` (from `<git>/land.git`, branch `main`);
`<second>` is the project `main-run-second` (from `<git>/second.git`, branch `main`); `M2` is the
CLI signed in as `main-run-second@example.test`, used like `M` (never `mend login` or `mend logout`
it); `<git dir>` is the directory on the box that holds the bare repositories (`/srv/mend-git`).
"The owner's browser" is the saved sign-in other flows use; "the second browser" is the second
account's saved sign-in. The run's machine cannot reach `<git>`: every read of a bare repository is
`git` over `MEND_VERIFY_BOX_SSH` on the box.

These flows assume the owner adopted `<land>` and `<second>` with the default visibility, `private`.
A flow that needs the second account to see a project makes it `shared` and puts it back to
`private` before it ends.

Project settings: the map names Setup-tab sections. In the web today, `Visibility`,
`Linked projects` and `References` are on the project Settings tab's `General` sub-tab, and folders
are `Organization folders` (access `off`, `read`, `write`) on its `Folders` sub-tab. A flow reads a
section where it is now and reports a handle that differs from the map as a map gap.

The map still names the project page's `Setup` tab. The web now has a project `Settings` tab with
sub-tabs (`General`, `Workspace`, `Services`, `Secrets`, `Git`, `Landing`, `Review`, `Folders`;
`apps/web-old/src/components/project/settings-sections.ts`), and app Settings has one page per
section (`/settings/devices`, `/settings/git-access`, …; old `#anchors` redirect). A flow that reads
a Setup section reads it in the matching Settings sub-tab, and reports a missing section as a map
gap, not a product failure.

## Fixtures

Made once by hand, kept on the box, and checked by each run before the flow that needs it. A missing
fixture makes its flow `not run · fixture <name> missing`; recreate it as written, and only while
you hold the box (`verify box prepare`).

- **The project** `<p>`: adopted by the owner account from its network origin. `M projects` lists
  it. To recreate: `M adopt <origin> --name boat-check-ubuntu` (adopt-project.md `adopt-cli`).
- **The second GitHub project** `boat-check-arch`: adopted by the owner account from
  `https://github.com/octocat/Spoon-Knife.git` (branch `main`), for the flow that clones a second
  repository inside a Boat workspace. To recreate:
  `M adopt https://github.com/octocat/Spoon-Knife.git --name boat-check-arch`.
- **The Docker worktree** `main-run-docker` in `<p>`. To make it: on the web as the owner, Settings
  · Organization · Defaults, `Where new sessions run`: note the current choice (it read
  `Inherit · Boat` on 16 Nov), switch to Docker without moving anything; run
  `M run --project <p> --name main-run-docker -- sh -c 'echo docker > MAIN-RUN-DOCKER.md'`; put the
  noted choice back without moving anything. Made on 16 Nov. `M worktrees --project <p>` lists it.
- **The git service** on the box, serving bare repositories at `<git>/<name>.git` that accept
  pushes. Not on GitHub. Made by `fixtures.sh`, which keeps the repositories in `/srv/mend-git` on
  the box, written `<git dir>`.
- **The landing project** `<land>`, adopted by the owner from `<git>/land.git`. `M projects` lists
  it.
- **The second project** `<second>`, adopted by the owner from `<git>/second.git`. `M projects`
  lists it.
- **The second account** `main-run-second@example.test`, a member of Default, with its CLI config
  (`M2`, in `~/.local/share/mend-boat-check-2/cli`) and its password file beside it, joined and
  signed in by `fixtures.sh` through its own browser. `M members` lists it as `member`. It has no
  agent login.
- **The serve command** `<serve-cmd>`: `python3 -m http.server 8000`. Python is one of Mend's
  default workspace packages (`DEFAULT_WORKSPACE_PACKAGES`, `packages/domain/src/settings.ts`), so
  the Ubuntu image has it; nothing needs making.
- **The previous run's session**: the ledger's `session` from the last run (SKILL.md, State). Not
  made by hand; with no previous run, `server.data-intact` runs its listing half only.

Each run also makes, and leaves for the next run to read: the worktree `main-run-<sha8>` (the turn),
`main-run-run-<sha8>` (the `mend run`), and `main-run-live-<sha8>` (the live session). Wind-down
removes what SKILL.md's ledger says to remove.

## Run order

Flows are grouped below as the map's README groups features; they run in this order, because later
flows reuse what earlier ones made:

1. `server.data-intact` (before half), `server.upgrade`, `server.data-intact` (after half),
   `server.status-logs`
2. `doctor.checklist`, `cli.version`, `exposure.read`, `operator.read`, `organization.read-invite`,
   `provider-accounts.read`, `models.list-picker`
3. `start-session.boat-turn`, `review-change.web-review`, `now-and-sessions.web-now`,
   `attach-resume.boat-stop-resume`, `send-review-back.deliver`
4. `start-session.boat-run`, `start-session.composer`, `start-session.web-write`,
   `start-session.web-answer`, `review-change.web-comments`, `land-change.panel-read`,
   `pull-change.boat-run`, `attach-resume.rename-web`, `tui.dashboard`
5. `start-session.docker-run`
6. `start-session.boat-live`, `attach-resume.attach-detach`, `session-shell.live-shell`,
   `shared-control.refuse-script`, `services.cli-run`, `capture-and-save.live-stop`
7. `worktrees.web-create-remove`, `handoff.held`, `now-and-sessions.inbox-settle`,
   `now-and-sessions.cli-lists`
8. The rest, in any order: `adopt-project.*`, `sign-in.fresh-browser`, `pairing-devices.mint-read`,
   `git-access.read`, `workspace-ssh.status`, the Personal setup and Project setup flows, then
   `doctor.bundle-web` last.
9. `land-change.web-push`, `land-change.cli-again`, `land-change.refused`,
   `organization.visibility-who-sees`, `repositories-in-session.add-second`,
   `references-folders.select-link`, `organization.roles-roundtrip`, `organization.join-refused`,
   `operator.owner-grant-restore`, `shared-control.two-people`, `shared-control.ask-and-grant`,
   `shared-control.new-web-ask-and-grant`, `per-person-homes.two-people`, in that order and one at a
   time: several change `<land>`, `<second>` or a role, and each runs only after the one before it
   has put that back.

## The core loop

### adopt-project.refusals

- **Map:** adopt-project.md `adopt-invalid-url`, `adopt-access`, `adopt-cli`; git-access.md
  `adopt-auth`
- **Needs:** no session; no turn; CLI; none
- **Do:** Run the three refused adoptions the map lists: a local path, `--auth ambient`, and
  `--auth nope` (git-access.md "Refused mode"). Nothing is adopted.
- **See:** each exits `1` with the map's `mend: …` line; `M projects` lists no `nope`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/adoptions.ts`, `packages/store/`

### adopt-project.web-directory

- **Map:** adopt-project.md `projects-directory`, `project-page`, `adopt-web` (the panel opens and
  refuses a local path; nothing is adopted)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** On `/projects`, open `Adopt a repository`, type a local path in its `Repository` combobox
  and read the refusal, close the dialog with `Cancel`; filter the directory by `<p>` and open its
  page.
- **See:** the dialog `Adopt a repository` with the `Repository` combobox marked invalid
  (`aria-invalid`), the line
  `Use an HTTP(S), SSH, SCP-style, or git:// repository URL. Local paths and file:// URLs are not supported.`
  and `Adopt` disabled; `1 of <n>` and one row for `<p>`; the project heading `<p>` with the
  navigation `<p> project` and its `Worktrees <n>` link.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/projects.index.tsx`, `apps/web-old/src/components/project/`,
  `apps/api/src/adoptions.ts`

### adopt-project.new-web-projects

- **Map:** adopt-project.md `projects-directory`, `adopt-web`, `adopt-invalid-url`,
  `adopt-visibility`; project-settings.md `settings-remove`, `settings-retention`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `new-web-projects` (after the composer's CLI batch
  `new-web-composer-setup.json`): Projects lists the projects, searches and filters them; Add
  project refuses a local path, clones a small public repository shared with the organization,
  clones a big one while a session queued in the composer waits for it, and reports a clone the key
  can't read and a clone that fails; Remove project…, Restore and Purge… under Removed projects.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the session queued on the
  clone starts by itself; every project the recipe made is purged at its end.
- **Mode:** `scripted` (recipes/new-web-projects.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/projects/`, `apps/web/src/routes/_inbox.projects.index.tsx`,
  `apps/web/src/lib/projects.ts`, `apps/web/src/lib/clone-state.ts`,
  `apps/web/src/lib/project-removal.ts`

### settings.new-web-settings

- **Map:** appearance.md `theme-web`, `theme-system`, `theme-persist`; sign-in.md `web-sign-out`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-settings`: Settings opens Profile beside its own sidebar, with
  every page a person may open; old settings addresses go to their new homes; Profile changes the
  account's name and password and puts both back; Appearance sets theme, text size and terminal
  font, kept across a reload from the first paint, and the account menu reads the same theme; a
  member sees no owner page or Server and is refused them by address; an operator sees Server; the
  phone's Settings tab, Profile and Appearance at 390px; Sign out last.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's name and
  password are what they were before the run.
- **Mode:** `scripted` (recipes/new-web-settings.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/`, `apps/web/src/routes/_inbox.settings.index.tsx`,
  `apps/web/src/routes/_inbox.settings.profile.tsx`,
  `apps/web/src/routes/_inbox.settings.appearance.tsx`, `apps/web/src/routes/_inbox.settings.$.tsx`,
  `apps/web/src/lib/settings-pages.ts`, `apps/web/src/lib/settings-guards.ts`,
  `apps/web/src/lib/appearance.ts`, `apps/web/src/lib/account.ts`

### settings.new-web-dotfiles

- **Map:** dotfiles.md `dotfiles-repo-web`, `dotfiles-repo-refused`, `dotfiles-manager`,
  `dotfiles-web-files`; secret-files.md `secrets-list`, `secrets-add-web`, `secrets-path-refused`,
  `secrets-remove`
- **Needs:** no session; no turn; web; the server reaches GitHub
- **Do:** Drive the recipe `new-web-dotfiles`: old `/settings/workspace#<section>` links land on
  Dotfiles, Devices and access keys or Connected apps; a repository the server can't clone is
  refused with nothing saved, and a small public one saves with its manager; a home file is added
  from the browser and removed; a secret file's path outside the home folder is refused, then the
  file is added from pasted text, replaced from a chosen file and removed.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's repository,
  home files and secret files are what they were before the run, and no secret file's content
  appears anywhere.
- **Mode:** `scripted` (recipes/new-web-dotfiles.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/dotfiles-page.tsx`,
  `apps/web/src/routes/_inbox.settings.dotfiles.tsx`, `apps/web/src/lib/dotfiles-repository.ts`,
  `apps/web/src/lib/secret-files.ts`

### settings.new-web-devices

- **Map:** pairing-devices.md `pair-web`, `mint-by-hand`, `device-list`, `revoke`; workspace-ssh.md
  `ssh-keys`, `no-gateway`; access keys (ADR 0023)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-devices`: `/settings/access-keys` opens Devices and access keys;
  Show a code makes a pairing code with its QR; a token made by hand is shown once, then its device
  is listed and revoked by name; an access key is created, shown once, listed by name and revoked;
  the workspace SSH keys list, Add SSH key… with `mend ssh setup`, and Remove… with its result; on
  the box, the keys this account registered with `mend ssh setup`.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no device or key the run
  made is left behind, and no code, token or key appears in any picture.
- **Mode:** `scripted` (recipes/new-web-devices.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/devices-page.tsx`,
  `apps/web/src/routes/_inbox.settings.devices.tsx`, `apps/web/src/lib/devices.ts`,
  `apps/web/src/lib/pairing-qr.ts`

### settings.new-web-agent-logins

- **Map:** provider-accounts.md `accounts-list`, `connect-web` (an API key only), `disconnect`,
  `reconnect-state`, `agent-logins`; git-access.md `mode-choice`, `mend-key`, `key-card`,
  `key-check`, `bridge-share`; git-author.md `git-author-set-web`, `git-author-refused`,
  `git-author-clear`
- **Needs:** no session; no turn; web and the CLI
- **Do:** Drive the recipe `new-web-agent-logins`, and while it waits run its CLI batch
  `new-web-agent-logins-connect.json`: `/settings/git-access` opens Agent logins and Git; Connect
  Claude Code shows `mend login --url` and `mend connect claude` and closes by itself when the
  batch's login lands; Codex's login is replaced with an API key, a wrong key refused first; a
  refused login reads Reconnect; Disconnect removes one; "Selected agent's login only" saves and
  reports a failed save; the Git author is refused, saved and returned to the account's; the Mend
  key is checked against GitHub; the Git access mode switches to your computer's key and back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no part of any key on a
  page; the account's author, mode and switch are what they were before the run.
- **Mode:** `scripted` (recipes/new-web-agent-logins.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/agent-logins-page.tsx`,
  `apps/web/src/components/agent-login-panels.tsx`,
  `apps/web/src/routes/_inbox.settings.agent-logins.tsx`, `apps/web/src/lib/agent-login.ts`

### settings.new-web-mcp-servers

- **Map:** none in a feature file (route PR 41: a person's own MCP servers, docs/adr/0024)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-settings-mcp`: MCP servers lists the account's own servers under
  "Only you"; add an HTTP server with a header (the row names the header, never its value), a stdio
  server and an SSE one; a taken name is refused before sending; turn one off and it stays off; a
  failed switch goes back with Try again; edit a URL and keep the saved header; a kept sign-in shows
  Signed in and Forget sign-in… confirms; remove one; the Executor services section (recorded
  answers) points to Connected apps without a link, lists services with one, and a service sign-in
  comes back through `/executor/service-callback`, or says why it was refused; a failed read shows
  Try again; the phone width uses 44px targets and an action sheet. The recipe removes the servers
  it added.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no header value in any
  picture, log or note.
- **Mode:** `scripted` (recipes/new-web-settings-mcp.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/mcp-servers-page.tsx`,
  `apps/web/src/components/settings/mcp-server-dialog.tsx`,
  `apps/web/src/components/settings/executor-services.tsx`,
  `apps/web/src/routes/_inbox.settings.mcp-servers.tsx`,
  `apps/web/src/routes/_inbox.executor.service-callback.tsx`, `apps/web/src/lib/mcp-servers.ts`

### settings.new-web-notifications

- **Map:** none in a feature file (route PR 42: phone notifications, `GET`/`PUT /me/notifications`)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-settings-notifications`: Notifications shows the four switches
  as the server holds them under "Only you"; turning one saves it at once, says so in a toast, and
  the server keeps it; a slow save shows Saving…; a refused one goes back with Try again; Sent to
  says no phone is paired, and (recorded answer) lists a paired iPhone and leaves a browser out; a
  failed read shows Try again; the phone width. The recipe puts the setting back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's setting is
  what it was before the run.
- **Mode:** `scripted` (recipes/new-web-settings-notifications.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/notifications-page.tsx`,
  `apps/web/src/routes/_inbox.settings.notifications.tsx`, `apps/web/src/lib/notifications.ts`,
  `apps/web/src/server/routers/devices.ts`

### settings.new-web-connected-apps

- **Map:** slack.md `slack-link`, `slack-default-project`; doppler.md `doppler-settings`,
  `doppler-disconnect`
- **Needs:** no session; no turn; web; for Slack and Executor for real, a Slack workspace and an
  Executor connected to the organization
- **Do:** Drive the recipe `new-web-settings-connected-apps`: Connected apps under "Only you" shows
  Slack, Executor and Doppler; Doppler connects, replaces and disconnects a token with no part of it
  ever shown, and the disconnect confirmation counts the projects with a picked config; a linked
  Slack shows Your default project and unlinks; Executor's row says your link is used before the
  organization's shared account; `/executor/callback` finishes a link and returns, or says why it
  didn't; old `/settings/workspace` opens Connected apps; `/slack/link#<code>` names the workspace,
  the Slack user and the Mend account, warns when it replaces a link, links, and says when a code
  can't be used; old `/slack/link/<code>` moves the code to the fragment; a signed-out visitor signs
  in on the same address. On the box, link Slack from a real mention.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no token in any picture,
  log or note; no Doppler token left on the account.
- **Mode:** `scripted` (recipes/new-web-settings-connected-apps.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/connected-apps-page.tsx`,
  `apps/web/src/components/settings/brand-marks.tsx`,
  `apps/web/src/routes/_inbox.settings.connected-apps.tsx`,
  `apps/web/src/routes/_inbox.executor.callback.tsx`, `apps/web/src/routes/slack.link.index.tsx`,
  `apps/web/src/routes/slack.link.$code.tsx`, `apps/web/src/lib/connected-apps.ts`,
  `apps/web/src/lib/slack-link.ts`

### settings.new-web-automation

- **Map:** land-change.md `land-automatic` (the composer starts from the switch); review-change.md
  (description and tour, suggested fixes as your switches); project-settings.md
  `settings-review-automation`, `settings-landing` (moved here, no Inherit). Route PR 43.
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-settings-automation`: `/settings/review`, `/settings/landing`
  and `/settings/sessions` open Your automation; under "Only you" the four switches (Change
  description and tour, Suggested fixes, Automatic landing, Stop the session when you settle its
  thread) show what the server holds, with no Inherit; turning each saves it, says so in a toast,
  and the server keeps it without changing `autoName` or `backgroundSessions`; the home composer's
  "Land when a turn completes" starts from Automatic landing, on and off; a slow save shows Saving…;
  a refused one goes back with Try again; a failed read shows Try again; the phone width. The recipe
  puts both settings back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's automation
  and settle settings are what they were before the run.
- **Mode:** `scripted` (recipes/new-web-settings-automation.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/automation-page.tsx`,
  `apps/web/src/routes/_inbox.settings.automation.tsx`, `apps/web/src/lib/automation.ts`

### settings.new-web-boat

- **Map:** none in a feature file (route PR 48: the organization's Boat key, docs/adr/0025)
- **Needs:** no session; no turn; web; for a connected key for real, an owner and a Boat key
- **Do:** Drive the recipe `new-web-settings-boat`: Boat under "Everyone in <organization>" says
  whether there is a key; an owner connects one through a dialog with the create-key command, a
  value that isn't a key is refused and the field empties; a connected key shows who added it and
  when it expires, a banner two weeks before expiry with Replace key…, the wallet when the key's
  account can bill several, Last check with Check again, Full check with its steps and a dialog to
  run one, and what Boat reported; replace and remove confirm in dialogs and say a refusal there; a
  member reads only whether there is a key; a failed read shows Try again. On the box, connect and
  check a real key.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no part of the key in any
  picture, log or note.
- **Mode:** `scripted` (recipes/new-web-settings-boat.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/boat-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.boat.tsx`, `apps/web/src/lib/boat-key.ts`,
  `apps/web/src/server/routers/boat-key.ts`

### organization.new-web-org-projects

- **Map:** none in a feature file (the owners' Projects page, the owner's ruling of 18 Nov 2026)
- **Needs:** no session; no turn; web; a second account to join and leave
- **Do:** Drive the recipe `new-web-settings-org-projects`: Projects under "Owners of
  <organization>" sits in the owner's settings sidebar right before Audit log, and a member has no
  such entry and is sent to Profile by its address; with nothing to show, both lists say so; a
  project whose creator left is listed without a creator, and Take over… confirms, says a refusal in
  the dialog, and once taken over the row goes, a toast says so and the project is the owner's; kept
  volumes list their project, volume, Docker name, when and size, with no actions; a failed read
  shows Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the member and the
  project the recipe made are gone afterwards.
- **Mode:** `scripted` (recipes/new-web-settings-org-projects.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/organization-projects-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.projects.tsx`,
  `apps/web/src/lib/organization-projects.ts`

### settings.new-web-server

- **Map:** exposure.md `exposure-report`, `tenancy-gate`; doctor.md `doctor-web-connection`;
  workspace-images.md `image-instance-default` (read-only); operator.md `org-list`
- **Needs:** no session; no turn; web; the server's operator and a second account that isn't one
- **Do:** Drive the recipe `new-web-settings-server`: Server under "Operators of this server" shows
  the exposure declaration and every gate item with how it was established, with Check again; the
  version, where the server runs, its store and session channel; the Sealant connection with Check
  again (Checking… while it runs; connected, key refused, unreachable and not Sealant each say what
  Mend saw), and the runtimes offered with the server's Boat lines; the starting workspace image
  with no editor; tenancy, the multi mode gate item by item and every organization with its member
  and owner counts ("no owner" for an ownerless one). A section whose read fails shows Try again and
  the rest stand. Old `/settings/instance/*` and `/settings/sealant` land here. Someone who isn't an
  operator has no Server in the sidebar, is sent to Profile, and the API answers them 404. On the
  box, the check reads the box's own Sealant.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no key, token or
  connection secret in any picture, log or note.
- **Mode:** `scripted` (recipes/new-web-settings-server.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/server-page.tsx`,
  `apps/web/src/routes/_inbox.settings.[server].tsx`, `apps/web/src/lib/server-settings.ts`,
  `apps/web/src/server/routers/operator.ts`

### adopt-project.new-web-first-project

- **Map:** adopt-project.md `adopt-web`, `adopt-invalid-url`, `adopt-visibility`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `new-web-first-project` (after the composer's CLI batch
  `new-web-composer-setup.json`): setup's First project step sends someone who sees a project on to
  Mend; with the project list answered without the account's projects, it refuses a local path,
  reports a clone that fails with Clone again and Change details, clones a small public repository
  shared with the organization, then clones a big one, keeps it across a reload, and Continue to
  Mend opens the composer, where a session queued on the clone waits and starts.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the session queued on the
  clone starts by itself; every project the recipe made is purged at its end.
- **Mode:** `scripted` (recipes/new-web-first-project.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/first-project-step.tsx`,
  `apps/web/src/routes/welcome.first-project.tsx`, `apps/web/src/lib/use-clone.ts`,
  `apps/web/src/lib/setup.ts`

### adopt-project.new-web-project-page

- **Map:** adopt-project.md `project-page`; session-shell.md `shell-session-web`; start-session.md
  `start-in-worktree`; handoff.md `handoff-row`; models.md `model-shown`; per-person-homes.md
  `join-line`
- **Needs:** no turn; web; CLI; `verify-fixture` (or `<p>` on the box) with a live `mend run`
  session in it
- **Do:** Drive the recipe `new-web-project` (after its CLI batch `new-web-project-setup.json`): a
  project's page with its header, facts and tabs; the Sessions tab's search, Filter, Mine or
  Everyone and Open or Stopped, kept in the address across a reload; a row's "…" starts a shell and
  another session in its worktree; Open shell starts one in a new worktree; the "…" opens Set up
  this project, which starts a setup session; an empty project; a clone's page while it runs; the
  old setup page's address; a project that fails to load.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every session the recipe
  started is stopped, and every project it made is purged, at its end.
- **Mode:** `scripted` (recipes/new-web-project.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/project/`,
  `apps/web/src/routes/_inbox.projects.$projectId.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.index.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.setup-session.tsx`,
  `apps/web/src/lib/project-sessions.ts`, `apps/web/src/lib/project-starts.ts`,
  `apps/web/src/lib/shared-workspace.ts`

### session-page.new-web-tiles

- **Map:** no feature file yet (ADR 0026, tabs and tiles); start-session.md `session-page`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-tiles-sessions.json` (two sessions in the worktree `tiles-ws`,
  each a `sleep`), then drive the recipe `new-web-tiles`: drag a tab onto a tile's right edge and
  into another tile's middle, move tabs with Alt+Shift and the arrows, resize by the divider,
  reload, maximise and restore, close a tile's last tab, reopen it from "+", open a New session tab,
  start a session in the worktree from outside the page, open `?full=1`, and look under 1024px and
  at 390px. Stop both batch sessions at the end.
- **See:** each step's note in the recipe's `steps.log`: the drop marks Split right and Add to this
  tile, two tiles after a split and one after a merge, the resized width kept over a reload, the
  same conversation element after its tab moved, Restore layout on a maximised tile, the started
  session's tab beside the active one, and one strip of tabs under 1024px.
- **Mode:** `scripted` (recipes/new-web-tiles.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/workspace/`,
  `apps/web/src/components/session/session-sheet.tsx`,
  `apps/web/src/components/session/workspace-tabs.tsx`,
  `apps/web/src/components/session/new-session-tab.tsx`, `apps/web/src/lib/tiles.ts`

### session-page.new-web-layouts

- **Map:** no feature file yet (ADR 0026, "Layouts": the layout menu and a person's saved layouts,
  SLNT-1175)
- **Needs:** either; no turn; web and CLI; `<p>`; the owner's sign-in typed in a second browser
- **Do:** Run the CLI batch `new-web-layouts-sessions.json` (two sessions in the worktree
  `layouts-one`, one in `layouts-two`, each a `sleep`), then drive the recipe `new-web-layouts` with
  `--account`: open the layout button in the Workspace header, pick Change over terminal and press
  ⌥2 and ⌥3, save the sheet as "Review with terminal", be refused the same name in lower case, pick
  it in `layouts-two`, see it from a second browser signed in as the same person, rename and remove
  it, and look under 1024px. Then drive `new-web-layouts-server` for the API's refusals, limits and
  a second person.
- **See:** each step's note in the recipes' `steps.log`: the check on the layout the sheet shows,
  both sessions kept in one tile under Change over terminal and the Terminal tab kept under ⌥2, the
  saved toast and the menu again with the saved layout at ⌥5, the name-taken sentence in the dialog,
  the same three tiles in `layouts-two` while `layouts-one` keeps its own, the layout in the second
  browser, and no layout button under 1024px. Each recipe leaves nothing it saved.
- **Mode:** `scripted` (recipes/new-web-layouts.mjs, recipes/new-web-layouts-server.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/lib/layouts.ts`, `apps/web/src/components/workspace/layout-menu.tsx`,
  `packages/domain/src/workbench/saved-layout.ts`, `packages/db/src/repos/saved-layouts.ts`,
  `packages/api-contracts/src/saved-layouts.ts`, `apps/api/src/routes/saved-layouts.ts`,
  `apps/web/src/server/routers/layouts.ts`

### session-page.new-web-terminal

- **Map:** session-shell.md `shell-holds`; mobile.md `mobile-terminal-embed`; shared-control.md
  `terminal-owner-only`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-terminal-sessions.json` (a `sleep` session in the worktree
  `term-ws`), then drive the recipe `new-web-terminal`: open the old shell address, open New shell,
  type a command, Ctrl and click a printed link, move the Terminal tab to a tile of its own,
  maximise it, put it under the conversation and back, Close shell…, watch as a member with shared
  control (a fixture), look at 390px, load `/tty-embed` with an upgrade ticket and no cookie, and
  stop the session. Stop the batch session at the end if the recipe didn't.
- **See:** each step's note in the recipe's `steps.log`: the redirect to `/sessions/<id>/terminal`
  with the Terminal tab showing, the command's output read through Copy, the link's new tab, the
  shell's column count falling in half a sheet and rising when maximised with the same terminal
  element, the closed shell's row, "Only <owner> types here. You're watching.", the ticket trade
  answering 200 and the socket's first output, and the stopped workspace's line.
- **Mode:** `scripted` (recipes/new-web-terminal.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/workspace/views/`, `apps/web/src/components/terminal/`,
  `apps/web/src/lib/workspace-shells.ts`, `apps/web/src/lib/terminal-links.ts`,
  `apps/web/src/lib/embed-exchange.ts`, `apps/web/src/routes/tty-embed.tsx`,
  `apps/web/src/routes/_inbox.sessions.$sessionId.$view.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.shell.$sessionId.tsx`

### session-page.new-web-details

- **Map:** models.md `model-shown`; per-person-homes.md `shared-workspace-line`, `layout-fallback`;
  repositories-in-session.md `repo-session-card`; handoff.md `handoff-row`; land-change.md
  `land-session-line`; shared-control.md `share-on-web`, `share-off-web`, `who-pays`,
  `viewer-lines`, `org-owner-off`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-details-sessions.json` (two `sleep` sessions in one worktree
  `details-ws-<time>`, the first declaring a `web` Service in `.mend/mend.toml`), then drive the
  recipe `new-web-details`: start the `web` Service, open `/sessions/<id>/details`, follow "Shared
  with 1 other session", turn shared control on (through its dialog) and off, open Details from the
  other session's tile "+", read the fixture lines (a pull request, a handoff, a second repository,
  checks with edits since, a model, a per-person workspace and a layout fallback; shared control
  granted to the viewer alone), follow Preview to its tab, and a pull request read that fails with
  Try again.
- **See:** each step's note in the recipe's `steps.log`: the Details tab selected; the Workspace
  group's worktree, branch, base and "None yet"; "web :8000" Running under Services; both sessions
  with owner, agent and status; focus on "Sessions in this workspace"; the who-pays line and the
  dialog's words; `sharedControlEnabledAt` set after Turn on and null after Turn off; Details in the
  "+" menu; the Preview tab selected from Preview; the fixture lines; "This didn't load." then "None
  yet" after Try again.
- **Mode:** `scripted` (recipes/new-web-details.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/workspace/details-view.tsx`,
  `apps/web/src/components/session/shared-control.tsx`,
  `apps/web/src/components/workspace/views/details-view.tsx`, `apps/web/src/lib/session-details.ts`

### session-page.new-web-shared-workspace

- **Map:** per-person-homes.md `join-line`, `runs-as-yourself`, `shared-workspace-line`;
  start-session.md `session-stop-shared`; land-change.md `land-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-shared-workspace-sessions.json` (the worktree
  `shared-ws-<time>`: one `mend run` that writes a file, then two `sleep` sessions in it), then
  drive the recipe `new-web-shared-workspace`: open the home composer's worktree picker, pick the
  running workspace, read the join line with another person's session live there (fixture), open
  that person's session and press "Start your own session in this workspace", Stop session… on the
  second session and stop it, then Land… on the first and land (fixture answer).
- **See:** each step's note in the recipe's `steps.log`: "Your running workspaces in <project>" with
  the worktree and "2 sessions"; no join line where only your sessions run; the join line saying the
  session runs as you, on your own logins; a New session tab beside the other person's with the join
  line and the task field focused; the Stop dialog naming the session that keeps the workspace
  running, and the toast that it is still running; the Land dialog naming the session still editing,
  and the toast "Pushed … to origin. … is still running."
- **Mode:** `scripted` (recipes/new-web-shared-workspace.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/new-session/join-line.tsx`,
  `apps/web/src/components/new-session/pickers.tsx`, `apps/web/src/lib/shared-workspace.ts`

### session-stop.new-web-session-actions

- **Map:** start-session.md `session-stop`, `session-stop-shared`; attach-resume.md `resume-web`,
  `rename-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-session-actions-sessions.json` (two sessions in the worktree
  `actions-ws` and one in `actions-solo`, each a `sleep`), then drive the recipe
  `new-web-session-actions`: right-click a session tab, open its tile's "…" and the workspace "…",
  Copy branch name, New session in this workspace, rename by F2, open Stop session… on a session
  that shares its workspace and on one alone in its own, stop each, resume the lone one, and open
  the phone's "…" sheet and its Stop session sheet at 390px.
- **See:** each step's note in the recipe's `steps.log`: the tab menu holds the session's actions
  and no workspace action, the workspace menu holds no session action; the dialog names the session
  that keeps the workspace running, and says the workspace stops too for the lone one; the stopped
  banner and "You stopped the session at …" with what the workspace does now; the session running
  again after Resume session.
- **Mode:** `scripted` (recipes/new-web-session-actions.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/session/session-actions.tsx`,
  `apps/web/src/components/session/stopped-banner.tsx`, `apps/web/src/lib/session-stop.ts`

### session-stop.new-web-session-ended

- **Map:** capture-and-save.md `capture-stop-line`, `capture-not-saved`, `capture-discard`;
  workspace-replace.md `retire-line`, `retire-evidence`, `replace-web`, `replace-refused`,
  `replacing-line`; services.md `service-hold`; attach-resume.md `delete-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-session-ended-sessions.json` (one `sleep` session in `ended-a`
  and one in `ended-b`), then drive the recipe `new-web-session-ended`: read the bands a stopped
  session shows while it saves, when work isn't saved (Discard…), while Services keep the workspace
  up (Stop services) and while the workspace waits to be replaced (Replace this workspace now), then
  stop the other session and delete it from its tab's menu.
- **See:** each step's note in the recipe's `steps.log`: each band's line in the domain's words, the
  server's answer to Discard and stop, Stop services and Replace this workspace now; no Delete
  session… on a running session; the Delete dialog's "What stays"; home after Delete with "Deleted …
  Its worktree and change are still in …", and the session gone from the inbox.
- **Mode:** `scripted` (recipes/new-web-session-ended.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/session/session-notices.tsx`,
  `apps/web/src/lib/shared-workspace.ts`

### session-page.new-web-preview

- **Map:** services.md `service-run-web`, `service-recipe`, `service-add`, `service-observe`,
  `service-logs`, `service-restart-stop`; mend-toml.md `toml-recipes-card`, `toml-parse-error`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-preview-sessions.json` (two `sleep` sessions in a new worktree
  `preview-ws-<time>`, whose `.mend/mend.toml` declares `web` and `broken`), then drive the recipe
  `new-web-preview`: open `/sessions/<id>/preview`, Start web, open its page in a new tab, type a
  path, Run a command… that asks `web` for its page from inside the workspace, open both logs,
  Restart service…, adopt a port with an empty command, Start broken, Stop web and Run again, look
  at 390px with the picker open, a Mend preview on another site, a file that doesn't parse and a
  watcher with shared control (fixtures), the view's failed read, and Stop session on both.
- **See:** each step's note in the recipe's `steps.log`: the file's recipes with Start, "Both
  sessions in <worktree> use these services…", `web` Running with `:8000` on the Preview tab, the
  new tab at the Service's address and the typed path in its link, `docs` printing
  `web answered 200` and `web`'s Logs bar showing that `GET /`, the Restart dialog saying the other
  session uses it, the adopted port, `broken` named as not started with its exit and output, `web`
  Stopped then Running, the picker's services and actions, "Previews are on a different site…" with
  Open in a new tab, the file's error with Read it again, "Only <owner> starts services…" with
  Restart and Stop still there, Try again, and "This workspace isn't running…" with Resume after
  both stop.
- **Mode:** `scripted` (recipes/new-web-preview.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/workspace/views/preview-view.tsx`,
  `apps/web/src/components/workspace/views/preview-page.tsx`,
  `apps/web/src/components/workspace/views/service-log.tsx`,
  `apps/web/src/components/workspace/views/run-command-dialog.tsx`,
  `apps/web/src/components/workspace/views/use-workspace-services.ts`,
  `apps/web/src/lib/workspace-services.ts`, `apps/web/src/lib/previews.ts`,
  `apps/web/src/server/routers/services.ts`

### session-page.new-web-checks

- **Map:** none in a feature file: the checks the agent ran were a section of the old app's side
  panel, and are the Checks view in the new web app (SLNT-1157)
- **Needs:** either; one Codex turn; web and CLI; `<p>`
- **Do:** Drive the recipe `new-web-checks-box` (`pnpm verify drive new-web --box`): it starts a
  Codex session on `verify-fixture` that writes three scripts, runs a test twice, a typecheck, a
  lint that fails and `ls`, then edits README.md; it opens `/sessions/<id>/checks`, the tile's "+",
  and 390px, then lays fixtures over that session's record reads: earlier history unread with a
  check Claude ran through Bash, an empty record, the record being read, and a failed read with Try
  again; then it stops the session. Locally, the CLI batch `new-web-checks-sessions.json` (a `sleep`
  session in `checks-ws`) and the recipe `new-web-checks` draw the same states from fixtures alone.
- **See:** each step's note in the recipe's `steps.log`: the Checks tab showing with its fact ("1
  failed"), one row per command, newest first, `ls` not among them and the test once, each with what
  it is, how it ended and the checkpoint it ran after ("Lint failed after checkpoint N"), the
  command, Codex's exit code and how long it took; "No check ran after the last edit."; Checks
  between Change and Preview in the "+" menu; no sideways scroll at 390px. From the fixtures:
  Claude's run reading "The record doesn't hold how it ended.", Read earlier history, the empty
  line, "Reading the record…", and "This didn't load." with Try again bringing the list back.
- **Mode:** `scripted` (recipes/new-web-checks-box.mjs, recipes/new-web-checks.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/workspace/views/checks-view.tsx`, `apps/web/src/lib/checks.ts`

### start-session.boat-turn

- **Map:** start-session.md `start-cli-harness`; models.md `launch-flags`, `model-shown`
- **Needs:** Boat; real turn (codex); CLI; `<p>`
- **Do:**
  `M codex "Create a file named MAIN-RUN.md containing the one line: seen. Change nothing else." --name main-run-<sha8> --project <p> --effort low --detach --conversation --json`;
  record the session id in the ledger as `session` and `main-run-<sha8>` as `worktree`. Then
  `M wait <id> --turn --timeout 8m` and `M sessions --project <p>`.
- **See:** `mend wait` exits `0` on a completed turn; the session lists in `<p>` as `codex`, its dim
  facts ending `· <default model id> · low`, its change one file, `+1`.
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Sample:** yes
- **Areas:** `packages/sessions/`, `packages/agent-protocol/`, `packages/agent-conversation/`,
  `apps/cli/src/`

### start-session.composer

- **Map:** start-session.md `start-composer`; now-and-sessions.md `home-composer`
- **Needs:** Boat; real turn (codex); web; `start-session.boat-run` (its worktree)
- **Do:** On `/`, in the form `New session`: project `<p>`, worktree `main-run-run-<sha8>`, harness
  codex, the prompt `Reply with the single word ready and change nothing.`, then `Start`. Wait for
  the turn with `M wait <id> --turn --timeout 8m`.
- **See:** the browser lands on `/sessions/<id>` for a codex session in that worktree; the turn
  completes; `M sessions --project <p> --json` lists it with no file changed by it.
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web-old/src/`, `apps/api/src/`, `packages/sessions/`

### start-session.web-write

- **Map:** start-session.md `session-page`
- **Needs:** Boat; real turn (codex); web; `start-session.composer` (its session)
- **Do:** On `/sessions/<id>` for the session `start-session.composer` started, in the composer
  under its conversation (the field `Message Codex`): send
  `Reply with the single word pong and change nothing.` and wait for the turn. Send
  `Run the shell command sleep 45, then reply with the single word slept.`; while that turn runs,
  send `Add the word steered after slept.` and wait for the turn. Send
  `Run the shell command sleep 600, then reply with the word done.`, and once `Stop turn` shows,
  choose it.
- **See:** each message shows in the conversation as soon as it is sent, and the field empties; the
  first is answered `pong`; the one sent while the turn ran reads
  `Sent into this turn. Codex reads it when its current step finishes.` (then
  `Codex read this during its turn`) and starts no turn of its own; after `Stop turn` that turn
  reads `Stopped after …`, the line `This turn was stopped at …` follows it, and the session's tab
  reads Idle.
- **Mode:** `agent`
- **Box:** after cut-over
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/components/session/composer.tsx`, `apps/web/src/lib/outbox.ts`,
  `apps/web/src/lib/session-composer.ts`

### start-session.web-answer

- **Map:** terminal-agent-waits.md `wait-permission`, `wait-question`, `wait-clears`;
  shared-control.md (anyone who steers answers)
- **Needs:** Boat; real turn (codex); web; `start-session.composer` (its session)
- **Do:** On `/sessions/<id>` for the session `start-session.composer` started, open the composer's
  model menu, tick `Ask before acting`, and send
  `Run the shell command printf ok > approval-check.txt, then delete the file by running exactly rm -f approval-check.txt. Reply with the single word deleted if the file is gone, or kept if the deletion didn't run.`
  Codex runs with full access in the workspace, so it asks only before a command it counts as
  dangerous, such as `rm -f`. When the composer card asks (`Codex wants to run a command`), choose
  `Approve`. Send the same message again with `refused-check.txt` and choose `Deny` when it asks.
- **See:** while Codex waits, the card shows the command with `Approve once`, `Always allow …`,
  `Deny` and `Approve`, the conversation reads `Wants to run a command · Waiting for your approval`,
  and the session's sidebar row is under `Waiting on you`; after `Approve` the card goes, the
  conversation reads `You approved the command once`, the row leaves `Waiting on you` with no
  reload, and the turn replies `deleted`; after `Deny` it reads `You denied` and Codex replies
  `kept`.
- **Mode:** `agent`
- **Box:** after cut-over
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/components/session/request-card.tsx`,
  `apps/web/src/lib/agent-requests.ts`, `apps/web/src/lib/answered-here.ts`

### start-session.boat-run

- **Map:** start-session.md `start-cli-run`
- **Needs:** Boat; no turn; CLI; `<p>`
- **Do:**
  `M run --project <p> --name main-run-run-<sha8> -- sh -c 'printf "verified\n" > VERIFY.md'`;
  record its session id as this run's `run session`.
- **See:** the map's `✓ project`, `✓ worktree`, `✓ recording · sh · workspace mounts the worktree …`
  lines and, at the end, `✓ exited · code 0 · recorded`; exit code `0`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Sample:** yes
- **Areas:** `packages/sessions/`, `apps/api/src/machine-boat.ts`, `apps/cli/src/`

### start-session.docker-run

- **Map:** start-session.md `start-cli-run`
- **Needs:** Docker; no turn; CLI; fixture `main-run-docker`
- **Do:** `M run --project <p> --worktree main-run-docker -- sh -c 'date -u > MAIN-RUN-DOCKER.md'`.
- **See:** `✓ recording · sh · workspace mounts the worktree` and `✓ exited · code 0 · recorded`;
  exit code `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Sample:** yes
- **Areas:** `packages/sessions/`, `apps/api/src/`, `apps/cli/src/`

### start-session.boat-live

- **Map:** start-session.md `start-cli-run` (a live session for the flows after it)
- **Needs:** Boat; no turn; CLI in its own PTY; `<p>`
- **Do:** In tmux, `M run --project <p> --name main-run-live-<sha8> -- sleep 1800`; record `<id>`
  and `<id8>` from its `✓ base … · session <id8>` line. `capture-and-save.live-stop` ends it.
- **See:** `✓ recording · sleep · …`; `M sessions --project <p> --json` lists it live.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `apps/api/src/machine-boat.ts`, `apps/cli/src/`

### review-change.web-review

- **Map:** review-change.md `review-open`, `review-diff`; start-session.md `session-page`
- **Needs:** either (the turn's session); no turn; web; `start-session.boat-turn`
- **Do:** Recipe `session-review` with `MAIN_RUN_SESSION` set to the turn's session.
- **See:** on the Now inbox, the session's row menu `Open review` opens the session's change at
  `/sessions/<id>/change` (`/changes/<id>` lands there too; either path is seen), whose diff shows
  `MAIN-RUN.md` and the added line `seen`. The recipe's exit `0` and its `steps.log` line
  `Open review on <id8>'s row opened <path>: the diff's MAIN-RUN.md reads … seen` show all of it.
- **Mode:** `scripted` (recipes/session-review.mjs)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/web-old/src/routes/changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

### review-change.new-web-change

- **Map:** review-change.md `review-open`, `review-diff`, `review-files`, `review-pinned`;
  repositories-in-session.md `repo-review-line`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-change-sessions.json` (worktrees `change-small`, written by two
  sessions, `change-big` and `change-empty`, each by `mend run`), then drive the recipe
  `new-web-change`; when its `steps.log` reads "waiting for the worktree to change", run the batch
  `new-web-change-moves.json`. It opens `/sessions/<id>/change` and `/changes/<id>#land`, picks a
  file, switches to Split and reloads, marks a file viewed and reloads, shows the new version after
  the files change, reads the big change and filters it, splits the Change tab beside the
  conversation, and looks at 390px.
- **See:** each step's note in the recipe's `steps.log`: the Change tab focused with its +/− counts,
  "This workspace's change, from 2 sessions.", Split and the viewed mark kept over a reload, the
  banner "Files changed since you opened this." and the changed file unviewed after Show the new
  version, the lock file folded as generated, fewer drawn lines than the 3,000-line file holds,
  `/changes/<id>#land` arriving at `/sessions/<id>/change#land`, and the narrow tile's file picker.
- **Mode:** `scripted` (recipes/new-web-change.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/change/`,
  `apps/web/src/components/workspace/views/change-view.tsx`,
  `apps/web/src/routes/_inbox.changes.$changeId.tsx`, `apps/web/src/lib/change-files.ts`,
  `apps/web/src/lib/review-open.ts`, `apps/web/src/lib/viewed-files.ts`

### review-change.new-web-tour

- **Map:** review-change.md `review-machine-pass` (the description and tour); mobile.md (the tour on
  the phone)
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-change-sessions.json`, then drive the recipe `new-web-tour`. It
  waits for Mend's own pass on `change-small` (written on the box, failed on a local stack) and asks
  again; then lays a written description and a four-stop tour over the change, walks the tour
  forwards and back, opens a link into the session, ends the tour, folds the description on a later
  look, shows out of date, no description, being written and a login failure, then the narrow tile
  beside the conversation and 390px.
- **See:** each step's note in the recipe's `steps.log`: Mend's real outcome (the description "Mend
  wrote this from checkpoint N", or "Mend couldn't write the description." with its reason and Try
  again); "How the session got there" and "Tour · 4 stops" with Start tour; the Tour section above
  Files; stop 1's note between rows with the bar on its lines only; "Mend's reading of the code.
  Nothing in the session backs this up." on stop 2; stop 3 under its file's header; stop 4 under the
  description with Finish tour; End tour back at the same scroll; a record link focusing the
  session's conversation tab; Show more; Write again; the narrow tile's picker on the stop's file;
  44px Previous and Next on the phone.
- **Mode:** `scripted` (recipes/new-web-tour.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/change/change-description.tsx`,
  `apps/web/src/components/change/change-tour.tsx`, `apps/web/src/components/change/tour-stop.tsx`,
  `apps/web/src/lib/tour.ts`

### review-change.web-comments

- **Map:** review-change.md `review-change-comment`, `review-comment-state`,
  `review-checkpoint-mark`, `review-pinned`, `review-files`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On the run session's review, add a change-level comment; choose `Dismiss` on its row under
  `Comments 1 not sent`, then `Reopen` on the card it becomes; choose
  `More session actions → Mark a checkpoint`; reload the review. Leave the comment open for the next
  flow.
- **See:** under `Comments 1 not sent` the row `whole change` over the comment, with
  `Mark addressed` and `Dismiss`; after `Dismiss`, `Comments 0 not sent` and a card
  `<name> · dismissed` with `Reopen`; after `Reopen`, the row back under `Comments 1 not sent` and
  no card; a new `#<n> user-mark` checkpoint line; the `<sha A> → <sha B>` line unchanged on reload;
  `M sessions --project <p> --all --json` shows the session's `review.openComments` as `1`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/changes.$changeId.tsx`,
  `apps/web-old/src/components/session/change-tab.tsx`,
  `apps/web-old/src/components/comment-state.tsx`, `apps/api/src/`, `packages/store/`

### send-review-back.deliver

- **Map:** send-review-back.md `send-open`, `send-select`, `send-deliver`, `send-sent-state`
- **Needs:** Boat; real turn (codex); web; `attach-resume.boat-stop-resume` (the turn's session,
  settled)
- **Do:** On the turn's change, in the Comments rail's `Comment on the whole change` box, add the
  comment `Add a second line to MAIN-RUN.md reading: reviewed.` and choose `Comment`; choose
  `Send 1 to Codex` in the rail, then `Send 1 to Codex` in the overlay. Wait for the turn with
  `M wait <id> --turn --timeout 8m`.
- **See:** the rail's `Comments 1 not sent`; the overlay `Send 1 to Codex` with
  `1 of 1 comments · continues <branch>` and the checked comment
  `whole change · Add a second line …`; its confirm button reads `Sending…`; then
  `Comments 0 not sent` and the card `<owner> · sent` over the comment; `M wait` exits `0`; the
  change shows `MAIN-RUN.md` with the lines `seen` and `reviewed`.
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web-old/src/`, `apps/api/src/`, `packages/sessions/`

### land-change.panel-read

- **Map:** land-change.md `land-session-line`, `land-web` (the panel read; nothing pushed)
- **Needs:** either; no turn; web; `start-session.boat-run`
- **Do:** On the run session's page read the landing line, choose `Land →`, read the `Land` region,
  and push nothing.
- **See:** `not landed` with `Land →`; the region `Land` reads
  `not landed · nothing pushed from Mend yet` and either the pull request row or
  `pull request unavailable · origin is on <host>, not GitHub` (record which).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/`, `apps/api/src/landing-state.ts`, `packages/landing/`

### land-change.web-push

- **Map:** land-change.md `land-web` (submit, a non-GitHub origin), `land-session-line`,
  `land-preview` (its absence), `land-observe` (`Check origin`)
- **Needs:** either; no turn; CLI, web (the owner's browser) and `git` on the box over
  `MEND_VERIFY_BOX_SSH`; `<land>`
- **Do:**
  `M run --project <land> --name main-run-land-<sha8> -- sh -c 'printf "landed\n" > LAND.md'`;
  record its session id as this run's `land session`. On its page read the landing line, choose
  `Land →`, read the `Land` region, choose `Push to origin`, then `Check origin`; go back to the
  session page. On the box, `git --git-dir <git dir>/land.git log --oneline -1 <remote branch>` and
  `git --git-dir <git dir>/land.git show <remote branch>:LAND.md`. Nothing to restore: the pushed
  branch stays for `land-change.cli-again`.
- **See:** `not landed` with `Land →`; the region reads `push <branch> to origin`,
  `not landed · nothing pushed from Mend yet` and
  `pull request unavailable · origin is on <git host>, not GitHub`, with the button `Push to origin`
  and neither `Pull request title` nor `Preview description`; after the push a status line
  `pushed · <remote branch> · <sha>` with no pull request part; `Check origin` adds when origin was
  last checked; the session line now states that fact instead of `not landed`; the box's `log` names
  the same `<sha>` and `show` prints `landed`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/land-panel.tsx`, `apps/api/src/landing-state.ts`,
  `apps/api/src/workspace-landing.ts`, `packages/landing/`

### land-change.cli-again

- **Map:** land-change.md `land-cli` (`--no-pr`, `--branch`), `land-again` (nothing new; more work)
- **Needs:** either; no turn; CLI and `git` on the box; `land-change.web-push`
- **Do:** `M land main-run-land-<sha8> --project <land>` (nothing new); add work without a turn with
  `M run --project <land> --worktree main-run-land-<sha8> -- sh -c 'printf "again\n" >> LAND.md'`,
  then `M land main-run-land-<sha8> --project <land>`; add work the same way once more
  (`printf "push-only\n"`), then
  `M land main-run-land-<sha8> --project <land> --no-pr --branch main-run/push-only-<sha8>`. On the
  box, `git --git-dir <git dir>/land.git log --oneline -2` for both branches. Restore: on the box,
  `git --git-dir <git dir>/land.git branch -D main-run/push-only-<sha8>`, so only Mend's landing
  branch is left.
- **See:** the first `land` prints `  landing <branch> to origin · <land> · session <id8> · …`, exit
  `1`, and `mend: landing not started · nothing new since the last landing`; the second prints the
  same `  landing <branch> to origin · …` line, then `✓ pushed · <remote branch> · <sha>` with no
  pull request, `  checkpoint <sha>` and an `  observed` block, exit `0` (record the pull request
  line it prints, if any); the third prints
  `  landing <branch> to origin as main-run/push-only-<sha8> · …` and its first `✓` line reads
  `pushed · main-run/push-only-<sha8> · <sha>`, exit `0`; the box's logs carry those shas; after the
  restore only `<remote branch>` holds this run's commits.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/landing.ts`, `apps/api/src/landing-state.ts`, `packages/landing/`,
  `packages/domain/src/workbench/landing-rules.ts`

### land-change.refused

- **Map:** land-change.md `land-refused`, `land-observe` (`Check origin` after a refused push)
- **Needs:** either; no turn; CLI, web (the owner's browser) and `git` on the box;
  `land-change.cli-again`
- **Do:** Add unlanded work with
  `M run --project <land> --worktree main-run-land-<sha8> -- sh -c 'printf "refused\n" >> LAND.md'`.
  On the box, in this order:
  1. Record `<mend sha>`, the sha Mend last pushed:
     `git --git-dir <git dir>/land.git rev-parse <remote branch>`.
  2. In a `mktemp -d` directory, clone `<git dir>/land.git` at `<remote branch>`, write
     `OUTSIDE.md`, `git add OUTSIDE.md`, make exactly one commit, and push it back. Write these
     commands fresh: no other commit, no `--allow-empty`, no `|| true`. On 19 Nov a script reused
     from another flow left an empty commit before the outside one.
  3. Check that origin holds exactly one commit Mend has not seen:
     `git --git-dir <git dir>/land.git log --oneline <mend sha>..<remote branch>` prints one line,
     `OUTSIDE.md`'s commit. Record its sha as `<outside sha>`. If it prints more than one line, set
     the branch back to `<mend sha>` with the restore's `update-ref` below and do step 2 again,
     before any `land`.

  Run `M land main-run-land-<sha8> --project <land>` with no `--branch`; read `rev-parse` again and
  `git --git-dir <git dir>/land.git branch --list 'main-run/push-only-*'`; on the review page read
  the `Land` region's first line, then choose `Check origin`. Restore: on the box, set the branch
  back to the sha Mend last pushed
  (`git --git-dir <git dir>/land.git update-ref refs/heads/<remote branch> <mend sha> <outside sha>`)
  and remove the clone.

- **See:** the `land` prints `  landing <branch> to origin · <land> · session <id8> · …`, naming
  Mend's landing branch and not `main-run/push-only-<sha8>`, with no `origin no longer has …` line,
  then `· push refused · <remote branch> · <remote's words>`, exit `1`; origin's head is the outside
  commit before and after the `land`, and `branch --list` prints nothing (the push-only branch was
  not created again); the region reads `push <branch> to origin`, with no
  `as main-run/push-only-<sha8>`, and shows the refused landing; after `Check origin` it reads
  `origin <remote branch> at <outside sha7> · holds the landed commit · checked <n> s ago` and
  `origin has moved · <remote branch> has 1 commit Mend has not seen`; after the restore `rev-parse`
  prints Mend's last sha.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/workspace-landing.ts`, `packages/landing/src/git-words.ts`,
  `apps/web-old/src/components/land-panel.tsx`, `apps/cli/src/landing.ts`,
  `packages/domain/src/workbench/landing-rules.ts`

### land-change.new-web-land

- **Map:** land-change.md `land-web`, `land-preview`, `land-again`, `land-refused`, `land-check`,
  `land-observe`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `new-web-land-sessions.json` (the worktree `land-retry`, written by
  `mend run`, and a second session in it that keeps running), then drive the recipe `new-web-land`.
  It opens `/sessions/<id>/change`, chooses `Land…`, chooses `Push to origin` against the project's
  origin, then `Check origin`; opens the dialog from the workspace "…" and from
  `/changes/<id>#land`; then lays recorded answers over the landing reads for a GitHub origin: the
  title and description with `Preview`, the view after landing, the conversation's landing line,
  `Land again…` with `Update pull request #412`, GitHub refusing the push, and the phone's sheet. It
  stops the running session at the end.
- **See:** each step's note in the recipe's `steps.log`: `Land…` in the Change view's toolbar; the
  dialog `Land change` naming `Write tests for retry is still editing`; on an origin that is not
  GitHub, `No pull request: …` and `Push to origin`; the push refused in git's own words with
  `Try again`; a line from `Check origin`; `#land` opened by the workspace's `Land…` and by
  `/changes/<id>#land`; Preview showing your text, then Mend's section (`Summary` or no summary,
  changed files, `In Mend`); "Checkpoint N is in pull request #412." with no Land button;
  "Checkpoint N landed as pull request #412 · View pull request" in the conversation; "Checkpoint N
  isn't in pull request #412 yet." with `Land again…`; `Update pull request #412` keeping the title;
  `GitHub refused the push` with GH006's words.
- **Mode:** `scripted` (recipes/new-web-land.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/change/land-dialog.tsx`, `apps/web/src/lib/landing.ts`,
  `apps/web/src/components/change/change-view.tsx`,
  `apps/web/src/components/session/conversation-tile.tsx`

### services.cli-run

- **Map:** services.md `service-run-cli`, `service-observe`, `service-connect`, `service-logs`,
  `service-restart-stop`, `service-hold`; start-session.md `session-stop-shared`
- **Needs:** Boat; no turn; CLI and web; `start-session.boat-live`
- **Do:** On the live session, as services.md's CLI steps:
  `M service run <id8> --port 8000 --name web --http --no-connect -- python3 -m http.server 8000`,
  `service list`, `service connect web --port 18000` with one curl, `service logs`,
  `service restart`. While `web` runs, read its card in the owner's browser: on
  `<web>/sessions/<id>` the `Preview` section shows a link `web :8000 · open the Preview tab`;
  choose it (or go to `<web>/sessions/<id>/preview`), and on the Preview tab wait up to 20 s for the
  `Services` card's `web` row to read `reachable`. The session page itself has no `Services` card.
  Start a second session in the worktree to keep the workspace running:
  `M run --project <p> --name main-run-live-<sha8> --detach --json -- sleep 1800`; record `<k8>`. In
  the owner's browser open `<web>/api/sessions/<id>/stop-preview`. Then `M stop <id8>` and
  `M stop --services <id8>`.
- **See:** the Preview tab's `Services` card lists `web` ending at `reachable`; curl prints `200`;
  the preview reads `"workspace":"keeps-running"` naming `<k8>`'s session and listing `web`;
  `mend stop` prints `the workspace keeps running for …` and names what keeps the workspace up
  ending `· mend stop --services <id8>`; then `✓ stopped 1 service · …` and `no live services — …`
  from `service list`. `<k8>` stays running for `capture-and-save.live-stop`.
- **Mode:** `agent` · a recipe would make it cheaper (the card half)
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `apps/api/src/`, `apps/cli/src/`, `packages/network/`

## Access and identity

### sign-in.fresh-browser

- **Map:** sign-in.md `registration-closed`, `web-sign-in`, `web-sign-out`, `authorize-page`
- **Needs:** no session; no turn; web; a fresh browser context (not the saved `browser.json`)
- **Do:** In a context with no saved sign-in, open `/settings`, sign in with the account file, open
  `/authorize` with no code, then `Sign out`. The saved browser state other flows use is untouched.
- **See:** `/login#next=%2Fsettings%2Faccount` with the heading `Sign in` and
  `Accounts are created by invitation. …`; after sign-in `/settings/account` with the heading
  `Account`; the heading `No code to authorize`; after sign-out, `/login`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `packages/auth/`, `apps/web-old/src/routes/login.tsx`,
  `apps/web-old/src/routes/authorize.tsx`

### pairing-devices.mint-read

- **Map:** pairing-devices.md `pair-web`, `pair-cli`, `device-list`, `qr-render`
- **Needs:** no session; no turn; web and CLI; none
- **Do:** On Settings → Devices choose `Pair a phone`, read the panel, `Done`; run `M pair`,
  `M pair --url http://not-configured.invalid`, `M qr hello`, `M qr`. Claim no code.
- **See:** the dialog `Pair a phone` with a code `XXXX-XXXX`, its QR, and
  `Scan with the Mend app, or type the code. Expires in m:ss.` where `m:ss` falls between two reads;
  `✓ pairing code …` and `  expires in 10 min · one device, once`; the `--url` refusal and
  `mend: usage: mend qr <text>`, each exit `1`; the `Devices` table's row for this CLI's device
  reading `<device> cli`, its paired day (`Nov 5, 2026`) and its last use.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/settings.devices.tsx`, `apps/cli/src/`, `apps/api/src/`

### provider-accounts.read

- **Map:** provider-accounts.md `accounts-list`, `doctor-lines`, `agent-logins`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M accounts`; Settings → Connected accounts read only; `M agent-logins`, then
  `M agent-logins selected` and `M agent-logins all` to restore it in the same flow.
- **See:** `codex   connected · …`, `claude` and `github` each `connected` or `not connected`,
  recorded as found; the web rows agree; `selected · …` after the change and `all · …` after the
  restore.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/agent-logins.ts`, `apps/api/src/connections.ts`, `apps/web-old/src/`

### git-access.read

- **Map:** git-access.md `mode-choice`, `mend-key`, `key-card`, `project-override`
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M keys mode`, `M keys show` (never `keys init`), `M keys mode nonsense`; read Settings →
  Git access and `<p>`'s Git settings without choosing anything.
- **See:** the mode line (`mend-key — …` or `bridge — …`) and the key or `no Mend key yet — …`; the
  refusal `mend: keys mode takes mend-key or bridge, not "nonsense"`, exit `1`; the web shows the
  same mode pressed.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web-old/src/routes/settings.git-access.tsx`, `apps/api/src/`

### workspace-ssh.status

- **Map:** workspace-ssh.md `ssh-status`, `no-gateway`, `ssh-keys`
- **Needs:** no session; no turn; CLI; none
- **Do:** With a disposable `HOME` and a copy of the signed-in `cli.json` as the map says, run
  `M ssh`, `M ssh keys`, `M ssh bogus`. Never `ssh setup`.
- **See:** either `gateway  <host>:<port> · published for <web>` or
  `workspace ssh   no gateway · this deployment exposes none` (record which), exit `0`; the key list
  or `no keys registered`; the `Unknown ssh subcommand "bogus"` line, exit `1`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `packages/workspace-ssh/`, `apps/cli/src/`

### models.list-picker

- **Map:** models.md `models-list`, `web-picker`
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M models` and `M models --json`; on `/` pick `<p>` in the composer and open the agent
  menu, pick `codex`, read the `Model` and `Thinking` groups, `Escape`, and start nothing.
- **See:** one block per harness; codex's block with `default` on one model, claude's and opencode's
  with no `default` (neither names one, by design); JSON `"version": 1` with the same ids,
  `defaultModel` set for codex and `null` for claude and opencode; codex's `Model` group with its
  default row (`<label> default`) `aria-checked="true"`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web-old/src/`, `apps/api/src/`

## Personal setup

### dotfiles.read

- **Map:** dotfiles.md `dotfiles-show`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M dotfiles`; read Settings → Workspace (`/settings/workspace`), its `Dotfiles` and
  `Home files` sections.
- **See:** `repo …` and `snapshot …` lines (`none` or the saved values); the `Repository` field
  empty when `repo` is `none` (or holding the saved URL); `Home files 0 files` with the row
  `nothing synced yet · run mend dotfiles sync, or add files here` when `snapshot` is `none` (or the
  snapshot's file count and rows).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/dotfiles.ts`, `apps/web-old/src/`, `apps/api/src/`

### secret-files.cli-roundtrip

- **Map:** secret-files.md `secrets-add-cli`, `secrets-list`, `secrets-path-refused`,
  `secrets-remove`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M secrets add .main-run/token --from <scratch>/token`, `M secrets`,
  `M secrets add .claude/verify --from <scratch>/token`, read Settings → Secret files, then
  `M secrets rm .main-run/token`, which restores the list in the same flow.
- **See:** `created ~/.main-run/token · 13 B · …`; the list and the web both show it, with no
  content; the refusal `… is under .claude, which sessions capture`, exit `1`;
  `removed ~/.main-run/token · …`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`, `apps/web-old/src/`

### git-author.roundtrip

- **Map:** git-author.md `git-author-show`, `git-author-set-cli`, `git-author-refused`,
  `git-author-clear`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M git-author`; when it reads `· your account's name and email`, set one with the CLI,
  reload Settings → Git access (`/settings/git-access`), try the `not-an-email` refusal, then
  `M git-author --clear`. When a setting is already saved, only show it and stop.
- **See:** `✓ git author · Verify Cli <verify-cli@example.com> · your setting`; under `Git author`
  the textboxes `Name` holding `Verify Cli` and `Email` holding `verify-cli@example.com`, and the
  button `Use my account's name and email`; the refusal, exit `1`; after the clear,
  `· your account's name and email`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/git-author.ts`, `apps/api/src/`, `apps/web-old/src/`

### skills.read

- **Map:** skills.md `skills-list`, `skills-push-project` (the listing)
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M skills`, `M skills --project <p>`; open `/skills`.
- **See:** the library entries or `no skills in your library — …`; the same for `<p>`; the heading
  `Your skill library`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web-old/src/routes/skills.index.tsx`, `apps/api/src/`

### skills.new-web-skills

- **Map:** skills.md `skills-list`, `skills-web-create`, `skills-web-edit`, `skills-web-remove`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `new-web-skills`: Skills with nothing yet; New skill… creates one and
  says each broken field's rule beside it; search and no matches; a skill whose name a project's
  skill also has; Edit skill adds and removes a file, previews, asks before leaving, and is refused
  when a second browser saved first; Remove skill…, and a skill already removed elsewhere.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every skill and the
  project the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/new-web-skills.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/skills/`, `apps/web/src/routes/_inbox.skills.tsx`,
  `apps/web/src/routes/_inbox.skills.$skillId.tsx`, `apps/web/src/lib/skills.ts`,
  `apps/web/src/lib/skill-removal.ts`, `apps/web/src/lib/use-skill-twins.ts`

### skills.new-web-project-skills

- **Map:** skills.md `skills-list`, `skills-web-create`, `skills-web-edit`, `skills-web-remove`, in
  a project's library; `skills-project-inherit` is dropped (no "Use global skills" switch)
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `new-web-project-skills`: a project's Skills tab with nothing yet; New
  skill… from an empty skill, then each rule (nothing picked to copy, a name the project has); a
  copy of one of your skills under its own name; your skill and the project's each saying which is
  used, and linking to the other; Edit skill in place of the project page and Save; Remove skill…,
  which says yours is used again; fixtures for a reader who may not change them and for a project
  being removed; a list that fails to load; the phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every skill and the
  project the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/new-web-project-skills.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/project/skills-tab.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.skills.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.skills.$skillId.tsx`,
  `apps/web/src/lib/project-skills.ts`, `apps/web/src/lib/use-project-skill-owner.ts`

### search.new-web-search

- **Map:** none yet: search from anywhere is new in the new web app (SLNT-1142), and the map
  describes the app people use until cut-over.
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-search`: Ctrl K from the home composer, the Skills page and a
  session page; nothing typed; a query that finds sessions, a project and a skill; one that finds
  nothing; arrows, Enter and Escape; the sidebar's Search field and its rail's button; New session,
  Add project… and Collapse/Expand sidebar; skills that fail to read, then Try again; on a phone,
  the inbox's search screen with Clear, Cancel and the keyboard's search key.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the projects and skills
  the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/new-web-search.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/command-palette.tsx`,
  `apps/web/src/components/phone-search.tsx`, `apps/web/src/components/search-parts.tsx`,
  `apps/web/src/lib/search.ts`, `apps/web/src/lib/search-keys.ts`, `apps/web/src/lib/fuzzy.ts`,
  `packages/ui/src/components/command-palette.tsx`

### agent-memory.read

- **Map:** agent-memory.md `memory-list`
- **Needs:** no session; no turn; CLI; `<p>`
- **Do:** `M memory --project <p>`.
- **See:** the list, or `<p>: no agent memory yet · mend memory import brings this machine's`; exit
  `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/agent-memory.ts`, `apps/api/src/`

### appearance.web-theme

- **Map:** appearance.md `theme-web`, `theme-system`, `theme-persist`
- **Needs:** no session; no turn; web; a fresh browser context
- **Do:** As appearance.md's web steps: emulate light, open Settings, pin `Dark`, reload, back to
  `System`. The choice lives in that browser only.
- **See:** the buttons `System`, `Light`, `Dark`; `html` keeps `dark` across a reload while pinned;
  `mend-theme` is `"system"` at the end.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/`, `packages/ui-old/`

## Project setup and customization

### project-environment.read

- **Map:** project-environment.md `env-show-cli`, `env-routing` (the refusal; nothing saved)
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M env show --project <p>`; open `<p>`'s environment settings, type `MEND_X` as a key,
  read the refusal, and leave without saving.
- **See:** the stored names per lane, never a value (or `  nothing stored — …`);
  `The MEND_ prefix is reserved for Mend itself.` with `Save` disabled.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/env.ts`, `apps/web-old/src/components/project/settings/`, `apps/api/src/`

### cluster-bindings.read

- **Map:** cluster-bindings.md `cluster-show`, `cluster-local-runner`
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** Read `<p>`'s `Cluster bindings` panel and the cluster lines of `M env show --project <p>`.
  Bind nothing.
- **See:** either the panel with `No cluster bindings.` and its form, or the degraded panel of a
  non-Kubernetes install (record which); no `cluster binding` line in `env show`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`, `apps/api/src/`

### workspace-images.read

- **Map:** workspace-images.md `image-project-override` (the panel read),
  `image-organization-default` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Image` section of `<p>`'s Settings → Workspace sub-tab, and the organization
  default on Settings → Organization → Environment. Choose nothing.
- **See:** under `Image`, the groups `Base` (`OS family` pressed), `OS` (`Ubuntu` pressed),
  `Login shell` (one shell pressed) and the textbox `Packages` listing the packages, each field
  marked `set for <p> · reset` (a project's image is its own since SLNT-1155: never
  `from your organization` or `from the instance default`); the section
  `Workspace environment · Default` reading
  `Set for Default. Each new project starts with a copy; existing projects keep their own.`, as the
  editor for an owner or the line `<os> · <n> packages · set for Default` for a member, with no
  `Follow the instance`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`,
  `apps/web-old/src/components/settings/environment-organization.tsx`, `apps/api/src/`,
  `packages/db/src/repos/organization-settings.ts`

### automatic-install.read

- **Map:** automatic-install.md `install-detected`, `install-colocated`
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Dependencies` section of `<p>`'s Settings → Workspace sub-tab. Change nothing.
- **See:** `Installs dependencies in every new worktree before the agent starts.`; the switch
  `Automatic install` checked (or unchecked, with
  `No install runs, in sessions or for the shared cache`); while checked, the textbox
  `Custom command` and one line under it:
  `no lockfile recognised on origin/<default branch> · detected again at launch`,
  `detected · <command> · from <lockfile> on origin/<default branch>` or `runs · <command> · custom`
  (record which); or `Capture mode only. …`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`, `apps/api/src/`

### hot-sessions.read

- **Map:** hot-sessions.md `hot-status`, `hot-count` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Ready workspaces` section of `<p>`'s Settings → Workspace sub-tab. Change no
  count.
- **See:** `Ready workspaces` with the textbox `Ready workspaces` reading `0`, the status `off` and
  `One fewer: Ready workspaces` disabled, or for a raised count its number with `<n> ready now`,
  `<n> warming`, `<n> failed` or `none ready yet` (record which).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`, `apps/api/src/preview-pools.ts`,
  `packages/sessions/`

### project-settings.read

- **Map:** project-settings.md `settings-background`, `settings-review-automation`,
  `settings-landing`, `settings-own-automation`, `settings-org-defaults` (all read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s Settings → Landing sub-tab (`Sessions`, `Landing`) and Review sub-tab
  (`Review automation`), your own Settings → Sessions, Review and Landing, and Settings →
  Organization → Defaults. Choose nothing.
- **See:** on `<p>`, the groups `Run sessions in the background`, `Land when a turn completes`,
  `Compose the description and tour`, `Suggest fixes` and `Name the session`, each with one of
  `Inherit · on|off`, `On`, `Off` pressed, an `Inherit` tip reading `From your own settings`; your
  own pages show the same five as switches with no Inherit, each `Inherit · <value>` on `<p>`
  matching your switch; under `Defaults · Default`, only `Where new sessions run`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`,
  `apps/web-old/src/components/settings/`, `apps/web-old/src/lib/person-settings.ts`,
  `apps/web-old/src/routes/settings.organization.defaults.tsx`, `apps/api/src/`,
  `packages/db/src/repos/person-settings.ts`

### references-folders.folder-cli

- **Map:** references-folders.md `folder-cli`, `folder-web` (read)
- **Needs:** no session; no turn; CLI and web; `<scratch>/folder` holding `a.txt`, `sub/b.txt` and
  one file under `node_modules`
- **Do:** `M folder create main-run-<sha8>`, `M folder push main-run-<sha8> <scratch>/folder`,
  `M folder list`, expand it in Settings → Folders, then `M folder rm main-run-<sha8>`, which
  restores the folder list in the same flow.
- **See:** `✓ created folder …`; `✓ pushed 2 files to … · 1 skipped (skipped)`; the list line
  `main-run-<sha8>  created <day>`; the web lists `a.txt` and `sub/b.txt`; after `rm`, gone.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`,
  `apps/web-old/src/routes/settings.organization.folders.tsx`

### references-folders.select-link

- **Map:** references-folders.md `folder-select`, `ref-add`, `ref-select`, `ref-refresh-remove`,
  `link-project`, `extras-delivery`
- **Needs:** Boat; no turn; CLI and web (the owner's browser); `<land>` and `<second>`; a
  `<scratch>/folder` holding `a.txt`
- **Do:** `M folder create main-run-sel-<sha8>`,
  `M folder push main-run-sel-<sha8> <scratch>/folder`. On `<land>`'s Settings: give
  `main-run-sel-<sha8>` `read` access; add the reference `main-run-ref` with the URL
  `<git>/second.git` and no ref; link `<second>` as `main-run-link`. Run
  `M folder rm main-run-sel-<sha8>` (refused while selected). Then
  `M run --project <land> --name main-run-extras-<sha8> -- sh -c 'ls -R /workspace/home /workspace/ref /workspace/repos > EXTRAS.txt 2>&1; true'`
  and record its session `<id>` from `✓ base … · session <id8>` and `M sessions --json`. Read
  `EXTRAS.txt` in its change: in the owner's browser go straight to `<web>/sessions/<id>/change` (do
  not click `Review change` and wait for the URL: it keeps a query string, so a wait for a URL
  ending `/change` never matches), wait up to 30 s for
  `page.getByRole("region", { name: "EXTRAS.txt", exact: true })`, and `note()` the text of its
  `code` elements. Choose `refresh` (the button reads `Fetch`) on `main-run-ref`. Restore in the
  same flow: set the folder's access back to `off`, `remove` the reference and the link,
  `M folder rm main-run-sel-<sha8>`, and
  `M worktrees rm main-run-extras-<sha8> --project <land> --force` (`EXTRAS.txt` is never landed, so
  removal without `--force` is refused).
- **See:** the folder row with `read` pressed; the reference row with its short head sha and
  `fetched <date>` (or the refusal of a `git://` URL in its own words: record which); the
  `Linked projects` row reads `main-run-second`, its worktree (`main`), and
  `/workspace/repos/main-run-link`, with the button `Unlink main-run-link`;
  `mend: A project mounts this folder. Deselect it there first.`, exit `1`; `EXTRAS.txt` lists
  `a.txt` under `main-run-sel-<sha8>`, the reference's top level, and `main-run-link` under
  `/workspace/repos` or a missing directory (record which: the map says linked projects are not
  delivered in capture mode); after the restore, `<land>`'s sections show none of the three,
  `M folder list` has no `main-run-sel-<sha8>` and `M worktrees --project <land>` no
  `main-run-extras-<sha8>`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/web-old/src/components/project/settings/general-links.tsx`,
  `apps/web-old/src/components/project/settings/folders.tsx`, `apps/api/src/`, `packages/sessions/`

### now-and-sessions.web-now

- **Map:** now-and-sessions.md `inbox-groups`
- **Needs:** either; no turn; web; `start-session.boat-turn`
- **Do:** Recipe `now` with `MAIN_RUN_SESSION` set to the turn's session.
- **See:** the Now page's `Sessions` inbox, with a row linking to that session.
- **Mode:** `scripted` (recipes/now.mjs)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/web-old/src/routes/_inbox.tsx`, `apps/web-old/src/routes/_inbox.index.tsx`,
  `apps/api/src/`

### now-and-sessions.cli-lists

- **Map:** now-and-sessions.md `sessions-cli`, `projects-cli`; worktrees.md `worktrees-cli`
- **Needs:** either; no turn; CLI; the run's earlier sessions
- **Do:** `M projects`, `M sessions --all --project <p>`, `M worktrees --project <p>`.
- **See:** `<p>` listed; this run's sessions listed, each settled; `main-run-<sha8>`,
  `main-run-run-<sha8>` and `main-run-docker` listed with their sessions.
- **Mode:** `scripted` (recipes/cli-reads.sh now-and-sessions.cli-lists)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/cli/src/`, `apps/api/src/`

### now-and-sessions.inbox-settle

- **Map:** now-and-sessions.md `inbox-snooze-settle`, `inbox-folds`, `inbox-filters`,
  `home-composer` (read), `rail`
- **Needs:** either; no turn; CLI and web; a session of its own: `Ready to review` holds only a
  completed change nobody has commented on, and `review-change.web-comments` comments on the run
  session's change before this flow runs
- **Do:**
  `M run --project <p> --name main-run-settle-<sha8> -- sh -c 'printf "settle\n" > SETTLE.md'`. On
  `/`, wait for its row under `Ready to review`, settle it, open `Settled`, and use
  `Back to the inbox` on it, so the flow ends where it began; narrow the inbox by `<p>` and clear
  it. Type no prompt. Restore: `M worktrees rm main-run-settle-<sha8> --force --project <p>`.
- **See:** the `main-run-settle-<sha8>` row under `Ready to review` leaves it and reads
  `settled just now` under `Settled`, then is back; the project filter shows only `<p>`'s rows; the
  heading `What should an agent work on?`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/_inbox.tsx`, `apps/api/src/`

### attach-resume.boat-stop-resume

- **Map:** start-session.md `session-stop`; attach-resume.md `stop-cli`, `resume-web`
- **Needs:** Boat; no turn (resume sends no prompt); CLI and web; `start-session.boat-turn`
- **Do:** `M stop <id8>` on the turn's session, then recipe `resume` with `MAIN_RUN_SESSION` set to
  it, then `M stop <id8>` again.
- **See:** `✓ stopped · codex · <id8> · …`; the session's row menu on the Now inbox has
  `Resume session`, which opens the session page and brings it to `running`; after the second stop,
  `M sessions --all --project <p> --json` lists it settled with `MAIN-RUN.md` still in its change.
- **Mode:** `scripted` (recipes/resume.mjs)
- **Box-only:** `boat`
- **Sample:** yes
- **Areas:** `packages/sessions/`, `apps/web-old/src/routes/_inbox.sessions.$sessionId.tsx`,
  `apps/api/src/`

### attach-resume.attach-detach

- **Map:** attach-resume.md `attach-cli`, `detach`
- **Needs:** Boat; no turn; CLI in tmux; `start-session.boat-live`
- **Do:** `M attach <id8>` in tmux, then `Ctrl+]`; then `M attach zzzzzzzz`.
- **See:** `✓ attaching to main-run-live-<sha8> · … · detach: Ctrl+]`;
  `detached — the session keeps running; …`, exit `0`, still live in `M sessions`;
  `mend: no active session matches "zzzzzzzz"`, exit `1`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/`, `apps/api/src/`, `packages/sessions/`

### attach-resume.rename-web

- **Map:** attach-resume.md `rename-web`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On the run session's page choose `rename`, set `main-run label`, then clear it again.
- **See:** the heading shows the label and `M sessions --all --project <p>` agrees; after the clear,
  the heading is back to its earlier title.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/_inbox.sessions.$sessionId.tsx`, `apps/api/src/`

### session-shell.live-shell

- **Map:** session-shell.md `shell-cli`, `shell-holds`; per-person-homes.md `runs-as-yourself`;
  repositories-in-session.md `repo-list`, `repo-projects`
- **Needs:** Boat; no turn; CLI in tmux; `start-session.boat-live`
- **Do:** `M shell <id8>` in tmux; in it run `id -un; id -u; echo $HOME`, `mend repo list`,
  `mend repo projects`, and write `/workspace/repo/SHELL.md`; detach with `Ctrl+]`. The shell stays
  open for `services.cli-run`. The session page has no `Repositories` card here: it shows only once
  a repository is added, and `repositories-in-session.add-second` reads it.
- **See:** `✓ shell in … session <id8> · <branch> · detach: Ctrl+]`; a login `m` plus 8 characters,
  a uid in 40001–49999 and `/home/<name>` (or the shared-home line, record which);
  `no repositories beside /workspace/repo · …`;
  `detached — the shell keeps running and holds the workspace open`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/`, `packages/sessions/`, `apps/api/src/`

### capture-and-save.live-stop

- **Map:** capture-and-save.md `capture-stop-line`, `capture-sessions`; session-shell.md
  `shell-holds` (end); start-session.md `session-stop`
- **Needs:** Boat; no turn; TUI and CLI; `services.cli-run` (its keeper session `<k8>`)
- **Do:** Rejoin the open shell from the dashboard as session-shell.md's "Rejoin" says, `cat` the
  file and `exit`; then `M stop <k8>`, the last session running in the workspace, and read
  `M sessions` and `M sessions --project <p> --all --json` until both sessions settle.
- **See:** `no live terminal · rejoining the open shell` and `from the shell`; `M stop <k8>` prints
  no `keeps running` line; while it saves, a `stopping` row with a `saving …` line and a `capture`
  object with `"notSaved": false`; then both sessions settled. A drain that ends before the first
  read is reported as not seen.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `packages/store/`, `apps/api/src/`, `apps/cli/src/`

### repositories-in-session.add-second

- **Map:** repositories-in-session.md `repo-projects`, `repo-add`, `repo-list`, `repo-refusals` (own
  project, unknown project, name taken), `repo-session-card`, `repo-review-line`,
  `repo-removal-hold`
- **Needs:** Boat; no turn; CLI in tmux and web (the owner's browser); `<p>` and `boat-check-arch`
  (`https://github.com/octocat/Spoon-Knife.git`, branch `main`), both on GitHub. A Boat workspace
  clones the added repository itself, and reaches GitHub but not the box's own git service
  (SLNT-1102); the clone also goes to the main project's origin host, so both projects are on
  GitHub.
- **Do:** In tmux, `M run --project <p> --name main-run-repo-<sha8> -- sleep 1800`; record `<id8>`.
  `M shell <id8>` in a second tmux session and, as the map's steps, run `mend repo list`,
  `mend repo projects`, `mend repo add boat-check-ubuntu`, `mend repo add no-such-project`,
  `mend repo add boat-check-arch` (wait for the row),
  `git -C /workspace/repos/boat-check-arch status -sb`, `mend repo add boat-check-arch` again,
  `mend repo list`, then write `/workspace/repo/VERIFY.md`. Read the session page's `Repositories`
  card; choose `Mark checkpoint` and open the review. `exit` the shell, `M stop <id8>`, wait in
  `M sessions --project <p> --all --json` until it is settled and its capture done, then
  `M worktrees rm main-run-repo-<sha8> --project <p>`. Restore:
  `M worktrees rm main-run-repo-<sha8> --project <p> --force`, then
  `M worktrees rm main-run-repo-<sha8> --project boat-check-arch`, so neither project keeps this
  run's worktree.
- **See:** `no repositories beside /workspace/repo · …`; `mend repo projects` names
  `boat-check-arch` with `main` and `https://github.com/octocat/Spoon-Knife.git`, and not
  `boat-check-ubuntu`; the own-project and unknown-project refusals, each `exit=1`;
  `adding boat-check-arch · /workspace/repos/boat-check-arch · branch mend/main-run-repo-<sha8> · cloning`,
  then the row ending `ready · saved with the main repository`, `exit=0`;
  `## mend/main-run-repo-<sha8>`; `this session already has a repository named boat-check-arch`,
  `exit=1`; the card's `ready` row (and `adding`, or "not observed"); the review line
  `repositories · /workspace/repos/boat-check-arch ready · nothing of its own to review yet`; the
  removal refusal naming 1 repository added with `mend repo add`, exit `1`; after the restore,
  `M worktrees --project <p>` and `M worktrees --project boat-check-arch` list no
  `main-run-repo-<sha8>`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/`, `packages/sessions/`, `packages/store/`, `apps/api/src/`,
  `apps/web-old/src/`

### worktrees.web-create-remove

- **Map:** worktrees.md `worktrees-tab`, `worktrees-new`, `worktrees-view`, `worktrees-menu`,
  `worktrees-remove`, `worktrees-cli`; start-session.md `start-new-worktree`
- **Needs:** no session; no turn; web and CLI; `<p>`
- **Do:** On `<p>`'s Worktrees tab create `main-run-wt-<sha8>` with `New worktree`, read it with
  `M worktrees --project <p> --json`, right-click its name to open its menu, and choose
  `Remove worktree…`, then `Really remove worktree main-run-wt-<sha8>? …`.
- **See:** the dialog's `branch mend/main-run-wt-<sha8>`; the row `Worktree main-run-wt-<sha8>`
  reading `base master@<sha7>`, `0 sessions`, `not landed` and `No visible sessions`; JSON with
  `"version": 2` and that name; the menu ending `Remove worktree…`; after removal the row is gone
  from the tab and `M worktrees --project <p> --json` no longer lists it.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/tabs/worktrees.tsx`, `apps/api/src/`,
  `packages/store/`

### worktrees.new-web-worktrees

- **Map:** worktrees.md `worktrees-tab`, `worktrees-new`, `worktrees-menu`, `worktrees-remove`,
  `worktrees-clear-settled`, `worktrees-hidden-ended`; capture-and-save.md `capture-removal-hold`;
  repositories-in-session.md `repo-removal-hold` (their words, from `lib/worktree-removal.ts`)
- **Needs:** no turn; web; CLI; `verify-fixture` (or `<p>` on the box)
- **Do:** Drive the recipe `new-web-worktrees` (after its CLI batch `new-web-worktrees-setup.json`):
  the Worktrees tab; New worktree… makes one; its "…" menu, and a shell started from it; Remove
  worktree… while the shell runs, then again once it is stopped; the never-landed refusal with its
  files and Remove anyway; Clear finished…; the phone sheets; a project with no worktrees; a project
  that fails to load.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "Not removed" says a
  session is still running with no Remove anyway; after the stop, `Removed <name> and its session.`;
  Clear finished's toast names `wt-unlanded-<time>` as kept because its change was never landed;
  Remove anyway's toast says the change was discarded.
- **Mode:** `scripted` (recipes/new-web-worktrees.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/project/worktrees-tab.tsx`,
  `apps/web/src/components/project/worktree-actions.tsx`,
  `apps/web/src/components/project/new-worktree.tsx`,
  `apps/web/src/components/project/remove-worktree.tsx`,
  `apps/web/src/components/project/clear-finished.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.worktrees.tsx`,
  `apps/web/src/lib/project-worktrees.ts`, `apps/web/src/lib/worktree-removal.ts`

### resources.new-web-resources

- **Map:** ADR 0019 resources, as the new web app's Resources tab shows them (no feature file): the
  list with each worktree's Shared · Own · Off, Add a resource…, Start and Stop, a failed start,
  Load data…, Remove…, no resources yet, the New session composer's resource line, and "New
  worktrees use project resources"
- **Needs:** no turn; web; `verify-fixture` (or `<p>` on the box); a runtime that runs resources
  (Docker)
- **Do:** Drive the recipe `new-web-resources`: on `verify-fixture` it makes two worktrees, writes a
  Postgres table into one with Add a resource…, starts it from that worktree as the project's
  resource, turns the other worktree's database Off and back, loads a small SQL dump, stops and
  starts it, removes it, and opens the home composer on the first worktree.
- **See:** each step's note in the recipe's `steps.log`: the table Mend wrote; the panel reads
  Running with both worktrees and their choices; the load ends `loaded … from verify-seed.sql`; Stop
  reads Stopped; Remove's toast says `archived · volumes kept`; the composer reads
  `Resources @<name> shared database`; the home, project and session pages are no taller than the
  window.
- **Mode:** `scripted` (recipes/new-web-resources.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/project/resources-tab.tsx`,
  `apps/web/src/components/project/resource-panel.tsx`,
  `apps/web/src/components/project/resource-dialogs.tsx`,
  `apps/web/src/components/new-session/composer-resources.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.resources.tsx`, `apps/web/src/lib/resources.ts`,
  `apps/web/src/lib/resources-card.ts`, `apps/web/src/lib/resources-model.ts`,
  `apps/web/src/lib/resource-load.ts`

### pull-change.boat-run

- **Map:** pull-change.md `pull-fetch`, `pull-again`, `pull-not-a-clone`
- **Needs:** no session; no turn; CLI and git; `start-session.boat-run`; `<p>`'s origin cloneable
  from this machine into `<scratch>/clone`
- **Do:** `M pull main-run-run-<sha8> --project <p>` in `<scratch>` (not a repository), then in the
  fresh clone twice.
- **See:** `mend: … is not a git repository · …`, exit `1`;
  `✓ fetched mend/main-run-run-<sha8> · … · created` and `git show <branch>:VERIFY.md` prints
  `verified`; the second pull prints
  `✓ mend/main-run-run-<sha8> · <sha7> · unchanged since the last pull · nothing moved`, exit `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `packages/local-git/`, `apps/api/src/`

### handoff.held

- **Map:** handoff.md `handoff-held`, `handoff-unchanged`, `handoff-row`
- **Needs:** Boat; no turn; CLI and web; a local clone of `<p>`'s origin in `<scratch>` with one
  commit and one untracked file on a branch `main-run/handoff-<sha8>`
- **Do:** Fingerprint the clone with the map's script, `M handoff` with no prompt, fingerprint
  again; read `M sessions --project <p>` and, on the project page's Worktrees tab, the row of the
  worktree `✓ handed off as <name>` named (`main-run-handoff-<sha8>`). Restore: `M stop <id8>`, then
  `M worktrees rm <name> --force --project <p>`. The handed-off change was never landed, so Mend
  refuses the removal without `--force`; a refusal that names a save under way lasts until the save
  ends, so wait for it and run the removal again. Read back `M worktrees --project <p>`.
- **See:** without a terminal,
  `  starting · the hold is still coming up · following it for up to 3 min · …`, then
  `✓ held · idle, no agent` within the 3 minutes, exit `0` (on Docker, `✓ held · idle, no agent`
  alone); never a last line of `starting` or `still starting`; the two fingerprints identical;
  `handed off from <host>` on the CLI row and on the worktree's fact line on the Worktrees tab;
  after the restore, `M worktrees --project <p>` lists no `<name>`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/handoff.ts`, `packages/local-git/`, `apps/api/src/handoff-start.ts`

## Organization and sharing

### organization.read-invite

- **Map:** organization.md `members-cli`, `org-cli`, `members-web`, `invite-cli`, `invite-revoke`,
  `audit-log`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M members`, `M org`; `M invite --email main-run@example.invalid --days 1`; on Settings →
  Invitations choose `Revoke` on that link's row, which restores the list in the same flow; read the
  audit log.
- **See:** `<org> · 2 members` (the owner and `fixtures.sh`'s second account) with the `▸` row
  `owner`; `M org` marks Default; the link, then the row gone from `Open invitations` and the fold
  `Used and closed <n> links` one higher (it appears as `1 link` when absent before), its summary
  naming `main-run@example.invalid · revoked`; the audit log's newest lines name the invite and the
  revoke.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`,
  `apps/web-old/src/routes/settings.organization.invitations.tsx`

### organization.visibility-who-sees

- **Map:** organization.md `visibility`, `who-sees-what`, `members-cli` (the member's row);
  land-change.md Gotchas (a non-owner's `Landing →` and `only the change's owner lands it`)
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time;
  `land-change.web-push` (something landed in `<land>`)
- **Do:** `M2 members`; `M2 projects`; in the second browser, `/projects`. In the owner's browser,
  set `<land>`'s `Visibility` to `shared`. `M2 projects` again; in the second browser, `/projects`,
  then the land session's page, choose `Landing →` and read the `Land` region. In the owner's
  browser set `<land>` back to `private`, which restores it in the same flow; `M2 projects` once
  more.
- **See:** `M2 members` has `Default · 2 members` with the `▸` row the second account's, `member`;
  before, neither `M2 projects` nor the second browser's `main` lists `<land>` or `<second>`; after
  `shared`, the owner's header line reads `… · shared with Default` and both list `<land>`; the
  session page link reads `Landing →` (not `Land →`) and the region reads
  `only the change's owner lands it` with no `Push to origin`; after `private`, `<land>` is gone
  from `M2 projects`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/general.tsx`, `apps/api/src/`,
  `apps/web-old/src/components/land-panel.tsx`, `apps/cli/src/`

### organization.roles-roundtrip

- **Map:** organization.md `role-change` (and its last-owner refusal), `members-web`, `members-cli`,
  `audit-log`
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time; the second
  account a `member`
- **Do:** In the owner's browser on Settings · Members, choose `Make member` on the owner's row
  (refused). Choose `Make owner` on the second account's row; `M members`; in the second browser,
  read Settings · Members and look for `Invitations`. In the owner's browser, choose `Make member`
  scoped to the second account's row by its email, which restores the role in the same flow. Then,
  in this order:
  1. `M members`. Go on only when the second account's row reads `member`. When the restore's recipe
     failed (on 19 Nov a sign-in timeout) or the row still reads `owner`, run the restore again and
     read `M members` again.
  2. Only then `M2 invite`. Run as an owner it makes a real link, so never run it before step 1
     reads `member`. If it exits `0` anyway, revoke the link it printed at once on Settings ·
     Invitations, and record the slip in `result.txt`.
  3. Read the audit log.
- **See:** `An organization needs an owner. Make someone else an owner before this one steps down.`;
  the row then reads `owner`, and `M members` agrees; the second browser shows the owner controls
  while it is an owner (record which); after the restore the row and `M members` read `member`, the
  second browser shows `Members` without `Make owner`, `Remove…` or `Invitations`, and `M2 invite`
  exits `1` with `mend: only an owner can invite; mend members shows who`; the audit log's newest
  lines name `made <second> an owner` and the change back.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/settings.organization.members.tsx`, `apps/api/src/`,
  `apps/cli/src/`

### organization.join-refused

- **Map:** organization.md `invite-web`, `invite-cli`, `join-refused` (not an invitation, already a
  member, bound to another email, spent), `invite-revoke`
- **Needs:** no session; no turn; CLI and web, one browser at a time, plus a fresh signed-out
  browser context
- **Do:** Each `web` call is its own browser, so the two links travel between them in files of the
  private directory `~/.local/state/mend-main-run/private/`, never in the evidence:
  1. `M invite --days 1 > ~/.local/state/mend-main-run/private/invite-a.out`; record the exit code.
     Line 1 is link A. Copy both lines into `cli.log` with the token cut from the first:
     `sed '1s/#.*/#<link A>/' ~/.local/state/mend-main-run/private/invite-a.out`.
  2. In the owner's browser on Settings · Invitations, record `Used and closed <n> links`, then make
     a `member` link bound to `main-run-other@example.invalid` (link B). In the same recipe, before
     `Done`: wait for `page.getByRole("dialog")`, read its whole `innerText()` (the warning is the
     end of a longer line, so waiting for it as an exact paragraph never matches), take the
     `<web>/join#…` link out of it, `writeFileSync` it to
     `~/.local/state/mend-main-run/private/link-b.txt`, and `note()` the text with the link replaced
     by `<link B>`. Then `Done`. Once that recipe ends, link B is gone for good.
  3. In the second browser (`web2`), one recipe opens `<web>/join#not-a-token`, then link A (line 1
     of `invite-a.out`), then link B (`link-b.txt`), reading each file with `readFileSync`, and
     notes each page's text. In `result.txt` call the first page "the not-a-token join page": the
     evidence scan reads `/join#` followed by text as an invitation link and deletes the file (19
     Nov).
  4. In the owner's browser revoke links A and B (`Revoke the invitation for anyone with the link`,
     `Revoke the invitation for main-run-other@example.invalid`), which restores the open list in
     the same flow. In the signed-out context open link A.
- **See:** link A's two lines (`works once · member · expires <day>`); for B, the dialog's
  `Copy it now: Mend shows it only this once.` and the link's line
  `works once · expires <day> · not shown again`; `This link is not an invitation`;
  `You are already a member of Default.` with `Open Mend` for A; B refused with its reason (record
  the words); both rows leave the open list, and `Used and closed <n> links` goes up by two (record
  the count before and after); A in the signed-out context reads it cannot be used (record the
  words).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/routes/join.$token.tsx`, `apps/web-old/src/routes/join.index.tsx`,
  `apps/web-old/src/routes/settings.organization.invitations.tsx`, `apps/api/src/`

### organization.new-web-create-leave

- **Map:** organization.md `org-create`, `org-leave` (the new web app's organization switcher)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-organizations`: the switcher on a single-tenant server, on the
  desk and in the phone's Settings sheet; then, with the organization read and list rewritten in the
  page to say the server allows creating and the account has a second organization, the Create
  organization dialog with an empty name, a taken name and the server's own refusal, and the Leave
  dialog for the only owner and for a member, whose Leave the server refuses; then the toasts home
  shows after a create and a leave.
- **See:** each step's note in the recipe's `steps.log`, and its captures: no "Create organization…"
  or "Leave …" item with one organization; `This Mend runs one organization (MEND_TENANCY=single).`
  in the dialog's alert; `You can't leave yet.` for the only owner;
  `This is your only organization. Ask one of its owners to remove you instead.` in the Leave
  dialog's alert. Nothing changes on the server.
- **Mode:** `scripted` (recipes/new-web-organizations.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/organization-menu.tsx`,
  `apps/web/src/components/organization-dialogs.tsx`, `apps/web/src/lib/organization-membership.ts`,
  `apps/web/src/lib/organization-switch.ts`

### organization.new-web-audit-log

- **Map:** operator.md `operator-audit`; shared-control.md `audit`; organization.md `audit-log` (the
  new web app's Audit log page)
- **Needs:** a session of the owner's (the CLI batch `new-web-shared-control-setup.json`); no turn;
  web
- **Do:** Run the CLI batch, then drive the recipe `new-web-audit-log`: it makes real events as the
  owner (verify-fixture shared and private again, shared control on and off, enough invitation links
  made and revoked to need a second page), opens `/settings/organization/audit-log`, reads the next
  page with Show older events, then, with the log's answers rewritten in the page, an older page
  that fails, an empty log, the loading screen and a first page that fails with Try again; desk and
  phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "Revoked an invitation
  link", "Made verify-fixture private", the shared-control rows, `Owners of <organization>` under
  the title, more rows after Show older events, "Mend couldn't read older events." under the button.
  verify-fixture ends private and every link the run made is revoked.
- **Mode:** `scripted` (recipes/new-web-audit-log.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/audit-log-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.audit-log.tsx`, `apps/web/src/lib/audit-log.ts`

### organization.new-web-general

- **Map:** organization.md `org-leave` (from the General page); an owner renames the organization
  (`PUT /organization/name`, new with route PR 45)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-org-general`: `/settings/organization` as its owner (old
  `/settings/organization/` and `/settings/organization/defaults` land there, and so does the
  switcher's settings item); rename it (Unsaved changes, an empty name refused beside the field,
  Save, Enter, Escape) and put the name back; a second person joins through an invitation and reads
  the page as a member; made an owner and back; then, with a second organization written into the
  page's list, the Leave dialog for an owner beside another owner and for the only owner; a read
  that fails and Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures: `Renamed to <name>.`, the
  breadcrumb and audience line reading the new name, an `organization.renamed` audit entry; the
  member's read-only name with `Only an owner can rename it: <owner>.`; the server's 404 to the
  member's rename. The name is what it was before the run, and the second person is removed.
- **Mode:** `scripted` (recipes/new-web-org-general.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/organization-general-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.index.tsx`,
  `apps/web/src/lib/organization-general.ts`

### organization.new-web-members

- **Map:** organization.md `members-web`, `invite-web`, `invite-revoke`, `role-change`,
  `password-reset`, `member-removal` (the new web app's Members page)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `new-web-org-members`: `/settings/organization/invitations` lands on
  `/settings/organization/members`; the only owner's role is locked; the owner creates a link bound
  to an email through Create invitation, a second person joins with it in a second browser and the
  owner's page says so; the owner makes them an owner and undoes it, makes them a reset link,
  revokes another link, opens the fold of used and revoked links, reads the page as that person,
  then removes them. With answers rewritten in the page: the link dialog's and reset panel's
  pictures, a refused role change, a first read that fails; desk and phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "<person> joined
  <organization> with your invitation.", "<person> is now an owner of <organization>." with Undo,
  "Revoked the invitation for anyone with the link.", "Removed <person> from <organization>", the
  removed person's browser at `/login?reason=access`. The person is removed and every link the run
  made is revoked.
- **Mode:** `scripted` (recipes/new-web-org-members.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `apps/web/src/components/settings/organization-members-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.members.tsx`,
  `apps/web/src/lib/organization-members.ts`

### shared-control.two-people

- **Map:** shared-control.md `share-on-web`, `share-off-web`, `share-cli`, `share-refused` (a
  non-owner), `viewer-lines`, `org-owner-off`, `terminal-owner-only`, `who-pays`, `audit`
- **Needs:** Boat; no turn; CLI (`M` and `M2`, `M2` also in tmux) and web, two browsers at once (the
  owner's and the second's, side by side); `<second>`
- **Do:** In the owner's browser set `<second>`'s `Visibility` to `shared`. In tmux,
  `M2 run --project <second> --name main-run-share-<sha8> -- sleep 1800`; record `<id>` and `<id8>`.
  Open `/sessions/<id>` in both browsers. `M session share <id8> on --yes` (as the owner). In the
  second browser: `On`, `Keep it off`, `On`, `Turn on`. Then, in the owner's browser, open the
  `Terminal` tab: `<web>/sessions/<id>/terminal`, or the `Terminal` link in the tab row. The session
  page opens on `Conversation`, which shows only `Type to it in the Terminal tab.`: the read-only
  line is never there. On the Terminal tab wait up to 30 s for `Only <second> types here`, and read
  the line. Then choose `Share` in the header; in its popover read
  `<second> shares control of this session.` and choose `Turn off`.
  `M2 session share <id8> on --yes`, `M2 session share <id8> off`, and in tmux
  `M2 session share <id8> on` answered `n`. Read the audit log. Restore in the same flow:
  `M2 stop <id8>`, wait until it settles,
  `M2 worktrees rm main-run-share-<sha8> --project <second>`, and set `<second>` back to `private`.
- **See:** the owner's page reads
  `Only <second> steers this session. You can read the record and review the change.`; the owner's
  `share` exits `1` with `mend: only the session owner can share control of this session`; in the
  second browser `Off` pressed, the who-pays line (record which layout's words), the dialog
  `Turn on shared control?`, `Off` still pressed after `Keep it off`, then `On` pressed; the owner's
  Terminal tab shows the read-only line
  `This session runs in a terminal. Only <second> types here; they can continue it as a conversation.`,
  and the `Share` popover `<second> shares control of this session.` with `Turn off`, then the
  viewer line again; `✓ shared control on · <harness> <id8>` and `✓ shared control off · …`, exit
  `0`; `shared control stays off`; the audit log names both turn-ons and both turn-offs with their
  people. Record whether a `mend run` session shows the switch at all: the map drives it on a
  harness session.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/shared-control-dialog.tsx`, `apps/web-old/src/`,
  `apps/api/src/`, `apps/cli/src/`

### shared-control.ask-and-grant

- **Map:** shared-control.md `ask`, `withdraw`, `grant`, `take-back`, `switch-ends-grants`,
  `sender-login`, `audit`
- **Needs:** Boat; one codex turn; CLI (`M` and `M2`) and two browsers once the new web app asks and
  grants (route PR 34); until then the API with each account's access key, as the feature file says
- **Do:** In the owner's browser set `<second>`'s `Visibility` to `shared`.
  `M2 codex "Say hello and change nothing." --project <second> --name main-run-ask-<sha8> --detach`;
  record `<id>` and `<id8>`. As the owner, ask for shared control; as `<second>`, see the ask in the
  inbox and grant it. As the owner, send one message (`Say hello again and change nothing.`) and see
  it run on the owner's own codex login. As the owner, also try to grant: refused. Take it back as
  `<second>`; ask, grant, then `M2 session share <id8> off`. Restore: `M2 stop <id8>`,
  `M2 worktrees rm main-run-ask-<sha8> --project <second>`, `<second>` back to `private`, and delete
  any access key the flow made.
- **See:** the ask in `<second>`'s inbox and on the session; the grant read back as one person
  holding it while `everyoneSince` stays null; the owner's message's turn names the owner and their
  login; the second grant refused `not-asked`; after the take-back and after `share off`, nobody but
  `<second>` holds it; the control log and audit log name each step and the person.
- **Mode:** `agent`
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `packages/db/src/repos/session-shared-control.ts`,
  `apps/web/src/server/routers/sessions.ts`, `apps/web/src/server/api/errors.ts`

### shared-control.new-web-ask-and-grant

- **Map:** shared-control.md `ask`, `withdraw`, `grant`, `take-back`, `switch-ends-grants`,
  `viewer-lines`, `who-pays`, `sender-login`
- **Needs:** Boat; one codex turn; web as two people (the owner's browser and `<second>`'s, side by
  side); CLI (`M2`); `<second>` without a Codex login, then with one
- **Do:** In the owner's browser set `<second>`'s `Visibility` to `shared`.
  `M2 codex "Say hello and change nothing." --project <second> --name main-run-ask-web-<sha8> --detach`;
  record `<id>`. In the owner's browser open `/sessions/<id>` and choose `Ask for shared control`.
  In `<second>`'s browser find the session under `Waiting on you`, open it, choose
  `Turn on shared control…`, read the dialog and choose `Turn on shared control`. In the owner's
  browser send `Say hello again and change nothing.` and wait for the turn. In `<second>`'s browser
  open the tile's `…` and choose `Turn off shared control`. Ask again as the owner, choose
  `Dismiss request` as `<second>`; ask again and `Cancel request`. Restore: `M2 stop <id8>`,
  `M2 worktrees rm main-run-ask-web-<sha8> --project <second>`, `<second>` back to `private`.
- **See:** the owner's band `This is <second>'s session.` and the composer line
  `Only <second> can send messages in this session.`; after asking,
  `You asked <second> for shared control at …` with `Cancel request`; `<second>`'s sidebar row reads
  `<owner> asked for shared control`, the session's band names the owner with
  `Turn on shared control…` and `Dismiss request`; once on, `Shared control is on.` with
  `Turn off shared control`, and the owner's band
  `<second> turned on shared control, so you can send messages.`; the owner's message in
  `<second>`'s browser carries the owner's name, and its turn reads
  `Codex · turn 2 · <owner>'s login`; each step leaves a line in both conversations (`asked`,
  `turned on`, `turned off`, `dismissed`, `cancelled`). If the owner's Codex login is refused, the
  band reads `Your Codex login has expired, so your message wasn't sent.` with `Connect again…`, and
  the message sends by itself once `mend connect codex` finishes.
- **Mode:** `agent`
- **Box:** after cut-over
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/components/session/shared-control.tsx`,
  `apps/web/src/lib/shared-control.ts`

### per-person-homes.two-people

- **Map:** per-person-homes.md `join-line`, `shared-workspace-line`, `runs-as-yourself` (the second
  person)
- **Needs:** Boat; no turn; CLI (`M` and `M2`) in tmux and web, one browser at a time (the owner's);
  `<second>`
- **Do:** In the owner's browser set `<second>`'s `Visibility` to `shared`. In tmux,
  `M2 run --project <second> --name main-run-pp-<sha8> -- sleep 1800`; record `<b8>`. In the owner's
  browser, on `<second>`'s Worktrees tab open `New session in main-run-pp-<sha8>`, read it,
  `Escape`. In tmux, `M run --project <second> --worktree main-run-pp-<sha8> -- sleep 1800`; record
  `<a8>`. `M sessions --project <second>`; open `<a8>`'s session page. `M2 shell <b8>` and
  `M shell <a8>`, each running `id -un; id -u; echo $HOME`, then `exit`. Restore in the same flow:
  `M stop <a8>`, `M2 stop <b8>`, wait until both settle, remove the worktree as its owner
  (`M2 worktrees rm main-run-pp-<sha8> --project <second>`), and set `<second>` back to `private`.
- **See:** the menu's line
  `<second>'s session is running in this worktree. You share its workspace: …`; the owner's `run`
  prints `✓ joins worktree main-run-pp-<sha8> · 1 session · …` and the join line (record whether it
  prints: the map names it for harness launches); under the live row
  `Shared workspace with <second> · …`, and the same line on the session page; two different `m`
  plus 8 character logins, each uid in 40001–49999 with its own `/home/<name>` (or uid `0` and the
  shared-home case, record which: the map says a first launch on an unchecked image can share one
  home).
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/web-old/src/components/shared-workspace.tsx`,
  `packages/domain/src/workbench/shared-workspace.ts`, `packages/sessions/`, `apps/cli/src/`

### operator.owner-grant-restore

- **Map:** operator.md `operator-only`, `org-create` (the refusal), `org-rename`,
  `org-invite-owner`, `grant-owner`, `reset-link` (the refusal), `operator-audit`,
  `instance-defaults` (the member's view); organization.md `operator-add-member` (the single-tenancy
  refusal)
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time, plus a fresh
  signed-out browser context; the owner account is the operator
- **Do:** `M2 operator org list`, `M2 operator gate`; `M operator org create main-run-x`;
  `M operator org rename Default main-run-renamed`, `M members`, then
  `M operator org rename main-run-renamed Default`, which restores the name in the same flow;
  `M operator org rename no-such-org x`;
  `M operator org add-member Default main-run-second@example.test`;
  `M operator org invite-owner Default --email main-run-owner@example.invalid`, open it in the
  signed-out context, then revoke it on Settings · Invitations;
  `M operator grant-owner Default main-run-second@example.test`, `M members`, then `Make member` on
  the second account's row (scoped by email), which restores the role;
  `M operator grant-owner Default nobody@example.invalid`;
  `M operator reset-link nobody@example.invalid`. In the second browser look for
  `instance · operator` on Settings; in the owner's, read the audit log.
- **See:** both `M2` commands exit `1` with `mend: this account is not the operator of this Mend`;
  the create refusal naming `MEND_TENANCY=single`; `✓ renamed Default to main-run-renamed`,
  `M members` starting `main-run-renamed · 2 members`, and the rename back;
  `mend: no organization named "no-such-org"`;
  `mend: This Mend runs one organization (MEND_TENANCY=single). Invite people with a link instead.`;
  the owner link's line `owner of Default · for main-run-owner@example.invalid · works once · …` and
  `as owner · expires <day>` on the join page, then the row gone;
  `✓ main-run-second@example.test is an owner of Default` and `owner` in `M members`, then `member`
  again; the two `No … has that email` refusals, exit `1`; no `instance · operator` for the second
  account; the audit log names the renames, the owner invitation and its revoke, and the grant, each
  `as the operator` where the map says so.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/`, `apps/cli/src/`,
  `apps/web-old/src/routes/settings.organization.audit-log.tsx`

### shared-control.refuse-script

- **Map:** shared-control.md `share-refused` (the script case)
- **Needs:** Boat; no turn; CLI; `start-session.boat-live`
- **Do:** `M session share <id8> on < /dev/null`. Nothing changes. On the session page, once it has
  loaded, open `Share` to read it, choose nothing, and press `Escape`.
- **See:** `mend: non-interactive · pass --yes to turn shared control on`, exit `1`; the header's
  `Share` button, not pressed; its popover `Share this session` with the group `Shared control` and
  `Off` pressed. The owner never reads `Only <owner> steers this session. …`: that line is for a
  viewer who cannot steer.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`

### operator.read

- **Map:** operator.md `org-list`, `instance-defaults`
- **Needs:** no session; no turn; CLI and web; the owner account is the box's operator
- **Do:** `M operator org list`; look for `instance · operator` on Settings.
- **See:** `Default  1 members · 1 owner` (count words as printed), exit `0`, and the operator
  defaults shown; or `mend: this account is not the operator of this Mend`, which makes the flow
  `not run · not the operator`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`,
  `apps/web-old/src/routes/settings.instance.defaults.tsx`

### exposure.read

- **Map:** exposure.md `health-counts`, `exposure-report`, `tenancy-gate`, `shell-line`,
  `doctor-line`
- **Needs:** no session; no turn; CLI, HTTP and web; operator for the two `mend operator` commands
- **Do:** `curl -s $WEB/api/health`; `M operator exposure`; `M operator gate`; at 1280x800, open the
  sidebar's account button (`<name>, account and machine`) and read its popover; the `exposure` line
  of `doctor.checklist`'s output.
- **See:** JSON with `"tenancy": "single"` and an `exposure` object naming no item; line 1
  `exposure · declared <posture> · …`; the gate ending `<k> of 10 items open; …`; the popover
  `Account and machine` with `machine` and the line `exposure · <posture> · https`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/exposure.ts`, `packages/network/`, `apps/cli/src/`

## This machine: the server and the CLI

### server.upgrade

- **Map:** server.md `server-upgrade`
- **Needs:** no session; no turn; the box over `MEND_VERIFY_BOX_SSH`; the previous build running
  with every earlier run's data
- **Do:** SKILL.md step 4: deploy the preview of this commit over the build the box ran.
- **See:** `$E/server.upgrade/deploy.log` ends `preview-deploy: finished for <version>`;
  `verify box identity` reads `the box runs this head`.
- **Mode:** `agent`
- **Box-only:** `preview-deploy`, `upgrade-real-data`
- **Sample:** yes
- **Areas:** `scripts/preview-deploy.sh`, `apps/cli/src/` (server), `packages/db/`,
  `tooling/scripts/`

### server.data-intact

- **Map:** server.md `server-upgrade` (data kept); now-and-sessions.md `sessions-cli`,
  `projects-cli`; review-change.md `review-open`
- **Needs:** either; no turn; CLI and web; the previous run's session
- **Do:** Before the deploy, `M projects` and `M sessions --all --project <p> --json` into
  `before.*`; after it, the same into `after.*`. Then recipe `session-review` with
  `MAIN_RUN_SESSION` set to the previous run's session.
- **See:** every project and session id of `before` is in `after` with the same status; the old
  session page loads and its change still shows `MAIN-RUN.md` with `seen`. With no previous run, the
  listing half alone, and say so.
- **Mode:** `agent` (its second half runs recipes/session-review.mjs)
- **Box-only:** `upgrade-real-data`
- **Sample:** yes
- **Areas:** `packages/db/`, `packages/store/`, `apps/api/src/`

### server.status-logs

- **Map:** server.md `server-status`, `server-logs`
- **Needs:** no session; no turn; the box's host CLI over `MEND_VERIFY_BOX_SSH`
- **Do:** On the box host, `mend server status` and `mend server logs --tail 20`. Change nothing.
- **See:** `Pinned Mend <version> at …`, the `exposure · declared …` and
  `tenancy · declared single …` lines and the containers up; at most 20 lines per container, exit
  `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/` (server), `scripts/preview-deploy.sh`

### doctor.checklist

- **Map:** doctor.md `doctor-checklist`, `doctor-exit-code`, `doctor-fix-commands`;
  provider-accounts.md `doctor-lines`
- **Needs:** no session; no turn; CLI; none
- **Do:** `M doctor`.
- **See:** `✓ server` naming `$WEB · mend <version>`; `✓ signed in  token accepted`; `✓ sealant` and
  `✓ codex … connected`; the `claude` and `github` lines each read `connected` or
  `· … not connected`, recorded as found (claude was connected on 16 Nov); no `✗` line, exit `0`.
- **Mode:** `scripted` (recipes/cli-reads.sh doctor.checklist)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/cli/src/doctor.ts`, `apps/api/src/`

### doctor.bundle-web

- **Map:** doctor.md `doctor-bundle`, `doctor-bundle-redaction`, `doctor-bundle-options`,
  `doctor-web-connection`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M doctor --bundle --out $E/doctor.bundle-web/bundle.tgz --tail 50`; its mode
  (`stat -c %a`); extract it into `$E/doctor.bundle-web/x` and run
  `node .agents/skills/verify/scripts/scan-evidence.mjs --dir $E/doctor.bundle-web/x --secrets $P`,
  which looks for every credential shape without anyone reading the CLI's token (the run may not);
  `M doctor --bundle --tail 0`; on Settings, `Sealant connection` and `Check again`.
- **See:** the archive path and one line per file; mode `600`; the scan exits `0`, no hit;
  `mend: --tail is 1..2000`, exit `1`; the panel reads connected after `Check again`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/doctor-bundle.ts`, `apps/cli/src/doctor-bundle-collectors.ts`,
  `apps/web-old/src/routes/settings.sealant.tsx`

### cli.version

- **Map:** cli.md `version`
- **Needs:** no session; no turn; CLI; none
- **Do:** `M version`, which asks the server. Help, man pages, completions, usage errors and bare
  `mend` on a pipe (the index) do not, and are in "Not on the box".
- **See:** `mend <v>` and `server <v> · $WEB`, exit `0`. A CLI packed from source carries the
  package's version, so a `versions differ` line follows; it is recorded, not judged.
- **Mode:** `scripted` (recipes/cli-reads.sh cli.version)
- **Box-only:** no
- **Areas:** `apps/cli/src/version.ts`, `apps/cli/src/`

### tui.dashboard

- **Map:** tui.md `tui-open`, `tui-navigate`, `tui-keys`, `tui-filter`, `tui-review`,
  `tui-open-web`, `tui-quit`; review-change.md `review-tui`
- **Needs:** either; no turn; TUI (tmux 200x50, Node 26); `start-session.boat-run`
- **Do:** `M ui` in tmux; jump panes, open `?`, filter worktrees by `main-run-run`, select its
  session, `v` to review and `esc`, `o`, then `q`. No `w`, `n`, `K` or `D`.
- **See:** ` mend  <n> projects · <m> live`; the overlay `keys · …`; the review header
  `… · 1 files +1 −0 · <n> open` and `VERIFY.md · unified`; `opened · $WEB/sessions/<id8>…`;
  `exit 0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/dashboard.tsx`, `apps/cli/src/dashboard-model.ts`,
  `apps/cli/src/review.tsx`

## Clients and integrations

No flow: every client needs a device, an app or a world the box run does not have. See the table.

## Not on the box

| Feature                 | Sub-feature(s)                                                                                                                                                                                                          | Why not                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adopt-project           | `adopt-web` (submit), `adopt-cli` (a new project), `adopt-visibility`, `adopt-tui`, `adopt-mobile`, `adopt-vscode`                                                                                                      | each run would leave a project; `<p>` was adopted once; phone, VS Code                                                                                            |
| start-session           | `start-in-worktree`, `start-tui`, `start-desktop`, `start-mobile`, `start-vscode`, `start-slack`, `session-attach-resume`                                                                                               | desktop, phone, VS Code, Slack; a local stack shows the rest                                                                                                      |
| review-change           | `review-inline-comment`, `review-machine-pass`, `review-desktop`, `review-mobile`                                                                                                                                       | inline has no stable handle; Mend's passes use inference; desktop, phone                                                                                          |
| send-review-back        | `send-edit`, `send-pending`, `send-continue-cli`, `send-tui`, `send-desktop`, `send-mobile`                                                                                                                             | a local stack shows them; desktop, phone                                                                                                                          |
| land-change             | `land-preview`, `land-check`, `land-observe` (`Refresh pull request`), `land-automatic`, `land-desktop`, `land-mobile-observe`, `land-slack`                                                                            | need a GitHub origin and login; automatic landing needs a fourth real turn; desktop, phone, Slack                                                                 |
| services                | `service-run-web`, `service-recipe`, `service-add`, `service-tui`, `service-desktop`                                                                                                                                    | a local stack shows them; `<p>` declares no `mend.toml`; desktop                                                                                                  |
| sign-in                 | `first-account`, `cli-login`, `cli-logout`, `password-reset`, `desktop-connect`                                                                                                                                         | the CLI sign-in is never touched; a reset ends the owner's browser sessions; desktop                                                                              |
| pairing-devices         | `mint-by-hand`, `claim-mobile`, `revoke`, `unpair-mobile`                                                                                                                                                               | each run would add a device; no phone                                                                                                                             |
| provider-accounts       | `connect-grant`, `connect-my-login`, `connect-stdin`, `connect-github`, `connect-web`, `disconnect`, `reconnect-state`                                                                                                  | would replace or remove the owner's codex login; no claude or GitHub credential                                                                                   |
| git-access              | `bridge-share`, `adopt-auth` (a real adoption), mode switches                                                                                                                                                           | needs an ssh-agent and a private repository; changes the account's mode                                                                                           |
| workspace-ssh           | `ssh-setup`, `vscode-setup`, `vscode-open`                                                                                                                                                                              | registers a key every run; VS Code                                                                                                                                |
| models                  | `desktop-picker`, `mobile-picker`, `vscode-picker`, `resume-with`                                                                                                                                                       | desktop, phone, VS Code; `--with` another harness needs claude                                                                                                    |
| dotfiles                | all but `dotfiles-show`                                                                                                                                                                                                 | replaces the owner's saved repository and snapshot; a local stack shows them                                                                                      |
| secret-files            | `secrets-add-web`, `secrets-delivery`, `secrets-mobile-list`                                                                                                                                                            | a local stack shows them; phone                                                                                                                                   |
| doppler                 | all                                                                                                                                                                                                                     | needs a real Doppler account                                                                                                                                      |
| git-author              | `git-author-set-web`, `git-author-session`                                                                                                                                                                              | a local stack shows them                                                                                                                                          |
| skills                  | all but `skills-list`                                                                                                                                                                                                   | writes the owner's libraries; a local stack shows them                                                                                                            |
| agent-memory            | all but `memory-list`                                                                                                                                                                                                   | needs a checkout with Claude memory; delivery needs claude                                                                                                        |
| pi-profile              | all: `pi-profile-dry-run`, `pi-profile-refused`, `pi-profile-save`, `pi-profile-dir`, `pi-profile-remove`, `pi-profile-session`                                                                                         | the dry run never calls the server (an ordinary test: SLNT-1082); the rest write the owner's saved profile, and a local stack shows them                          |
| appearance              | `theme-desktop`, `theme-mobile`, `text-size-mobile`                                                                                                                                                                     | desktop, phone                                                                                                                                                    |
| project-environment     | all but `env-show-cli`, `env-routing`                                                                                                                                                                                   | changes `<p>`'s environment for every later session                                                                                                               |
| cluster-bindings        | all but `cluster-show`, `cluster-local-runner`                                                                                                                                                                          | needs operator-made Kubernetes objects; changes `<p>`                                                                                                             |
| workspace-images        | all but the panel reads                                                                                                                                                                                                 | an image change rebuilds every later workspace                                                                                                                    |
| automatic-install       | `install-custom`, `install-switch`, `install-in-session`                                                                                                                                                                | changes `<p>`; `<p>` is not a Node repository                                                                                                                     |
| hot-sessions            | `hot-count` (change), `hot-claim`, `hot-rewarm`                                                                                                                                                                         | each ready standby is a live workspace on the box                                                                                                                 |
| project-settings        | changes, `settings-visibility`, `settings-remove`, `settings-retention`, `settings-instance-defaults`                                                                                                                   | organization-wide or `<p>`-wide settings other checks depend on                                                                                                   |
| references-folders      | `host-mounts`                                                                                                                                                                                                           | maps a path of the box host into sessions                                                                                                                         |
| mend-toml               | all: `toml-init`, `toml-recipes-card`, `toml-run-cli`, `toml-project-recipes`, `toml-shadowed`, `toml-parse-error`                                                                                                      | `mend service init` never calls the server (`run-commands-json.test.ts` covers it); `<p>` has no `mend.toml`, and the rest change `<p>`                           |
| now-and-sessions        | `now-menus`, `now-mobile`, `now-desktop`                                                                                                                                                                                | a local stack shows the menu; phone, desktop                                                                                                                      |
| attach-resume           | `resume-cli`, `rejoin-cli`, `delete-web`, `attach-tui`, `pickup-takeover`, `attach-tunnels`, `attach-image-paste`                                                                                                       | delete would remove sessions the next run reads; phone; a local stack shows the rest                                                                              |
| session-shell           | `shell-session-web`, `shell-session-tui`, `shell-tab-desktop`, `shell-mobile`                                                                                                                                           | a local stack shows them; desktop, phone                                                                                                                          |
| worktrees               | `worktrees-toggle`, `worktrees-clear-settled`, `worktrees-hidden-ended`, `worktrees-refresh`, `worktrees-tui`                                                                                                           | clear-settled would remove worktrees the next run reads; a local stack shows the rest                                                                             |
| workspace-replace       | all                                                                                                                                                                                                                     | needs a workspace marked to retire, and replacing stops what runs in it                                                                                           |
| pull-change             | `pull-wrong-origin`, `pull-checked-out`, `pull-too-large`                                                                                                                                                               | a local stack shows them                                                                                                                                          |
| handoff                 | `handoff-review-base`, `handoff-split`, `handoff-prompt`, `handoff-again`, `handoff-foreign-origin`, `handoff-hidden`                                                                                                   | the prompt case spends a turn; a local stack shows the rest                                                                                                       |
| repositories-in-session | `repo-refusals` (a private project in a shared session, no origin, a taken worktree name)                                                                                                                               | each needs another project or a shared main project; a local stack shows them                                                                                     |
| capture-and-save        | `capture-not-saved`, `capture-discard`, `capture-removal-hold`                                                                                                                                                          | needs a stalled or slow drain sized for the store                                                                                                                 |
| observed-agents         | all                                                                                                                                                                                                                     | runs `claude` by hand in the workspace; no claude login                                                                                                           |
| terminal-agent-waits    | all                                                                                                                                                                                                                     | its recipe runs in the VS Code driver's own world                                                                                                                 |
| organization            | `join`, `join-signed-in`, `password-reset`, `member-removal`, `org-switch-cli`, `org-switch-web`, `org-per-sign-in`, `org-isolation`, `org-leave`, `org-access-key`, `operator-add-member` (an actual add), `take-over` | each creates or removes an account, or mints a reset link nothing revokes; the rest need a second organization and multi tenancy                                  |
| shared-control          | `share-refused` (opencode), a steered turn                                                                                                                                                                              | no opencode login; the second account has no agent login and the web sends no turn                                                                                |
| per-person-homes        | `layout-opt-out`, `no-way-back`, `layout-fallback`, `waiting-line`, `retirement` (in workspace-replace)                                                                                                                 | the first two restart the server with `MEND_HARNESS_LAYOUT=shared`; the fallback needs an image that cannot run per person; the waiting line needs a steered turn |
| operator                | `org-create` (an actual create), `reset-link` (a real link)                                                                                                                                                             | multi tenancy; a reset link nothing revokes                                                                                                                       |
| exposure                | `public-refusal`, `declared-items`, `budget-refusal`, `upgrade-tickets`, `url-bearers`                                                                                                                                  | each restarts the server with changed exposure variables                                                                                                          |
| server                  | `server-setup`, `server-repair`, `server-exposure-flags`, `server-edge`, `server-posture`, `server-offline`, `server-lifecycle`, `server-next-channel`, `server-lock`                                                   | changes the box's install; the map drives them on a disposable host                                                                                               |
| uninstall               | all                                                                                                                                                                                                                     | a regression would remove the box's server or the sign-in the run may never touch                                                                                 |
| cli                     | `help-index`, `help-page`, `help-group`, `help-alias`, `man-page`, `usage-errors`, `unknown-command`, `completions`, `bare-mend`, `qr`                                                                                  | never call the server: `help.test.ts` and `main.test.ts` cover them; `qr` is in pairing-devices                                                                   |
| tui                     | `tui-new-worktree`, `tui-new-session`, `tui-attach`, `tui-auto-attach`, `tui-resume`, `tui-rename`, `tui-stop`, `tui-remove`, `tui-refresh`, `tui-snake`, `tui-adopt`, `tui-tunnels`, `tui-layout`, `tui-screen-mode`   | a local stack shows them; each new one leaves sessions                                                                                                            |
| desktop-app             | all                                                                                                                                                                                                                     | no desktop app on the run's machine (and not shipping)                                                                                                            |
| mobile-app              | all                                                                                                                                                                                                                     | no phone, and its web build needs an allowed origin the box does not list                                                                                         |
| vscode                  | all                                                                                                                                                                                                                     | no VS Code; its driver runs its own world                                                                                                                         |
| slack                   | all                                                                                                                                                                                                                     | not drivable yet; no Slack workspace                                                                                                                              |
| t3-gateway              | all                                                                                                                                                                                                                     | its recipe needs a local stack's gateway                                                                                                                          |

Flows: 64 total · 6 scripted · 58 agent · 3 needing a real turn (`start-session.boat-turn`,
`start-session.composer`, `send-review-back.deliver`) · 16 box-only. Features: 42 with a flow, 12
only in Not on the box (doppler, workspace-replace, observed-agents, terminal-agent-waits,
uninstall, pi-profile, mend-toml, desktop-app, mobile-app, vscode, slack, t3-gateway): 54 of the
map's 54 mapped features placed, none left over.
