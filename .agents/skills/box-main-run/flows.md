# Flows on the box

Runs: the flows marked `Sample: yes`, until the owner picks a set on SLNT-1050. Every other flow is
listed so a person can read what a full pass would cover; a run reports it
`not run · not in this run's set`.

Every flow one run of [SKILL.md](SKILL.md) can use on the box (VM 131), as its signed-in owner,
after the preview of `main` is deployed. Each flow comes from the feature map
(`.agents/skills/verify/features/`, written "the map"); the feature file holds the exact handles,
commands and strings, and a flow points at it instead of copying them. Every feature in the map has
at least one flow here or a line in [Not on the box](#not-on-the-box). A PR that adds or changes a
feature adds or updates its flow here in the same PR. Ids are stable: reports, tickets and PRs name
flows by id, so rename one only with a note in the PR that does it.

`M` is the CLI under test, signed in as the box's owner account (never `mend login` or `mend logout`
it). `<p>` is the project `boat-check-ubuntu` (Ubuntu, branch `master`). `<sha8>` is the first 8
characters of the commit under test. `$E/<flow id>` is the flow's evidence directory. `<scratch>` is
a fresh `mktemp -d` directory of this run. Web flows run through
`.agents/skills/verify/scripts/drive-web.mjs`; `scripted` flows name their recipe, `agent` flows are
driven by the run's agent from the feature file.

Box facts the flows depend on: sessions run on Boat by default, and Docker is offered beside it; the
runtime is chosen per organization and a worktree keeps the runtime it was made on. One organization
(Default), one account, single tenancy. Provider logins on 16 Nov: codex and claude connected,
GitHub not. Flows use codex only until the owner says the run may spend Claude tokens (SLNT-1050).
Exactly one flow, `start-session.boat-turn`, runs a real agent turn (codex, a one-line prompt):
every turn spends the owner's tokens.

The map still names the project page's `Setup` tab. The web now has a project `Settings` tab with
sub-tabs (`General`, `Workspace`, `Services`, `Secrets`, `Git`, `Landing`, `Review`, `Folders`;
`apps/web/src/components/project/settings-sections.ts`), and app Settings has one page per section
(`/settings/devices`, `/settings/git-access`, …; old `#anchors` redirect). A flow that reads a Setup
section reads it in the matching Settings sub-tab, and reports a missing section as a map gap, not a
product failure.

## Fixtures

Made once by hand, kept on the box, and checked by each run before the flow that needs it. A missing
fixture makes its flow `not run · fixture <name> missing`; recreate it as written, and only while
you hold the box (`verify box prepare`).

- **The project** `<p>`: adopted by the owner account from its network origin. `M projects` lists
  it. To recreate: `M adopt <origin> --name boat-check-ubuntu` (adopt-project.md `adopt-cli`).
- **The Docker worktree** `main-run-docker` in `<p>`. To make it: on the web as the owner, Settings
  · Organization · Defaults, `Where new sessions run`: note the current choice (it read
  `Inherit · Boat` on 16 Nov), switch to Docker without moving anything; run
  `M run --project <p> --name main-run-docker -- sh -c 'echo docker > MAIN-RUN-DOCKER.md'`; put the
  noted choice back without moving anything. Made on 16 Nov. `M worktrees --project <p>` lists it.
- **The serve command** `<serve-cmd>`: a command the Ubuntu workspace image runs that listens on TCP
  port 8000 and answers HTTP (services.md: "Launch must confirm which command the image supports").
  Confirm it once with `M shell` in any live session, and write the command here. Until it is
  written, `services.cli-run` is `not run · fixture serve-cmd missing`.
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
2. `doctor.checklist`, `cli.help-version`, `exposure.read`, `operator.read`,
   `organization.read-invite`, `provider-accounts.read`, `models.list-picker`
3. `start-session.boat-turn`, `review-change.web-review`, `now-and-sessions.web-now`,
   `attach-resume.boat-stop-resume`
4. `start-session.boat-run`, `review-change.web-comments`, `send-review-back.open-only`,
   `land-change.panel-read`, `pull-change.boat-run`, `attach-resume.rename-web`, `tui.dashboard`
5. `start-session.docker-run`
6. `start-session.boat-live`, `attach-resume.attach-detach`, `session-shell.live-shell`,
   `shared-control.refuse-script`, `services.cli-run`, `capture-and-save.live-stop`
7. `worktrees.web-create-remove`, `handoff.held`, `now-and-sessions.inbox-settle`,
   `now-and-sessions.cli-lists`
8. The rest, in any order: `adopt-project.*`, `sign-in.fresh-browser`, `pairing-devices.mint-read`,
   `git-access.read`, `workspace-ssh.status`, the Personal setup and Project setup flows, then
   `doctor.bundle-web` last.

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
- **Do:** On `/projects`, open `Adopt a repository`, type a local path and read the refusal, close
  the panel; filter the directory by `<p>` and open its page.
- **See:** an alert with `Adopt` disabled; `1 of <n>` and one row for `<p>`; the project heading
  `<p>` with the `Worktrees` region.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/routes/projects.index.tsx`, `apps/web/src/components/project/`,
  `apps/api/src/adoptions.ts`

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
- **See:** on the Now inbox, the session's row menu `Open review` opens `/changes/<id>`, whose diff
  shows `MAIN-RUN.md` and the added line `seen`.
- **Mode:** `scripted` (recipes/session-review.mjs)
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/web/src/routes/changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

### review-change.web-comments

- **Map:** review-change.md `review-change-comment`, `review-comment-state`,
  `review-checkpoint-mark`, `review-pinned`, `review-files`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On the run session's review, add a change-level comment, dismiss and reopen it; on the
  session page choose `Mark checkpoint`; reload the review. Leave the comment open for the next
  flow.
- **See:** a card `<name> · open` and `1 open comment`; `dismissed` then `open`; a new
  `<n> · user-mark` checkpoint line; the `<sha A> → <sha B>` line unchanged on reload;
  `M sessions --project <p> --all --json` shows the session's `review.openComments` as `1`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/routes/changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

### send-review-back.open-only

- **Map:** send-review-back.md `send-open`, `send-select`
- **Needs:** either; no turn; web; `review-change.web-comments`
- **Do:** On the same review, choose `Send review to session`, uncheck the one comment, read the
  overlay, and close it without delivering. Delivering would resume the session and spend a turn.
- **See:** the overlay `Send review to the session` with
  `1 of 1 comments selected · resumes <branch>`, then `0 of 1` after the uncheck; after closing, the
  card still reads `open`, not `sent to session`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/`, `apps/api/src/`

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
- **Areas:** `apps/web/src/`, `apps/api/src/landing-state.ts`, `packages/landing/`

### services.cli-run

- **Map:** services.md `service-run-cli`, `service-observe`, `service-connect`, `service-logs`,
  `service-restart-stop`, `service-hold`
- **Needs:** Boat; no turn; CLI and web; `start-session.boat-live`, fixture `<serve-cmd>`
- **Do:** On the live session, as services.md's CLI steps: `service run` with
  `--name web --http --no-connect`, `service list`, `service connect web --port 18000` with one
  curl, `service logs`, `service restart`; then `M stop <id8>` and `M stop --services <id8>`.
- **See:** the session page's `Services` card lists `web` ending at `reachable`; curl prints `200`;
  `mend stop` names what keeps the workspace up ending `· mend stop --services <id8>`; then
  `✓ stopped 1 service · …` and `no live services — …` from `service list`.
- **Mode:** `agent` · a recipe would make it cheaper (the card half)
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `apps/api/src/`, `apps/cli/src/`, `packages/network/`

## Access and identity

### sign-in.fresh-browser

- **Map:** sign-in.md `registration-closed`, `web-sign-in`, `web-sign-out`, `authorize-page`
- **Needs:** no session; no turn; web; a fresh browser context (not the saved `browser.json`)
- **Do:** In a context with no saved sign-in, open `/settings`, sign in with the account file, open
  `/authorize` with no code, then `Sign out`. The saved browser state other flows use is untouched.
- **See:** `/login?next=%2Fsettings` with the heading `Sign in` and
  `Accounts are created by invitation. …`; after sign-in the heading `Settings`;
  `No code to authorize`; after sign-out, `/login`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `packages/auth/`, `apps/web/src/routes/login.tsx`, `apps/web/src/routes/authorize.tsx`

### pairing-devices.mint-read

- **Map:** pairing-devices.md `pair-web`, `pair-cli`, `device-list`, `qr-render`
- **Needs:** no session; no turn; web and CLI; none
- **Do:** On Settings → Devices choose `Pair a phone`, read the panel, `Done`; run `M pair`,
  `M pair --url http://not-configured.invalid`, `M qr hello`, `M qr`. Claim no code.
- **See:** a code `XXXX-XXXX` with a countdown `expires in m:ss` that falls; `✓ pairing code …` and
  `  expires in 10 min · one device, once`; the `--url` refusal and `mend: usage: mend qr <text>`,
  each exit `1`; the device list names this CLI's device as `cli · paired …`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/routes/settings.devices.tsx`, `apps/cli/src/`, `apps/api/src/`

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
- **Areas:** `apps/cli/src/`, `apps/web/src/routes/settings.git-access.tsx`, `apps/api/src/`

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
- **See:** one block per harness with `default` on one model; JSON `"version": 1` with the same ids;
  the menu's default model row `aria-checked="true"`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web/src/`, `apps/api/src/`

## Personal setup

### dotfiles.read

- **Map:** dotfiles.md `dotfiles-show`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M dotfiles`; read Settings → Dotfiles.
- **See:** `repo …` and `snapshot …` lines (`none` or the saved values); the panel footer
  `repo · … — snapshot · …` agrees.
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
  reload Settings, try the `not-an-email` refusal, then `M git-author --clear`. When a setting is
  already saved, only show it and stop.
- **See:** `✓ git author · Verify Cli <verify-cli@example.com> · your setting`; the web panel reads
  `your setting`; the refusal, exit `1`; after the clear, `· your account's name and email`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/git-author.ts`, `apps/api/src/`, `apps/web/src/`

### skills.read

- **Map:** skills.md `skills-list`, `skills-push-project` (the listing)
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** `M skills`, `M skills --project <p>`; open `/skills`.
- **See:** the library entries or `no skills in your library — …`; the same for `<p>`; the heading
  `Your skill library`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/web/src/routes/skills.index.tsx`, `apps/api/src/`

### agent-memory.read

- **Map:** agent-memory.md `memory-list`
- **Needs:** no session; no turn; CLI; `<p>`
- **Do:** `M memory --project <p>`.
- **See:** the list, or `<p>: no agent memory yet · mend memory import brings this machine's`; exit
  `0`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/agent-memory.ts`, `apps/api/src/`

### pi-profile.dry-run

- **Map:** pi-profile.md `pi-profile-dry-run`, `pi-profile-refused`
- **Needs:** no session; no turn; CLI; a disposable agent directory in `<scratch>` as pi-profile.md
  builds it
- **Do:** `M connect pi --dir <scratch>/pi-agent --dry-run`, then the same with
  `--dir <scratch>/missing`.
- **See:** `pi profile · <scratch>/pi-agent · 2 files · …` ending `  --dry-run: nothing sent`, exit
  `0`; the missing directory refused, exit `1`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`

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
- **Do:** `M env show --project <p>`; open `<p>`'s environment settings, type `MEND_X` as a key,
  read the refusal, and leave without saving.
- **See:** the stored names per lane, never a value (or `  nothing stored — …`);
  `The MEND_ prefix is reserved for Mend itself.` with `Save` disabled.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/env.ts`, `apps/web/src/components/project/settings/`, `apps/api/src/`

### cluster-bindings.read

- **Map:** cluster-bindings.md `cluster-show`, `cluster-local-runner`
- **Needs:** no session; no turn; CLI and web; `<p>`
- **Do:** Read `<p>`'s `Cluster bindings` panel and the cluster lines of `M env show --project <p>`.
  Bind nothing.
- **See:** either the panel with `No cluster bindings.` and its form, or the degraded panel of a
  non-Kubernetes install (record which); no `cluster binding` line in `env show`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/settings/`, `apps/api/src/`

### workspace-images.read

- **Map:** workspace-images.md `image-project-override` (the panel read),
  `image-organization-default` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s `Workspace image` panel and the organization default in Settings. Open no
  editor.
- **See:** `ubuntu · <n> packages · …` with `inherited` or `project override`, and `Edit…`; the
  organization line ends with its source.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/settings/`, `apps/api/src/`

### automatic-install.read

- **Map:** automatic-install.md `install-detected`, `install-colocated`
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s `Dependencies` card.
- **See:** `automatic install` with `on` or `off` pressed and a `detected · …`, `runs · … · custom`
  or `off · …` line, or `Capture mode only. …` (record which).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/settings/`, `apps/api/src/`

### hot-sessions.read

- **Map:** hot-sessions.md `hot-status`, `hot-count` (read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s `Hot sessions` section. Change no count.
- **See:** `off` with the count `0` and `Keep one fewer workspace ready` disabled, or the status
  words the map lists for a raised count (record which).
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/settings/`, `apps/api/src/preview-pools.ts`,
  `packages/sessions/`

### project-settings.read

- **Map:** project-settings.md `settings-background`, `settings-review-automation`,
  `settings-landing`, `settings-org-defaults` (all read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s session, review automation and landing switches, and Settings → Organization
  · Defaults. Choose nothing.
- **See:** each project switch with one of `inherit`, `on`, `off` pressed; the five organization
  rows with one of `Instance · on|off`, `On`, `Off` pressed.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/settings/`,
  `apps/web/src/routes/settings.organization.defaults.tsx`, `apps/api/src/`

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
  `apps/web/src/routes/settings.organization.folders.tsx`

### mend-toml.init

- **Map:** mend-toml.md `toml-init`
- **Needs:** no session; no turn; CLI; `<scratch>/init` outside any repository, holding only the
  map's `package.json`
- **Do:** In `<scratch>/init`, `M service init < /dev/null`, then `M service init --yes`, then
  again.
- **See:** `proposed …/mend.toml:` with `[service.web]`, then
  `mend: non-interactive — pass --yes to write the file`, exit `1`; `✓ wrote …/mend.toml — …`, exit
  `0`; the third refused with `already exists — edit it directly (init never merges)`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`

## Sessions

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
- **Mode:** `agent`
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/cli/src/`, `apps/api/src/`

### now-and-sessions.inbox-settle

- **Map:** now-and-sessions.md `inbox-snooze-settle`, `inbox-folds`, `inbox-filters`,
  `home-composer` (read), `rail`
- **Needs:** either; no turn; web; `start-session.boat-run`
- **Do:** On `/`, settle the run session's `Ready to review` row, open `Settled`, and use
  `Back to the inbox` on it, so the flow ends where it began; narrow the inbox by `<p>` and clear
  it. Type no prompt.
- **See:** the row leaves `Ready to review` and reads `settled just now` under `Settled`, then is
  back; the project filter shows only `<p>`'s rows; the heading `What should an agent work on?`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.tsx`, `apps/api/src/`

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
- **Areas:** `packages/sessions/`, `apps/web/src/routes/_inbox.sessions.$sessionId.tsx`,
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
- **Areas:** `apps/cli/src/attach-terminal.ts`, `apps/api/src/`, `packages/sessions/`

### attach-resume.rename-web

- **Map:** attach-resume.md `rename-web`
- **Needs:** either; no turn; web and CLI; `start-session.boat-run`
- **Do:** On the run session's page choose `rename`, set `main-run label`, then clear it again.
- **See:** the heading shows the label and `M sessions --all --project <p>` agrees; after the clear,
  the heading is back to its earlier title.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/routes/_inbox.sessions.$sessionId.tsx`, `apps/api/src/`

### session-shell.live-shell

- **Map:** session-shell.md `shell-cli`, `shell-holds`; per-person-homes.md `runs-as-yourself`;
  repositories-in-session.md `repo-list`, `repo-projects`, `repo-session-card`
- **Needs:** Boat; no turn; CLI in tmux and web; `start-session.boat-live`
- **Do:** `M shell <id8>` in tmux; in it run `id -un; id -u; echo $HOME`, `mend repo list`,
  `mend repo projects`, and write `/workspace/repo/SHELL.md`; detach with `Ctrl+]`. Read the session
  page's `Repositories` card. The shell stays open for `services.cli-run`.
- **See:** `✓ shell in … session <id8> · <branch> · detach: Ctrl+]`; a login `m` plus 8 characters,
  a uid in 40001–49999 and `/home/<name>` (or the shared-home line, record which);
  `no repositories beside /workspace/repo · …`;
  `detached — the shell keeps running and holds the workspace open`.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/`, `packages/sessions/`, `apps/api/src/`

### capture-and-save.live-stop

- **Map:** capture-and-save.md `capture-stop-line`, `capture-sessions`; session-shell.md
  `shell-holds` (end)
- **Needs:** Boat; no turn; TUI and CLI; `services.cli-run`
- **Do:** Rejoin the open shell from the dashboard as session-shell.md's "Rejoin" says, `cat` the
  file and `exit`; then read `M sessions` and `M sessions --project <p> --all --json` until the
  session settles.
- **See:** `no live terminal · rejoining the open shell` and `from the shell`; while it saves, a
  `stopping` row with a `saving …` line and a `capture` object with `"notSaved": false`; then the
  session settled. A drain that ends before the first read is reported as not seen.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `packages/sessions/`, `packages/store/`, `apps/api/src/`, `apps/cli/src/`

### worktrees.web-create-remove

- **Map:** worktrees.md `worktrees-tab`, `worktrees-new`, `worktrees-view`, `worktrees-menu`,
  `worktrees-remove`, `worktrees-cli`; start-session.md `start-new-worktree`
- **Needs:** no session; no turn; web and CLI; `<p>`
- **Do:** On `<p>`'s Worktrees tab create `main-run-wt-<sha8>`, read it with
  `M worktrees --project <p> --json`, switch to `Cards` and back to `List`, open its menu and remove
  it.
- **See:** the dialog's `branch mend/main-run-wt-<sha8>`; the row with `0 sessions`; JSON with
  `"version": 2` and that name; after removal it is gone from both views.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/web/src/components/project/tabs/worktrees.tsx`, `apps/api/src/`,
  `packages/store/`

### pull-change.boat-run

- **Map:** pull-change.md `pull-fetch`, `pull-again`, `pull-not-a-clone`
- **Needs:** no session; no turn; CLI and git; `start-session.boat-run`; `<p>`'s origin cloneable
  from this machine into `<scratch>/clone`
- **Do:** `M pull main-run-run-<sha8> --project <p>` in `<scratch>` (not a repository), then in the
  fresh clone twice.
- **See:** `mend: … is not a git repository · …`, exit `1`;
  `✓ fetched mend/main-run-run-<sha8> · … · created` and `git show <branch>:VERIFY.md` prints
  `verified`; the second pull ends `· already here`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `packages/local-git/`, `apps/api/src/`

### handoff.held

- **Map:** handoff.md `handoff-held`, `handoff-unchanged`, `handoff-row`
- **Needs:** Boat; no turn; CLI and web; a local clone of `<p>`'s origin in `<scratch>` with one
  commit and one untracked file on a branch `main-run/handoff-<sha8>`
- **Do:** Fingerprint the clone with the map's script, `M handoff` with no prompt, fingerprint
  again; read `M sessions --project <p>` and the project page's worktree row; stop the held session
  and remove its worktree with `M worktrees rm <name> --project <p>`.
- **See:** `✓ held · <status>, no agent`; the two fingerprints identical; `handed off from <host>`
  on the CLI row and the web row; the worktree gone afterwards.
- **Mode:** `agent`
- **Box-only:** `boat`
- **Areas:** `apps/cli/src/handoff.ts`, `packages/local-git/`, `apps/api/src/handoff-start.ts`

## Organization and sharing

### organization.read-invite

- **Map:** organization.md `members-cli`, `org-cli`, `members-web`, `invite-cli`, `invite-revoke`,
  `audit-log`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M members`, `M org`; `M invite --email main-run@example.invalid --days 1`; on Settings →
  Invitations revoke that link, which restores the list in the same flow; read the audit log.
- **See:** `<org> · 1 member` with the `▸` row `owner`; `M org` marks Default; the link, then the
  invitation gone and `<n> spent` unchanged; the audit log's newest lines name the invite and the
  revoke.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/`,
  `apps/web/src/routes/settings.organization.invitations.tsx`

### shared-control.refuse-script

- **Map:** shared-control.md `share-refused` (the script case)
- **Needs:** Boat; no turn; CLI; `start-session.boat-live`
- **Do:** `M session share <id8> on < /dev/null`. Nothing changes.
- **See:** `mend: non-interactive · pass --yes to turn shared control on`, exit `1`; the session
  page still reads `Only <owner> steers this session. …`.
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
- **Areas:** `apps/cli/src/`, `apps/api/src/`, `apps/web/src/routes/settings.instance.defaults.tsx`

### exposure.read

- **Map:** exposure.md `health-counts`, `exposure-report`, `tenancy-gate`, `shell-line`,
  `doctor-line`
- **Needs:** no session; no turn; CLI, HTTP and web; operator for the two `mend operator` commands
- **Do:** `curl -s $WEB/api/health`; `M operator exposure`; `M operator gate`; read the web
  sidebar's exposure line at 1280x800; the `exposure` line of `doctor.checklist`'s output.
- **See:** JSON with `"tenancy": "single"` and an `exposure` object naming no item; line 1
  `exposure · declared <posture> · …`; the gate ending `<k> of 10 items open; …`; the sidebar
  `exposure · <posture> · https`.
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
- **Mode:** `agent`
- **Box-only:** no
- **Sample:** yes
- **Areas:** `apps/cli/src/doctor.ts`, `apps/cli/src/doctor-boat.ts`, `apps/api/src/`

### doctor.bundle-web

- **Map:** doctor.md `doctor-bundle`, `doctor-bundle-redaction`, `doctor-bundle-options`,
  `doctor-web-connection`
- **Needs:** no session; no turn; CLI and web; none
- **Do:** `M doctor --bundle --out $E/doctor.bundle-web/bundle.tgz --tail 50`, then the map's mode
  and token checks on the archive (count the token's occurrences without printing it);
  `M doctor --bundle --tail 0`; on Settings, `Sealant connection` and `Check again`.
- **See:** the archive path and one line per file; mode `600`; the token count `0`;
  `mend: --tail is 1..2000`, exit `1`; the panel reads connected after `Check again`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/doctor-bundle.ts`, `apps/cli/src/doctor-bundle-collectors.ts`,
  `apps/web/src/routes/settings.sealant.tsx`

### cli.help-version

- **Map:** cli.md `help-index`, `help-page`, `help-group`, `help-alias`, `man-page`, `usage-errors`,
  `unknown-command`, `version`, `completions`, `bare-mend`
- **Needs:** no session; no turn; CLI; none
- **Do:** The map's steps: `M help`, the three ways to one page, `M help service`, `M help claude`,
  `MANPAGER=cat M man doctor`, `M completions`, `M nope`, `M version`, `M completions zsh`,
  `M | head -1`.
- **See:** `mend · the agent workbench`; three identical pages; `mend service · 8 commands`; the
  refusals naming `mend help`, exit `1`; `mend <v>` and `server <v> · $WEB` with no
  `versions differ` line; `#compdef mend`.
- **Mode:** `agent` · a recipe would make it cheaper
- **Box-only:** no
- **Areas:** `apps/cli/src/help.ts`, `apps/cli/src/`

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

| Feature                 | Sub-feature(s)                                                                                                                                                                                                                                                                      | Why not                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| adopt-project           | `adopt-web` (submit), `adopt-cli` (a new project), `adopt-visibility`, `adopt-tui`, `adopt-mobile`, `adopt-vscode`                                                                                                                                                                  | each run would leave a project; `<p>` was adopted once; phone, VS Code                |
| start-session           | `start-composer`, `start-in-worktree`, `start-tui`, `start-desktop`, `start-mobile`, `start-vscode`, `start-slack`, `session-attach-resume`                                                                                                                                         | a composer start spends a turn; desktop, phone, VS Code, Slack                        |
| review-change           | `review-inline-comment`, `review-machine-pass`, `review-desktop`, `review-mobile`                                                                                                                                                                                                   | inline has no stable handle; Mend's passes use inference; desktop, phone              |
| send-review-back        | `send-edit`, `send-deliver`, `send-pending`, `send-continue-cli`, `send-sent-state`, `send-tui`, `send-desktop`, `send-mobile`                                                                                                                                                      | delivering resumes the session and spends a turn; desktop, phone                      |
| land-change             | `land-web` (submit), `land-preview`, `land-cli`, `land-again`, `land-refused`, `land-check`, `land-observe`, `land-automatic`, `land-desktop`, `land-mobile-observe`, `land-slack`                                                                                                  | pushes to origin and opens pull requests; no GitHub login                             |
| services                | `service-run-web`, `service-recipe`, `service-add`, `service-tui`, `service-desktop`                                                                                                                                                                                                | a local stack shows them; `<p>` declares no `mend.toml`; desktop                      |
| sign-in                 | `first-account`, `cli-login`, `cli-logout`, `password-reset`, `desktop-connect`                                                                                                                                                                                                     | the CLI sign-in is never touched; a reset ends the owner's browser sessions; desktop  |
| pairing-devices         | `mint-by-hand`, `claim-mobile`, `revoke`, `unpair-mobile`                                                                                                                                                                                                                           | each run would add a device; no phone                                                 |
| provider-accounts       | `connect-grant`, `connect-my-login`, `connect-stdin`, `connect-github`, `connect-web`, `disconnect`, `reconnect-state`                                                                                                                                                              | would replace or remove the owner's codex login; no claude or GitHub credential       |
| git-access              | `bridge-share`, `adopt-auth` (a real adoption), mode switches                                                                                                                                                                                                                       | needs an ssh-agent and a private repository; changes the account's mode               |
| workspace-ssh           | `ssh-setup`, `vscode-setup`, `vscode-open`                                                                                                                                                                                                                                          | registers a key every run; VS Code                                                    |
| models                  | `desktop-picker`, `mobile-picker`, `vscode-picker`, `resume-with`                                                                                                                                                                                                                   | desktop, phone, VS Code; `--with` another harness needs claude                        |
| dotfiles                | all but `dotfiles-show`                                                                                                                                                                                                                                                             | replaces the owner's saved repository and snapshot; a local stack shows them          |
| secret-files            | `secrets-add-web`, `secrets-delivery`, `secrets-mobile-list`                                                                                                                                                                                                                        | a local stack shows them; phone                                                       |
| doppler                 | all                                                                                                                                                                                                                                                                                 | needs a real Doppler account                                                          |
| git-author              | `git-author-set-web`, `git-author-session`                                                                                                                                                                                                                                          | a local stack shows them                                                              |
| skills                  | all but `skills-list`                                                                                                                                                                                                                                                               | writes the owner's libraries; a local stack shows them                                |
| agent-memory            | all but `memory-list`                                                                                                                                                                                                                                                               | needs a checkout with Claude memory; delivery needs claude                            |
| pi-profile              | `pi-profile-save`, `pi-profile-dir`, `pi-profile-remove`, `pi-profile-session`                                                                                                                                                                                                      | writes the owner's saved profile; a local stack shows them                            |
| appearance              | `theme-desktop`, `theme-mobile`, `text-size-mobile`                                                                                                                                                                                                                                 | desktop, phone                                                                        |
| project-environment     | all but `env-show-cli`, `env-routing`                                                                                                                                                                                                                                               | changes `<p>`'s environment for every later session                                   |
| cluster-bindings        | all but `cluster-show`, `cluster-local-runner`                                                                                                                                                                                                                                      | needs operator-made Kubernetes objects; changes `<p>`                                 |
| workspace-images        | all but the panel reads                                                                                                                                                                                                                                                             | an image change rebuilds every later workspace                                        |
| automatic-install       | `install-custom`, `install-switch`, `install-in-session`                                                                                                                                                                                                                            | changes `<p>`; `<p>` is not a Node repository                                         |
| hot-sessions            | `hot-count` (change), `hot-claim`, `hot-rewarm`                                                                                                                                                                                                                                     | each ready standby is a live workspace on the box                                     |
| project-settings        | changes, `settings-visibility`, `settings-remove`, `settings-retention`, `settings-instance-defaults`                                                                                                                                                                               | organization-wide or `<p>`-wide settings other checks depend on                       |
| references-folders      | `ref-add`, `ref-select`, `ref-refresh-remove`, `folder-select`, `link-project`, `host-mounts`, `extras-delivery`                                                                                                                                                                    | needs a second project or an operator mount; changes `<p>`                            |
| mend-toml               | `toml-recipes-card`, `toml-run-cli`, `toml-project-recipes`, `toml-shadowed`, `toml-parse-error`                                                                                                                                                                                    | `<p>` has no `mend.toml`; changes `<p>`                                               |
| now-and-sessions        | `now-menus`, `now-mobile`, `now-desktop`                                                                                                                                                                                                                                            | a local stack shows the menu; phone, desktop                                          |
| attach-resume           | `resume-cli`, `rejoin-cli`, `delete-web`, `attach-tui`, `pickup-takeover`, `attach-tunnels`, `attach-image-paste`                                                                                                                                                                   | delete would remove sessions the next run reads; phone; a local stack shows the rest  |
| session-shell           | `shell-session-web`, `shell-session-tui`, `shell-tab-desktop`, `shell-mobile`                                                                                                                                                                                                       | a local stack shows them; desktop, phone                                              |
| worktrees               | `worktrees-toggle`, `worktrees-clear-settled`, `worktrees-hidden-ended`, `worktrees-refresh`, `worktrees-tui`                                                                                                                                                                       | clear-settled would remove worktrees the next run reads; a local stack shows the rest |
| workspace-replace       | all                                                                                                                                                                                                                                                                                 | needs a workspace marked to retire, and replacing stops what runs in it               |
| pull-change             | `pull-wrong-origin`, `pull-checked-out`, `pull-too-large`                                                                                                                                                                                                                           | a local stack shows them                                                              |
| handoff                 | `handoff-review-base`, `handoff-split`, `handoff-prompt`, `handoff-again`, `handoff-foreign-origin`, `handoff-hidden`                                                                                                                                                               | the prompt case spends a turn; a local stack shows the rest                           |
| repositories-in-session | `repo-add`, `repo-refusals`, `repo-review-line`, `repo-removal-hold`                                                                                                                                                                                                                | needs a second project                                                                |
| capture-and-save        | `capture-not-saved`, `capture-discard`, `capture-removal-hold`                                                                                                                                                                                                                      | needs a stalled or slow drain sized for the store                                     |
| observed-agents         | all                                                                                                                                                                                                                                                                                 | runs `claude` by hand in the workspace; no claude login                               |
| terminal-agent-waits    | all                                                                                                                                                                                                                                                                                 | its recipe runs in the VS Code driver's own world                                     |
| organization            | `invite-web`, `join`, `join-signed-in`, `join-refused`, `role-change`, `password-reset`, `member-removal`, `org-switch-cli`, `org-switch-web`, `org-per-sign-in`, `org-isolation`, `org-leave`, `org-access-key`, `operator-add-member`, `take-over`, `visibility`, `who-sees-what` | needs a second account or organization; multi tenancy                                 |
| shared-control          | all but `share-refused` (script)                                                                                                                                                                                                                                                    | needs a second account                                                                |
| per-person-homes        | all but `runs-as-yourself`                                                                                                                                                                                                                                                          | needs a second account; `layout-opt-out` restarts the server                          |
| operator                | `org-create`, `org-rename`, `org-invite-owner`, `grant-owner`, `reset-link`, `operator-only`, `operator-audit`                                                                                                                                                                      | changes the organization or needs a second account                                    |
| exposure                | `public-refusal`, `declared-items`, `budget-refusal`, `upgrade-tickets`, `url-bearers`                                                                                                                                                                                              | each restarts the server with changed exposure variables                              |
| server                  | `server-setup`, `server-repair`, `server-exposure-flags`, `server-edge`, `server-posture`, `server-offline`, `server-lifecycle`, `server-next-channel`, `server-lock`                                                                                                               | changes the box's install; the map drives them on a disposable host                   |
| uninstall               | all                                                                                                                                                                                                                                                                                 | a regression would remove the box's server or the sign-in the run may never touch     |
| cli                     | `qr` (covered by pairing-devices), live-id `completions`                                                                                                                                                                                                                            | a local stack shows them                                                              |
| tui                     | `tui-new-worktree`, `tui-new-session`, `tui-attach`, `tui-auto-attach`, `tui-resume`, `tui-rename`, `tui-stop`, `tui-remove`, `tui-refresh`, `tui-snake`, `tui-adopt`, `tui-tunnels`, `tui-layout`, `tui-screen-mode`                                                               | a local stack shows them; each new one leaves sessions                                |
| desktop-app             | all                                                                                                                                                                                                                                                                                 | no desktop app on the run's machine (and not shipping)                                |
| mobile-app              | all                                                                                                                                                                                                                                                                                 | no phone, and its web build needs an allowed origin the box does not list             |
| vscode                  | all                                                                                                                                                                                                                                                                                 | no VS Code; its driver runs its own world                                             |
| slack                   | all                                                                                                                                                                                                                                                                                 | not drivable yet; no Slack workspace                                                  |
| t3-gateway              | all                                                                                                                                                                                                                                                                                 | its recipe needs a local stack's gateway                                              |

Flows: 54 total · 3 scripted · 51 agent · 1 needing a real turn (`start-session.boat-turn`) · 11
box-only. Features: 44 with a flow, 10 only in Not on the box (doppler, workspace-replace,
observed-agents, terminal-agent-waits, uninstall, desktop-app, mobile-app, vscode, slack,
t3-gateway): 54 of the map's 54 mapped features placed, none left over. (The map's README says 53;
its tables list 54.)
