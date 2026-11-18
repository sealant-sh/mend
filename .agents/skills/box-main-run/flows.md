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
Three flows run a real agent turn, each with a one-line prompt: `start-session.boat-turn`,
`start-session.composer` and `send-review-back.deliver`. They use codex: the owner has far more
Codex capacity than Claude (17 Nov).

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
4. `start-session.boat-run`, `start-session.composer`, `review-change.web-comments`,
   `land-change.panel-read`, `pull-change.boat-run`, `attach-resume.rename-web`, `tui.dashboard`
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
   `operator.owner-grant-restore`, `shared-control.two-people`, `per-person-homes.two-people`, in
   that order and one at a time: several change `<land>`, `<second>` or a role, and each runs only
   after the one before it has put that back.

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
- **Areas:** `apps/web-old/src/routes/changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

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
- **Areas:** `apps/web-old/src/routes/changes.$changeId.tsx`, `apps/api/src/`, `packages/store/`

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
- **See:** the first `land` prints `  landing <branch> · <land> · session <id8> · …`, exit `1`, and
  `mend: landing not started · nothing new since the last landing`; the second prints
  `✓ pushed · <remote branch> · <sha>` with no pull request, `  checkpoint <sha>` and an
  `  observed` block, exit `0` (record the pull request line it prints, if any); the third's first
  `✓` line reads `pushed · main-run/push-only-<sha8> · <sha>`, exit `0`; the box's logs carry those
  shas; after the restore only `<remote branch>` holds this run's commits.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/cli/src/`, `apps/api/src/landing-state.ts`, `packages/landing/`

### land-change.refused

- **Map:** land-change.md `land-refused`, `land-observe` (`Check origin` after a refused push)
- **Needs:** either; no turn; CLI, web (the owner's browser) and `git` on the box;
  `land-change.cli-again`
- **Do:** Add unlanded work with
  `M run --project <land> --worktree main-run-land-<sha8> -- sh -c 'printf "refused\n" >> LAND.md'`.
  On the box, in a `mktemp -d` directory, clone `<git dir>/land.git` at `<remote branch>`, commit a
  file `OUTSIDE.md`, push it back, and record origin's head with
  `git --git-dir <git dir>/land.git rev-parse <remote branch>`. Run
  `M land main-run-land-<sha8> --project <land>`; read `rev-parse` again; on the review page's
  `Land` region choose `Check origin`. Restore: on the box, set the branch back to the sha Mend last
  pushed
  (`git --git-dir <git dir>/land.git update-ref refs/heads/<remote branch> <mend sha> <outside sha>`)
  and remove the clone.
- **See:** `· push refused · <remote branch> · <remote's words>`, exit `1`; origin's head is the
  outside commit before and after the `land`; the panel shows the refused landing and, after
  `Check origin`, a line stating what origin held; after the restore `rev-parse` prints Mend's last
  sha.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/api/src/workspace-landing.ts`, `packages/landing/src/git-words.ts`,
  `apps/web-old/src/components/land-panel.tsx`, `apps/cli/src/`

### services.cli-run

- **Map:** services.md `service-run-cli`, `service-observe`, `service-connect`, `service-logs`,
  `service-restart-stop`, `service-hold`
- **Needs:** Boat; no turn; CLI and web; `start-session.boat-live`
- **Do:** On the live session, as services.md's CLI steps:
  `M service run <id8> --port 8000 --name web --http --no-connect -- python3 -m http.server 8000`,
  `service list`, `service connect web --port 18000` with one curl, `service logs`,
  `service restart`; then `M stop <id8>` and `M stop --services <id8>`.
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
  marked `set for <p> · reset`, or `from your organization` or `from the instance default` when it
  follows; the section `Workspace environment · Default` with the line
  `<os> · <n> packages · from the instance` or `… · set for Default`.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`, `apps/api/src/`

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
  `settings-landing`, `settings-org-defaults` (all read)
- **Needs:** no session; no turn; web; `<p>`
- **Do:** Read `<p>`'s Settings → Landing sub-tab (`Sessions`, `Landing`) and Review sub-tab
  (`Review automation`), and Settings → Organization → Defaults. Choose nothing.
- **See:** the groups `Run sessions in the background`, `Land when a turn completes`,
  `Compose the description and tour`, `Suggest fixes` and `Name the session`, each with one of
  `Inherit · on|off`, `On`, `Off` pressed; under `Defaults · Default`, six groups
  (`Run sessions in the background`, `Compose the description & tour`, `Suggest fixes`,
  `Name the session`, `Land when a turn completes`, `Where new sessions run`), each with one of
  `Inherit · …`, `On`/`Off` (or `Docker`/`Boat`) pressed.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/project/settings/`,
  `apps/web-old/src/routes/settings.organization.defaults.tsx`, `apps/api/src/`

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
  and read `EXTRAS.txt` in its change. Choose `refresh` on `main-run-ref`. Restore in the same flow:
  set the folder's access back to `off`, `remove` the reference and the link,
  `M folder rm main-run-sel-<sha8>`, and `M worktrees rm main-run-extras-<sha8> --project <land>`.
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
  scoped to the second account's row by its email, which restores the role in the same flow;
  `M members`, `M2 invite`. Read the audit log.
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
- **Do:** `M invite --days 1` (link A). In the owner's browser on Settings · Invitations, make a
  `member` link bound to `main-run-other@example.invalid` (link B), `Done`. In the second browser,
  open `/join#not-a-token`, link A, then link B. In the owner's browser revoke links A and B, which
  restores the open list in the same flow. In the signed-out context open link A.
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

### shared-control.two-people

- **Map:** shared-control.md `share-on-web`, `share-off-web`, `share-cli`, `share-refused` (a
  non-owner), `viewer-lines`, `org-owner-off`, `terminal-owner-only`, `who-pays`, `audit`
- **Needs:** Boat; no turn; CLI (`M` and `M2`, `M2` also in tmux) and web, two browsers at once (the
  owner's and the second's, side by side); `<second>`
- **Do:** In the owner's browser set `<second>`'s `Visibility` to `shared`. In tmux,
  `M2 run --project <second> --name main-run-share-<sha8> -- sleep 1800`; record `<id>` and `<id8>`.
  Open `/sessions/<id>` in both browsers. `M session share <id8> on --yes` (as the owner). In the
  second browser: `On`, `Keep it off`, `On`, `Turn on`. Reload the owner's page; there choose
  `Turn off`. `M2 session share <id8> on --yes`, `M2 session share <id8> off`, and in tmux
  `M2 session share <id8> on` answered `n`. Read the audit log. Restore in the same flow:
  `M2 stop <id8>`, wait until it settles,
  `M2 worktrees rm main-run-share-<sha8> --project <second>`, and set `<second>` back to `private`.
- **See:** the owner's page reads
  `Only <second> steers this session. You can read the record and review the change.`; the owner's
  `share` exits `1` with `mend: only the session owner can share control of this session`; in the
  second browser `Off` pressed, the who-pays line (record which layout's words), the dialog
  `Turn on shared control?`, `Off` still pressed after `Keep it off`, then `On` pressed; the owner's
  page shows a read-only terminal line naming `<second>`, and
  `<second> shares control of this session.` with `Turn off`, then the viewer line again;
  `✓ shared control on · <harness> <id8>` and `✓ shared control off · …`, exit `0`;
  `shared control stays off`; the audit log names both turn-ons and both turn-offs with their
  people. Record whether a `mend run` session shows the switch at all: the map drives it on a
  harness session.
- **Mode:** `agent`
- **Box-only:** no
- **Areas:** `apps/web-old/src/components/shared-control-dialog.tsx`, `apps/web-old/src/`,
  `apps/api/src/`, `apps/cli/src/`

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
