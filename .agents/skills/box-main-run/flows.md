# Flows of the daily run

Runs: every flow below, once a day (the owner's choice on SLNT-1050, 17 Nov), but those with a
`Not on the box:` line, which a run reports as `not run · not on the box`. To run fewer, name the
set on this line, for example "the flows marked `Sample: yes`"; a run reports each flow outside it
as `not run · not in this run's set`.

A flow with a `Waiting on:` line still runs. That line names a ticket and the part of the See line
that cannot show until the ticket is settled (the shipped app lacks it, or a recipe cannot reach
it): a flow that falls short on exactly that part, with the rest of its See line seen, is
`failed · <ticket> (known)`, needs no second look and files nothing (SKILL.md, step 5). Remove the
line once the ticket is settled, rewriting the See line if the app changed.

Every flow one run of [SKILL.md](SKILL.md) can use on the box, as its signed-in owner, after the
preview of `main` is deployed. **The box**, in this file, is the check VM copy of the run's own data
that runs the flow's lane (SKILL.md, Lanes): lane A, B or C, each at its own address. Where a flow
says `MEND_VERIFY_BOX_SSH`, it is that copy's (`~/.local/state/mend-main-run/lanes/<lane>/ssh`), and
`box`, `M`, `M2` and `web` are that lane's names. Until 20 Nov 2026 the box was VM 131; nothing here
reaches VM 131 now. Each flow comes from the feature map (`.agents/skills/verify/features/`, written
"the map"); the feature file holds the exact handles, commands and strings, and a flow points at it
instead of copying them. Every feature in the map has at least one flow here or a line in
[Not on the box](#not-on-the-box). A PR that adds or changes a feature adds or updates its flow here
in the same PR, and its judge names that flow (`pnpm verify judge`, which refuses an id this file
does not have). Ids are stable: reports, tickets and PRs name flows by id, so rename one only with a
note in the PR that does it. A flow's `Areas` line names the paths it passes through: an entry
ending in `/` holds everything under it, and a judge cannot answer "no flow" for a change inside
one. Every flow runs on every box: the box serves the web app (`apps/web`) that ships.

`M` is the CLI under test, signed in as the box's owner account (never `mend login` or `mend logout`
it). `<p>` is the project `boat-check-ubuntu` (Ubuntu, branch `master`). `<sha8>` is the first 8
characters of the commit under test. `$E/<flow id>` is the flow's evidence directory. `<scratch>` is
a fresh `mktemp -d` directory of this run. Web flows run through
`.agents/skills/verify/scripts/drive-web.mjs`; `scripted` flows name their recipe, `agent` flows are
driven by the run's agent from the feature file.

Box facts the flows depend on: the flows run on the run's own data, which every copy boots with, at
the address the lane's copy serves (`$WEB`, read each run). On a Boat copy (lanes A and C, with
`BOAT_COPIES` at 2) sessions run on Boat by default, and Docker is offered beside it; on a copy
without Boat they run on Docker. The runtime is chosen per organization and a worktree keeps the
runtime it was made on, so a worktree the data made on Boat starts no session on a copy without it.
Multi tenancy, the default since #1916, with one organization in the data (Default). Provider logins
on 16 Nov: codex and claude connected, GitHub not. Flows use codex only: the box's Claude login
stays unused until SLNT-905 is decided. Six flows run a real agent turn, each with one-line prompts:
`start-session.boat-turn`, `start-session.composer`, `start-session.web-write`,
`start-session.web-answer`, `send-review-back.deliver` and `start-session.go-back`. They use codex:
the owner has far more Codex capacity than Claude (17 Nov).

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
pages (`General`, `Workspace`, `Services`, `Variables and secrets`, `Folders and references`,
`Only you`; `apps/web/src/lib/settings-pages.ts`), and app Settings has one page per section
(`/settings/devices`, `/settings/agent-logins`, …; old addresses redirect). A flow that reads a
Setup section reads it in the matching Settings sub-tab, and reports a missing section as a map gap,
not a product failure.

## Fixtures

Made once, kept in the run's data (`world.sql`, its store and the git service's repositories, which
`pnpm verify vm save` writes from lane A each night and the master is built from), and checked on
each lane before the flow that needs it. A missing fixture makes its flow
`not run · fixture <name> missing`; recreate it as written, on lane A only: what lanes B and C make
goes with their copies.

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
  Since 20 Nov no flow starts a session in it: its captures stayed in VM 131's blob store, and
  `start-session.docker-run` makes a worktree of its own on lane B instead.
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
  agent login, and the run gives it none: Mend keeps each account's agent logins its own (nobody
  else's work spends them), and a copy of the checker's Codex login would share one refresh token,
  which the first refresh spends for the other (SLNT-1267).
- **The serve command** `<serve-cmd>`: `python3 -m http.server 8000`. Python is one of Mend's
  default workspace packages (`DEFAULT_WORKSPACE_PACKAGES`, `packages/domain/src/settings.ts`), so
  the Ubuntu image has it; nothing needs making.
- **The previous run's session**: the ledger's `session` from the last run (SKILL.md, State). Not
  made by hand; with no previous run, `server.data-intact` runs its listing half only.

Each run also makes, and leaves for the next run to read: the worktree `main-run-<sha8>` (the turn),
`main-run-run-<sha8>` (the `mend run`), and `main-run-live-<sha8>` (the live session). Wind-down
removes what SKILL.md's ledger says to remove.

## Run order

Flows are grouped below as the map's README groups features; within a lane they run in this order,
because later flows reuse what earlier ones made. SKILL.md's Lanes says which lane runs each group:
A runs 1, 2, 3, 4, 6, 7 and 8; B runs 5 and 11; C runs 9, 10 and 12, and when C has no Boat, the
Boat flows of 9 and 10 run on A after its own. Each copy has its own data, so a group on one lane
never sees what another lane changed. On every lane, a verify CLI batch runs without its
`mend connect` steps (SKILL.md, Lanes, "Agent logins on a lane").

1. `server.data-intact` (before half), `server.upgrade`, `server.data-intact` (after half),
   `server.status-logs`; then `land-change.web-push`, `land-change.cli-again` and
   `land-change.refused`, in that order. Opus drives every flow of this group. The landing flows'
   worktree `main-run-land-<sha8>` stays in lane A's saved data, in the ledger's `worktrees`, until
   a later wind-down removes it.
2. `doctor.checklist`, `cli.version`, `exposure.read`, `operator.read`, `organization.read-invite`,
   `provider-accounts.read`, `models.list-picker`
3. `start-session.boat-turn`, `review-change.web-review`, `now-and-sessions.web-now`,
   `attach-resume.boat-stop-resume`, `send-review-back.deliver`, `start-session.go-back`
4. `start-session.boat-run`, `tui.dashboard`, `start-session.composer`, `start-session.web-write`,
   `start-session.web-answer`, `review-change.web-comments`, `land-change.panel-read`,
   `pull-change.boat-run`, `attach-resume.rename-web`, then `start-session.antigravity-conversation`
   last: its turns run in boat-run's worktree, which the flows before it read as boat-run left it
5. `start-session.docker-run`
6. `start-session.boat-live`, `attach-resume.attach-detach`, `attach-resume.terminal-and-web`,
   `session-shell.live-shell`, `shared-control.refuse-script`, `services.cli-run`,
   `capture-and-save.live-stop`
7. `worktrees.web-create-remove`, `handoff.held`, `now-and-sessions.inbox-settle`,
   `now-and-sessions.cli-lists`
8. Reads of a person's and a project's setup, in any order: `sign-in.fresh-browser`,
   `pairing-devices.mint-read`, `git-access.read`, `workspace-ssh.status`, `dotfiles.read`,
   `secret-files.cli-roundtrip`, `git-author.roundtrip`, `skills.read`,
   `skills.adopt-project-skills`, `agent-memory.read`, `appearance.web-theme`,
   `project-environment.read`, `cluster-bindings.read`, `workspace-images.read`,
   `automatic-install.read`, `hot-sessions.read`, `project-settings.read`,
   `references-folders.folder-cli`. Each restores what it changes, so lane A's saved data keeps none
   of it.
9. `organization.visibility-who-sees`, `repositories-in-session.add-second`,
   `references-folders.select-link`, `organization.roles-roundtrip`, `organization.join-refused`,
   `operator.owner-grant-restore`, `shared-control.two-people`, `shared-control.ask-and-grant`,
   `shared-control.new-web-ask-and-grant`, `per-person-homes.two-people`, in that order and one at a
   time within a lane: several change `<land>`, `<second>` or a role, and each runs only after the
   one before it in its lane has put that back.
10. The new web's sessions, most with a real Codex turn, in any order:
    `start-session.new-web-instant-start` (Boat), `adopt-project.new-web-project-page`,
    `session-page.new-web-checks`, `session-page.new-web-record`, `session-page.new-web-screen`,
    `start-session.new-web-steer-taken`, `start-session.new-web-streaming`,
    `start-session.new-web-impatient-start`, `start-session.new-web-cut-short-start`,
    `review-change.new-web-second-look`, `now-and-sessions.new-web-session-states`,
    `session-page.new-web-tiles`, `session-page.new-web-layouts`, `session-page.new-web-terminal`,
    `session-page.new-web-details`.
11. The rest of the new web, on a copy without Boat: `start-session.memory-limit` first (a real
    turn, which needs the copy's own login); then, in any order, every flow no other group names:
    `adopt-project.*` but `adopt-project.new-web-project-page`, `settings.new-web-*` but
    `settings.new-web-agent-logins`, `organization.new-web-*` but group 12's four,
    `sign-in.new-web-*` but the two that run a real `mend login`,
    `attach-resume.antigravity-mode-switch`, `session-page.new-web-shared-workspace`,
    `session-page.new-web-preview`, `session-page.new-web-checkpoint-lines`, `session-stop.*`,
    `start-session.new-web-code-colours`, the `review-change.new-web-*` reads but the second look,
    `land-change.new-web-land`, `skills.new-web-*`, `search.new-web-search`,
    `agent-memory.new-web-only-you`, the `project-settings.new-web-*`,
    `workspace-images.new-web-project` and `references-folders.new-web-project` flows, the other
    `now-and-sessions.new-web-*`, `worktrees.new-web-*` and `resources.new-web-resources`; then
    yours, `sign-in.new-web-setup-revisit` and `sign-in.new-web-authorize-account` (SKILL.md, step
    5), after every flow that counts the organization's members: `setup-revisit` leaves the person
    it joins a member of Default (a trial on 22 Nov then read `Default · 3 members`); then
    `settings.new-web-agent-logins`, which replaces and disconnects the copy's logins on purpose, so
    nothing after it needs one; then `doctor.bundle-web` last.
12. The organization's own pages, with no session, in any order and last on their lane:
    `organization.new-web-create-leave`, `organization.new-web-operator-create`,
    `organization.new-web-general`, `organization.new-web-members`. `general` and `members` add a
    person and remove them, and `operator-create` makes an organization that no command removes, so
    nothing after them on the lane counts members or organizations. Never on lane A, whose data is
    saved: with lane C left out they run on lane B, before its two `mend login` flows.

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

- **Map:** adopt-project.md `projects-directory`, `project-page`, `adopt-web` (the dialog opens and
  refuses a local path; nothing is adopted)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** On `/projects`, choose `Add project`; on its tab `From a Git URL` type a local path in
  `Repository address`, leave the field and read the refusal, choose `Add project` once, then
  `Cancel`. Search `Search projects` for `<p>` and open its page.
- **See:** the dialog `Add project` with `Repository address` marked invalid (`aria-invalid`) and a
  line ending `Local paths and file:// URLs are not supported.`; nothing adopted (`M projects` lists
  what it did before); the table `Projects` with one row for `<p>`; `<p>`'s page at
  `/projects/<id>`.
- **Mode:** `agent` · the verify skill's `recipes/projects.mjs` drives the same refusal on a stack
- **Box-only:** no
- **Areas:** `apps/web/src/components/projects/`, `apps/web/src/routes/_inbox.projects.index.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.tsx`, `apps/api/src/adoptions.ts`

### adopt-project.new-web-projects

- **Map:** adopt-project.md `projects-directory`, `adopt-web`, `adopt-invalid-url`,
  `adopt-visibility`; project-settings.md `settings-remove`, `settings-retention`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `projects` (after the composer's CLI batch `composer-setup.json`):
  Projects lists the projects, searches and filters them; Add project refuses a local path, clones a
  small public repository shared with the organization, clones a big one while a session queued in
  the composer waits for it, and reports a clone the key can't read and a clone that fails; Remove
  project…, Restore and Purge… under Removed projects.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the session queued on the
  clone starts by itself; every project the recipe made is purged at its end.
- **Mode:** `scripted` (recipes/projects.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/projects/`, `apps/web/src/routes/_inbox.projects.index.tsx`,
  `apps/web/src/lib/projects.ts`, `apps/web/src/lib/clone-state.ts`,
  `apps/web/src/lib/project-removal.ts`

### settings.new-web-settings

- **Map:** appearance.md `theme-web`, `theme-system`, `theme-persist`; sign-in.md `web-sign-out`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `settings`: Settings opens Profile beside its own sidebar, with every
  page a person may open; old settings addresses go to their new homes; Profile changes the
  account's name and password and puts both back; Appearance sets theme, text size and terminal
  font, kept across a reload from the first paint, and the account menu reads the same theme; a
  member sees no owner page or Server and is refused them by address; an operator sees Server; the
  phone's Settings tab, Profile and Appearance at 390px; Sign out last.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's name and
  password are what they were before the run.
- **Mode:** `scripted` (recipes/settings.mjs)
- **Box-only:** no
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
- **Do:** Drive the recipe `dotfiles`: old `/settings/workspace#<section>` links land on Dotfiles,
  Devices and access keys or Connected apps; a repository the server can't clone is refused with
  nothing saved, and a small public one saves with its manager; a home file is added from the
  browser and removed; a secret file's path outside the home folder is refused, then the file is
  added from pasted text, replaced from a chosen file and removed.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's repository,
  home files and secret files are what they were before the run, and no secret file's content
  appears anywhere.
- **Mode:** `scripted` (recipes/dotfiles.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/dotfiles-page.tsx`,
  `apps/web/src/routes/_inbox.settings.dotfiles.tsx`, `apps/web/src/lib/dotfiles-repository.ts`,
  `apps/web/src/lib/secret-files.ts`

### settings.new-web-devices

- **Map:** pairing-devices.md `pair-web`, `mint-by-hand`, `device-list`, `revoke`; workspace-ssh.md
  `ssh-keys`, `no-gateway`; access keys (ADR 0023)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `devices`: `/settings/access-keys` opens Devices and access keys; Show a
  code makes a pairing code with its QR; a token made by hand is shown once, then its device is
  listed and revoked by name; an access key is created, shown once, listed by name and revoked; the
  workspace SSH keys list, Add SSH key… with `mend ssh setup`, and Remove… with its result; on the
  box, the keys this account registered with `mend ssh setup`.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no device or key the run
  made is left behind, and no code, token or key appears in any picture.
- **Mode:** `scripted` (recipes/devices.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/devices-page.tsx`,
  `apps/web/src/routes/_inbox.settings.devices.tsx`, `apps/web/src/lib/devices.ts`,
  `apps/web/src/lib/pairing-qr.ts`

### settings.new-web-agent-logins

- **Map:** provider-accounts.md `accounts-list`, `connect-web` (an API key only), `disconnect`,
  `reconnect-state`, `agent-logins`; git-access.md `mode-choice`, `mend-key`, `key-card`,
  `key-check`, `bridge-share`; git-author.md `git-author-set-web`, `git-author-refused`,
  `git-author-clear`
- **Needs:** no session; no turn; web and the CLI
- **Do:** Drive the recipe `agent-logins`, and while it waits run its CLI batch
  `agent-logins-connect.json`: `/settings/git-access` opens Agent logins and Git; Connect Claude
  Code shows `mend login --url` and `mend connect claude` and closes by itself when the batch's
  login lands; Codex's login is replaced with an API key, a wrong key refused first; a refused login
  reads Reconnect; Disconnect removes one; "Selected agent's login only" saves and reports a failed
  save; the Git author is refused, saved and returned to the account's; the Mend key is checked
  against GitHub; the Git access mode switches to your computer's key and back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no part of any key on a
  page; the account's author, mode and switch are what they were before the run.
- **Mode:** `scripted` (recipes/agent-logins.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/agent-logins-page.tsx`,
  `apps/web/src/components/agent-login-panels.tsx`,
  `apps/web/src/routes/_inbox.settings.agent-logins.tsx`, `apps/web/src/lib/agent-login.ts`

### settings.new-web-mcp-servers

- **Map:** none in a feature file (route PR 41: a person's own MCP servers, docs/adr/0024)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `settings-mcp`: MCP servers lists the account's own servers under "Only
  you"; add an HTTP server with a header (the row names the header, never its value), a stdio server
  and an SSE one; a taken name is refused before sending; turn one off and it stays off; a failed
  switch goes back with Try again; edit a URL and keep the saved header; a kept sign-in shows Signed
  in and Forget sign-in… confirms; remove one; the Executor services section (recorded answers)
  points to Connected apps without a link, lists services with one, and a service sign-in comes back
  through `/executor/service-callback`, or says why it was refused; a failed read shows Try again;
  the phone width uses 44px targets and an action sheet. The recipe removes the servers it added.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no header value in any
  picture, log or note.
- **Mode:** `scripted` (recipes/settings-mcp.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/mcp-servers-page.tsx`,
  `apps/web/src/components/settings/mcp-server-dialog.tsx`,
  `apps/web/src/components/settings/executor-services.tsx`,
  `apps/web/src/routes/_inbox.settings.mcp-servers.tsx`,
  `apps/web/src/routes/_inbox.executor.service-callback.tsx`, `apps/web/src/lib/mcp-servers.ts`

### settings.new-web-notifications

- **Map:** none in a feature file (route PR 42: phone notifications, `GET`/`PUT /me/notifications`)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `settings-notifications`: Notifications shows the four switches as the
  server holds them under "Only you"; turning one saves it at once, says so in a toast, and the
  server keeps it; a slow save shows Saving…; a refused one goes back with Try again; Sent to says
  no phone is paired, and (recorded answer) lists a paired iPhone and leaves a browser out; a failed
  read shows Try again; the phone width. The recipe puts the setting back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's setting is
  what it was before the run.
- **Mode:** `scripted` (recipes/settings-notifications.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/notifications-page.tsx`,
  `apps/web/src/routes/_inbox.settings.notifications.tsx`, `apps/web/src/lib/notifications.ts`,
  `apps/web/src/server/routers/devices.ts`

### settings.new-web-connected-apps

- **Map:** slack.md `slack-link`, `slack-default-project`; doppler.md `doppler-settings`,
  `doppler-disconnect`
- **Needs:** no session; no turn; web; for Slack and Executor for real, a Slack workspace and an
  Executor connected to the organization
- **Do:** Drive the recipe `settings-connected-apps`: Connected apps under "Only you" shows Slack,
  Executor and Doppler; Doppler connects, replaces and disconnects a token with no part of it ever
  shown, and the disconnect confirmation counts the projects with a picked config; a linked Slack
  shows Your default project and unlinks; Executor's row says your link is used before the
  organization's shared account; `/executor/callback` finishes a link and returns, or says why it
  didn't; old `/settings/workspace` opens Connected apps; `/slack/link#<code>` names the workspace,
  the Slack user and the Mend account, warns when it replaces a link, links, and says when a code
  can't be used; old `/slack/link/<code>` moves the code to the fragment; a signed-out visitor signs
  in on the same address. On the box, link Slack from a real mention.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no token in any picture,
  log or note; no Doppler token left on the account.
- **Mode:** `scripted` (recipes/settings-connected-apps.mjs)
- **Box-only:** no
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
- **Do:** Drive the recipe `settings-automation`: `/settings/review`, `/settings/landing` and
  `/settings/sessions` open Your automation; under "Only you" the four switches (Change description
  and tour, Suggested fixes, Automatic landing, Stop the session when you settle its thread) show
  what the server holds, with no Inherit; turning each saves it, says so in a toast, and the server
  keeps it without changing `autoName` or `backgroundSessions`; the home composer's "Land when a
  turn completes" starts from Automatic landing, on and off; a slow save shows Saving…; a refused
  one goes back with Try again; a failed read shows Try again; the phone width. The recipe puts both
  settings back.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the account's automation
  and settle settings are what they were before the run.
- **Mode:** `scripted` (recipes/settings-automation.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/automation-page.tsx`,
  `apps/web/src/routes/_inbox.settings.automation.tsx`, `apps/web/src/lib/automation.ts`

### settings.new-web-boat

- **Map:** none in a feature file (route PR 48: the organization's Boat key, docs/adr/0025)
- **Needs:** no session; no turn; web; for a connected key for real, an owner and a Boat key
- **Do:** Drive the recipe `settings-boat`: Boat under "Everyone in <organization>" says whether
  there is a key; an owner connects one through a dialog with the create-key command, a value that
  isn't a key is refused and the field empties; a connected key shows who added it and when it
  expires, a banner two weeks before expiry with Replace key…, the wallet when the key's account can
  bill several, Last check with Check again, Full check with its steps and a dialog to run one, and
  what Boat reported; replace and remove confirm in dialogs and say a refusal there; a member reads
  only whether there is a key; a failed read shows Try again. On the box, connect and check a real
  key.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no part of the key in any
  picture, log or note.
- **Mode:** `scripted` (recipes/settings-boat.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/boat-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.boat.tsx`, `apps/web/src/lib/boat-key.ts`,
  `apps/web/src/server/routers/boat-key.ts`

### organization.new-web-org-projects

- **Map:** none in a feature file (the owners' Projects page, the owner's ruling of 18 Nov 2026)
- **Needs:** no session; no turn; web; a second account to join and leave
- **Do:** Drive the recipe `settings-org-projects`: Projects under "Owners of <organization>" sits
  in the owner's settings sidebar right before Audit log, and a member has no such entry and is sent
  to Profile by its address; with nothing to show, both lists say so; a project whose creator left
  is listed without a creator, and Take over… confirms, says a refusal in the dialog, and once taken
  over the row goes, a toast says so and the project is the owner's; kept volumes list their
  project, volume, Docker name, when and size, with no actions; a failed read shows Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the member and the
  project the recipe made are gone afterwards.
- **Mode:** `scripted` (recipes/settings-org-projects.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/organization-projects-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.projects.tsx`,
  `apps/web/src/lib/organization-projects.ts`

### settings.new-web-server

- **Map:** exposure.md `exposure-report`, `tenancy-gate`; doctor.md `doctor-web-connection`;
  workspace-images.md `image-instance-default` (read-only); operator.md `org-list`
- **Needs:** no session; no turn; web; the server's operator and a second account that isn't one
- **Do:** Drive the recipe `settings-server`: Server under "Operators of this server" says what the
  server is (its address, version, where it runs, and the Sealant connection with Check again,
  Checking… while it runs), then "Needs you" only when something does (Sealant not connected, the
  server's Boat key refused or Boat unreachable when Boat is offered, a check not in place on a
  public server, a gate item missing on a server running several organizations), each with what Mend
  saw and the fix. Who can reach it shows the declaration and how it is set; on a private server
  what going public would change and the checks in place are two closed lines, each check with a
  plain title, its id small beside it, and sentences worded from the case and data the server sends.
  Where sessions run shows Docker and Boat with Boat's facts as sentences and Check the key now; the
  starting image named by what it is, its packages closed; the organizations with member and owner
  counts ("no owner" for an ownerless one), tenancy, and the gate closed the same way; the store and
  session channel last. A section whose read fails shows Try again and the rest stand. Old
  `/settings/instance/*` and `/settings/sealant` land here. Someone who isn't an operator has no
  Server in the sidebar, is sent to Profile, and the API answers them 404. On the box, the check
  reads the box's own Sealant.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no key, token or
  connection secret in any picture, log or note.
- **Mode:** `scripted` (recipes/settings-server.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/server-page.tsx`,
  `apps/web/src/routes/_inbox.settings.[server].tsx`, `apps/web/src/lib/server-settings.ts`,
  `apps/web/src/server/routers/operator.ts`, `apps/api/src/exposure.ts`, `apps/api/src/tenancy.ts`,
  `packages/api-contracts/src/operator.ts`

### organization.new-web-folders

- **Map:** references-folders.md `folder-web`, `ref-refresh-remove`
- **Needs:** no session; no turn; web; GitHub reachable from the server, for a reference's clone
- **Do:** Drive the recipe `settings-folders`: Folders and references under "Everyone in
  <organization>" lists the organization's folders with their file count, size and when they were
  added, and its references with their repository, ref and when they were fetched; an owner makes a
  folder (a name the server refuses is said under the field), uploads files, shows and deletes one,
  renames the folder (a name another folder has is refused; the Audit log records it), adds a
  reference and fetches it again, deletes the folder (a refusal while a project picks it is said in
  the dialog) and removes the reference; a member reads both lists with no button that changes them;
  a failed read shows Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the folder and the
  reference the recipe made are gone afterwards.
- **Mode:** `scripted` (recipes/settings-folders.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/folders-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.folders.tsx`,
  `apps/web/src/lib/organization-folders.ts`, `apps/api/src/routes/folders.ts`

### settings.new-web-runtime

- **Map:** none in a feature file (route PR 47: where the organization's new sessions run, Docker or
  Boat, and what a switch changes; docs/adr/0025)
- **Needs:** no session; no turn; web; for a real switch, a server that offers Docker and Boat
- **Do:** Drive the recipe `settings-runtime`: Runtime under "Everyone in <organization>" lists the
  runtimes the server offers with where new sessions run selected, Boat's line linking to the Boat
  page; old `/settings/organization/defaults` and `/settings#organization-defaults` open it. An
  owner switches: when the server says nothing changes, at once with a toast; otherwise a dialog
  first says what the new runtime wouldn't run (the organization's image, projects by name, a count
  of private ones) and that running sessions stay, with Cancel, Switch without moving and Move and
  switch, and says a refusal there; after a switch without moving, the page lists what the runtime
  doesn't run with Move to what <runtime> runs. A switch Mend couldn't check says so. A member reads
  the choices and who can change them; a server where Sealant picks has no choice; a failed read
  shows Try again. On the box, switch for real where it offers both.
- **See:** each step's note in the recipe's `steps.log`, and its captures; what each switch sent.
- **Mode:** `scripted` (recipes/settings-runtime.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/runtime-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.runtime.tsx`,
  `apps/web/src/lib/runtime-switch.ts`

### organization.new-web-integrations

- **Map:** slack.md `slack-connect`, `slack-display`, the owners' Links list; the organization's
  Executor (manage, configure, the directory, share a service)
- **Needs:** no session; no turn; web; for Slack and Executor for real, a Slack workspace and an
  Executor (Mend-run or the organization's own)
- **Do:** Drive the recipe `settings-integrations`: old `/settings/organization/slack` and
  `/settings/organization/executor` land on Integrations under "Everyone in <organization>"; an
  owner connects Slack from Mend's manifest with two tokens that are never shown again (a refusal
  empties both fields), turns thread settings on and off, removes a person's Slack link from Linked
  people, replaces the tokens and removes the app; the Executor Mend runs shows its state and
  version with Stop, Start and Upgrade, the shared services with Share with everyone, and Who runs
  it; your own Executor shows its address and the shared account's link; a member reads what is set
  up with no button that changes it; a failed read shows Try again. On the box, connect a real Slack
  workspace and start the Executor Mend runs.
- **See:** each step's note in the recipe's `steps.log`, and its captures; no part of a token in any
  picture, log or note.
- **Mode:** `scripted` (recipes/settings-integrations.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/integrations-page.tsx`,
  `apps/web/src/components/settings/executor-services.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.integrations.tsx`,
  `apps/web/src/routes/_inbox.executor.service-callback.tsx`, `apps/web/src/lib/integrations.ts`

### settings.new-web-workspace-image

- **Map:** workspace-images.md `image-organization-default`, `image-packages`,
  `image-setup-commands`, `image-rejections` (route PR 47)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `settings-workspace-image`: Workspace image under "Everyone in
  <organization>" says Mend copies it into each new project when the project is created and that
  changing it changes no existing project. An owner adds packages with Add package; a package
  Sealant can't find refuses the save and is named beside why; the save goes through once it is
  removed, with a toast, and the server answers the new image back. A project made afterwards starts
  from it, and an existing project keeps its own. A custom image with no base image keeps Save off;
  with a base image and setup commands it saves, and they read back. The image is put back and the
  project removed. A member reads the image as rows and who can change it; a failed read shows Try
  again; on a phone the Unsaved changes bar has 44px buttons.
- **See:** each step's note in the recipe's `steps.log` (the images the server answered), and its
  captures.
- **Mode:** `scripted` (recipes/settings-workspace-image.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/workspace-image-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.workspace-image.tsx`,
  `apps/web/src/lib/workspace-image.ts`, `apps/web/src/lib/runtime-support.ts`

### adopt-project.new-web-first-project

- **Map:** adopt-project.md `adopt-web`, `adopt-invalid-url`, `adopt-visibility`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `first-project` (after the composer's CLI batch `composer-setup.json`):
  setup's First project step sends someone who sees a project on to How Mend fits together; with the
  project list answered without the account's projects, it refuses a local path, reports a clone
  that fails with Clone again and Change details, clones a small public repository shared with the
  organization, then clones a big one, keeps it across a reload, and Continue opens How Mend fits
  together, whose Skip for now opens the composer, where a session queued on the clone waits and
  starts.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the session queued on the
  clone starts by itself; every project the recipe made is purged at its end.
- **Mode:** `scripted` (recipes/first-project.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/first-project-step.tsx`,
  `apps/web/src/routes/welcome.first-project.tsx`, `apps/web/src/lib/use-clone.ts`,
  `apps/web/src/lib/setup.ts`

### sign-in.new-web-setup-order

- **Map:** sign-in.md `first-account`, `cli-login`; git-access.md `mend-key`, `bridge-share`;
  provider-accounts.md `accounts-list`; adopt-project.md `adopt-web`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `setup-order`: setup in the owner's order (SLNT-1191). Command line, step
  2 of 7, waits with the install and sign-in commands; Skip for now reaches Git access with
  "Skipped" under the step and the full block once; a device the server announces with the `user`
  event turns the open page into "Mend's command line is signed in on <computer>." with no reload.
  Git access shows one ticked line and the GitHub account section, waiting then connected. Agent
  login shows Mend's command line once above the tabs, and each tab holds only its own command.
  Organization, step 5 of 7, reports a failed save, renames, and goes on to First project, which
  shows how to connect GitHub with no login, then the person's repositories with an owner choice:
  their own account, then each organization; an organization lists its repositories, search looks
  within it, and one with none says it may need to approve GitHub CLI. Tab on the first-account form
  goes Name, Email, Password, Confirm password, the button. A person who joins lands on Command
  line, step 2 of 6, with no Organization step. The recipe also times a first `/api/github/owners`
  and `/api/github/repos` as the caller with a fake GitHub login.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the organization's name
  is put back, the minted device revoked and the fake GitHub login removed at the end.
- **Mode:** `scripted` (recipes/setup-order.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/command-line-step.tsx`,
  `apps/web/src/components/command-line-block.tsx`, `apps/web/src/components/organization-step.tsx`,
  `apps/web/src/components/github-connect.tsx`, `apps/web/src/components/setup-frame.tsx`,
  `apps/web/src/routes/welcome.command-line.tsx`, `apps/web/src/routes/welcome.organization.tsx`,
  `apps/web/src/lib/command-line.ts`, `apps/web/src/lib/setup-skips.ts`,
  `apps/web/src/lib/onboarding.ts`, `apps/api/src/github-identity.ts`,
  `apps/api/src/routes/github.ts`

### sign-in.new-web-how-mend-fits

- **Map:** sign-in.md `first-account`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `how-mend-fits` (SLNT-1203): setup's last step, How Mend fits together.
  The first account sees step 7 of 7 with three screens on `?screen=`: how Mend's parts nest
  (server, organization, project, worktree, session, workspace, change), inside a session, and the
  sidebar ("The inbox" on a phone). The pictures are the app's own components with sample data; the
  sidebar picture is the sidebar itself with its five groups. Next, Back and the browser's back move
  between screens; Skip for now (screens 1 and 2) and Continue to Mend (screen 3) open Mend, and
  going back to Git access the step reads skipped or done. `/welcome` sends someone who finished
  setup to Mend, never to this step; First project sends someone who sees a project on to it.
  Someone who joins sees step 6 of 6 and "You're a member of …". The account menu's "How Mend fits
  together" opens the same screens in a dialog, Done returns focus to the account row; on a phone,
  Settings' account sheet opens them as a sheet.
- **See:** each step's note in the recipe's `steps.log`, and its captures of every screen in light,
  dark and at 390px, the skipped rail, and the dialog; the recipe clears what it remembered in the
  browser.
- **Mode:** `scripted` (recipes/how-mend-fits.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/how-mend-fits.tsx`,
  `apps/web/src/components/how-mend-fits-step.tsx`,
  `apps/web/src/components/how-mend-fits-dialog.tsx`,
  `apps/web/src/routes/welcome.how-mend-fits.tsx`, `apps/web/src/lib/how-mend-fits.ts`,
  `apps/web/src/lib/how-mend-fits-open.ts`, `apps/web/src/components/account-menu.tsx`

### sign-in.new-web-setup-revisit

- **Map:** sign-in.md `first-account`, `cli-login`; git-access.md `mend-key`; provider-accounts.md
  `accounts-list`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `setup-revisit` (SLNT-1193). A real `mend login` signs a computer in. The
  first account goes forward from Command line to First project, then back to each earlier step by
  its link beside the sheet ("Git access, done"): each page shows what was saved and the later steps
  stay links, First project as "not finished". It renames the organization on Organization and
  Continue goes forward to First project again. Tab reaches each link by name; at 390px the header's
  back arrow goes to the step before, down to Command line, which has none. A person who joins skips
  Command line and Agent login, goes back to each by its link, goes forward again, and signing in
  again lands on `/welcome`.
- **See:** each step's note in the recipe's `steps.log`; only past steps are links, never Account,
  the current step or one not reached; no Continue sends the person back. The organization's name is
  put back and the computer's device revoked at the end.
- **Mode:** `scripted` (recipes/setup-revisit.mjs), driven by Opus with the stack file of SKILL.md,
  step 5: the recipe runs a real `mend login`, which subagents may not
- **Box-only:** no
- **Areas:** `apps/web/src/lib/setup.ts`, `apps/web/src/routes/welcome.git-access.tsx`,
  `apps/web/src/routes/welcome.index.tsx`, `apps/web/src/lib/git-access-step.ts`,
  `apps/web/src/components/git-access-step.tsx`, `apps/web/src/components/agent-login-step.tsx`

### sign-in.new-web-authorize-account

- **Map:** sign-in.md `authorize-page`, `cli-login`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `authorize-account` (SLNT-1193). The page a real `mend login` opens, then
  a request answered in the browser for three accounts: a short name and email, a long name and long
  email, and no name. Each at 1280px and 390px, then authorized, denied and signed out.
- **See:** the "Approving as" row reads the name, the email under it, and "Not you? Sign out", with
  no "·" in it; an account with no name shows only its email, and "signed in as <email>" once
  authorized.
- **Mode:** `scripted` (recipes/authorize-account.mjs), driven by Opus with the stack file of
  SKILL.md, step 5: the recipe runs a real `mend login`, which subagents may not
- **Box-only:** no
- **Areas:** `apps/web/src/routes/authorize.tsx`

### adopt-project.new-web-project-page

- **Map:** adopt-project.md `project-page`; session-shell.md `shell-session-web`; start-session.md
  `start-in-worktree`; handoff.md `handoff-row`; models.md `model-shown`; per-person-homes.md
  `join-line`
- **Needs:** no turn; web; CLI; `verify-fixture` (or `<p>` on the box) with a live `mend run`
  session in it
- **Do:** Run `project-setup.json` step by step without its `01-codex-login` step, with each
  `--name` suffixed `-<sha8>` (`project-ended-<sha8>`, `project-stopped-<sha8>`,
  `project-running-<sha8>`), then drive the recipe with `PROJECT_PAGE_SUFFIX=-<sha8>`. The data
  holds worktrees of the plain names whose captures it lacks, and Mend refuses a name it has seen,
  even after the worktree is removed (SLNT-1267). The recipe `project`: a project's page with its
  header, facts and tabs; the Sessions tab's search, Filter, Mine or Everyone and Open or Stopped,
  kept in the address across a reload; a row's "…" starts a shell and another session in its
  worktree; Open shell starts one in a new worktree; the "…" opens Set up this project, which starts
  a setup session; an empty project; a clone's page while it runs; the old setup page's address; a
  project that fails to load. Then `M stop` the batch's `project-running-<sha8>` session.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every session the recipe
  started is stopped, and every project it made is purged, at its end.
- **Mode:** `scripted` (recipes/project.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/`,
  `apps/web/src/routes/_inbox.projects.$projectId.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.index.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.setup-session.tsx`,
  `apps/web/src/lib/project-sessions.ts`, `apps/web/src/lib/project-starts.ts`,
  `apps/web/src/lib/shared-workspace.ts`

### session-page.new-web-tiles

- **Map:** no feature file yet (ADR 0026, tabs and tiles); start-session.md `session-page`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `tiles-sessions.json` step by step without its `00-codex-login` step,
  with its `--name` and `--worktree` suffixed `-<sha8>` (two sessions in the worktree
  `tiles-ws-<sha8>`, each a `sleep`), then drive the recipe with `TILES_SUFFIX=-<sha8>`. The data
  holds an old Boat worktree `tiles-ws` whose launches fail, and Mend refuses a name it has seen,
  even after the worktree is removed (SLNT-1300). The recipe `tiles`: drag a tab onto a tile's right
  edge and into another tile's middle, move tabs with Alt+Shift and the arrows, resize by the
  divider, reload, maximise and restore, close a tile's last tab, reopen it from "+", open a New
  session tab, start a session in the worktree from outside the page, open `?full=1`, and look under
  1024px and at 390px. Then pick the other batch session's tab, press Back, and reload on a view's
  tab. Stop both batch sessions at the end.
- **See:** each step's note in the recipe's `steps.log`: the drop marks Split right and Add to this
  tile, two tiles after a split and one after a merge, the resized width kept over a reload, the
  same conversation element after its tab moved, Restore layout on a maximised tile, the started
  session's tab beside the active one, and one strip of tabs under 1024px. Picking the other
  session's tab moves the address to `/sessions/<its id>` in place (no new history entry, the same
  conversation elements), the sidebar marks that session's row and the browser tab reads its title;
  Back leaves the workspace; a reload on a view's tab (`/sessions/<id>/<view>`) opens that tab
  focused in the same arrangement.
- **Mode:** `scripted` (recipes/tiles.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/`,
  `apps/web/src/components/session/session-sheet.tsx`,
  `apps/web/src/components/session/workspace-tabs.tsx`,
  `apps/web/src/components/session/new-session-tab.tsx`, `apps/web/src/lib/tiles.ts`,
  `apps/web/src/routes/_inbox.sessions.$sessionId.tsx`

### session-page.new-web-layouts

- **Map:** no feature file yet (ADR 0026, "Layouts": the layout menu and a person's saved layouts,
  SLNT-1175)
- **Needs:** either; no turn; web and CLI; `<p>`; the owner's sign-in typed in a second browser
- **Do:** Run the CLI batch `layouts-sessions.json` (two sessions in the worktree `layouts-one`, one
  in `layouts-two`, each a `sleep`), then drive the recipe `layouts` (the drive passes the account's
  sign-in): open the layout button in the Workspace header, pick Change over terminal and press ⌥2
  and ⌥3, save the sheet as "Review with terminal", be refused the same name in lower case, pick it
  in `layouts-two`, see it from a second browser signed in as the same person, rename and remove it,
  and look under 1024px. Then drive `layouts-server` for the API's refusals, limits and a second
  person.
- **See:** each step's note in the recipes' `steps.log`: the check on the layout the sheet shows,
  both sessions kept in one tile under Change over terminal and the Terminal tab kept under ⌥2, the
  saved toast and the menu again with the saved layout at ⌥5, the name-taken sentence in the dialog,
  the same three tiles in `layouts-two` while `layouts-one` keeps its own, the layout in the second
  browser, and no layout button under 1024px. Each recipe leaves nothing it saved.
- **Mode:** `scripted` (recipes/layouts.mjs, recipes/layouts-server.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/lib/layouts.ts`, `apps/web/src/components/workspace/layout-menu.tsx`,
  `packages/domain/src/workbench/saved-layout.ts`, `packages/db/src/repos/saved-layouts.ts`,
  `packages/api-contracts/src/saved-layouts.ts`, `apps/api/src/routes/saved-layouts.ts`,
  `apps/web/src/server/routers/layouts.ts`

### session-page.new-web-terminal

- **Map:** session-shell.md `shell-holds`; mobile.md `mobile-terminal-embed`; shared-control.md
  `terminal-owner-only`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `terminal-sessions.json` (a `sleep` session in the worktree `term-ws`),
  then drive the recipe `terminal`: open the old shell address, open New shell, type a command, Ctrl
  and click a printed link, move the Terminal tab to a tile of its own, maximise it, put it under
  the conversation and back, Close shell…, watch as a member with shared control (a fixture), look
  at 390px, load `/tty-embed` with an upgrade ticket and no cookie, and stop the session. Run the
  batch again, then drive `terminal-shells`: two shells, a shell's right-click menu, Rename…, its
  "…" menu's Copy working directory, `exit` in one shell, `exit 3` in another and its "What it
  printed", Close shell… on a shell running `sleep 600`, a long press, and 390px. Stop the batch
  sessions at the end if the recipes didn't.
- **See:** each step's note in the recipe's `steps.log`: the redirect to `/sessions/<id>/terminal`
  with the Terminal tab showing, the command's output read through Copy, the link's new tab, the
  shell's column count falling in half a sheet and rising when maximised with the same terminal
  element, the closed shell leaving the list, "Only <owner> types here. You're watching.", the
  ticket trade answering 200 and the socket's first output, and the stopped workspace's line. From
  the shells recipe: the tab's count and the list's heading equal to its rows at every step, a shell
  that exits leaving the list with "Shell 2 exited." or "Shell 3 exited with code 3." and the next
  shell shown, its output in "What it printed", `/workspace/repo` both copied and printed by `pwd`,
  the confirm before closing, and "No shells are open in this workspace." with New shell once the
  last one is closed.
- **Mode:** `scripted` (recipes/terminal.mjs, recipes/terminal-shells.mjs)
- **Box-only:** no
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
- **Do:** Run the CLI batch `details-sessions.json` (two `sleep` sessions in one worktree
  `details-ws-<time>`, the first declaring a `web` Service in `.mend/mend.toml`), then drive the
  recipe `details`: start the `web` Service, open `/sessions/<id>/details`, follow "Shared with 1
  other session", read the owner's row (shared control goes to the person who asked, #1848, so the
  row offers no `Turn on` for everyone), turn the everyone switch on through the API and off with
  the row's `Turn off shared control`, open Details from the other session's tile "+", read the
  fixture lines (a pull request, a handoff, a second repository, checks with edits since, a model, a
  per-person workspace and a layout fallback; shared control granted to the viewer alone), follow
  Preview to its tab, and a pull request read that fails with Try again.
- **See:** each step's note in the recipe's `steps.log`: the Details tab selected; the Workspace
  group's worktree, branch, base and "None yet"; "web :8000" Running under Services; both sessions
  with owner, agent and status; focus on "Sessions in this workspace"; the who-pays line and
  `Shared control is off.` with no `Turn on`; `sharedControlEnabledAt` null after
  `Turn off shared control`; Details in the "+" menu; the Preview tab selected from Preview; the
  fixture lines; "This didn't load." then "None yet" after Try again.
- **Mode:** `scripted` (recipes/details.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/details-view.tsx`,
  `apps/web/src/components/session/shared-control.tsx`, `apps/web/src/lib/session-details.ts`

### session-page.new-web-shared-workspace

- **Map:** per-person-homes.md `join-line`, `runs-as-yourself`, `shared-workspace-line`;
  start-session.md `session-stop-shared`; land-change.md `land-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `shared-workspace-sessions.json` (the worktree `shared-ws-<time>`: one
  `mend run` that writes a file, then two `sleep` sessions in it), then drive the recipe
  `shared-workspace`: open the home composer's worktree picker, pick the running workspace, read the
  join line with another person's session live there (fixture), open that person's session and press
  "Start your own session in this workspace", Stop session… on the second session and stop it, then
  Land… on the first and land (fixture answer).
- **See:** each step's note in the recipe's `steps.log`: "Your running workspaces in <project>" with
  the worktree and "2 sessions"; no join line where only your sessions run; the join line saying the
  session runs as you, on your own logins; a New session tab beside the other person's with the join
  line and the task field focused; the Stop dialog naming the session that keeps the workspace
  running, and the toast that it is still running; the Land dialog naming the session still editing,
  and the toast "Pushed … to origin. … is still running."
- **Mode:** `scripted` (recipes/shared-workspace.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/new-session/join-line.tsx`,
  `apps/web/src/components/new-session/pickers.tsx`, `apps/web/src/lib/shared-workspace.ts`

### session-stop.new-web-session-actions

- **Map:** start-session.md `session-stop`, `session-stop-shared`; attach-resume.md `resume-web`,
  `rename-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `session-actions-sessions.json` step by step, with each `--name` and
  `--worktree` suffixed `-<sha8>` (two sessions in the worktree `actions-ws-<sha8>` and one in
  `actions-solo-<sha8>`, each a `sleep`), then drive the recipe with
  `SESSION_ACTIONS_SUFFIX=-<sha8>`. The data holds Boat worktrees `actions-ws` and `actions-solo`,
  which start nothing on a copy without Boat, and Mend refuses a name it has seen, even after the
  worktree is removed (SLNT-1300). The recipe `session-actions`: right-click a session tab, open its
  tile's "…" and the workspace "…", Copy branch name, New session in this workspace, rename by F2,
  open Stop session… on a session that shares its workspace and on one alone in its own, stop each,
  resume the lone one, and open the phone's "…" sheet and its Stop session sheet at 390px.
- **See:** each step's note in the recipe's `steps.log`: the tab menu holds the session's actions
  and no workspace action, the workspace menu holds no session action; the dialog names the session
  that keeps the workspace running, and says the workspace stops too for the lone one; the stopped
  banner and "You stopped the session at …" with what the workspace does now; the session running
  again after Resume session.
- **Mode:** `scripted` (recipes/session-actions.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/session/session-actions.tsx`,
  `apps/web/src/components/session/stopped-banner.tsx`, `apps/web/src/lib/session-stop.ts`

### session-stop.new-web-session-ended

- **Map:** capture-and-save.md `capture-stop-line`, `capture-not-saved`, `capture-discard`;
  workspace-replace.md `retire-line`, `retire-evidence`, `replace-web`, `replace-refused`,
  `replacing-line`; services.md `service-hold`; attach-resume.md `delete-web`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `session-ended-sessions.json` (one `sleep` session in `ended-a` and one
  in `ended-b`), then drive the recipe `session-ended`: read the bands a stopped session shows while
  it saves, when work isn't saved (Discard…), while Services keep the workspace up (Stop services)
  and while the workspace waits to be replaced (Replace this workspace now), then stop the other
  session and delete it from its tab's menu.
- **See:** each step's note in the recipe's `steps.log`: each band's line in the domain's words, the
  server's answer to Discard and stop, Stop services and Replace this workspace now; no Delete
  session… on a running session; the Delete dialog's "What stays"; home after Delete with "Deleted …
  Its worktree and change are still in …", and the session gone from the inbox.
- **Mode:** `scripted` (recipes/session-ended.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/session/session-notices.tsx`,
  `apps/web/src/lib/shared-workspace.ts`

### session-page.new-web-preview

- **Map:** services.md `service-run-web`, `service-recipe`, `service-add`, `service-observe`,
  `service-logs`, `service-restart-stop`; mend-toml.md `toml-recipes-card`, `toml-parse-error`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `preview-sessions.json` (two `sleep` sessions in a new worktree
  `preview-ws-<time>`, whose `.mend/mend.toml` declares `web` and `broken`), then drive the recipe
  `preview`: open `/sessions/<id>/preview`, Start web, open its page in a new tab, type a path, Run
  a command… that asks `web` for its page from inside the workspace, open both logs, Restart
  service…, adopt a port with an empty command, Start broken, Stop web and Run again, look at 390px
  with the picker open, a Mend preview on another site, a file that doesn't parse and a watcher with
  shared control (fixtures), the view's failed read, and Stop session on both.
- **See:** each step's note in the recipe's `steps.log`: the file's recipes with Start, "Both
  sessions in <worktree> use these services…", `web` Running with `:8000` on the Preview tab, the
  new tab at the Service's address and the typed path in its link, `docs` printing
  `web answered 200` and `web`'s Logs bar showing that `GET /`, the Restart dialog saying the other
  session uses it, the adopted port, `broken` named as not started with its exit and output, `web`
  Stopped then Running, the picker's services and actions, "Previews are on a different site…" with
  Open in a new tab, the file's error with Read it again, "Only <owner> starts services…" with
  Restart and Stop still there, Try again, and "This workspace isn't running…" with Resume after
  both stop.
- **Mode:** `scripted` (recipes/preview.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/views/preview-view.tsx`,
  `apps/web/src/components/workspace/views/preview-page.tsx`,
  `apps/web/src/components/workspace/views/service-log.tsx`,
  `apps/web/src/components/workspace/views/run-command-dialog.tsx`,
  `apps/web/src/components/workspace/views/use-workspace-services.ts`,
  `apps/web/src/lib/workspace-services.ts`, `apps/web/src/lib/previews.ts`,
  `apps/web/src/server/routers/services.ts`

### session-page.new-web-checks

- **Map:** none in a feature file: the checks the agent ran were a section of the old app's side
  panel, and are the Checks view in the web app (SLNT-1157)
- **Needs:** either; one Codex turn; web and CLI; `<p>`
- **Do:** Drive the recipe `checks-box` (`pnpm verify drive web --box`): it starts a Codex session
  on `verify-fixture` that writes three scripts, runs a test twice, a typecheck, a lint that fails
  and `ls`, then edits README.md; it opens `/sessions/<id>/checks`, the tile's "+", and 390px, then
  lays fixtures over that session's record reads: earlier history unread with a check Claude ran
  through Bash, an empty record, the record being read, and a failed read with Try again; then it
  stops the session. Locally, the CLI batch `checks-sessions.json` (a `sleep` session in
  `checks-ws`) and the recipe `checks` draw the same states from fixtures alone.
- **See:** each step's note in the recipe's `steps.log`: the Checks tab showing with its fact ("1
  failed"), one row per command, newest first, `ls` not among them and the test once, each with what
  it is, how it ended and the checkpoint it ran after ("Lint failed after checkpoint N"), the
  command, Codex's exit code and how long it took; "No check ran after the last edit."; Checks
  between Change and Preview in the "+" menu; no sideways scroll at 390px. From the fixtures:
  Claude's run reading "The record doesn't hold how it ended.", Read earlier history, the empty
  line, "Reading the record…", and "This didn't load." with Try again bringing the list back.
- **Mode:** `scripted` (recipes/checks-box.mjs, recipes/checks.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/views/checks-view.tsx`, `apps/web/src/lib/checks.ts`

### session-page.new-web-record

- **Map:** review-change.md `review-checkpoint-mark`
- **Needs:** either; one Codex turn; web; `<p>`
- **Do:** Drive the recipe `record-box` (`pnpm verify drive web --box`): it starts a Codex session
  on `verify-fixture` that writes a file, runs `ls` and a command that exits 1, and edits the file
  again; it opens `/sessions/<id>/record`, filters by Commands and Checkpoints, opens the failing
  command's row, loads `/sessions/<id>#checkpoint-N` from scratch and clears the mark, marks a
  checkpoint by hand, and looks at 390px; then it lays fixtures over the session's record reads
  (earlier history unread, the record being read, a failed read with Try again into an empty record)
  and stops the session.
- **See:** each step's note in the recipe's `steps.log`: the session's messages, commands, edits and
  checkpoints newest first, each with its time, kind and checkpoint; Commands and Checkpoints
  showing only their kind; the failing command's row open with its output and "It exited with code 1
  after …"; `#checkpoint-N` moving to `/sessions/<id>/record#checkpoint-N` with "You opened
  checkpoint N from a link." and that row marked and in view; Clear the mark dropping the hash; a
  "marked by hand" checkpoint after Mark a checkpoint; no sideways scroll at 390px; "This is the
  record so far…" with Read earlier history, "Reading the record…", "This didn't load." with Try
  again, and "Nothing in the record yet…".
- **Mode:** `scripted` (recipes/record-box.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/views/record-view.tsx`,
  `apps/web/src/lib/record-rows.ts`, `apps/web/src/lib/screen-log.ts`

### session-page.new-web-screen

- **Map:** none in a feature file: the agent's screen, its log, Take over and Hand back (ADR 0020)
  were the old app's Screen tab, and are the Screen view in the web app (SLNT-1157)
- **Needs:** either; one Codex turn; web; a project whose workspace image has Screen on (else
  `verify-fixture`, and the live states are drawn by fixtures only)
- **Do:** Drive the recipe `screen-box` (`pnpm verify drive web --box`; on a local stack, `screen`,
  which turns Screen on in verify-fixture and starts a shell there): it starts a Codex session in a
  project with Screen on, opens `/sessions/<id>?view=desktop`, reads the Screen view, and when the
  screen is live takes over, hands back and opens full screen; then it lays fixtures over
  `screens.read` and `screens.log` (no screen, starting, didn't start, stopped with the session, and
  a live screen the viewer can't reach, with Reconnect), looks at 390px and stops the session.
- **See:** each step's note in the recipe's `steps.log`: `?view=desktop` moving to
  `/sessions/<id>/screen` with the Screen tab selected; a live screen's bar ("Codex has input ·
  You're watching", "Display :N · W × H", Full screen, Take over), "You have input · Codex waits
  until you hand back" after Take over and back after Hand back, the panel full screen; the screen
  log newest first with its frames; "No screen in this workspace.", "Starting the screen…", "The
  screen didn't start." with Try again, "The screen stopped with the session." with Resume session,
  and "Mend couldn't reach the screen." with Reconnect; no sideways scroll at 390px.
- **Mode:** `scripted` (recipes/screen-box.mjs, recipes/screen.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/workspace/views/screen-view.tsx`,
  `apps/web/src/components/workspace/views/screen-viewer.ts`, `apps/web/src/lib/screen-state.ts`,
  `apps/web/src/lib/screen-rtc.ts`, `apps/web/src/lib/screen-socket.ts`

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

### session-page.new-web-checkpoint-lines

- **Map:** start-session.md `session-page`
- **Needs:** either; web; `verify-fixture`
- **Do:** Run the CLI batch `checkpoints-sessions.json` (three `mend run` sessions in the worktree
  `ckpt-turns`, one after another: the first writes two files, the second only reads them, the third
  changes one), then drive the recipe `checkpoints`. It lays one conversation of three turns over
  the worktree's real checkpoints, a turn inside each run, and reads it with one, two and three
  turns held; it hovers the last checkpoint line, opens it from the keyboard, follows Open in
  Record, then Show changes, and taps the line at 390px.
- **See:** no checkpoint line above the first message; one line after the first turn,
  `Checkpoint · 2 files changed`; none after the turn that changed nothing;
  `Checkpoint · 1 file changed` after the third. Hovering, Enter or a tap opens the line's details:
  `Checkpoint N` with its short sha, "When this turn ended, Mend saved a copy of the files in this
  worktree…", the changed file `NOTES.md`, `Show changes`, `Open in Record` and
  `Go back to this checkpoint…` (the owner's; `start-session.go-back` and
  `review-change.new-web-go-back` use it). Open in Record lands on
  `/sessions/<id>/record#checkpoint-N`, whose Checkpoints filter still lists every checkpoint; Show
  changes opens `/sessions/<id>/change` over that turn's checkpoints with `NOTES.md` in it; no
  sideways scroll at 390px.
- **Mode:** `scripted` (recipes/checkpoints.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/session/checkpoint-line.tsx`,
  `apps/web/src/lib/turn-checkpoints.ts`

### start-session.go-back

- **Map:** review-change.md `review-go-back`
- **Needs:** either; real turn (codex); web and CLI; `<p>`
- **Do:**
  `M codex "Create a file named BACK.md containing the one line: first. Change nothing else." --name main-run-back-<sha8> --project <p> --effort low --detach --conversation --json`,
  then `M wait <id> --turn --timeout 8m`; the moment it returns,
  `M message <id> --queue -- "Replace the line in BACK.md with: second. Change nothing else."` and
  wait again. Read each turn's checkpoint, the one that names the turn (`turnId` in
  `GET /api/sessions/<id>`'s checkpoints), with `M diff <id> --to <its id>`. On `/sessions/<id>`,
  send `Run sleep 60 in the shell, then reply done.` and, while that turn works, open the first
  turn's checkpoint line, choose `Go back to this checkpoint…`, then `Go back`. Wait for the turn,
  and do the same again. Send
  `Before my message, did Mend tell you anything about this worktree's files? Say what in one sentence, then reply with the contents of BACK.md.`
  and wait. Then open the line `Went back to checkpoint N`, choose `Go back to checkpoint M…`, then
  `Go back`; open `/sessions/<id>/change`.
- **See:** each of the two turns has a checkpoint that names it, neither marked `unconfirmed`, and
  BACK.md reads `first` at the first turn's and `second` at the second's (SLNT-1263: a turn's
  checkpoint holds that turn's edits, never the turn before's); the conversation shows a line
  `Checkpoint · 1 file changed` after each of the two turns, each opening its own turn's checkpoint
  number; while the turn works, the dialog says
  `An agent in this worktree is working. Stop its turn or wait for it to end, then try again.` and
  nothing changes; after it, the toast
  `Went back to checkpoint N. Your files from before are checkpoint M.` and the line
  `Went back to checkpoint N`; the agent's reply says Mend told it the files went back to checkpoint
  N, and reads `first`; the conversation shows the person's message as they wrote it, without the
  note; after the undo, the Change view shows BACK.md reading `second`.
- **Mode:** `agent`
- **Box-only:** `real-agent-turn`
- **Areas:** `apps/web/src/components/session/go-back-dialog.tsx`,
  `apps/web/src/components/session/restore-line.tsx`, `apps/web/src/lib/checkpoint-restores.ts`,
  `packages/sessions/src/checkpoint-restore.ts`,
  `packages/domain/src/workbench/checkpoint-restore.ts`,
  `packages/domain/src/workbench/checkpoint.ts`

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
- **Areas:** `apps/web/src/`, `apps/api/src/`, `packages/sessions/`

### start-session.web-write

- **Map:** start-session.md `session-page`
- **Needs:** Boat; real turn (codex); web; `start-session.composer` (its session)
- **Do:** On `/sessions/<id>` for the session `start-session.composer` started, in the composer
  under its conversation (the field `Message Codex`): send
  `Reply with the single word pong and change nothing.` and wait for the turn. Send
  `Run the shell command sleep 45, then reply with the single word slept.`; while that turn runs,
  send `Add the word steered after slept.` and wait for the turn. Send
  `Run the shell command sleep 600, then reply with the word done.`, and once the turn shows its
  first step (the `sleep 600` command), choose `Stop turn` once.
- **See:** each message shows in the conversation as soon as it is sent, and the field empties; the
  first is answered `pong`; the one sent while the turn ran is dashed and reads
  `Sent into this turn. Codex reads it when its current step finishes.` until Codex takes it into
  the turn (Codex 0.160.1 records it within a second, while `sleep 45` still runs; the model reads
  it in its next request); from then, while the turn still runs, it reads as any sent message
  (solid, nothing under it but who and when), sits below the step Codex had started when it was sent
  and above what Codex did after taking it, and starts no turn of its own
  (`start-session.new-web-steer-taken` drives this part with a recipe); after `Stop turn` that
  turn's steps read `Stopped after <duration> <n> steps`, followed by
  `This turn was stopped at <hh:mm>. What Codex changed before then is kept, and the workspace is still running.`,
  and the session's tab is named `<session name>, Replied` (the visible text is the name; `Replied`
  is in its accessible name).
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/components/session/composer.tsx`, `apps/web/src/lib/outbox.ts`,
  `apps/web/src/lib/session-composer.ts`, `apps/web/src/lib/conversation-rows.ts`,
  `apps/web/src/components/session/conversation-tile.tsx`

### start-session.antigravity-conversation

- **Map:** start-session.md `start-antigravity-conversation`
- **Needs:** Boat; real turn (antigravity); web; the owner's Antigravity login;
  `start-session.boat-run` (its worktree)
- **Do:** On `/`, in the form `New session`: project `<p>`, worktree `main-run-run-<sha8>`, harness
  Antigravity, the prompt `Run the shell command echo hi, then reply with the single word done.`,
  then `Start`. Wait for the turn with `M wait <id> --turn --timeout 8m`. In the session's composer
  (the field `Message Antigravity`), open the model menu, pick another model and
  `Ask before acting`, and send
  `Run the shell command echo again, then reply with the single word twice.`
- **See:** the browser lands on `/sessions/<id>` for an antigravity session in conversation mode;
  the first turn shows the `echo hi` command with its output and the reply `done`, and asks nothing;
  the second turn shows an approval for `echo again` before it runs it; once approved it completes
  with `twice`, and the model menu reads the model picked for it.
- **Waiting on:** SLNT-1276 · the box's data holds no Antigravity login, so the session does not
  start. Nothing else of this flow can be seen without one.
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `packages/agent-protocol/src/antigravity.ts`, `apps/t3-gateway/src/server-config.ts`

### start-session.new-web-steer-taken

- **Map:** start-session.md `session-page`
- **Needs:** real turn (codex); web; the project `verify-fixture`
- **Do:** Drive the recipe `steer-taken-box` (`pnpm verify drive web --box`): it starts a Codex
  session in `verify-fixture` from the New session composer, asks it to run `sleep 30`, then
  `sleep 40`, then reply `slept`, and once Codex runs `sleep 30`, sends
  `When you reply, add the word steered after slept.` from the composer (its button reads Steer).
  Stop the session with `M stop <id8>` once it ends.
- **See:** the second message shows in the conversation at once. Until Codex takes it, it is dashed
  with `Sent into this turn. Codex reads it when its current step finishes.` under it (Codex 0.160.1
  takes it within a second, so the page may not get to show this). While turn 2 still runs (Stop
  turn shown) it is solid with only `You · <time>` under it. It sits below the `sleep 30` step and
  above `sleep 40`, Codex replies `slept steered`, no turn starts for it, and after the turn ends
  and after a reload it stays solid with nothing under it but who and when. It fails (SLNT-1234) if
  the message still reads as waiting when turn 2 ends, or reads `Codex read this during its turn`:
  the recipe stops with "the message read as waiting until turn 2 ended".
- **Mode:** `scripted` (recipes/steer-taken-box.mjs)
- **Box-only:** `real-agent-turn`
- **Areas:** `apps/web/src/lib/session-composer.ts`, `apps/web/src/lib/conversation-rows.ts`,
  `apps/web/src/components/session/conversation-tile.tsx`,
  `packages/agent-conversation/src/feed.ts`, `packages/agent-protocol/src/codex.ts`,
  `packages/agent-protocol/src/claude-turn.ts`

### start-session.memory-limit

- **Map:** start-session.md `session-memory-limit`
- **Needs:** real turn (codex); web; the project `verify-fixture`; a copy without Boat (its sessions
  run on Docker)
- **Do:** Drive the recipe `memory-limit-box` (`pnpm verify drive web --box`): it starts a Codex
  session in `verify-fixture` that replies `ready`, then a second one told to run
  `head -c 4608M /dev/zero | tail | wc -c` once and reply `finished`, then sends the first one
  `Reply with the single word pong, and nothing else.` Stop both with `M stop <id8>` once it ends.
- **See:** the command is stopped inside its workspace (a copy has 8 GB, so the workspace's limit is
  a little under 4 GiB and the command holds 4.5 GiB). Under that turn:
  `The workspace hit its memory limit` and
  `The workspace reached its memory limit of <n> GiB, and the kernel stopped a process in it, most likely a command Codex ran. Codex is still running.`,
  once, and still once after a reload. `/api/health` answers 200 throughout, and the first session
  answers `pong` with no such line. It fails (SLNT-1233) on a build whose workspaces have no memory
  limit, or that says nothing when one is reached: the recipe stops with "nothing says the workspace
  hit its memory limit".
- **Mode:** `scripted` (recipes/memory-limit-box.mjs)
- **Box-only:** `real-agent-turn`
- **Areas:** `packages/sessions/src/workspace-memory.ts`,
  `packages/domain/src/workbench/memory-limit.ts`, `apps/web/src/components/session/agent-turn.tsx`

### start-session.new-web-streaming

- **Map:** start-session.md `session-page`
- **Needs:** real turn (codex); web; the project `verify-fixture`
- **Do:** Drive the recipe `streaming-box` with `STREAM_OUT` set to `<scratch>`: it starts a Codex
  session in `verify-fixture` from the New session composer, then asks for three replies of about
  500 words with headings, a list and a code block, the second with 100ms more latency on every
  request, and in the third scrolls up mid-reply, waits, and scrolls back to the end. Stop the
  session with `M stop <id8>` once it ends.
- **See:** each reply's words appear at a steady pace, a word at a time, never a sentence or more at
  once: the notes' `stepChars` median is under 15 and `gapMs` median under 50 (as each update lands,
  they read about 70 characters every 300 ms); each new paragraph, list or code block fades in; the
  reply is whole within about a second of the turn ending. Turn 4's note reads the same scroll
  position 3 seconds after scrolling up, and 0px from the end both right after scrolling back and 3
  seconds later. Reopening the session shows every reply whole at once, with nothing fading.
- **Mode:** `scripted`
- **Box-only:** `real-agent-turn`
- **Areas:** `apps/web/src/components/session/rich-text.tsx`,
  `apps/web/src/components/session/agent-turn.tsx`, `apps/web/src/lib/text-reveal.ts`,
  `apps/web/src/lib/markdown-blocks.ts`

### start-session.new-web-code-colours

- **Map:** start-session.md `session-page` (an agent's reply, its code blocks in syntax colours),
  skills.md `skills-web-edit` (a skill's file and its Preview, their code in syntax colours)
- **Needs:** either; no turn; web and CLI; the project `verify-fixture`
- **Do:** Run the CLI batch `code-colours-sessions.json`, then drive the recipe `code-colours`. It
  lays a reply with a TypeScript block, a shell block, a block in an unknown language and one with
  none over the session's reads, reads each block's colours in light and dark, grows the reply a few
  lines at a time as a streamed one does, then makes a skill with a TypeScript block in its
  `SKILL.md` and `scripts/check.sh` beside it, reads both and the editor's Preview, and removes it.
- **See:** each step's note in the recipe's `steps.log`: `export` in the keyword colour (a different
  computed colour in dark), the comment muted, the shell block's string in the string colour, and no
  colours in the other two blocks (the recipe fails otherwise); while the reply grows, every
  coloured piece of its first line keeps its node and the lines that stream in are coloured; the
  skill's `await` in the keyword colour with its Markdown text plain, the script's string coloured,
  and the Preview's block coloured.
- **Mode:** `scripted` (.agents/skills/verify/recipes/code-colours.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/code-text.tsx`, `apps/web/src/lib/code-highlighter.ts`,
  `apps/web/src/lib/code-theme.ts`, `apps/web/src/lib/code-fences.ts`,
  `apps/web/src/components/session/rich-text.tsx`, `apps/web/src/components/skills/skill-panel.tsx`,
  `apps/web/src/components/skills/code-lines.tsx`

### start-session.new-web-instant-start

- **Map:** start-session.md `start-composer`; now-and-sessions.md `home-composer`
- **Needs:** Boat; real turn (codex); web; `<p>`, a worktree in it
- **Do:** On `/`, write `Reply with the single word ready and change nothing.` and press Enter;
  while the session starts, send `Then reply with the word again.` from its composer, and the moment
  the address moves to the session's id send `And say done.`; then, while it still reads Starting,
  go to Projects and wait there a minute before coming back. Then, on `<p>`'s Worktrees tab, open a
  worktree's "…", New session in this worktree, Codex, and once it has started send `hi` from its
  composer, wait a minute, then send `tell me a joke`. Drive the recipe `instant-start` for the same
  steps against a stack, with a refused start and the phone width.
- **See:** the session's page opens at once at `/sessions/starting-…` with the message,
  `Getting the session ready`, and a Starting row under Running; the composer is open and reads
  `Codex is starting. What you send now goes to it once it's ready.`, never `runs in a terminal`;
  the address moves to the session's id in place; the second and third messages wait
  (`Waits for Codex to start.`) and both are sent after the opening turn, in order, while you are on
  Projects (back on the session, Codex has answered all three and nothing reads
  `Waits for Codex to start.` or `Not sent`); the menu's start opens its page at once and shows no
  red line while it starts; nothing on the page reads `per-person users` or `takes one person`. The
  session started from the worktree's menu, with no message, reads `New session` in its row, its tab
  and the project's Sessions table, never the worktree's name or its other session's name; once sent
  `hi` it reads `hi`, and a minute later still `hi`, never `placeholder`, `untitled`, `new session`
  or the project's name as a name (SLNT-1230); once sent `tell me a joke` within about a minute it
  reads a name Mend made from the joke, different from the worktree's other session.
- **Mode:** `agent`
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/lib/start-session.ts`, `apps/web/src/lib/pending-starts.ts`,
  `apps/web/src/components/new-session/instant-start.ts`,
  `apps/web/src/components/session/starting-session.tsx`, `apps/web/src/lib/starting-line.ts`,
  `apps/web/src/lib/project-starts.ts`, `apps/web/src/lib/session-title.ts`,
  `apps/api/src/session-naming.ts`

### start-session.new-web-impatient-start

- **Map:** start-session.md `start-composer`, `session-page`
- **Needs:** real turn (codex); web; the project `verify-fixture`
- **Do:** Drive the recipe `impatient-start-box` (`pnpm verify drive web --box`). It starts a Codex
  session in `verify-fixture` from the New session composer with
  `Reply with the single word ready, and nothing else.`, and while it still reads Starting sends
  `Then reply with the single word again, and nothing else.` from its composer. As soon as Mend has
  answered for those words it closes the tab (the page leaves the app), then opens the session in a
  new tab. Then it starts a second session with
  `Reply with the single word second, and nothing else.` and reloads its page the moment the address
  moves to the session's id. Stop both sessions with `M stop <id8>` once they end.
- **See:** before the tab closes, the second message reads `Waits for Codex to start.` (or nothing,
  once Codex took it), never `Sending…`. In the new tab both messages are there, in order. Codex
  replies `ready`, then `again`, and neither message reads `Waits for` or `Not sent`. After the
  reload during the second start, the page still reads `Getting the session ready…`, the first
  message shows within 5 seconds, and the conversation is titled after it or with a name Mend made,
  never `New session`. Codex then replies `second`. It fails (SLNT-1237) if the new tab never shows
  the second message, which then lived only in the closed tab: the recipe stops with "the message
  sent while it started isn't there in a new tab". It also fails if the reload shows no first
  message, or `New session`.
- **Mode:** `scripted` (recipes/impatient-start-box.mjs)
- **Box-only:** `real-agent-turn`
- **Areas:** `apps/web/src/lib/start-session.ts`, `apps/web/src/lib/outbox.ts`,
  `apps/web/src/components/new-session/instant-start.ts`,
  `apps/web/src/components/session/composer.tsx`,
  `apps/web/src/components/session/conversation-tile.tsx`, `packages/sessions/src/protocol-host.ts`,
  `packages/db/src/repos/agent-conversation.ts`, `docs/formal/turn-dispatch/`

### start-session.new-web-cut-short-start

- **Map:** start-session.md `start-composer`
- **Needs:** real turn (codex); web; the project `verify-fixture`
- **Do:** Drive the recipe `cut-short-start` (`pnpm verify drive web --box`). From the New session
  composer it starts a Codex session in `verify-fixture` with
  `Change nothing. Reply with closed <time>.`, lets that start reach Mend, and closes the tab before
  Mend's answer reaches the page. It then starts a second with
  `Change nothing. Reply with reloaded <time>.` and reloads the page the same way. Stop both
  sessions with `M stop <id8>` (the recipe prints their ids).
- **See:** the closed tab's session launches: within two minutes it has left Starting, and its
  conversation and its page hold the first message. The reloaded page moves to `/sessions/<id>`, the
  session Mend made, and shows its first message; it never stays on `/` with an empty composer. It
  fails (SLNT-1239) on a build whose page sent the launch as a second request once Mend answered the
  first: the recipe stops with "never launched" for the closed tab and "an empty composer" for the
  reload.
- **Mode:** `scripted` (recipes/cut-short-start.mjs)
- **Box:** after cut-over
- **Areas:** `apps/web/src/lib/start-session.ts`, `apps/web/src/lib/pending-starts.ts`,
  `apps/web/src/lib/project-starts.ts`, `apps/web/src/components/new-session/instant-start.ts`,
  `apps/web/src/components/session/starting-session.tsx`, `apps/api/src/session-starts.ts`,
  `apps/api/src/routes/session-starts.ts`, `packages/db/src/repos/session-starts.ts`

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
- **Needs:** Docker; no turn; CLI; a copy without Boat (lane B), where a new worktree runs on Docker
- **Do:**
  `M run --project <p> --name main-run-docker-<sha8> -- sh -c 'date -u > MAIN-RUN-DOCKER.md'`. A new
  worktree each run: the fixture `main-run-docker`'s earlier captures stayed in VM 131's blob store,
  so a session in it fails at boot on a check VM (20 Nov, `BlobNotFoundError`).
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
- **Do:** Open the turn's session's change at `/sessions/<id>/change` (and `/changes/<id>`, which
  opens the same change), and read its diff.
- **See:** the Change view's file list (the heading `Files …`) names `MAIN-RUN.md`, and its diff
  shows the added line `seen`; either path is seen.
- **Mode:** `agent` (the old app's `recipes/session-review.mjs` went at cut-over)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/web/src/components/change/`,
  `apps/web/src/routes/_inbox.sessions.$sessionId.$view.tsx`,
  `apps/web/src/routes/_inbox.changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

### review-change.new-web-change

- **Map:** review-change.md `review-open`, `review-diff`, `review-files`, `review-pinned`;
  repositories-in-session.md `repo-review-line`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `change-sessions.json` (worktrees `change-small`, written by two
  sessions, `change-big` and `change-empty`, each by `mend run`), then drive the recipe `change`;
  when its `steps.log` reads "waiting for the worktree to change", run the batch
  `change-moves.json`. It opens `/sessions/<id>/change` and `/changes/<id>#land`, picks a file,
  switches to Split and reloads, marks a file viewed and reloads, shows the new version after the
  files change, reads the big change and filters it, splits the Change tab beside the conversation,
  and looks at 390px.
- **See:** each step's note in the recipe's `steps.log`: the Change tab focused with its +/− counts,
  "This workspace's change, from 2 sessions.", Split and the viewed mark kept over a reload, the
  banner "Files changed since you opened this." and the changed file unviewed after Show the new
  version, the lock file folded as generated, fewer drawn lines than the 3,000-line file holds,
  `/changes/<id>#land` arriving at `/sessions/<id>/change#land`, and the narrow tile's file picker.
- **Mode:** `scripted` (recipes/change.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/`, `apps/web/src/components/workspace/view-facts.ts`,
  `apps/web/src/routes/_inbox.changes.$changeId.tsx`, `apps/web/src/lib/change-files.ts`,
  `apps/web/src/lib/review-open.ts`, `apps/web/src/lib/viewed-files.ts`

### review-change.new-web-go-back

- **Map:** review-change.md `review-go-back`
- **Needs:** either; no turn; web and CLI; `verify-fixture`
- **Do:** Run the CLI batch `go-back-sessions.json` (two `mend run` sessions in the worktree
  `go-back`: the first writes BACK.md, the second rewrites it and adds LATER.md), drive the recipe
  `go-back`, then run the batch `go-back-files.json`. The recipe goes back to the first run's last
  checkpoint from the Change tab's range picker, reads the result back from the stack, then undoes
  it from the line in the conversation.
- **See:** the dialog `Go back to a checkpoint?` naming the checkpoint and saying Mend saves the
  files first; the toast `Went back to checkpoint N. Your files from before are checkpoint M.`; the
  stack's checkpoints `restore-save` then `restore`, the latter's files matching checkpoint N; the
  line `Went back to checkpoint N` with `Go back to checkpoint M…`; after the undo, both lines and
  the files matching checkpoint M; the last batch prints `BACK.md: second` and `LATER.md is there`;
  no sideways scroll at 390px.
- **Mode:** `scripted` (recipes/go-back.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/session/go-back-dialog.tsx`,
  `apps/web/src/components/session/restore-line.tsx`,
  `apps/web/src/components/change/range-picker.tsx`, `apps/web/src/lib/checkpoint-restores.ts`,
  `packages/sessions/src/checkpoint-restore.ts`, `packages/db/src/repos/checkpoints.ts`

### review-change.new-web-tour

- **Map:** review-change.md `review-machine-pass` (the description and tour); mobile.md (the tour on
  the phone)
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `change-sessions.json`, then drive the recipe `tour`. It waits for
  Mend's own pass on `change-small` (written on the box, failed on a local stack) and asks again;
  then lays a written description and a four-stop tour over the change, walks the tour forwards and
  back, opens a link into the session, ends the tour, folds the description on a later look, shows
  out of date, no description, being written and a login failure, then the narrow tile beside the
  conversation and 390px.
- **See:** each step's note in the recipe's `steps.log`: Mend's real outcome (the description "Mend
  wrote this from checkpoint N", or "Mend couldn't write the description." with its reason and Try
  again); "How the session got there" and "Tour · 4 stops" with Start tour; the Tour section above
  Files; stop 1's note between rows with the bar on its lines only; "Mend's reading of the code.
  Nothing in the session backs this up." on stop 2; stop 3 under its file's header; stop 4 under the
  description with Finish tour; End tour back at the same scroll; a record link focusing the
  session's conversation tab; Show more; Write again; the narrow tile's picker on the stop's file;
  44px Previous and Next on the phone.
- **Mode:** `scripted` (recipes/tour.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/change-description.tsx`,
  `apps/web/src/components/change/change-tour.tsx`, `apps/web/src/components/change/tour-stop.tsx`,
  `apps/web/src/lib/tour.ts`

### review-change.new-web-comments

- **Map:** review-change.md `review-inline-comment`, `review-change-comment`,
  `review-comment-state`, `review-machine-pass` (Read this change, Suggest fixes);
  send-review-back.md `send-open`, `send-select`, `send-edit`, `send-deliver`, `send-pending`,
  `send-sent-state`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `change-sessions.json`, then drive the recipe `comments`. On
  `change-small` it comments on one line (a click on its number), on a range (a drag across
  numbers), on lines typed from a file's "…", and on the whole change; resolves, reopens and
  dismisses; asks Mend to read the change and suggest fixes; lays Mend's drafts over the comments
  and adds one, then removes it; marks every file viewed; chooses and edits before sending; sends
  (the `mend run` session refuses it); then shows a failed, a pending and a delivered send from the
  server's answers, the sent state with a second look, and 390px.
- **See:** each step's note in the recipe's `steps.log`: the box "Comment on <file>, line 20" and
  "lines 12–15"; each comment under its last line as "Not sent · line N"; "On the whole change" over
  the diffs; "Send 4 comments to Claude Code" with "Claude Code has finished, so it starts on your
  comments as soon as you send them."; "Resolved" and "Dismissed" folding a comment, Send counting
  down; Mend's real pass lines; "Draft from Mend" with its suggested replacement, Add to comments
  and Dismiss, then "from Mend's draft" and Remove; "Your review" listing what goes; "Comments to
  send · 2 of 3" and the message written again when one is unchecked; "Mend couldn't send your
  comments." with Try again; "Your comments are saved, not sent yet."; the conversation tab after a
  delivered send; "Sent" and "1 comment resolved, 2 open."; the phone's "Send N comments" and
  Comments sheet.
- **Mode:** `scripted` (recipes/comments.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/change-comments.tsx`,
  `apps/web/src/components/change/review-comment.tsx`,
  `apps/web/src/components/change/send-dialog.tsx`, `apps/web/src/lib/review-comments.ts`

### review-change.new-web-second-look

- **Map:** review-change.md `review-comment-state` (Second look: a review since your last review,
  the agent's answer under each sent comment, replies)
- **Needs:** either; no turn on a local stack, a real codex turn on the box; web and CLI; `<p>`
- **Do:** Run the CLI batch `change-sessions.json`, then drive the recipe `second-look`. On
  `change-small` it opens the range picker before anyone has sent comments, comments on line 20 and
  on the whole change, lays where you last reviewed and Claude Code's answers over the real
  comments, follows "Show changes since your last review", picks "Up to a checkpoint" and compares
  one checkpoint with itself, replies and resolves, and shows 390px and a review that fails to open.
  On the box, `second-look-ui-box` sends real comments to codex through Send and reads its answers
  in the view.
- **See:** each step's note in the recipe's `steps.log`: no "Since your last review" in the picker
  before a send; "Claude Code finished working on your 2 comments." with "Show changes since your
  last review"; the chip "Since your last review · checkpoint N to M" and "N files changed since
  your last review."; each comment's answer with "Changed the code at checkpoint M" or no outcome on
  the whole change; "Up to checkpoint N"; "Nothing changed between these checkpoints" with "Show the
  whole change"; "Your reply goes to Claude Code with your next comments." then the reply "Not sent"
  and "Send 1 reply to Claude Code"; a resolved comment folded with what the agent did; the phone's
  "Show changes" sheet.
- **Mode:** `scripted` (recipes/second-look.mjs; recipes/second-look-ui-box.mjs on the box)
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/range-picker.tsx`, `apps/web/src/lib/review-range.ts`,
  `apps/web/src/lib/review-open.ts`

### review-change.new-web-review-reads

- **Map:** review-change.md `review-diff` (the diff's code in syntax colours),
  `review-comment-state` (Second look: an "Up to a checkpoint" range with nothing in it)
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `change-sessions.json`, then drive the recipe `review-reads`. On
  `change-small` it reads the colour each token of `src/payments/retry.ts` is drawn in, in light and
  dark, then picks "Up to a checkpoint" with checkpoint 1, which holds the base's files, and goes
  back to the whole change through the range picker.
- **See:** each step's note in the recipe's `steps.log`: `import`, `"./charge"` and `lastError` in
  three different computed colours, light and dark (the recipe fails when any two match); "Nothing
  changed up to checkpoint 1" under the toolbar with the range picker still there (it fails when the
  picker is gone); the picker back at the whole change with the diffs drawn.
- **Mode:** `scripted` (.agents/skills/verify/recipes/review-reads.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/change-diffs.tsx`,
  `apps/web/src/components/change/change-view.tsx`,
  `apps/web/src/components/change/range-picker.tsx`, `apps/web/src/styles.css`,
  `packages/ui/src/styles/globals.css`

### review-change.web-comments

- **Map:** review-change.md `review-change-comment`, `review-comment-state`,
  `review-checkpoint-mark`, `review-pinned`, `review-files`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On `/sessions/<id>/change` for the run session (`Open a view → Change`), choose
  `Comment on the whole change`, type a comment and choose `Add comment`. On its card under
  `On the whole change` choose `Dismiss`; then `Show it` and `Reopen` on the card. Look in the
  session tab's and the workspace's menus, and on its Record view, for `Mark a checkpoint`. Reload
  the change. Leave the comment open for the next flow.
- **See:** under `Comments 1 not sent`, the row `Whole change · <name>` over the comment, and under
  `On the whole change` its card `<name> Not sent` with `Reply`, `Resolve` and `Dismiss`; after
  `Dismiss`, `Comments 0 open`, `You dismissed 1 comment.` with `Show it`, which shows the card
  reading `Dismissed` with `Reopen`; after `Reopen`, the row back under `Comments 1 not sent` with
  no `Dismissed` and no `You dismissed`; `Mark a checkpoint`, and after it a new checkpoint line
  marked by hand; the `<sha A> → <sha B> · observed at capture <n>` line unchanged on reload;
  `M sessions --project <p> --all --json` shows the session's `review.openComments` as `1`.
- **Waiting on:** SLNT-1270 · `Mark a checkpoint` on a finished session: the shipped app offers it
  only on the Record view of a session whose agent is live, and the run session has ended. The rest
  of the See line is checked; the missing mark is known.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.changes.$changeId.tsx`,
  `apps/web/src/components/change/change-view.tsx`,
  `apps/web/src/components/change/change-comments.tsx`, `apps/api/src/`, `packages/store/`

### send-review-back.deliver

- **Map:** send-review-back.md `send-open`, `send-select`, `send-deliver`, `send-sent-state`
- **Needs:** Boat; real turn (codex); web; `attach-resume.boat-stop-resume` (the turn's session,
  stopped)
- **Do:** On the turn's change (`/sessions/<id>/change`), choose `Comment on the whole change`, type
  `Add a second line to MAIN-RUN.md reading: reviewed.` and choose `Add comment`; mark the files
  viewed; in `Your review` choose `Choose and edit before sending…`, then `Send 1 comment` in the
  dialog `Send to Codex`. Wait for the turn with `M wait <id> --turn --timeout 8m`.
- **See:** the comment under `On the whole change`; the toolbar's `Send 1 comment to Codex`; the
  dialog `Send to Codex` with that comment checked; then the comment reads `Sent`; `M wait` exits
  `0`; the change shows `MAIN-RUN.md` with the lines `seen` and `reviewed`.
- **Mode:** `agent` · the verify skill's `recipes/comments-box.mjs` drives the same send on a
  session of its own
- **Box-only:** `boat`, `real-agent-turn`
- **Areas:** `apps/web/src/components/change/`, `apps/api/src/`, `packages/sessions/`

### land-change.panel-read

- **Map:** land-change.md `land-session-line`, `land-web` (the panel read; nothing pushed)
- **Needs:** either; no turn; web; `start-session.boat-run`
- **Do:** On the run session's page choose `Open a view → Details` and read the `Pull request` row
  in `Workspace`. Choose its `Land…`, which opens `/sessions/<id>/change#land`, read the dialog
  `Land change`, and choose `Cancel` without pushing.
- **See:** `Pull request` reads `None yet` with the link `Land…` and no landing line under it; the
  dialog `Land change` in one of two forms (record which): for a GitHub origin,
  `Mend pushes the branch to origin and opens a pull request on GitHub. It doesn't merge the pull request.`,
  `Pull request base` `<base>`, `Observed` `nothing pushed from Mend yet` with `Check GitHub`, the
  field `Pull request title` and the button `Push and open pull request`; for another origin,
  `Pull request` `No pull request: origin is on <host>, not GitHub.` and the button
  `Push to origin`; nothing pushed (`None yet` still there after `Cancel`).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/`, `apps/api/src/landing-state.ts`, `packages/landing/`

### land-change.web-push

- **Map:** land-change.md `land-web` (submit, a non-GitHub origin), `land-session-line`,
  `land-preview` (its absence), `land-observe` (`Check origin`)
- **Needs:** either; no turn; CLI, web (the owner's browser) and `git` on the box over
  `MEND_VERIFY_BOX_SSH`; `<land>`
- **Do:**
  `M run --project <land> --name main-run-land-<sha8> -- sh -c 'printf "landed\n" > LAND.md'`;
  record its session id as this run's `land session`. On `/sessions/<id>` choose
  `Open a view → Details` and read the `Pull request` row in `Workspace`. On `/sessions/<id>/change`
  choose `Land…` in the toolbar, read the dialog `Land change`, then choose `Push to origin`. Choose
  the toolbar's `What landed`, and in its dialog choose `Check origin`. Go back to `/sessions/<id>`
  and read the conversation and `Details` again. On the box,
  `git --git-dir <git dir>/land.git log --oneline -1 <remote branch>` and
  `git --git-dir <git dir>/land.git show <remote branch>:LAND.md`. Nothing to restore: the pushed
  branch stays for `land-change.cli-again`.
- **See:** before the push, Details' `Pull request` reads `None yet` with `Land…` and no line under
  it, and the Change toolbar has `Land…` and no `is on origin` line; the dialog `Land change` reads
  `Mend pushes the branch to origin.`, `Push` `<branch> to <git host>:<port>/land`, `Pull request`
  `No pull request: origin is on <git host>, not GitHub.` and `Change`
  `The whole change from main to checkpoint <n>, …`, with the button `Push to origin` and neither
  `Pull request title` nor `Preview`; after the push the toolbar reads
  `Checkpoint <m> is on origin as <remote branch>.` with `What landed` where `Land…` was;
  `What landed` reads `pushed · <remote branch> · <sha> · observed`, and `Check origin` adds
  `origin <remote branch> at <sha> · holds the landed commit · checked …`; the conversation shows
  `Checkpoint <m> pushed to origin as <remote branch> · <sha>`; Details' `Pull request` now has
  `pushed · <remote branch> · <sha> · observed` under `None yet`; the box's `log` names the same
  `<sha>` and `show` prints `landed`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/change/land-dialog.tsx`, `apps/api/src/landing-state.ts`,
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
  `apps/web/src/components/change/land-dialog.tsx`, `apps/cli/src/landing.ts`,
  `packages/domain/src/workbench/landing-rules.ts`

### land-change.new-web-land

- **Map:** land-change.md `land-web`, `land-preview`, `land-again`, `land-refused`, `land-check`,
  `land-observe`
- **Needs:** either; no turn; web and CLI; `<p>`
- **Do:** Run the CLI batch `land-sessions.json` (the worktree `land-retry`, written by `mend run`,
  and a second session in it that keeps running), then drive the recipe `land`. It opens
  `/sessions/<id>/change`, chooses `Land…`, chooses `Push to origin` against the project's origin,
  then `Check origin`; opens the dialog from the workspace "…" and from `/changes/<id>#land`; then
  lays recorded answers over the landing reads for a GitHub origin: the title and description with
  `Preview`, the view after landing, the conversation's landing line, `Land again…` with
  `Update pull request #412`, GitHub refusing the push, and the phone's sheet. It stops the running
  session at the end.
- **See:** each step's note in the recipe's `steps.log`: `Land…` in the Change view's toolbar; the
  dialog `Land change` naming `Write tests for retry is still editing`; on an origin that is not
  GitHub, `No pull request: …` and `Push to origin`; `#land` opened by the workspace's `Land…` and
  by `/changes/<id>#land`; Preview showing your text, then Mend's section (`Summary` or no summary,
  changed files, `In Mend`); "Checkpoint N is in pull request #412." with no Land button;
  "Checkpoint N landed as pull request #412 · View pull request" in the conversation; "Checkpoint N
  isn't in pull request #412 yet." with `Land again…`; `Update pull request #412` keeping the title;
  `GitHub refused the push` with GH006's words. Two parts of the recipe are a local stack's, not
  this flow's: the push refused in git's own words with `Try again`, and a line from `Check origin`.
  They need an origin that refuses pushes, as a local stack's git fixture does, and on a check VM
  copy `verify-fixture`'s origin is GitHub: the recipe notes `differs · this origin is GitHub …`,
  `Check GitHub` answers that no GitHub account is connected, and nothing is pushed (SLNT-1298). On
  the box, `land-change.refused` sees a refused push in git's words and `Check origin` after it, and
  `land-change.web-push` sees `Check origin` holding the landed commit, both against the copy's own
  git service.
- **Mode:** `scripted` (recipes/land.mjs)
- **Box-only:** no
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
  `service restart`. While `web` runs, open `<web>/sessions/<id>/preview` in the owner's browser
  (the session's tab `Preview :8000`), select `web :8000` in `This workspace's services`, and wait
  up to 20 s for its preview line to read `reachable`. Start a second session in the worktree to
  keep the workspace running:
  `M run --project <p> --name main-run-live-<sha8> --detach --json -- sleep 1800`; record `<k8>`. In
  the owner's browser open `<web>/api/sessions/<id>/stop-preview`. Then `M stop <id8>` and
  `M stop --services <id8>`.
- **See:** the Preview tab's `This workspace's services` lists `web :8000` reading
  `Running · python3 -m http.server 8000`, and beside it
  `preview · web · reachable · observed <age>` (`42 s ago`, `2 min ago`; never `unreachable`); curl
  prints `200`; the preview reads `"workspace":"keeps-running"` naming `<k8>`'s session and listing
  `web`; `mend stop` prints `the workspace keeps running for …` and names what keeps the workspace
  up ending `· mend stop --services <id8>`; then `✓ stopped 1 service · …` and
  `no live services — …` from `service list`. `<k8>` stays running for `capture-and-save.live-stop`.
- **Mode:** `agent` · a recipe would make it cheaper (the card half)
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `apps/api/src/`, `apps/cli/src/`, `packages/network/`

## Access and identity

### sign-in.fresh-browser

- **Map:** sign-in.md `registration-closed`, `web-sign-in`, `web-sign-out`, `authorize-page`
- **Needs:** no session; no turn; web; a fresh browser context (not the saved `browser.json`)
- **Do:** In a context with no saved sign-in, open `/settings/profile`, sign in with the account
  file, open `/authorize` with no code, then `Sign out` on Profile. The saved browser state other
  flows use is untouched.
- **See:** `/login#next=%2Fsettings%2Fprofile` with the heading `Sign in` and
  `No account? Ask an owner of your organization for an invitation.`; after sign-in
  `/settings/profile`; on `/authorize`, `This code can't be used.`; after sign-out, `/login`.
- **Mode:** `agent` · the verify skill's `recipes/sign-in.mjs`, `recipes/authorize.mjs` and
  `recipes/settings.mjs` drive each part on a stack
- **Box-only:** no
- **Areas:** `packages/auth/`, `apps/web/src/routes/login.tsx`, `apps/web/src/routes/authorize.tsx`,
  `apps/web/src/lib/sign-in.ts`

### pairing-devices.mint-read

- **Map:** pairing-devices.md `pair-web`, `pair-cli`, `device-list`, `qr-render`
- **Needs:** no session; no turn; web and CLI; none
- **Do:** On Settings → Devices and access keys (`/settings/devices`) choose `Show a code` under
  `Pair a phone` and read the section; read it again at least 60 seconds later, then reload. Run
  `M pair`, `M pair --url http://not-configured.invalid`, `M qr hello`, `M qr`. Claim no code.
- **See:** under `Pair a phone`, a code `XXXX-XXXX`, the image `QR code for XXXX-XXXX`, and
  `It works once and expires at <hh:mm>, in <n> minutes. The phone reaches this server at <web>.`;
  on the second read the same `<hh:mm>` and a smaller `<n>`; after the reload, `No pairing code yet`
  and `Show a code`; `✓ pairing code …` and `  expires in 10 min · one device, once`; the `--url`
  refusal `mend: --url must exactly match one of the server's configured pairing URLs` and
  `mend: usage: mend qr <text>`, each exit `1`; under `Signed-in devices`, this CLI's device row
  reading `<device>`, `mend CLI`, its last use and its paired day.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.settings.devices.tsx`, `apps/cli/src/`, `apps/api/src/`

### provider-accounts.read

- **Map:** provider-accounts.md `accounts-list`, `doctor-lines`, `agent-logins`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M accounts`; Settings → Connected accounts read only; `M agent-logins`, then
  `M agent-logins selected` and `M agent-logins all` to restore it in the same flow.
- **See:** `codex   connected · …`; `github` and `antigravity` `connected` or `not connected`, and
  `claude` `connected`, `not connected` or `reconnect needed · the provider refused the login · …`
  (the checker's Claude login is refused, left so by the owner: SLNT-1219), each recorded as found;
  the web rows agree (including Antigravity without an API-key option); `selected · …` after the
  change and `all · …` after the restore.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/agent-logins.ts`, `apps/api/src/connections.ts`, `apps/web/src/`

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
- **Areas:** `apps/cli/src/`, `apps/web/src/routes/_inbox.settings.agent-logins.tsx`,
  `apps/api/src/`

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
- **See:** one block per harness (including `antigravity`); codex's and antigravity's blocks with
  `default` on one model, claude's and opencode's with no `default` (neither names one, by design);
  JSON `"version": 1` with the same ids, `defaultModel` set for codex and antigravity and `null` for
  claude and opencode; codex's `Model` group with its default row (`<label> default`)
  `aria-checked="true"`, and Antigravity selectable in the `Agent` menu with its seeded models and
  thinking options.
- **Waiting on:** SLNT-1270 · the web picker's codex `Model` group marks no row `default`
  (`<label> default`); the row the account will use is checked. The CLI half and the menu's groups
  are still checked; the missing `default` is known.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web/src/`, `apps/api/src/`

## Personal setup

### dotfiles.read

- **Map:** dotfiles.md `dotfiles-show`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M dotfiles`; read Settings → Dotfiles (`/settings/dotfiles`), its `Dotfiles repository`
  field and `Home files`.
- **See:** `repo …` and `snapshot …` lines (`none` or the saved values); the textbox
  `Dotfiles repository` empty when `repo` is `none` (or holding the saved URL); under `Home files`,
  `No home files yet.` when `snapshot` is `none`, or one `~/<path>` row with its size per file the
  snapshot holds.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/dotfiles.ts`, `apps/web/src/`, `apps/api/src/`

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
- **Areas:** `apps/cli/src/`, `apps/api/src/`, `apps/web/src/`

### git-author.roundtrip

- **Map:** git-author.md `git-author-show`, `git-author-set-cli`, `git-author-refused`,
  `git-author-clear`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M git-author`; when it reads `· your account's name and email`, set one with the CLI,
  reload Settings → Agent logins and Git (`/settings/agent-logins`), try the `not-an-email` refusal,
  then `M git-author --clear`. When a setting is already saved, only show it and stop.
- **See:** `✓ git author · Verify Cli <verify-cli@example.com> · your setting`; under `Git` the
  textboxes `Author name` holding `Verify Cli` and `Author email` holding `verify-cli@example.com`,
  each described `You set this.`, and the button `Use my account's name and email`; the refusal
  `mend: git author not saved · the email is not an address like you@example.com`, exit `1`; after
  the clear, `✓ git author · <account name> <account email> · your account's name and email`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/git-author.ts`, `apps/api/src/`, `apps/web/src/`

### skills.read

- **Map:** skills.md `skills-list`, `skills-push-project` (the listing)
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M skills`, `M skills --project <p>`; open `/skills`.
- **See:** the library entries or `no skills in your library — …`; the same for `<p>`; on `/skills`
  the heading `Skills` and the region `Your skills`, reading `No skills yet` when the CLI listed
  none or the CLI's names as its rows.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web/src/routes/_inbox.skills.index.tsx`, `apps/api/src/`

### skills.new-web-skills

- **Map:** skills.md `skills-list`, `skills-web-create`, `skills-web-edit`, `skills-web-remove`
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `skills`: Skills with nothing yet; New skill… creates one and says each
  broken field's rule beside it; search and no matches; a skill whose name a project's skill also
  has; Edit skill adds and removes a file, previews, asks before leaving, and is refused when a
  second browser saved first; Remove skill…, and a skill already removed elsewhere.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every skill and the
  project the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/skills.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/skills/`, `apps/web/src/routes/_inbox.skills.tsx`,
  `apps/web/src/routes/_inbox.skills.$skillId.tsx`, `apps/web/src/lib/skills.ts`,
  `apps/web/src/lib/skill-removal.ts`, `apps/web/src/lib/use-skill-twins.ts`

### skills.new-web-project-skills

- **Map:** skills.md `skills-list`, `skills-web-create`, `skills-web-edit`, `skills-web-remove`, in
  a project's library; `skills-project-inherit` is dropped (no "Use global skills" switch)
- **Needs:** no session; no turn; web; GitHub reachable from the box
- **Do:** Drive the recipe `project-skills`: a project's Skills tab with nothing yet; New skill…
  from an empty skill, then each rule (nothing picked to copy, a name the project has); a copy of
  one of your skills under its own name; your skill and the project's each saying which is used, and
  linking to the other; Edit skill in place of the project page and Save; Remove skill…, which says
  yours is used again; fixtures for a reader who may not change them and for a project being
  removed; a list that fails to load; the phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures; every skill and the
  project the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/project-skills.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/skills-tab.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.skills.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.skills.$skillId.tsx`,
  `apps/web/src/lib/project-skills.ts`, `apps/web/src/lib/use-project-skill-owner.ts`

### skills.adopt-project-skills

- **Map:** skills.md `skills-list` (project skills imported automatically at adoption from
  `.agents/skills`)
- **Needs:** no session; no turn; CLI; `<git>` (git service on the box)
- **Do:** On the box, create a throwaway bare repository in `<git dir>` carrying
  `.agents/skills/adopted-skill/SKILL.md` (with a `description:` line in frontmatter), adopt it as a
  project with `M adopt <git>/<repo>.git --name <name>`, read `M skills --project <name>` and
  `M skills`, then remove the project and throwaway bare repository.
- **See:** `M skills --project <name>` lists `adopted-skill` with its frontmatter description;
  `M skills` (the personal library) does not list `adopted-skill`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/adoption-skills.ts`, `apps/api/src/routes/workbench.ts`,
  `packages/store/src/store.ts`

### search.new-web-search

- **Map:** none yet: search from anywhere is new in the web app (SLNT-1142), and the map has no
  feature file for it.
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `search`: Ctrl K from the home composer, the Skills page and a session
  page; nothing typed; a query that finds sessions, a project and a skill; one that finds nothing;
  arrows, Enter and Escape; the sidebar's Search field and its rail's button; New session, Add
  project… and Collapse/Expand sidebar; skills that fail to read, then Try again; on a phone, the
  inbox's search screen with Clear, Cancel and the keyboard's search key.
- **See:** each step's note in the recipe's `steps.log`, and its captures; the projects and skills
  the recipe made are removed at its end.
- **Mode:** `scripted` (recipes/search.mjs)
- **Box-only:** no
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

### agent-memory.new-web-only-you

- **Map:** agent-memory.md `memory-list`, `memory-show`, `memory-remove` (and Clear memory…, new on
  the web with route PR 57); doppler.md `doppler-use`
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `project-only-you`: it makes a project with no repository, imports three
  memory files through `POST /api/projects/<id>/memory/import`, and opens
  `/projects/<id>/settings/only-you` from the settings sidebar; View notes…, shows MEMORY.md,
  removes it; Clear memory… where one file isn't removed (a rewritten answer), then all of them;
  saves a fake Doppler token, types a config the token can't list, picks one from recorded lists,
  and chooses Stop using Doppler here; a read that fails and Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures:
  `3 notes. You last imported one today at …`; the notes list with each note's agent and size;
  MEMORY.md's words; the server listing 2 files after Remove and none after Clear memory; the
  Doppler row reading `checkout / dev_personal`, then `checkout / dev`, then `None` with Choose…; no
  part of the token on any page. The recipe removes the token and the project.
- **Mode:** `scripted` (recipes/project-only-you.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/only-you-page.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.only-you.tsx`,
  `apps/web/src/server/routers/memory.ts`, `apps/web/src/lib/only-you.ts`

### appearance.web-theme

- **Map:** appearance.md `theme-web`, `theme-system`, `theme-persist`
- **Needs:** no session; no turn; web; a fresh browser context
- **Do:** As appearance.md's web steps: emulate light, open Settings, pin `Dark`, reload, back to
  `System`. The choice lives in that browser only.
- **See:** the buttons `System`, `Light`, `Dark`; `html` keeps `dark` across a reload while pinned;
  `mend-theme` is `"system"` at the end.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/`, `packages/ui/`

## Project setup and customization

### project-environment.read

- **Map:** project-environment.md `env-show-cli`, `env-routing` (the refusal; nothing saved)
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M env show --project <p>`. Open `<p>`'s Settings → Variables and secrets
  (`/projects/<id>/settings/secrets`) and choose `Add variable…`. Type `MEND_X` under `Name`, press
  the dialog's `Add variable`, read the refusal, `Cancel`, reload, and run
  `M env show --project <p>` again.
- **See:** the stored names per lane, never a value (or `  nothing stored — …`);
  `The MEND_ prefix is reserved for Mend itself.` under `Name` with the dialog `Add variable` still
  open; after `Cancel` and the reload, `Environment variables` unchanged (`No variables yet.` when
  nothing was stored), and the second `env show` the same as the first.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/env.ts`, `apps/web/src/components/settings/`, `apps/api/src/`

### cluster-bindings.read

- **Map:** cluster-bindings.md `cluster-show`, `cluster-local-runner`
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M env show --project <p>`, then open `<p>`'s Settings → Variables and secrets and wait
  until `Environment variables` and `Secrets` have loaded. Bind nothing.
- **See:** `<p> · configuration r<n> · secrets r<n> · cluster r<n>` with no `cluster binding` or
  `service account` line; on the page no `Loading…` and no `This didn't load.`, then one of two
  states (record which): on a server without Kubernetes, no `Cluster bindings` section (it is hidden
  while nothing is bound); on Kubernetes, the section `Cluster bindings` reading `Nothing is bound.`
  with the combobox `Kind` and the button `Bind`; never `These bindings can't resolve here.` while
  `env show` lists no binding. (`project-settings.new-web-cluster-bindings` drives the bound and
  stranded states.)
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/`, `apps/api/src/`

### workspace-images.read

- **Map:** workspace-images.md `image-project-override` (the panel read),
  `image-organization-default` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Image` section of `<p>`'s Settings → Workspace
  (`/projects/<id>/settings/workspace`); choose `Edit image…`, read the dialog, `Cancel`. Read
  Settings → Default → Workspace image (`/settings/organization/workspace-image`). Choose nothing.
- **See:** under `Image`,
  `<p> has its own image. Mend copied it from Default's starting image when the project was created on <day>. Changing Default's image doesn't change this one.`,
  then `Current image` reading `<OS>, <shell> and <n> packages.`; the dialog `Edit <p>'s image` with
  `Base`, `Operating system` and `Shell` each with one choice pressed and the list `Packages` with
  `<n>` items, and `Cancel` leaving the summary as it was; on the organization page
  `The starting image for Default's projects. Mend copies it into each new project when the project is created.`
  and
  `Changing it doesn't change existing projects. Each project edits its own copy on its Workspace page.`,
  with the section `Starting image` as an editor for an owner (or
  `Only an owner can change it: <names>.` for a member); no `Follow the instance` anywhere.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/`,
  `apps/web/src/components/settings/workspace-image-page.tsx`, `apps/api/src/`,
  `packages/db/src/repos/organization-settings.ts`

### automatic-install.read

- **Map:** automatic-install.md `install-detected`, `install-colocated`
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Dependencies` section of `<p>`'s Settings → Workspace sub-tab. Change nothing.
- **See:** `Mend installs dependencies in each new worktree before the agent starts.`; the switch
  `Automatic install` checked, with
  `Mend runs your custom command. If you haven't set one, it runs the command it finds from the lockfile.`,
  the textbox `Custom command` and one line under it (record which):
  `Mend found no lockfile it knows on <default branch>, and looks again when a session starts. …`,
  `Mend found <command> from <lockfile> on <default branch> and runs it. …`,
  `Mend runs this instead of the command it found from the lockfile.` or
  `Mend couldn't read <default branch>, …`; or unchecked, with
  `No install runs, in sessions or for the shared cache.` and no `Custom command`; or, on a
  colocated install, `Sessions here run beside the store, …`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/`, `apps/api/src/`

### hot-sessions.read

- **Map:** hot-sessions.md `hot-status`, `hot-count` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read the `Ready workspaces` section of `<p>`'s Settings → Workspace sub-tab. Change no
  count.
- **See:** `Ready workspaces` with `Per person` and `You can set up to 8.`; in the group
  `Ready workspaces per person`, the count `0` with the status `Off` and `One fewer ready workspace`
  disabled, or for a raised count its number and `<n> ready for you`, `<n> starting`, `<n> failed`
  or `None ready yet` (record which); never `Mend couldn't read them.`
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/`, `apps/api/src/preview-pools.ts`,
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
- **Waiting on:** SLNT-1270 · the project's automation groups (`Inherit · on|off`, `On`, `Off`, five
  per project) and the organization's `Defaults` are not in the shipped app: the project's Landing
  and Review addresses open your own `Your automation`, and the organization's runtime is on
  Settings → Default → `Runtime`. Until that ticket settles it, this flow fails on those groups and
  is known.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/`, `apps/web/src/components/settings/`,
  `apps/web/src/lib/settings-pages.ts`,
  `apps/web/src/routes/_inbox.settings.organization.runtime.tsx`, `apps/api/src/`,
  `packages/db/src/repos/person-settings.ts`

### project-settings.new-web-general

- **Map:** project-settings.md `settings-visibility`, `settings-remove`, `settings-retention`;
  organization.md `visibility`; renaming a project (`POST /projects/:id/name`, new on the web with
  route PR 52); the project's settings frame (its pages in the settings sidebar, the phone's list of
  them, old `/projects/<id>/configuration#…` addresses)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `project-general`: it makes a project with no repository, opens
  `/projects/<id>/settings` (General) as its owner, follows the old configuration and settings
  addresses and the project's "…" → Project settings; renames it (a name Mend won't take and a taken
  one refused beside the field, Save, Enter, Escape); makes it shared and private; a second person
  joins through an invitation and reads the shared project's page as a member; the phone's list of
  the project's pages; removes it from its page, restores it, removes it again and purges it; a read
  that fails and Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures: the breadcrumb
  `Settings / <project> / General`; `Renamed to <name>.` with the breadcrumb and sidebar reading the
  new name, and a `project.renamed` audit entry; the member's read-only page naming who can change
  it and who can remove it, and the server's 404 to their rename; after Remove the page shows the
  removed project with Restore and Purge…; after Purge its address is not found. The project is
  purged and the second person removed.
- **Mode:** `scripted` (recipes/project-general.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-general-page.tsx`,
  `apps/web/src/components/settings/phone-project-settings.tsx`,
  `apps/web/src/components/settings/removed-project-page.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.index.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.general.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.configuration.tsx`,
  `apps/web/src/lib/project-settings.ts`

### workspace-images.new-web-project

- **Map:** workspace-images.md `image-project-override`, `image-rejections`, `image-use-default`
  (read as "start again from a copy of the organization's starting image"); automatic-install.md
  `install-detected`, `install-custom`, `install-switch`, `install-colocated`; hot-sessions.md
  `hot-count`, `hot-status`, `hot-rewarm` (route PR 53); project-settings.md `settings-remove` after
  the project's automatic installs (SLNT-1243)
- **Needs:** no session; no turn; web; Sealant's package catalog
- **Do:** Drive the recipe `project-workspace`: it makes a project with no repository and opens
  `/projects/<id>/settings/workspace` from the settings sidebar; Edit image… with a package Sealant
  can't find, then bash and the Docker switch saved; Start again from the organization's image and
  saved; a custom command saved, install switched off and on, the command cleared; the
  ready-workspace count raised and lowered; the ready workspaces starting again and failing
  (rewritten status), a status read that fails, and the page as a reader. Then it waits until the
  automatic installs those saves queued have ended, and removes the project with Remove project… on
  its General page.
- **See:** each step's note in the recipe's `steps.log`, and its captures: the refused package named
  with Sealant's reason and nothing saved; the server holding bash and the Docker switch, then a
  copy of the organization's starting image; `Saved the custom command.`; the switch's line saying
  the command is kept; `None ready yet` at 1 and `Off` at 0; on the box, a real project's ready
  workspaces reading `starting` after an image save. `install-then-remove`: on the box, one or more
  `install · mend` worktrees, none live, then `<name> was removed` and the project under Removed
  projects; a refusal that asks only to try again is retried once and noted, and any other
  (`executor not ended`, a session to stop) fails the flow, with its words and
  `workspace-install-then-remove-refused`. The cleanup line says whether the server removed and
  purged the project.
- **Mode:** `scripted` (recipes/project-workspace.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-workspace-page.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.workspace.tsx`,
  `apps/web/src/lib/workspace-image.ts`

### references-folders.new-web-project

- **Map:** references-folders.md `folder-select`, `ref-select`, `host-mounts` (operator of a single
  install), `link-project` (on the project's General page); `ref-add` is the organization's page's
  (docs/adr/0025)
- **Needs:** no session; no turn; web; GitHub reachable from the server, for a reference's clone
- **Do:** Drive the recipe `project-folders`: it makes two projects with no repository, two
  organization folders (one with two files) and a reference cloned from GitHub; on
  `/projects/<id>/settings/folders` it sets one folder Read only and the other Read and write, turns
  the reference on and reloads; a refused save; as the operator of a single-organization install it
  adds and removes a server folder, and on a multi-tenancy server (check VMs) it tries the add; the
  page as a reader, with no folders or references, and a read that fails with Try again; on General
  it links the second project as `web` and unlinks it.
- **See:** each step's note in the recipe's `steps.log`, and its captures: the folders with their
  size (`2 files · …`, `Empty`) and the access pressed after the reload; the reference's switch on;
  the refusal under the section with the folder back to Read only; on a single-organization install,
  `Added pf-…-tmp.` and the server folder's row, then gone; on a multi-tenancy server, no Server
  folders section and the add refused with no folder made (docs/adr/0003); the reader's page naming
  who can change it, with each access as words; the Linked projects row reading
  `/workspace/repos/web` and its worktree, then `No linked projects.`. The recipe removes what it
  made.
- **Mode:** `scripted` (recipes/project-folders.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-folders-page.tsx`,
  `apps/web/src/components/settings/project-links-section.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.folders.tsx`,
  `apps/web/src/lib/project-folders.ts`

### project-settings.new-web-services

- **Map:** mend-toml.md (the file's Services, read-only; `toml-project-recipes` and `toml-shadowed`
  dropped by ruling D8); services.md (the fixed preview address and moving it to another worktree)
- **Needs:** no session; no turn; web; `<p>` (a project whose default branch has a
  `.mend/mend.toml`, ideally with `[preview] fixed = true`)
- **Do:** Drive the recipe `project-services`, or by hand: open `<p>`'s Settings → Services; read
  the banner, the file and the Fixed preview address row; on a project whose file declares a fixed
  preview, Change worktree… to another worktree and back.
- **See:** "Read-only here." over the page; "This is the file on <branch>." with the branch's
  `.mend/mend.toml` shown with line numbers, or "<branch> has no .mend/mend.toml." and what that
  means; the row naming the host, the Service and the worktree it shows; Change worktree… listing
  the project's worktrees by their newest session with the current one marked, then Default branch;
  after the move, `The preview address now shows "<label>".` and the row naming it.
- **Mode:** `scripted` (recipes/project-services.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-services-page.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.services.tsx`,
  `apps/web/src/lib/project-services.ts`

### project-settings.new-web-secrets

- **Map:** project-environment.md `env-composer`, `env-import`, `env-routing`, `env-configuration`,
  `env-secrets`, `env-not-inherited` (the web app's Variables and secrets page)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `project-secrets`, or by hand on a project the run makes: add, edit,
  rename and remove a variable; add, replace and remove a secret (a value from `scripts/fakes.mjs`);
  Import .env file… with a variable, a secret-looking name, a reserved name and a line that isn't
  `NAME=value`; then remove the project.
- **See:** `Saved <name>.`, `Added <name>.`, `Replaced <name>.`, `Removed <name>.` toasts and the
  lists following each; a secret-looking name refused as a variable beside the field; the import's
  rows each saying where they go, values hidden, and its toast
  `Saved 1 variable and 1 secret. 1 name was refused.`; the secrets read and the page never holding
  a secret's value.
- **Mode:** `scripted` (recipes/project-secrets.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-secrets-page.tsx`,
  `apps/web/src/components/settings/environment-dialogs.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId_.settings.secrets.tsx`,
  `apps/web/src/lib/project-environment.ts`, `apps/web/src/lib/env-composer.ts`

### project-settings.new-web-cluster-bindings

- **Map:** cluster-bindings.md `cluster-bind-web`, `cluster-remove`, `cluster-service-account`,
  `cluster-local-runner` (the web app's Variables and secrets page)
- **Needs:** no session; no turn; web; on the box, whatever runtime it runs
- **Do:** Drive the recipe `project-cluster-bindings`: verify-fixture's Variables and secrets page
  as the server has it, then with the bindings read rewritten as a Kubernetes server answers it
  (bind, a duplicate, the service account, remove) and as a server without Kubernetes that still has
  a binding.
- **See:** on a local runner with nothing bound, no Cluster bindings section; on Kubernetes,
  `Bound Secret <name>.`, `Secret app-env is already bound to this project.`,
  `Workspaces run as <account>.`, `Removed ConfigMap <name>.`; a stranded binding's "These bindings
  can't resolve here." with Remove only, and the section gone once it is removed.
- **Mode:** `scripted` (recipes/project-cluster-bindings.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/cluster-bindings-section.tsx`,
  `apps/web/src/lib/cluster-bindings.ts`

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
  `apps/web/src/routes/_inbox.settings.organization.folders.tsx`

### references-folders.select-link

- **Map:** references-folders.md `folder-select`, `ref-add`, `ref-select`, `ref-refresh-remove`,
  `link-project`, `extras-delivery`
- **Needs:** Boat; no turn; CLI and web (the owner's browser); `<land>` and `<second>`; a
  `<scratch>/folder` holding `a.txt`
- **Do:** `M folder create main-run-sel-<sha8>`,
  `M folder push main-run-sel-<sha8> <scratch>/folder`. On `<land>`'s Settings · Folders and
  references set `Access to main-run-sel-<sha8>` to `Read only`. On Default's Settings · Folders and
  references choose `Add reference…` with Repository `<git>/second.git`, Name `main-run-ref` and no
  ref, then `Add reference`. Back on `<land>`'s Folders and references turn on
  `Use main-run-ref in sessions`, reload, and go on only when the switch reads checked. On
  `<land>`'s Settings · General choose `Link project…`, Project `<second>`, Mounted as
  `main-run-link`, then `Link project`. Run `M folder rm main-run-sel-<sha8>` (refused while
  selected). Then
  `M run --project <land> --name main-run-extras-<sha8> -- sh -c 'ls -R /workspace/home /workspace/ref /workspace/repos > EXTRAS.txt 2>&1; true'`
  and record its session `<id>` from `✓ base … · session <id8>` and `M sessions --json`. Read
  `EXTRAS.txt` in its change: in the owner's browser go straight to `<web>/sessions/<id>/change` (do
  not click `Review change` and wait for the URL: it keeps a query string, so a wait for a URL
  ending `/change` never matches), wait up to 30 s for
  `page.getByRole("region", { name: "EXTRAS.txt", exact: true })`, and `note()` the text of its
  `code` elements. On Default's Folders and references choose `Fetch again` on `main-run-ref`.
  Restore in the same flow: set the folder's access back to `Off`; choose `Unlink <second>`; on
  Default's page choose `Actions for main-run-ref`, `Remove reference…`, then `Remove reference`;
  `M folder rm main-run-sel-<sha8>`; and
  `M worktrees rm main-run-extras-<sha8> --project <land> --force` (`EXTRAS.txt` is never landed, so
  removal without `--force` is refused).
- **See:** the folder's `Read only` pressed; on `<land>`'s page the `main-run-ref` row with its
  short head sha and the switch checked after the reload, and on Default's page its `Fetched` cell
  reading a time (`just now`, `<n> minutes ago`) before and after `Fetch again` (or the refusal of a
  `git://` URL in its own words: record which); the `Linked projects` row `main-run-link` reads
  `<second>`, `/workspace/repos/main-run-link` and `main`, with the button `Unlink <second>`;
  `mend: A project mounts this folder. Deselect it there first.`, exit `1`; `EXTRAS.txt` lists
  `a.txt` under `main-run-sel-<sha8>`, the reference's top level under
  `/workspace/ref/main-run-ref`, and either `main-run-link` under `/workspace/repos` or
  `/workspace/repos` missing (missing when `Linked projects` says
  `Sessions here run in captured workspaces, which don't get linked projects, …`; record which);
  after the restore, `<land>`'s pages read `Default has no folders yet.`,
  `Default has no references yet.` and `No linked projects.`, `M folder list` has no
  `main-run-sel-<sha8>`, and `M worktrees --project <land>` has no `main-run-extras-<sha8>`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/web/src/components/settings/project-links-section.tsx`,
  `apps/web/src/components/settings/project-folders-page.tsx`, `apps/api/src/`, `packages/sessions/`

### now-and-sessions.web-now

- **Map:** now-and-sessions.md `inbox-groups`
- **Needs:** either; no turn; web; `start-session.boat-turn`
- **Do:** Recipe `now` with `MAIN_RUN_SESSION` set to the turn's session.
- **See:** the Now page's `Sessions` inbox, with a row linking to that session.
- **Mode:** `scripted` (recipes/now.mjs)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/web/src/routes/_inbox.tsx`, `apps/web/src/routes/_inbox.index.tsx`,
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
- **Needs:** either; no turn; CLI and web; a session of its own
- **Do:**
  `M run --project <p> --name main-run-settle-<sha8> -- sh -c 'printf "settle\n" > SETTLE.md'`;
  record its session `<id>` from its `watch · <web>/sessions/<id>` line. `--name` names the
  worktree, not the session, and a session nobody named reads `New session` (SLNT-1211), as do many
  other rows of the inbox: find this session's row by its link to `/sessions/<id>`, never by its
  text, and use the controls inside that row (`Actions for <title>`). On `/`, wait for that row
  under `To review`, choose `Mark done` from its menu, open `Done`, then `Mark not done` on it, so
  the flow ends where it began; narrow the inbox to `<p>` with `Inbox filters: …` and put the filter
  back. Type no prompt. Restore: `M worktrees rm main-run-settle-<sha8> --force --project <p>`.
- **See:** the row linking to `/sessions/<id>` under `To review` reads `New session`, not
  `main-run-settle-<sha8>`; it leaves `To review` for `Done`, then is back; narrowed to `<p>`, the
  inbox shows only `<p>`'s rows; home is the composer under the heading `New session`.
- **Mode:** `agent` · the verify skill's `recipes/row-actions.mjs` and `recipes/inbox.mjs` drive the
  same controls on a stack
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.tsx`, `apps/web/src/components/row-actions.tsx`,
  `apps/web/src/components/inbox-filters.tsx`, `apps/api/src/`,
  `packages/domain/src/workbench/inbox-rules.ts`

### now-and-sessions.new-web-polish

- **Map:** now-and-sessions.md `now-menus`, `rail`; adopt-project.md `projects-directory`
- **Needs:** either; no turn; CLI and web; a session that keeps running
- **Do:** Drive the recipe `polish` (after its CLI batch `polish-sessions.json`): the sheet's edge
  beside the sidebar, open, pointed at and folded; a session row's focus ring and its right-click
  and "…" menus; Open project from them and from the phone's row sheet; a click on a Projects row
  and a project's Sessions row away from the name; the session header's and Settings' breadcrumbs.
- **See:** no line on the sidebar's edge at rest, in light or dark, and a short handle while pointed
  at; every focus ring in both sidebars and the two tables whole; `Open project` first in a session
  row's menus and no `Open session` (a click on the row opens it), opening the project; each row
  opens its project or session; the project's name in a session's header and a project settings
  page's breadcrumb opens the project.
- **Mode:** `scripted` (recipes/polish.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/app-sidebar.tsx`, `apps/web/src/components/row-actions.tsx`,
  `apps/web/src/lib/row-link.ts`, `apps/web/src/components/workspace/workspace-header.tsx`

### now-and-sessions.new-web-second-pass

- **Map:** now-and-sessions.md `inbox-groups`, `now-menus`, `rail`; adopt-project.md
  `projects-directory`
- **Needs:** either; no turn; CLI and web; two sessions that keep running
- **Do:** Drive the recipe `second-pass` (after its CLI batch `second-pass-sessions.json`): a
  project's tabs, the Record view's filters and a phone tile's strip; every picture in How Mend fits
  together, desktop and phone; the sidebar's edge dragged toward the page, dragged back, dragged
  outward while open, and clicked; Running while each read of the inbox says the other session
  worked last; a session row's right-click menu and "…" in the sidebar and on the project page; a
  skill's header, and its Remove skill button. On a machine with classic scrollbars (Linux or
  Windows Chrome), also look at a project's tabs.
- **See:** no row of tabs scrolls up and down or draws a scrollbar; every picture has room for what
  it draws, with even padding round the two sidebar rows; a drag from the edge toward the page folds
  the sidebar, outward opens it, outward on an open sidebar does nothing, and a click folds it;
  Running stays newest made first; no `Open session` in a row's menus, and a click on the row opens
  the session; a skill's header has Edit skill and a red Remove skill button and no "…", and the
  button asks before it removes.
- **Mode:** `scripted` (recipes/second-pass.mjs)
- **Box-only:** no
- **Areas:** `packages/ui/src/styles/globals.css`,
  `apps/web/src/components/project/project-frame.tsx`,
  `apps/web/src/components/workspace/phone-tab-strip.tsx`,
  `apps/web/src/components/project/session-actions.tsx`,
  `apps/web/src/components/skills/skill-panel.tsx`

### now-and-sessions.new-web-sheet-stop-setup

- **Map:** now-and-sessions.md `inbox-groups`; start-session.md `session-stop`; sign-in.md
  `web-sign-in`
- **Needs:** either; no turn; CLI and web; a session that keeps running
- **Do:** Drive the recipe `sheet-stop-setup` (after its CLI batch
  `sheet-stop-setup-sessions.json`): `/` for an account past setup, and for one with no project, one
  whose setup ended in this browser and one whose setup can't be read; Stop from a sidebar row's
  menu with Mend's answer held, refused, then let through with the toast's Try again; a toast beside
  a session's composer at desktop and phone width; the sheet's corners on a session's, a project's
  and a settings page, light and dark.
- **See:** `/` stays on Mend for someone past setup, opens setup's next step for someone without a
  project, and stays on Mend once setup ended here or can't be read; the row reads Stopped under
  Done or To review the moment Stop is confirmed, goes back to Running with a toast and Try again
  when Mend refuses, and stays where the stop put it once Mend took it; toasts sit in the
  bottom-right corner on a desktop and cover no composer; nothing square shows over the sheet's
  rounded corners, and no focus ring is cut by the sheet.
- **Mode:** `scripted` (recipes/sheet-stop-setup.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.tsx`, `apps/web/src/routes/_inbox.index.tsx`,
  `apps/web/src/lib/setup.ts`, `apps/web/src/lib/setup-skips.ts`,
  `apps/web/src/lib/pending-stops.ts`, `apps/web/src/lib/toast-clearance.ts`,
  `apps/web/src/components/toaster.tsx`

### now-and-sessions.new-web-session-states

- **Map:** now-and-sessions.md `inbox-groups`, `inbox-snooze-settle`, `rail`; start-session.md
  `session-stop`
- **Needs:** either; one real codex turn (one-line prompt); CLI and web; `<p>`
- **Do:** Run the CLI batch `session-states.json`, then drive the recipe `session-states`: the
  batch's live and ended sessions in their groups, the row menu of a Running and a To review row,
  Stop session… from a Running row (one with no files, one with a file), the project's Sessions tab,
  and the fixture's agent moves step by step. The data already holds the batch's worktree names: run
  the batch with each `--name` suffixed `-<sha8>` and pass `SESSION_STATES_SUFFIX=-<sha8>` to the
  recipe. On the box, also drive the recipe `session-states-turn` (`MAIN_RUN_PROJECT=<p>`, never
  after a batch that replaces the Codex login): a codex session from the composer with a one-line
  prompt, its row watched while it works, the turn ending, then Stop session… from its row.
- **See:** each step's note in the recipe's `steps.log`: a live session under Running with the
  kneading glyph, the server's `turnOpen` and `lastNewAt` on its row; ended ones under To review
  (files, or failed) and Done (none); Running rows offer Stop session… and no Mark done or Snooze; a
  stopped row changes in place, then moves and stays lit; the project table says each row's word
  with the same glyph. The real turn: Running with what the agent does, still Running saying
  `Replied` with the dome once the turn ends, and To review or Done after Stop session….
- **Mode:** `scripted` (recipes/session-states.mjs, recipes/session-states-turn.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/lib/inbox.ts`, `apps/web/src/lib/sidebar-moves.ts`,
  `apps/web/src/lib/row-actions.ts`, `apps/web/src/lib/project-sessions.ts`,
  `apps/web/src/components/session-status.tsx`, `apps/web/src/components/changed.tsx`,
  `apps/web/src/components/session/stop-session-host.tsx`

### attach-resume.boat-stop-resume

- **Map:** start-session.md `session-stop`; attach-resume.md `stop-cli`, `resume-web`
- **Needs:** Boat; no turn (resume sends no prompt); CLI and web; `start-session.boat-turn`
- **Do:** `M stop <id8>` on the turn's session; open its page `/sessions/<id>` and choose
  `Resume session` on its banner `This session is stopped.`; wait until it runs; then `M stop <id8>`
  again.
- **See:** `✓ stopped · codex · <id8> · …`; the banner and `Resume session`, then the banner gone
  and the session running again (its row under `Running`); after the second stop,
  `M sessions --all --project <p> --json` lists it settled with `MAIN-RUN.md` still in its change.
- **Mode:** `agent` (the old app's `recipes/resume.mjs` went at cut-over; the verify skill's
  `recipes/session-actions.mjs` drives the banner on a stack, resuming a command as a shell)
- **Box-only:** `boat`
- **Sample:** yes
- **Areas:** `packages/sessions/`, `apps/web/src/routes/_inbox.sessions.$sessionId.tsx`,
  `apps/web/src/components/session/stopped-banner.tsx`, `apps/api/src/`

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

### attach-resume.terminal-and-web

- **Map:** attach-resume.md `attach-cli`, `terminal-and-web`
- **Needs:** either; real turns (codex); CLI in tmux and the web app; `<p>`
- **Do:** Run the recipe with `MAIN_RUN_M=<M> MAIN_RUN_SHA8=<sha8> MAIN_RUN_PROJECT=<p>` through
  `pnpm verify drive web --box --recipe .agents/skills/box-main-run/recipes/terminal-and-web.mjs --timeout 900000`:
  it serves the web app from the commit under test in front of the lane's copy. It starts a Codex
  conversation from the CLI (ALPHA), takes it over with `M attach` in tmux and types a turn into
  Codex's TUI (BRAVO), opens the session in the web and sends a turn from its composer (CHARLIE),
  closes the terminal and waits, sends one more from the web (DELTA), then starts a session in a
  terminal with `M codex` (FOXTROT). It stops both sessions and its tmux server however it ends.
- **See:** each step's note in `steps.log`: BRAVO's question and answer in the web within 45 s of
  the page opening, ALPHA once, no "AGENTS.md instructions" message and no lock line, the field
  `Message Codex`; CHARLIE answered in the web and typed into the still-attached terminal; within
  the grace plus two minutes of the terminal closing, the line "Continued as a conversation after
  the terminal closed", then DELTA answered with every earlier turn shown once; FOXTROT on the
  terminal session's page within 45 s. On a build before SLNT-1235 it fails at BRAVO in the web.
- **Mode:** `scripted` (recipes/terminal-and-web.mjs)
- **Box-only:** `real-agent-turn`
- **Areas:** `apps/web/src/lib/session-composer.ts`, `apps/web/src/lib/conversation-rows.ts`,
  `apps/web/src/components/session/`, `apps/cli/src/`, `packages/sessions/`,
  `packages/agent-protocol/`, `apps/api/src/routes/workbench.ts`, `apps/api/src/routes/tty.ts`

### attach-resume.antigravity-mode-switch

- **Map:** attach-resume.md `antigravity-mode-switch`, `pickup-takeover`
- **Needs:** either; real turns (antigravity); CLI in tmux and the web app; the owner's Antigravity
  login; `<p>`
- **Do:** On `/`, in the form `New session`: project `<p>`, harness Antigravity, the prompt
  `Remember the word PELICAN. Reply with just OK.`, then `Start`; wait with
  `M wait <id> --turn --timeout 8m`. Run `M attach <id8>` in tmux and, once agy's prompt shows, type
  `Which word did I ask you to remember? Reply with just that word.` and Enter; once it answers,
  detach with `Ctrl+]`. Open `/sessions/<id>` and read the composer, then choose
  `Continue as a conversation` from the session menu and send
  `Say the word again, then the single word back.` from the field `Message Antigravity`. Stop the
  session with `M stop <id8>`.
- **See:** the attach prints `reopening as a terminal — same conversation…` and agy's terminal opens
  on the conversation, with no folder-trust question and no "Invalid Project", and answers `PELICAN`
  (agy's own colour scheme and terms screens may come first: SLNT-1290); while it is a terminal the
  composer reads `Antigravity runs in a terminal in this session. Type to it there.` and has no
  input, and the conversation reads
  `Antigravity runs in a terminal. It keeps the turns typed there; they don't show here.`; it is
  still a terminal a minute after the detach; after the switch the page is a conversation again, the
  reply holds `PELICAN` and `back`, and the conversation reads
  `Antigravity keeps the turns typed in its terminal; they don't show here.` On a build before
  SLNT-1277 the attach fails with `This session's agent cannot switch to that mode.`
- **Waiting on:** SLNT-1276 · the box's data holds no Antigravity login, so the session does not
  start. Nothing else of this flow can be seen without one.
- **Mode:** `agent`
- **Box-only:** `real-agent-turn`
- **Areas:** `packages/domain/src/workbench/harness-launch.ts`,
  `apps/web/src/components/session/session-actions.tsx`, `apps/web/src/lib/session-composer.ts`,
  `apps/web/src/components/session/conversation-tile.tsx`,
  `apps/mobile/src/components/session-pane.tsx`, `packages/sessions/src/harness-state.ts`,
  `packages/sessions/src/harness-seeds.ts`

### attach-resume.rename-web

- **Map:** attach-resume.md `rename-web`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On the run session's page, press `F2` on its tab (or choose `Rename…` from the tab's
  menu), set `main-run label` in `Session name` in the dialog `Rename session`, then rename it back
  to its earlier title the same way.
- **See:** the tab and the session's row read `main-run label`, and `M sessions --all --project <p>`
  agrees; afterwards both read the earlier title again.
- **Mode:** `agent` · the verify skill's `recipes/session-actions.mjs` drives the same rename on a
  stack
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.sessions.$sessionId.tsx`,
  `apps/web/src/components/session/session-actions.tsx`, `apps/web/src/components/row-actions.tsx`,
  `apps/api/src/`

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
  object with `"notSaved": false`; then both sessions settled. A save already done at the first read
  is what a person sees too: `M stop <k8>` printed
  `saving · the workspace stops once nothing is pending`, and the first read lists both sessions
  settled with a `capture` object with `"notSaved": false` and no `saving …` line. Record it as
  seen, naming that read. A settled session whose `capture` reads `"notSaved": true`, or that has no
  `capture`, is failed: nothing was saved.
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
  `apps/web/src/`

### worktrees.web-create-remove

- **Map:** worktrees.md `worktrees-tab`, `worktrees-new`, `worktrees-menu`, `worktrees-remove`,
  `worktrees-cli`; start-session.md `start-new-worktree`
- **Needs:** no session; no turn; web and CLI; `<p>`
- **Do:** On `<p>`'s Worktrees tab (`/projects/<id>/worktrees`) choose `New worktree…` and create
  `main-run-wt-<sha8>`, read it with `M worktrees --project <p> --json`, open its menu and choose
  `Remove worktree…`, then `Remove worktree` in the dialog.
- **See:** `Created main-run-wt-<sha8> on mend/main-run-wt-<sha8>.` and its row in the region
  `Worktrees`; JSON with `"version": 2` and that name; the menu holding `Remove worktree…`; after
  removal the row is gone from the tab and `M worktrees --project <p> --json` no longer lists it.
- **Mode:** `agent` · the verify skill's `recipes/worktrees.mjs` drives the same tab on a stack
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/`,
  `apps/web/src/routes/_inbox.projects.$projectId.worktrees.tsx`, `apps/api/src/`, `packages/store/`

### worktrees.new-web-worktrees

- **Map:** worktrees.md `worktrees-tab`, `worktrees-new`, `worktrees-menu`, `worktrees-remove`,
  `worktrees-clear-settled`, `worktrees-hidden-ended`; capture-and-save.md `capture-removal-hold`;
  repositories-in-session.md `repo-removal-hold` (their words, from `lib/worktree-removal.ts`)
- **Needs:** no turn; web; CLI; `verify-fixture` (or `<p>` on the box)
- **Do:** Drive the recipe `worktrees` (after its CLI batch `worktrees-setup.json`): the Worktrees
  tab; New worktree… makes one; its "…" menu, and a shell started from it; Remove worktree… while
  the shell runs, then again once it is stopped; the never-landed refusal with its files and Remove
  anyway; Clear finished…; the phone sheets; a project with no worktrees; a project that fails to
  load.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "Not removed" says a
  session is still running with no Remove anyway; after the stop, `Removed <name> and its session.`;
  Clear finished's toast names `wt-unlanded-<time>` as kept because its change was never landed;
  Remove anyway's toast says the change was discarded.
- **Mode:** `scripted` (recipes/worktrees.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/worktrees-tab.tsx`,
  `apps/web/src/components/project/worktree-actions.tsx`,
  `apps/web/src/components/project/new-worktree.tsx`,
  `apps/web/src/components/project/remove-worktree.tsx`,
  `apps/web/src/components/project/clear-finished.tsx`,
  `apps/web/src/routes/_inbox.projects.$projectId.worktrees.tsx`,
  `apps/web/src/lib/project-worktrees.ts`, `apps/web/src/lib/worktree-removal.ts`

### worktrees.new-web-long-dialogs

- **Map:** worktrees.md `worktrees-clear-settled`; services.md (the fixed preview address)
- **Needs:** no turn; web; `verify-fixture`
- **Do:** Drive the recipe `long-dialogs`. It makes worktrees in `verify-fixture` until it has 80,
  with no sessions, then opens Clear finished… on the project's Worktrees tab and Change worktree…
  on its Services settings (with the preview read rewritten to declare a fixed preview), each at
  1280 × 900 and at 390 × 844, and cancels each. Clear finished is never confirmed. It removes the
  worktrees it made.
- **See:** in each dialog, and in the phone sheet, the title and the buttons are on screen and the
  confirm button can be clicked; the list of worktrees scrolls inside the dialog down to its last
  row, and the words under the list stay in view. It fails (SLNT-1242) on a build whose dialog had
  no maximum height: the recipe stops with "runs past the window".
- **Mode:** `scripted` (recipes/long-dialogs.mjs)
- **Box-only:** no
- **Box:** after cut-over
- **Areas:** `packages/ui/src/components/ui/dialog.tsx`,
  `apps/web/src/components/projects/overlay.tsx`,
  `apps/web/src/components/project/clear-finished.tsx`,
  `apps/web/src/components/settings/project-services-page.tsx`

### resources.new-web-resources

- **Map:** ADR 0019 resources, as the web app's Resources tab shows them (no feature file): the list
  with each worktree's Shared · Own · Off, Add a resource…, Start and Stop, a failed start, Load
  data…, Remove…, no resources yet, the New session composer's resource line, and "New worktrees use
  project resources"
- **Needs:** no turn; web; `verify-fixture` (or `<p>` on the box); a runtime that runs resources
  (Docker)
- **Do:** Drive the recipe `resources`: on `verify-fixture` it makes two worktrees, writes a
  Postgres table into one with Add a resource…, starts it from that worktree as the project's
  resource, turns the other worktree's database Off and back, loads a small SQL dump, stops and
  starts it, removes it, and opens the home composer on the first worktree.
- **See:** each step's note in the recipe's `steps.log`: the table Mend wrote; the panel reads
  Running with both worktrees and their choices; the load ends `loaded … from verify-seed.sql`; Stop
  reads Stopped; Remove's toast says `archived · volumes kept`; the composer reads
  `Resources @<name> shared database`; the home, project and session pages are no taller than the
  window.
- **Mode:** `scripted` (recipes/resources.mjs)
- **Box-only:** no
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
- **Do:** `M members`, `M org`; `M invite --email main-run@example.invalid --days 1`; on Settings ·
  Members, in `Invitations`, choose `Revoke the invitation for main-run@example.invalid`, which
  restores the list in the same flow; open the fold of closed links; read Settings · Audit log.
- **See:** `Default · 2 members` (the owner and `fixtures.sh`'s second account) with the `▸` row
  `owner`; `M org` prints `Default · owner · joined <date>`; the link with
  `works once · member · for main-run@example.invalid · expires <date>`; the `Open invitations` row
  `main-run@example.invalid` · `Member`, then `No open invitations.` and the fold
  `Show <n> used, expired or revoked links` one higher than before (record both;
  `Show 1 used, expired or revoked link` when there was none), its first item
  `main-run@example.invalid · Member Revoked on <day month>`; the audit log's two newest rows
  `Revoked an invitation link` and
  `Created an invitation link to join as a member, for one email address`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`,
  `apps/web/src/components/settings/organization-members-page.tsx`

### organization.visibility-who-sees

- **Map:** organization.md `visibility`, `who-sees-what`, `members-cli` (the member's row);
  land-change.md Gotchas (a non-owner's `Landing →` and `only the change's owner lands it`)
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time;
  `land-change.web-push` (something landed in `<land>`)
- **Do:** `M2 members`; `M2 projects`; in the second browser, `/projects`. In the owner's browser,
  on `<land>`'s Settings · General, choose `Everyone in Default` in `Visible to`. `M2 projects`
  again; in the second browser, `/projects`, then go straight to
  `<web>/sessions/<land session id>/change`, choose `What landed` and read its dialog. In the
  owner's browser choose `Only you`, which restores it in the same flow; `M2 projects` once more.
- **See:** `M2 members` has `Default · 2 members` with the `▸` row the second account's, `member`;
  before, `M2 projects` prints `no adopted projects — …` and the second browser's `/projects` reads
  `No projects yet`; after sharing, the owner's `Visible to` has `Everyone in Default` pressed with
  `Everyone in Default can see its sessions and start their own. …`, `M2 projects` lists `<land>`
  (not `<second>`), and the second browser's `Projects` table has the `<land>` row with
  `Everyone in Default`; the member's change toolbar has no `Land…` or `Land again…`, and its
  `What landed` dialog ends `Only the change's owner lands it.` with no `Push to origin`; after
  `Only you` (pressed, `Only you can see it and its sessions.`), `<land>` is gone from
  `M2 projects`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/project-general-page.tsx`, `apps/api/src/`,
  `apps/web/src/components/change/land-dialog.tsx`, `apps/cli/src/`

### organization.roles-roundtrip

- **Map:** organization.md `role-change` (and its last-owner refusal), `members-web`, `members-cli`,
  `audit-log`
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time; the second
  account a `member`
- **Do:** In the owner's browser on Settings · Members, open `Your membership` on the owner's row,
  read its menu, then `Escape`. On the second account's row set the `Main Run Second's role` select
  to `Owner`; `M members`; in the second browser, read Settings · Members and look for
  `Invitations`. In the owner's browser set that select (the row scoped by its email) back to
  `Member`, which restores the role in the same flow. Then, in this order:
  1. `M members`. Go on only when the second account's row reads `member`. When the restore's recipe
     failed (on 19 Nov a sign-in timeout) or the row still reads `owner`, run the restore again and
     read `M members` again.
  2. Only then `M2 invite`. Run as an owner it makes a real link, so never run it before step 1
     reads `member`. If it exits `0` anyway, revoke the link it printed at once on Settings ·
     Members, in `Invitations`, and record the slip in `result.txt`.
  3. Read the audit log.
- **See:** the owner's row reads `Owner` with `Locked: the only owner` and no role select, under the
  alert
  `You're Default's only owner. Make someone else an owner before you leave or change your own role. Default always needs at least one owner.`;
  its menu has `Make yourself a member` (`Default needs at least one owner.`) and `Leave Default…`
  (`Make someone else an owner first.`), both disabled, so no request reaches the server; the second
  row then reads `Owner` and `M members` agrees; while it is an owner, the second browser shows a
  role select on both rows and `Invitations` with `Create invitation…`; after the restore the row
  and `M members` read `member`, and the second browser shows `Members` with plain `Member` and
  `Owner` cells, no role select, no row menu and no `Invitations`; `M2 invite` exits `1` with
  `mend: only an owner can invite; mend members shows who`; the audit log's newest rows are
  `Made Main Run Second an owner` and `Made Main Run Second a member`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.settings.organization.members.tsx`, `apps/api/src/`,
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
  2. In the owner's browser on Settings · Members, in `Invitations`, record
     `Show <n> used, expired or revoked links`, then choose `Create invitation…` with Role `Member`
     and Email `main-run-other@example.invalid`, then `Create invitation link` (link B). In the same
     recipe, before `Done`: wait for `page.getByRole("dialog")`, read its whole `innerText()` (the
     warning is the end of a longer line, so waiting for it as an exact paragraph never matches),
     take the `<web>/join#…` link out of it, `writeFileSync` it to
     `~/.local/state/mend-main-run/private/link-b.txt`, and `note()` the text with the link replaced
     by `<link B>`. Then `Done`. Once that recipe ends, link B is gone for good.
  3. In the second browser (`web2`), one recipe opens `<web>/join#not-a-token`, then link A (line 1
     of `invite-a.out`), then link B (`link-b.txt`), reading each file with `readFileSync`, and
     notes each page's text. In `result.txt` call the first page "the not-a-token join page": the
     evidence scan reads `/join#` followed by text as an invitation link and deletes the file (19
     Nov).
  4. In the owner's browser choose `Revoke the invitation for Anyone with the link` and
     `Revoke the invitation for main-run-other@example.invalid`, which restores the open list in the
     same flow. In the signed-out context open link A.
- **See:** link A's two lines (`works once · member · expires <day>`); for B, the dialog
  `Invitation link created` with `You won't see the link again after you close this.`,
  `Who can use it` `Only someone signing up as main-run-other@example.invalid`, `Role` `Member`, and
  its `Expires` line; `This link is not an invitation`; for A,
  `You're already a member of Default. The invitation stays unused.` with `Open Mend`; B refused
  with its reason (record the words: the join page checks membership first, so on 22 Nov it read the
  same already-a-member line); both rows leave the open list (`No open invitations.`) and
  `Show <n> used, expired or revoked links` goes up by two (record the count before and after); A in
  the signed-out context reads `This invitation can't be used.` and `An owner revoked it.`
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/routes/join.$token.tsx`, `apps/web/src/routes/join.index.tsx`,
  `apps/web/src/components/settings/organization-members-page.tsx`, `apps/api/src/`

### organization.new-web-create-leave

- **Map:** organization.md `org-create`, `org-leave` (the web app's organization switcher)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `organizations`: the switcher on a single-tenant server, on the desk and
  in the phone's Settings sheet; then, with the organization read and list rewritten in the page to
  say the server allows creating and the account has a second organization, the Create organization
  dialog with an empty name, a taken name and the server's own refusal, and the Leave dialog for the
  only owner and for a member, whose Leave the server refuses; then the toasts home shows after a
  create and a leave.
- **See:** each step's note in the recipe's `steps.log`, and its captures: no "Create organization…"
  or "Leave …" item with one organization; `This Mend runs one organization (MEND_TENANCY=single).`
  in the dialog's alert; `You can't leave yet.` for the only owner;
  `This is your only organization. Ask one of its owners to remove you instead.` in the Leave
  dialog's alert. Nothing changes on the server.
- **Mode:** `scripted` (recipes/organizations.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/organization-menu.tsx`,
  `apps/web/src/components/organization-dialogs.tsx`, `apps/web/src/lib/organization-membership.ts`,
  `apps/web/src/lib/organization-switch.ts`

### organization.new-web-operator-create

- **Map:** organization.md `org-create` (an operator, under `MEND_ORGANIZATION_CREATION=operator`,
  the default)
- **Needs:** no session; no turn; web; a server running several organizations (`MEND_TENANCY=multi`)
  whose signed-in account holds the operator role. The run's data never declared tenancy and stays
  single, so this runs on a copy that is not saved, after
  `mend server setup --offline --tenancy multi` there.
- **Do:** Drive the recipe `org-create-operator`: the operator's switcher on the desk, the Create
  organization dialog with a name, the home it lands on, Settings → Server's Organizations rows, and
  the phone's Settings sheet. Then, as the second account (not an operator), `M2 organization` reads
  `canCreateOrganizations` false and a create is refused.
- **See:** the recipe's `steps.log`: `organizationCreation operator, canCreateOrganizations true`;
  the switcher reads `… | Create organization…`; `role owner, 1 member(s)` for the new organization;
  `Only an operator creates organizations, and owns each one they create.`;
  `Mend's git may reach private networks`. The second account's create answers
  `On this Mend, only an operator creates organizations (MEND_ORGANIZATION_CREATION=operator). Ask one for an organization.`
- **Mode:** `scripted` (recipes/org-create-operator.mjs)
- **Box-only:** no
- **Areas:** `apps/api/src/tenancy.ts`, `apps/api/src/routes/organization.ts`,
  `apps/web/src/lib/server-settings.ts`

### organization.new-web-audit-log

- **Map:** operator.md `operator-audit`; shared-control.md `audit`; organization.md `audit-log` (the
  web app's Audit log page)
- **Needs:** a session of the owner's (the CLI batch `shared-control-setup.json`); no turn; web
- **Do:** Run the CLI batch, then drive the recipe `audit-log`: it makes real events as the owner
  (verify-fixture shared and private again, shared control on and off, enough invitation links made
  and revoked to need a second page), opens `/settings/organization/audit-log`, reads the next page
  with Show older events, then, with the log's answers rewritten in the page, an older page that
  fails, an empty log, the loading screen and a first page that fails with Try again; desk and
  phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "Revoked an invitation
  link", "Made verify-fixture private", the shared-control rows, `Owners of <organization>` under
  the title, more rows after Show older events, "Mend couldn't read older events." under the button.
  verify-fixture ends private, and every link the run made is revoked or used, with none left open:
  the link the second person joined with is spent, and a revoke of it answers `409`
  `InvitationSpent` (the recipe's `links this run made: …; revoked …, spent by joining …`).
- **Mode:** `scripted` (recipes/audit-log.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/audit-log-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.audit-log.tsx`, `apps/web/src/lib/audit-log.ts`

### organization.new-web-general

- **Map:** organization.md `org-leave` (from the General page); an owner renames the organization
  (`PUT /organization/name`, new with route PR 45)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `org-general`: `/settings/organization` as its owner (old
  `/settings/organization/` lands there, and so does the switcher's settings item); rename it
  (Unsaved changes, an empty name refused beside the field, Save, Enter, Escape) and put the name
  back; a second person joins through an invitation and reads the page as a member; made an owner
  and back; then, with a second organization written into the page's list, the Leave dialog for an
  owner beside another owner and for the only owner; a read that fails and Try again.
- **See:** each step's note in the recipe's `steps.log`, and its captures: `Renamed to <name>.`, the
  breadcrumb and audience line reading the new name, an `organization.renamed` audit entry; the
  member's read-only name with `Only an owner can rename it: <owner>.`; the server's 404 to the
  member's rename. The name is what it was before the run, and the second person is removed.
- **Mode:** `scripted` (recipes/org-general.mjs)
- **Box-only:** no
- **Areas:** `apps/web/src/components/settings/organization-general-page.tsx`,
  `apps/web/src/routes/_inbox.settings.organization.index.tsx`,
  `apps/web/src/lib/organization-general.ts`

### organization.new-web-members

- **Map:** organization.md `members-web`, `invite-web`, `invite-revoke`, `role-change`,
  `password-reset`, `member-removal` (the web app's Members page)
- **Needs:** no session; no turn; web
- **Do:** Drive the recipe `org-members`: `/settings/organization/invitations` lands on
  `/settings/organization/members`; the only owner's role is locked; the owner creates a link bound
  to an email through Create invitation, a second person joins with it in a second browser and the
  owner's page says so; the owner makes them an owner and undoes it, makes them a reset link,
  revokes another link, opens the fold of used and revoked links, reads the page as that person,
  then removes them. With answers rewritten in the page: the link dialog's and reset panel's
  pictures, a refused role change, a first read that fails; desk and phone.
- **See:** each step's note in the recipe's `steps.log`, and its captures: "<person> joined
  <organization> with your invitation.", "<person> is now an owner of <organization>." with Undo,
  "Revoked the invitation for anyone with the link.", "Removed <person> from <organization>", the
  removed person's browser at `/login?reason=access`. The person is removed, and every link the run
  made is revoked or used, with none left open: the link the person joined with is spent, and a
  revoke of it answers `409` `InvitationSpent` (the recipe's
  `links this run made: …; revoked …, used by the person who joined …`).
- **Mode:** `scripted` (recipes/org-members.mjs)
- **Box-only:** no
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
- **Areas:** `apps/web/src/components/session/shared-control.tsx`, `apps/web/src/`, `apps/api/src/`,
  `apps/cli/src/`

### shared-control.ask-and-grant

- **Map:** shared-control.md `ask`, `withdraw`, `grant`, `take-back`, `switch-ends-grants`,
  `sender-login`, `audit`
- **Needs:** Boat; one codex turn; CLI (`M` and `M2`) and two browsers once the web app asks and
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
- **Not on the box:** the second account starts this session with `M2 codex`, which needs its own
  Codex login, and it has none (Fixtures, the second account). Mend lets no account use another's
  agent login, and connecting a copy of the checker's would share one refresh token between two
  logins: the first refresh spends it for the other, the run's saved one included. No new login is
  coming for it (SLNT-1267, 22 Nov).
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
- **Box-only:** `boat`, `real-agent-turn`
- **Not on the box:** the second account starts this session with `M2 codex`, which needs its own
  Codex login, and it has none (Fixtures, the second account). Mend lets no account use another's
  agent login, and connecting a copy of the checker's would share one refresh token between two
  logins: the first refresh spends it for the other, the run's saved one included. No new login is
  coming for it (SLNT-1267, 22 Nov).
- **Areas:** `apps/web/src/components/session/shared-control.tsx`,
  `apps/web/src/lib/shared-control.ts`

### per-person-homes.two-people

- **Map:** per-person-homes.md `join-line`, `shared-workspace-line`, `runs-as-yourself` (the second
  person)
- **Needs:** Boat; no turn; CLI (`M` and `M2`) in tmux and web, one browser at a time (the owner's);
  `<second>`
- **Do:** In the owner's browser, on `<second>`'s Settings · General, choose `Everyone in Default`.
  In tmux, `M2 run --project <second> --name main-run-pp-<sha8> -- sleep 1800`; record `<b8>`. Go on
  only once `M2 sessions --project <second>` lists `<b8>` `running` (a session whose workspace image
  is still building reads `starting`: about 5 min on 22 Nov, before step 6's warm-up). In the
  owner's browser, on `<second>`'s Worktrees tab open `Actions for main-run-pp-<sha8>`, hover
  `New session in this worktree`, read the paragraph at the top of its submenu, then `Escape`. In
  tmux, `M run --project <second> --worktree main-run-pp-<sha8> -- sleep 1800`; record `<a8>`. Once
  both read `running`, `M sessions --project <second>`, and open `<web>/sessions/<a8's id>/details`.
  `M2 shell <b8>` and `M shell <a8>`, each running `id -un; id -u; echo $HOME`, then `exit`. Restore
  in the same flow: `M stop <a8>`, `M2 stop <b8>`, wait until both settle, remove the worktree as
  its owner (`M2 worktrees rm main-run-pp-<sha8> --project <second>`), and choose `Only you` on
  `<second>`'s Settings · General.
- **See:** the submenu's line
  `Main Run Second's session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.`;
  the owner's `run` prints `✓ joins worktree main-run-pp-<sha8> · 1 session · …` and the join line
  (record whether it prints: the map names it for harness launches); under both live rows of
  `M sessions --project <second>`, and in the Details view's `Workspace` → `Worktree` row,
  `Shared workspace with Main Run Second · each of you runs as yourself · either of you can read the other's files.`;
  two different `m` plus 8 character logins, each uid in 40001–49999 with its own `/home/<name>` (or
  uid `0` and the shared-home case, whose submenu line reads
  `Another person's session is running in this worktree, in a workspace that shares one home: …`;
  record which: the map says a first launch on an unchecked image can share one home).
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/web/src/components/session/shared-control.tsx`,
  `packages/domain/src/workbench/shared-workspace.ts`, `packages/sessions/`, `apps/cli/src/`

### operator.owner-grant-restore

- **Map:** operator.md `operator-only`, `org-create` (the refusal), `org-rename`,
  `org-invite-owner`, `grant-owner`, `reset-link` (the refusal), `operator-audit`,
  `instance-defaults` (the member's view); organization.md `operator-add-member` (the single-tenancy
  refusal)
- **Needs:** no session; no turn; CLI (`M` and `M2`) and web, one browser at a time, plus a fresh
  signed-out browser context; the owner account is the operator
- **Do:** `M2 operator org list`, `M2 operator gate`; `M operator org create Default` (refused: the
  name is taken. Never create a new organization here: the copies run multi tenancy, a create
  succeeds, and no command removes an organization; `organization.new-web-operator-create` shows a
  create); `M operator org rename Default main-run-renamed`, `M members`, then
  `M operator org rename main-run-renamed Default`, which restores the name in the same flow;
  `M operator org rename no-such-org x`;
  `M operator org add-member Default main-run-second@example.test`;
  `M operator org invite-owner Default --email main-run-owner@example.invalid`, open it in the
  signed-out context, then on Settings · Members, in `Invitations`, choose
  `Revoke the invitation for main-run-owner@example.invalid`;
  `M operator grant-owner Default main-run-second@example.test`, `M members`, then set
  `Main Run Second's role` (the row scoped by its email) to `Member`, which restores the role;
  `M operator grant-owner Default nobody@example.invalid`;
  `M operator reset-link nobody@example.invalid`; `M operator org list`. In the second browser read
  Settings' sidebar and open `<web>/settings/server`; in the owner's, read the audit log.
- **See:** both `M2` commands exit `1` with `mend: this account is not the operator of this Mend`;
  `mend: An organization named "Default" exists.`, exit `1`;
  `✓ renamed Default to main-run-renamed`, `M members` starting `main-run-renamed · 2 members`, and
  the rename back; `mend: no organization named "no-such-org"`;
  `mend: That account already belongs to Default.`, exit `1`; the owner link's line
  `owner of Default · for main-run-owner@example.invalid · works once · expires <date>` and, on the
  join page, `Join Default` with `You're invited to join Default on Mend as an owner. …`, then
  `No open invitations.`; `✓ main-run-second@example.test is an owner of Default` and `owner` in
  `M members`, then `member` again;
  `mend: No member of Default has that email. Invite an owner instead.` and
  `mend: No active account in an organization has that email.`, each exit `1`; the last
  `M operator org list` is the one line `Default  2 members · 1 owner`; the second account's sidebar
  has no `Server` group and `/settings/server` does not show it the `Server` page; the audit log has
  `Renamed the organization to main-run-renamed`, `Renamed the organization to Default`,
  `Created an invitation link to join as an owner, for one email address`,
  `Revoked an invitation link`, `Made Main Run Second an owner, as this server's operator` and
  `Made Main Run Second a member`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/`, `apps/cli/src/`,
  `apps/web/src/routes/_inbox.settings.organization.audit-log.tsx`

### shared-control.refuse-script

- **Map:** shared-control.md `share-refused` (the script case)
- **Needs:** Boat; no turn; CLI; `start-session.boat-live`
- **Do:** `M session share <id8> on < /dev/null`. Nothing changes. On the session page, once it has
  loaded, open `Share` to read it, choose nothing, and press `Escape`.
- **See:** `mend: non-interactive · pass --yes to turn shared control on`, exit `1`; the header's
  `Share` button, not pressed; its popover `Share this session` with the group `Shared control` and
  `Off` pressed. The owner never reads `Only <owner> steers this session. …`: that line is for a
  viewer who cannot steer.
- **Waiting on:** SLNT-1270 · the header's `Share` button and its popover (`Share this session`,
  `Shared control`, `Off`): the shipped app has no control that turns shared control on unprompted;
  the owner only grants it when asked, and Details reads `Shared control is off.`. The CLI refusal
  is still checked; the missing button is known.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`

### operator.read

- **Map:** operator.md `org-list`, `instance-defaults`
- **Needs:** no session; no turn; CLI and web; the owner account is the box's operator
- **Do:** `M operator org list`; in the owner's browser open Settings and choose `Server` in the
  sidebar's `Server` group (`/settings` opens Profile).
- **See:** `Default  2 members · 1 owner` (the owner and `fixtures.sh`'s second account; count words
  as printed), exit `0`; the `Server` page with `Operators of this server` under its title and the
  operator defaults: `Where sessions run` (each runtime `Offered` or `Not offered`),
  `Starting workspace image`, and `Organizations` with its `Default` row `2 members, 1 owner`. When
  the CLI prints `mend: this account is not the operator of this Mend`, the flow is
  `not run · not the operator`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`, `apps/web/src/components/settings/server-page.tsx`

### exposure.read

- **Map:** exposure.md `health-counts`, `exposure-report`, `tenancy-gate`, `shell-line`,
  `doctor-line`
- **Needs:** no session; no turn; CLI, HTTP and web; operator for the two `mend operator` commands
- **Do:** `curl -s $WEB/api/health`; `M operator exposure`; `M operator gate`; at 1280x800, open the
  sidebar's account button (`<name>, account`, its second line the server's `<host>:<port>`) and
  read its menu; the `exposure` line of `doctor.checklist`'s output.
- **See:** JSON with `"tenancy":"multi"`, `"tenancyGate":{"passed":true,"failing":[]}` and an
  `exposure` object naming no item; line 1 `exposure · declared <posture> · …`; the gate's ten `✓`
  items, ending `every item is in place; MEND_TENANCY=multi may start`; the account button reading
  `<name>` over `$WEB`'s `<host>:<port>`, and its menu's first lines `<name> · <email>` and
  `exposure · <posture> · <scheme>`, `<scheme>` being `$WEB`'s (`http` on a check VM copy, `https`
  behind an edge).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/exposure.ts`, `packages/network/`, `apps/cli/src/`

## This machine: the server and the CLI

### server.upgrade

- **Map:** server.md `server-upgrade`
- **Needs:** no session; no turn; lane A's copy over `MEND_VERIFY_BOX_SSH`; the run's data, with
  every earlier run's data in it, and the master's build pinned
- **Do:** SKILL.md step 4: deploy the preview of this commit over the master's build, on lane A.
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
- **Do:** `before.*` is the listing the previous run took just before it saved the run's data
  (SKILL.md, State: `$STATE/listing/`, copied in step 4); after the deploy, `M projects --json` and
  `M sessions --all --project <p> --json` into `after.*`. Then open the previous run's session's
  change as `review-change.web-review` does.
- **See:** every project and session id of `before` is in `after` with the same status; the old
  session page loads and its change still shows `MAIN-RUN.md` with `seen`. With no previous run, the
  listing half alone, and say so; with no saved listing, the session half alone, and say so.
- **Mode:** `agent`
- **Box-only:** `upgrade-real-data`
- **Sample:** yes
- **Areas:** `packages/db/`, `packages/store/`, `apps/api/src/`

### server.status-logs

- **Map:** server.md `server-status`, `server-logs`
- **Needs:** no session; no turn; the box's host CLI over `MEND_VERIFY_BOX_SSH`
- **Do:** On the box host, `mend server status` and `mend server logs --tail 20`. Change nothing.
- **See:** `Pinned Mend <version> at …`, the `exposure · declared …` line,
  `tenancy · declared multi` (multi tenancy is the default since #1916, and every master since 21
  Nov declares it) and `tenancy · observed multi · multi mode gate · nothing open · …`, and the
  containers up; at most 20 lines per container, exit `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/` (server), `scripts/preview-deploy.sh`

### doctor.checklist

- **Map:** doctor.md `doctor-checklist`, `doctor-exit-code`, `doctor-fix-commands`;
  provider-accounts.md `doctor-lines`
- **Needs:** no session; no turn; CLI; none
- **Do:** `M doctor`.
- **See:** `✓ server` naming `$WEB · mend <version>`; `✓ signed in  token accepted`; `✓ sealant` and
  `✓ codex … connected`; the `github` line reads `connected` or `· … not connected`, and the
  `claude` line `connected`, `· … not connected` or
  `· claude reconnect needed · the provider refused the login`, each recorded as found (the
  checker's Claude login is refused, left so by the owner: SLNT-1219); no `✗` line, exit `0`.
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
  `apps/web/src/components/settings/server-page.tsx`

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
- **Needs:** either; no turn; TUI (tmux 200x50, Node 26); `start-session.boat-run`, before any Codex
  turn in its worktree (`start-session.web-answer`'s Deny keeps `refused-check.txt` there by design,
  and on 22 Nov the review then read `2 files`)
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
| shared-control          | `share-refused` (opencode), a steered turn, `ask`, `withdraw`, `grant`, `take-back`, `switch-ends-grants`, `sender-login` (their flows say why)                                                                         | no opencode login; the second account has no agent login and the web sends no turn                                                                                |
| per-person-homes        | `layout-opt-out`, `no-way-back`, `layout-fallback`, `waiting-line`, `retirement` (in workspace-replace)                                                                                                                 | the first two restart the server with `MEND_HARNESS_LAYOUT=shared`; the fallback needs an image that cannot run per person; the waiting line needs a steered turn |
| operator                | `org-create` (an actual create), `reset-link` (a real link)                                                                                                                                                             | multi tenancy; a reset link nothing revokes                                                                                                                       |
| exposure                | `public-refusal`, `declared-items`, `budget-refusal`, `upgrade-tickets`, `url-bearers`                                                                                                                                  | each restarts the server with changed exposure variables                                                                                                          |
| server                  | `server-setup`, `server-repair`, `server-exposure-flags`, `server-edge`, `server-posture`, `server-offline`, `server-lifecycle`, `server-next-channel`, `server-lock`, `server-workspace-memory`                        | changes the box's install; the map drives them on a disposable host                                                                                               |
| uninstall               | all                                                                                                                                                                                                                     | a regression would remove the box's server or the sign-in the run may never touch                                                                                 |
| cli                     | `help-index`, `help-page`, `help-group`, `help-alias`, `man-page`, `usage-errors`, `unknown-command`, `completions`, `bare-mend`, `qr`                                                                                  | never call the server: `help.test.ts` and `main.test.ts` cover them; `qr` is in pairing-devices                                                                   |
| tui                     | `tui-new-worktree`, `tui-new-session`, `tui-attach`, `tui-auto-attach`, `tui-resume`, `tui-rename`, `tui-stop`, `tui-remove`, `tui-refresh`, `tui-snake`, `tui-adopt`, `tui-tunnels`, `tui-layout`, `tui-screen-mode`   | a local stack shows them; each new one leaves sessions                                                                                                            |
| desktop-app             | all                                                                                                                                                                                                                     | no desktop app on the run's machine (and not shipping)                                                                                                            |
| mobile-app              | all                                                                                                                                                                                                                     | no phone, and its web build needs an allowed origin the box does not list                                                                                         |
| vscode                  | all                                                                                                                                                                                                                     | no VS Code; its driver runs its own world                                                                                                                         |
| slack                   | all                                                                                                                                                                                                                     | not drivable yet; no Slack workspace                                                                                                                              |
| t3-gateway              | all                                                                                                                                                                                                                     | its recipe needs a local stack's gateway                                                                                                                          |

Flows: 141 total (22 Nov) · 74 scripted · 67 agent · 26 box-only · 2 with a `Not on the box:` line
(`shared-control.ask-and-grant`, `shared-control.new-web-ask-and-grant`) · 4 with a `Waiting on:`
line (`project-settings.read`, `models.list-picker`, `review-change.web-comments`,
`shared-control.refuse-script`). Features: 42 with a flow, 12 only in Not on the box (doppler,
workspace-replace, observed-agents, terminal-agent-waits, uninstall, pi-profile, mend-toml,
desktop-app, mobile-app, vscode, slack, t3-gateway): 54 of the map's 54 mapped features placed, none
left over.
