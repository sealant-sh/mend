# VS Code extension

The Mend extension for VS Code (`apps/vscode`) lists a person's sessions in a `Sessions` view and
opens a session inside its workspace over Remote-SSH. The editor's files are then the session's
worktree, and its integrated terminal runs in the workspace, where Mend observes a `claude` or
`codex` started there. From the view a person starts a session (one quick input: her prompt, and the
harness, model, thinking, permissions and base behind its Change…), starts another session in the
same worktree, attaches a session's terminal in the current window, watches another person's session
read-only, stops a session, and opens it or its change in Mend's web app. The extension is published
as `sealant-sh.mend`. A verify run drives it live in a real VS Code with `scripts/drive-vscode.mjs`.
The driver builds the extension from a checkout, runs it with Microsoft's Remote-SSH on an Xvfb
display, and clicks the workbench DOM over CDP against a packaged Mend server in Docker-in-Docker.
Its evidence is numbered screenshots, a step log (`steps.jsonl`), the editor's and the server's
logs, and a video of the display. The flows below follow the stories in
`docs/specs/vscode-stories.md` (a to h) and say, per story, where today's extension differs.

## Sub-features

- `vscode-install` builds the extension from source (`dist/extension.js`) and packages
  `mend-<version>.vsix` (`<version>` is `apps/vscode/package.json`'s).
- `vscode-connect` is first run's sign-in (story h). Until `mend.serverUrl` names a server with a
  token for it, the view's welcome reads `Connect VS Code to your Mend server.` [Connect]: one URL
  input (a plain-http server elsewhere warns `Plain http: the token travels unencrypted`), Mend's
  approve page in the browser, one cancellable notification
  `Approve in the browser if it shows <code>` with the code kept in the status bar, then one toast
  `Signed in to <host> as <email>`; a denial, an expiry or an unreachable server ends in one error
  with [Try again]. With the Mend CLI signed in, the view's message reads
  `Mend at <host:port> · signed in as <email> (from the Mend CLI)` over one row, **Use it**. The
  account shows in VS Code's Accounts menu as `<email> @ <host> (Mend)`; its **Sign Out** (after VS
  Code's `Sign out of '<account>'?`) and `Mend: Sign out` revoke the editor's device. A token Mend
  refuses (401) is dropped in every window, with one `Signed out — sign in again.` toast, and
  Connect while connected revokes the device it replaces.
- `vscode-view` groups `Needs you`, `Since you last looked` and `Running` in any window that is not
  a session's workspace, always, an empty one reading `nothing`, then `Projects` (collapsed) once a
  project exists; a workspace window shows its own session as a row like any other (its name, its
  line beside it), on top even while it waits, and one line, `<n> other sessions · <n> needs you`.
  Rows read `<word> · <fact>`. The Mend icon's badge counts `Needs you`: a wait Mend observed that
  Answer lets her answer (a terminal agent's only for its owner, whoever launched its workspace,
  since Answer attaches it over Mend and not Remote-SSH; a conversation's for anyone who may steer
  it). Someone else's waiting terminal agent reads `waiting · <name>'s session` outside it. The
  status bar reads `Mend · 1 needs you · 2 finished`, or `● <session> · <word>` in a workspace
  window. One window of this VS Code toasts a wait (`<session> is waiting · <fact>` [Answer]), and
  only a focused one toasts a finished session (`<session> finished · <fact>` [Review] [Open]);
  neither toasts a session the window shows (its own, one selected in the view, or one whose agent
  tab is the active terminal). A sign-in Mend refuses (401) empties the view and toasts the server's
  words, `Signed out — sign in again.` [Connect to server] once.
- `vscode-answer` is `Mend: Answer` on a waiting row or toast: the agent's terminal attaches in this
  window's panel, and no window opens. Her own terminal agent attaches so in a workspace someone
  else launched.
- `vscode-adopt`: with no project yet, the view's message `Adopt <repo> from <origin>` over one row,
  **Adopt**, adopts the window's repository in one click; a window with no repository shows the
  welcome `Nothing adopted yet.` [Adopt a repository…], one input for a clone URL. The project takes
  the repository's name.
- `vscode-new-session` is `Mend: New session`: one quick input on the project the window's origin
  matched (else a project step with `Adopt this repository` on top), her prompt typed into an input
  box (an `InputBox`, which filters nothing, so a prompt of any length reaches the extension), one
  dim line `<harness> · <model> · … · from <base>` under it, and **Change…** on its title bar
  (harness, model, thinking, permissions, base, as lists, remembered per project). Enter starts a
  terminal agent and opens no window; a shell (Change… → `shell`) takes the typed text as its name
  and covers a worktree without an agent.
- `vscode-new-in-worktree` is the same quick input joined to a session's worktree
  (`New session · <project> · in <worktree>`).
- `vscode-open` is the session row's **Open** button (`Mend: Open`). It opens the session's
  workspace over Remote-SSH and follows VS Code's `window.openFoldersInNewWindow`: the default turns
  the current window into the workspace, `on` opens a new one. It never asks: a stopped session
  resumes as a shell, a missing Remote-SSH installs, as steps of the open's status bar progress. One
  open runs per session at a time; a second gesture joins it. A click or a double-click on the row
  only selects it.
- `vscode-open-new-window` is `Mend: Open in New Window` in the row's context menu: the same open,
  always in a new window.
- `vscode-attached-tab`: a session's workspace window attaches the session's live terminal as a tab
  named `<harness> · <session>` (`shell · <session>` for a shell session; an unlabelled session goes
  by its short id, `shell · d4355821`, though its row reads `claude · d4355821`), active and
  focused, with the banner
  `Mend · <session> · closing this tab detaches; the process keeps running`. Open in a window that
  already is the workspace focuses that tab and does nothing else.
- `vscode-continue-here`: a conversation's tab reads
  `<harness> is running as a conversation (from <where>) · Continue here to type to it`; its link
  moves the conversation into a terminal: a mode switch, `POST /sessions/:id/handoff {to:"pty"}`
  (the wire path keeps its old name; it is not `mend handoff`).
- `vscode-terminal` attaches a live session's terminal in the current window over `/api/tty`,
  without SSH.
- `vscode-watch-terminal` is `Mend: Watch terminal` on a session whose workspace another person
  launched, offered while they have shared control on. The tab is read-only and its banner reads
  `read-only · <owner>'s session`.
- `vscode-ssh-setup` is first run's **Set up**, the welcome after Connect
  (`Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend`) and
  `Mend: Set up workspace SSH`: it installs Remote-SSH if it is missing, registers this machine's
  key, writes one `Host` block (see [Workspace SSH](./workspace-ssh.md)), seeds Remote-SSH's
  platform, and records the consent, so no Open asks. **Skip for now** records that she skipped; the
  first Open then asks once, the modal
  `Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)` [Set up].
- `vscode-review` is review in the editor (story d): the **Change** section under Sessions, VS
  Code's diff and multi-diff editors over read-only `mend-change:` documents, and the slice picker.
- `vscode-stop` stops a live session; the worktree and change remain.
- `vscode-uri` opens a session from `vscode://sealant-sh.mend/open?session=<id>`.
- `vscode-bring-my-editor` installs the person's local extensions into a Mend workspace window
  (`mend.workspaces.bringMyEditor`).

## How to get to it (user POV)

- VS Code: the Mend icon in the Activity Bar opens the view `Sessions`. Its title bar holds
  `Mend: New session` (while Mend is unreachable a disabled twin, `Mend is offline · retrying`),
  `Mend: Refresh` and `Mend: Adopt a repository…`. Until first run is done it shows one step: the
  welcome `Connect VS Code to your Mend server.` [Connect], or the CLI's **Use it**; the welcome
  `Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend` [Set up] with the link
  `Skip for now`; with no project, **Adopt** for the window's repository or the welcome
  `Nothing adopted yet.` [Adopt a repository…]. When the view cannot read Mend, it shows one row
  naming the error, with the description `Run Mend: Connect to server`.
- VS Code: the Accounts menu in the Activity Bar lists `<email> @ <host> (Mend)` while connected;
  its submenu holds `Manage Trusted Extensions` and `Sign Out`.
- VS Code: on a project row, inline `Mend: New session`; its context menu holds it too.
- VS Code: on a session row whose workspace this person may open, inline `Mend: Open`. Its context
  menu holds `Mend: Open`, `Mend: Open in New Window`, `Mend: New session in this worktree…`,
  `Mend: Review change`, `Mend: Copy worktree path` and `Mend: Open in Mend` (rule 11: no row button
  opens the browser), and on a live session also `Mend: Open terminal` and `Mend: Stop session`.
- VS Code: on a session row whose workspace another person launched, no Open: inline
  `Mend: Review change`, plus `Mend: Watch terminal` while that person has shared control on. The
  row's tooltip ends `<launcher> launched this workspace · Remote-SSH opens it only for them`. Its
  context menu holds `Mend: Watch terminal` (shared control on), `Mend: Review change`,
  `Mend: Stop session`, `Mend: Copy worktree path` and `Mend: Open in Mend`.
- VS Code: a click or a double-click on a session row selects it and runs nothing.
- VS Code: while an open runs, the status bar item `Mend: opening a session` reads
  `installing Remote-SSH · <n> s`, `setting up workspace SSH · <n> s`,
  `starting <session>'s workspace · <n> s` or `opening <session>`.
- VS Code: the Command Palette lists every command, titles verbatim: `Mend: Refresh`,
  `Mend: Connect to server`, `Mend: Use the Mend CLI's sign-in` (while the view offers it),
  `Mend: Sign out`, `Mend: Skip workspace SSH setup for now` (while the view offers Set up),
  `Mend: Adopt this repository` (while the view offers it), `Mend: Adopt a repository…`,
  `Mend: Open`, `Mend: Open in New Window`, `Mend: Answer`, `Mend: Choose a session`,
  `Mend: Open terminal`, `Mend: Watch terminal`, `Mend: Review change`,
  `Mend: New session in this worktree…`, `Mend: Open in Mend`, `Mend: Copy worktree path`,
  `Mend: Set up workspace SSH`, `Mend: Stop session`, `Mend: New session` (left out while Mend is
  unreachable), `Mend: Show project sessions`, `Mend: Bring my editor into this workspace`,
  `Mend: Show workspace editor log`.
- VS Code: the status bar item `Mend · <n> needs you · <n> finished · <n> running` (only the parts
  that are not zero; `Mend` alone otherwise), which shows the Mend view; offline
  `Mend · last heard at <hh:mm>`. In a session's workspace window two items, the session's dot and
  `<session> · <word>`; both open the picker titled `Mend sessions`.
- VS Code: the Mend icon's badge, the number of sessions under `Needs you`.
- VS Code settings: `mend.serverUrl`, `mend.workspaceSshHost` and `mend.workspaces.bringMyEditor`.
- URI: `vscode://sealant-sh.mend/open?session=<session-id>`; without `session` it shows the Mend
  view.
- CLI: `mend login` writes the connection the extension offers as **Use it**; `mend ssh setup` is
  the terminal's half of `Mend: Set up workspace SSH` (the key and the `Host` block).
- Docs: `apps/docs/src/content/docs/clients/vscode.md`.

## Driving it with verify

The driver's contract is the header of `scripts/drive-vscode.mjs`, and the helpers a recipe receives
are the object `workbenchHelpers` returns in `scripts/drive-vscode.workbench.mjs`. A recipe is a
module whose default export is `async (helpers) => {}`. The recipes:

- `recipes/vscode-open.mjs` drives stories c and e against either build of the extension: the row's
  open button is found by `inline(/^Mend: Open( in VS Code)?$/)`. It calibrates `opens()` (two opens
  with a gap: +1, then +2), then asserts the story at every step. Today's extension fails it at the
  double-click; the redesign passes.
- `recipes/vscode-new-session.mjs` drives story a on an extension with flow 3: New session's quick
  input, a start that opens nothing, Change…, an unpushed base, a folder no project matched, a
  launch that fails and its Retry, and New session offline.
- `recipes/vscode-open-first.mjs` drives the first open on a machine without Remote-SSH, from
  `up --no-remote-ssh`.
- `recipes/vscode-first-run.mjs` drives story h. Which half runs is the world's: from
  `up --signed-out --no-ssh-setup --no-remote-ssh`, Connect through Sign Out; from
  `up --cli-only --no-ssh-setup --no-remote-ssh`, Use it, a skipped Set up, Connect cancelled while
  its request is out, and Open's one question cancelled, then answered.
- `recipes/vscode-open-as-built.mjs` drives #1080's extension as built: a session started from the
  palette, its row double-clicked with what that shows and opens counted, one open through to the
  workspace window's files and terminal. It needs the `Mend: Open in VS Code` manifest. Run `trunk2`
  (2026-10-19, `1a7196046`): the start's window `opens 0 → 1`; the double-click `opens 1 → 1`, 0
  windows, the pick `<session> is running` shown once and left open, while the server's `ssh-target`
  lines read `4 → 5` from the start window's teardown; its answer `opens 1 → 2`.
- `recipes/vscode-handoff-row.mjs` drives a session `mend handoff` made (story g's row): a commit on
  a new branch and one uncommitted edit, `mend handoff --yes` in the checkout (`via: "setup"`), then
  the row named after the received worktree reads `idle · handed off from <machine>`, its tooltip
  says it, and the worktree's `handoff.machine` in `GET /projects/<id>` is the machine the row
  names. It reloads the window first, so an extension rebuilt after `up` is the one under test. The
  branch is named per run (`verify-handoff-<base36 time>`), and a last setup step puts the checkout
  back on the branch it started on, the edit discarded and the branch deleted, so a second run and
  the recipes after it start clean. Run `v6prov` (2026-10-22, server `0.0.0-dev.shac1ddcd1da5c2`):
  the row read `starting · booting`, then `verify-handoff` `idle · handed off from nix-pc`, all 8
  steps passed.

Preconditions:

- Docker on this machine holds the server image `up` names, and `code` is on `PATH`. `VSCODE_BIN`
  names VS Code's Electron binary (the launcher `code` cannot take a debugging port), as the skill's
  Drive section sets it.
- ffmpeg is on `PATH` for the video (`nix shell nixpkgs#ffmpeg`). Without it `up` records nothing
  and says so.
- Playwright is installed at `$MEND_VERIFY_PLAYWRIGHT` (default `~/.cache/mend-verify/playwright`),
  never in this repository.
- The world is the driver's own, never the stack Launch made. It holds one account, one adopted
  project (written `<project>`, `state.project.name` in a recipe, `st-vscode-<run>`), one
  fresh-worktree session already run and stopped so the workspace image exists, and a local clone of
  the project open in the first window. By default the editor is signed in and workspace SSH is set
  up.

The commands, from the repository root:

- **Boot.**
  `VSCODE_BIN=$(dirname "$(readlink -f "$(which code)")")/../lib/vscode/code node .claude/skills/verify/scripts/drive-vscode.mjs up --version <v>`.
  In place of `--version <v>` (a preloaded `ghcr.io/sealant-sh/mend:<v>`), pass `--image <ref>` (any
  image on this machine's Docker) or `--build` (one built now from the checkout's Dockerfile).
  `--extension <checkout>` runs another checkout's `apps/vscode`. By default the CLI is signed in
  and `mend.serverUrl` names its server, as after **Use it**. `--signed-out` leaves no CLI
  connection and no setting; `--cli-only` leaves the CLI signed in and the editor not connected;
  `--no-ssh-setup` leaves workspace SSH and Remote-SSH's platform unset; `--no-remote-ssh` leaves
  Microsoft Remote-SSH uninstalled, so the first open installs it from the gallery (the ledger's
  `remoteSsh` is `false`); `--no-video` records no video. `up` prints
  `export MEND_VERIFY_VSCODE_RUN=<run>`; run that line.
- **Run a recipe.**
  `node .claude/skills/verify/scripts/drive-vscode.mjs run <recipe.mjs> --out "$E_vscode/vscode-<letter>"`.
  `--timeout <ms>` sets the wait per gesture (default 30000). It exits `0` when the recipe ends and
  `1` when a step fails.
- **Collect the logs.** `node .claude/skills/verify/scripts/drive-vscode.mjs logs`. The editor's
  logs (main, renderer, extension host, the output channels, Remote-SSH's) and the server
  container's are copied redacted into `<evidence>/logs`.
- **Tear down.** `node .claude/skills/verify/scripts/drive-vscode.mjs down`. It ends the editor,
  ffmpeg and Xvfb by pid, removes the daemon and the scratch, scans the evidence, then removes the
  private directory. Running it twice, or after a crash, converges.

Proof rules:

- Screenshots are numbered per recipe (`01-mend-view.png`, `02-…`), each with a `.png.checked`
  digest beside it. A window whose text shows a credential keeps no image; `<name>.png.withheld`
  says why.
- Every gesture runs inside `step(name, fn)`, one redacted line of `steps.jsonl` with what was done,
  what was observed, the step's screenshot and its timing. A step that calls the server to set up
  state or to read what Mend observed says `via: "api"`. The action under test is always a DOM
  gesture (`via: "dom"`), never an `api` call.
- A failing recipe keeps `failure-<n>.png` and the logs, and exits `1`.
- Each observation is written as a count or a quoted text (`2 windows opened · observed`,
  `row "claude · 1a2b3c4d running"`). Where the story and today's extension differ, the step names
  both the story's expectation and the observation.

The flows. Each story is one recipe; a `<label>` is a session row's visible label, the session's
label or `<harness> · <id8>` when it has none (the as-built recipe reads it with `api`). In the
world a session started on a prompt keeps `<harness> · <id8>`: the launch queues the `name-session`
job, whose inference runs on the session owner's connected Claude, then Codex, login, and the fake
logins are refused (Core answers `/v1/inference/respond` with 409 for Claude, then 404 or
`The Codex login did not authenticate`; the job fails, retries, and dead-letters). With a real login
the row takes the job's name.

- **a. Start a session and keep working.** `recipes/vscode-new-session.mjs`, from the default `up`,
  on an extension with flow 3 (`Mend: New session` is one quick input). Claude is connected with
  `FAKES.claude` and, for Change…, Codex with `FAKES.codexAuth`
  (`mend connect <provider> --from-stdin`, `via: "setup"`); `window.openFoldersInNewWindow` is `on`,
  so Open keeps the local window. `<base>` is the project's default branch (`master` for
  octocat/Hello-World). Runs `ns1` and `ns3` (2026-10-19, flow 3 at `cabb426c8`, server
  `0.0.0-dev.shab2a748d64120`) passed every step; `ns2` stopped at Change… on a race in the recipe
  (it read a step's title over the last step's rows), fixed by reading a step once two samples
  agree. Runs `nsr1` and `nsr2` (flow 3 rebased onto #1088's round 2, server
  `0.0.0-dev.shae93b27a70513`, each from a fresh `up`) passed all 29 steps. Runs `nsq1` and `nsq2`
  (#1092's round 2, server `0.0.0-dev.sha7a79816ce884`, each from a fresh `up`) passed all 37 steps;
  `recipes/vscode-open.mjs` then passed its 53 on `nsq1`'s world. Runs `ns3r1` and `ns3r2` (#1092
  rebased onto #1088's round 3, server `0.0.0-dev.shad6ba271e66a9`, each from a fresh `up`) passed
  all 37 steps. In the server's log the created session's first read of its own began about 480 ms
  after the create answered: the stream's project read came first, about 230 ms after, and the
  session read waited the 250 ms batch gap behind it. The row itself shows when the create answers.
  #1092's round 3 (server `0.0.0-dev.sha00132ab6f8bf`, which names the unknown base): runs `ns4r1`
  and `ns4r2` passed all 41 steps on the QuickPick prompt; `recipes/vscode-open.mjs` then stopped at
  its step 8 on `ns4r1`'s world (`Your Claude login needs reconnecting`: the new-session lanes leave
  the fake login marked), and passed its 53 on a fresh world, `ns4o1`. Runs `ns5r1` and `ns5r2` (the
  prompt an InputBox, the same server) passed all 43 steps, and `ns5o1` passed
  `recipes/vscode-open.mjs`'s 53 on a fresh world. The lanes, in an order where each leaves the next
  a usable world:
  - a1. `palette("Mend: New session")`: one input box, `quickInput.step()` reads the title
    `New session · <project>` with no counter, placeholder `What should claude do?`, no rows,
    `quickInput.message()` reads the dim line `claude · default model · from <base>` undecorated (VS
    Code's own `(Press 'Enter' to confirm or 'Escape' to cancel)` split off as its `hint`), and the
    title bar's buttons (`quickInput.buttons()`) hold `Change…`.
  - a2. `watch()`, then `quickInput.type(<prompt>)` and Enter. The input closes; `viewRows()` is
    sampled every 150 ms for rows that were not there before: the first one's delay after Enter, a
    `<label> · starting · …` sample (`shot("row-starting")`), then `running`. Over the API
    (`via: "api"`): exactly one new session, harness `claude`, its live process `agent-pty` (a PTY
    launch) with `argv` ending in the prompt.
  - a2, a3. `opens()` and `windows()` unchanged, the watch caught no toast and no dialog, and
    `statusBarItems()` holds `Mend · 1 running`.
  - Flow 1 on it: the row's `inline(/^Mend: Open$/)`: one window, `opens` +1 (which also shows the
    counter that read unchanged above works), the tab `claude · <label>` active, and the terminal
    shows the prompt or claude's `401`.
  - Change…: a second prompt typed, `quickInput.button("Change…")`; each step reads `(<n>/<total>)`
    after the title and its placeholder: `Harness` (`codex` picked), `Model for codex`
    (`quickInput.back()`: back to `Harness`), `codex` again, `Model for codex` (a non-default model
    of `/harnesses/models` with no efforts of its own picked), then each later step
    (`Thinking for <model>`, `Permissions`, `Base: a branch or commit`) keeps the row marked
    `check`. The prompt step returns with the second prompt typed and the dim line
    `codex · <model> · …`. Enter: one session, harness `codex`, `model` that id, `argv` holding it
    and ending in the prompt. New session again: the dim line starts `codex · <model> · `, and
    Change…'s `Harness` step marks `codex` with `check` and `remembered for <project>`.
  - The join title: `treeItem(<a2's label>).contextMenu("Mend: New session in this worktree…")`. The
    title reads `New session · <project> · in <label>'s worktree`, never `wt-<uuid>`. Escape.
  - Base not in the store (`via: "setup"`): `git switch -c verify-unpushed` and an empty commit in
    the window's checkout. New session's dim line ends
    `from <base> · your branch verify-unpushed isn't pushed`, decorated `warning` (the box's
    validation message). The checkout goes back to `<base>`.
  - The base is the ref that proved it. `git switch -c verify-tracks --track origin/<base>`
    (`via: "setup"`): the dim line ends `from <base>` with no `warning`; Enter, and the created
    session's worktree in `GET /projects/<id>` has `baseRef` `<base>` and `baseSha` the checkout's
    `origin/<base>` (`via: "api"`). Then a local `test` at `origin/test` (Hello-World has one) with
    `--set-upstream-to origin/<base>`, as `git push origin test` without `-u` leaves it: the line
    ends `from test`, and the worktree's `baseRef` is `test` at `origin/test`. Then `verify-gone`
    with `git update-ref refs/remotes/origin/verify-gone HEAD`, a ref origin does not have: Enter
    keeps the input open with the prompt and the line
    `from <base> · Mend's store couldn't find verify-gone`, no session created; Enter again starts
    one whose `baseRef` is `<base>`. The checkout goes back to `<base>`.
  - A repository nested inside the checkout (`via: "setup"`): `git init` at `vendor/nested` in the
    window's checkout, one empty commit, origin `https://github.com/verify-invalid/nested.git`
    (never fetched, adopted by no project), and `vendor/nested/` in the checkout's
    `.git/info/exclude`. `openFolder(<it>)`: New session's first step reads `New session`,
    `Choose a project`, `Adopt this repository` with that origin on top, then the projects. The
    window closes, the folder is removed, and New session in the checkout's own window reads
    `New session · <project>`. This world's project is adopted from a clone URL and its store is in
    the server's container, so neither path rule (the adopted source, a store worktree) can fire
    here: the lane shows the nested repository gets Adopt, and `project-match.test.ts` shows the
    parent's path no longer takes it.
  - No project matched (`via: "setup"`): `git clone https://github.com/octocat/Spoon-Knife.git` into
    a scratch folder named `<project>`, like the adopted project, so a match by folder name would
    take it. Then `openFolder(<it>)` and `waitForWindow`. There New session's first step reads
    `New session`, placeholder `Choose a project`, `Adopt this repository` (icon `repo-clone`,
    description the origin URL) on top, then the projects. Picking it: the prompt step
    `New session · <adopted>` (its delay after the pick is recorded, and whether the progress bar
    showed: VS Code draws a busy input's bar only after 800 ms); `GET /projects` lists one new
    project from that URL. The window closes.
  - Launch fails: `mend connect claude --remove` (`via: "setup"`). New session, a prompt, Change… →
    `claude`, the rest kept, Enter. The server refuses the launch (observed over the API on
    `0.0.0-dev.shab2a748d64120`, 2026-10-19: `422 Connect Claude to start a session here. …`, the
    session `failed` at once). The row reads the server's status with the refusal's words
    (`failed · launch refused · …`, or `starting · launch refused · …` while the server reads it
    `starting`), the watch caught exactly one toast `<label>[ failed] · launch refused · …` with
    [Retry], and one session was created. Claude reconnected (`via: "setup"`),
    `notification(/( failed)? · launch refused · /).click("Retry")`: no new session, the server's
    `'/api/sessions/<id>/launch'` lines +1, the session `running` with a live agent, the row
    `running`.
  - A long prompt: `quickInput.type()` pastes 100,000 ASCII characters; the box holds them all and
    the line does not warn. Enter: one session, its live agent's `argv` is `["claude", <prompt>]`
    with the last word equal to what was pasted (`via: "api"`). Then 130,000 characters: the line
    reads `the prompt is 130,000 bytes · claude takes at most 120,000`, decorated `warning`, Enter
    keeps the input open with the prompt, and no session is created. The box is cleared, so New
    session keeps nothing. Before the prompt was an InputBox, a QuickPick's row filter threw
    `Regular expression too large` past about 32,000 characters and claude started with no prompt.
  - Offline: New session with a prompt typed; the server container stopped (`via: "setup"`). The
    line reads `Mend is offline · retrying`; Enter leaves the input open with the prompt. Escape,
    then what VS Code shows: `paletteRows("Mend: New session")` (VS Code leaves a command whose
    enablement is false out of the palette), `viewActions()`, and the title bar button
    (`viewAction(/^(Mend: New session|Mend is offline)/)`) disabled with its tooltip. The server
    started again: New session opens with the prompt typed before, the cursor after it
    (`quickInput.selection()` reads `[n, n]`), and `quickInput.keys(" now")`, typed where the cursor
    is, adds to it rather than replacing it.
- **b. The agent needs Dana; she answers without leaving VS Code.** From the default `up`, with the
  shell session of story a live.
  - The story's signal (the row in `Needs you`, the badge `1`, the toast with [Answer]) is
    `recipes/vscode-view.mjs` on a server with G4: the stand-in's `PermissionRequest` moves the row
    to `Needs you` as `waiting · claude needs your permission to use Bash · since <hh:mm>`, badge
    `1`, one toast `view-rate-limit is waiting · claude needs your permission to use Bash` [Answer];
    `notification(...).click("Answer")` attaches `claude · view-rate-limit` in this window, `opens`
    and windows unchanged; `PostToolUse` returns the row to `running` and clears the badge.
  - a4 (the same recipe, on a server with #1089): `Terminal: Create New Terminal` puts her own
    terminal in front (Answer left the agent's tab there, and a window whose active terminal is the
    agent's tab toasts nothing for it). Claude's `Stop` then reads `idle · claude finished its turn`
    under `Running`: no `Needs you`, no badge, no toast. Claude's `/exit` reads `completed` and
    toasts `view-rate-limit finished · …` [Review] [Open].
  - Another window: `palette("New Window")`. Under Xvfb, with no window manager, VS Code holds both
    windows focused (each custom title bar active, `xdotool windowfocus` changes nothing). One wait
    toasts in one window of this VS Code (a claim in global storage), so the recipe checks exactly
    one window toasted it and both show badge `1`; which window it is stays not drivable. First
    `Terminal: Create New Terminal` in the home window: b1's Answer left the agent's tab in front
    there, which alone keeps that window quiet, so with it in front the step could not tell the
    claim from that. The step also lists the claim files in the run's
    `User/globalStorage/sealant-sh.mend/toasts`: one new file, named by when the wait began and its
    kind (`<ms>.<session>%3Await%3Apermission%3A<since>`), gone once `PostToolUse` ends the wait.
  - S3, someone else's wait: Ana (a second account, invited over the API, her claude connected with
    the fake token through a scratch CLI config) starts `view-ana` as a claude terminal agent in the
    shared project, shared control off, and her own shell fires the stand-in's `PermissionRequest`.
    Mend reads it `waiting`; Dana's view reads `view-ana · waiting · Ana's session` outside
    `Needs you`, `Needs you` reads `nothing`, the badge stays empty and nothing toasts. Then her
    shell exits and she stops it; in one run of four (`r2v4`) Mend still read it `waiting` minutes
    after the stop, both processes exited and the workspace stopped, so the recipe notes that
    instead of failing.
  - A conversation's request: `recipes/vscode-answer.mjs`, from the default `up`. A real claude
    under the fake token never asks, so only the process behind the name `claude` is a stand-in
    (`scripts/fixtures/claude-protocol-standin.mjs`, its wire tested in
    `claude-protocol-standin.test.mjs`). Mend's engine launches it with its own protocol argv over
    sealantd's pipe; ClaudeAdapter, ProtocolHost, the `agent_requests` row, the list and respond
    routes and the adapter's `control_response` are Mend's. Setup (`via: "tty"`): `add-rate-limit`
    starts as a claude terminal agent; a shell beside it writes the stand-in to `/tmp/mend-answer`
    and puts a shim where `command -v claude` resolves. `/usr/local/bin` is root's `755` and the
    person has no sudo, but holds `CAP_FOWNER` (`CapEff 0x8`, which sealantd grants so pnpm can
    relink bins). So the swap chmods the directory `o+w`, renames the symlink to
    `claude.mend-answer-orig`, writes the shim, and puts `755` back. The terminal agent is stopped
    (the shell keeps the workspace, the session reads `idle`), then
    `POST /sessions/:id/launch {"mode":"protocol","permissionMode":"ask","prompt":"mend-ask:permission …"}`.
    The stand-in records its argv and uid: Mend ran it as the person (uid `40001`) with
    `--print --verbose --input-format stream-json … --permission-prompt-tool stdio --resume <the terminal agent's id> --settings {"env":{"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS":"1"}}`;
    the session shows a live `agent-protocol`.
  - One request at a time. Each turn's text picks what the stand-in asks: `mend-ask:permission`
    (Bash `pnpm db:migrate`, `tool-permission`), `mend-ask:question` (`AskUserQuestion`, one
    single-select `target` question `Which database?` with `staging` and `production`, `user-input`)
    or `mend-ask:text` (the same with no options, `name`, `What should the migration be called?`). A
    step sends `POST /sessions/:id/turns` once the turns settle, and waits for a pending request it
    has not seen. It reads the stand-in's record back through the shell (`MEND-ANSWER-R<n>:` lines).
    A socket the server's restart cut attaches again.
  - `MEND_VERIFY_ANSWER_VIA=api` answers with the extension's bodies over the API: Mend's half of
    every step, on any extension. Two cold worlds, `ansr2` and `ansr3` (server
    `0.0.0-dev.sha1a696f3beeac`), each passed all 14 steps: Allow → `accept` and the stand-in
    `allow`; Deny → `decline`, `deny` with `Declined by user`; typed and picked answers arrive as
    `answers.<id> = [...]`, in Mend's row and the stand-in's response. A second respond answers
    `409 AgentRequestResolved`, the server log holds two POSTs, and the stand-in received one. Ana's
    conversation, shared control off: Dana's respond answers `403`
    `only the session owner can steer this session; …`. With shared control on it answers `403`
    `Only Ana can answer this; send a turn instead.`, because the process runs as Ana. Ana's own
    respond reaches her stand-in. A request pending across a server stop and start reads `pending`
    after it, and the same protocol process reads live. A respond then answered 200 and reached the
    stand-in in `ansr2`, `ansr3` and `ans5c`, and answered `409 ProtocolSessionNotLive` in `ans5b`,
    with the process row still live: whether Mend can deliver right after its restart varies.
  - The default (`ui`) drives the editor and needs flow 5's extension. Step 2: the toast
    `add-rate-limit asks: run pnpm db:migrate?` with [Allow] [Deny] [More…], the row
    `add-rate-limit · waiting · run pnpm db:migrate?` in `Needs you`, badge `1`; Allow, then the row
    leaves and the badge clears. Step 3: Deny. Step 4: [staging] [production] [More…]; More… opens
    the quick pick `add-rate-limit asks: Which database?` with `staging`, `production`,
    `Write an answer…`, and the typed answer arrives. Step 4b: [Answer…] and an input box. Step 5:
    the row's inline Answer opens the same pick. Step 6: the toast's Allow after an API answer; the
    server log holds one POST to `/api/requests/<id>/respond` and the status bar shows
    `add-rate-limit · …`. Step 7: two windows, both badges `1`, one toast between them. Step 8:
    `ana-migrate · waiting · Ana's session`, no Answer, no badge. Step 9: the server stopped; the
    row's Answer reads `Mend is offline` and is disabled. Two cold worlds on flow 5's extension,
    `ans5b` and `ans5c` (server `0.0.0-dev.sha353d68ba2054`), each passed every step (15 step
    lines); the one toast showed in the home window in `ans5b` and in the second window in `ans5c`,
    with one claim file each time. A typed answer is typed only once the input box replaced the
    list: typing sooner lands in the list, and the input box closed empty and no answer went out in
    `ans5a`; flow 5 now holds Enter on an empty answer. On the extension before flow 5 (`ansr2`,
    `ansr3`) step 2 fails as it should: the row reads
    `add-rate-limit · waiting · Bash · since <hh:mm>`.
  - Her own terminal agent in a workspace Ana launched: `recipes/vscode-answer-launcher.mjs`, on a
    server with terminal-agent waits (G4) newer than `0.36.0-next.1033`, an image built from main
    with `up --build`. Setup: Claude connected; Ana joins, the project is shared, her claude
    connected; Ana launches `ana-holds-workspace-<stamp>`, a claude terminal agent in a fresh
    worktree, so `workspaceLauncherUserId` is hers; Dana starts `dana-in-anas-workspace-<stamp>` in
    that worktree (`POST /worktrees/:id/sessions`) in ask mode, and it joins Ana's workspace. A
    shell beside Dana's session finds her claude's `--settings` in `/proc` and the hook stand-in
    (`scripts/fixtures/claude-standin.mjs`) replays `PermissionRequest` (Bash) through those hooks
    (`SessionStart` first when her row records no `--session-id`); the session reads
    `waiting · permission · Bash`. Dana's view lists it in `Needs you` with Answer and the badge
    counts it. Answer (the row's, else the palette's) attaches `claude · <session>` in Dana's window
    as the active tab, which shows claude's own text (`shift+tab`) and none of the attach errors
    `TtyAttachment` writes (`Mend refused this terminal`, `reattaching`, `connection lost`, …); no
    window opens, and no `no agent attached` line shows. The tab's text is kept as
    `<session>-answered-terminal.txt`.
  - `GET /sessions/:id/requests` filters only on `?pending=1` (`query.pending === "1"` in
    `apps/api/src/routes/workbench.ts`); `?pending=true` returned all 8 of a session's resolved
    requests in `ansr1`.
  - The answer's mechanics are drivable today. Record `windows()`, then
    `treeItem(<label>).contextMenu("Mend: Open terminal")`. The quick pick titled
    `Terminal · <label>` offers the session's shell (`Shell · <id8>`) and `New shell`;
    `quickInput.pick(/Shell · /)` (a plain `"Shell"` also matches `New shell`).
  - `terminal().waitForText("closing this tab detaches")`, then `shot("attached-terminal")`. The tab
    is `<harness> · <label>` (`shell · <label>` for a shell) and its banner reads
    `Mend · <label> · closing this tab detaches; the process keeps running`.
  - `terminal().type("echo answered-$(id -un)")`, then `terminal().waitForText(/answered-/)`.
    `newWindows(<recorded windows>)` reads 0, the story's rule that answering opens no workspace
    window.
- **c. Dana opens a running session to work in its workspace.** `recipes/vscode-open.mjs`, from the
  default `up`. Every claim about opens rests on `opens()`: the lines
  `SSH Resolver called for "ssh-remote+…", attempt 1` in every `*-Remote - SSH.log` under
  `<userData>/logs`, one per Remote-SSH window open or reload (a reconnect logs `attempt 2`). The
  server's `/v1/workspaces/<workspace>/ssh-target` lines are recorded as context only: a window's
  SSH teardown adds one about 4.6 s after its close. Each gesture is watched (`watch()`), so a
  toast, dialog or quick input that shows and goes is counted too. Claude is connected with the
  skill's fake setup token (`mend connect claude --from-stdin` with `FAKES.claude`, `via: "setup"`):
  the real claude starts on it, sits at its `❯` prompt as a terminal agent, and as a conversation
  answers its first turn with the provider's `401`. The lanes, in order, with what runs `open4` and
  `open5` (2026-10-19, the redesign at this branch) and `trunk3` (main's `apps/vscode`, #1080's head
  `1a7196046`) observed; the claude lanes, Ana's palette and deep links were added in `r1f` and
  `r1g` (round 1, rebased on main `cfc3862`), and `r1t` reran the trunk lane on main's extension;
  round 2 (`r2b`, `r2c` on main `66bdd4c`, the trunk lane `r2t`) added the read count, the stopping
  lane, the status bar's pick and the two sessions in one worktree; round 3 (`r3d`, `r3e` on main
  `de6d1b5`, the trunk lane `r3t` on `ec101e4`, whose `apps/vscode` is main's) added the stopped
  session opened from its own window and the unreachable lost-session step:
  - The start. With flow 3: `palette("Mend: New session")`, `workbench` typed (a shell's name),
    `quickInput.button("Change…")`, `Harness` → `shell`, the later steps kept, Enter; the row
    `workbench` reads `running`, and the start opens no window (`opens` and windows unchanged; the
    calibration next is the counter's first +1). Run `op1` (flow 3 at `cabb426c8`): `Harness` →
    `shell`, `Base: a branch or commit` → `this window's branch`, the dim line
    `shell · from master`, 0 windows, `opens 0 → 0`, then the calibration `opens 0 → 1 → 2`; run
    `nsr3` (flow 3 rebased onto #1088's round 2) passed all 53 steps. On main's extension (the
    palette lists `Mend: New Session…`): `Workbench` picked, and the start opens one window:
    `opens 0 → 1`, the signal's first check, its terminal recorded, not asserted (main attached
    nothing).
  - Setup (`via: "setup"`): `userSettings({ "window.openFoldersInNewWindow": "on" })`, so every open
    keeps the local window until the last lane.
  - Calibration. The open button twice with a gap, each window connected and closed: `opens` +1,
    then +2 (`1 → 2 → 3`). Main's button `Mend: Open in VS Code` asked `<session> is running` each
    time (answered `Open alongside`); the redesign's `Mend: Open` asked nothing. The same step
    calibrates the open-attempts counter: `open attempts 2 → 3 → 4` on both builds (runs `view30`,
    `view34`).
  - The open-attempts counter. The redesign's Mend view reads a session whenever an event names it,
    so a session read no longer means an open ran. An attempt is a burst (reads under 3 s apart) of
    the reads only an open makes: `GET /api/workspace-ssh`, which every open makes, plus on main's
    extension `GET /api/sessions/<id>`, which its open makes before its takeover question (and
    main's view never makes). A double-click's two runs land in one burst: the counter says an open
    ran, not how many.
  - Double-click the running row: the story expects it to select only. The redesign:
    `open attempts 4 → 4`, `opens 3 → 3`, 0 windows, 0 dialogs, 0 quick inputs, 0 toasts, the row
    selected (`view30`). Main fails here on the counter (the recipe exits 1; `view34`:
    `open attempts 4 → 5`, `1 open(s) ran`), with the pick `claude · <id8> is running` left open.
  - Click the running row once, then double-click the stopped `fresh worktree` row: on the redesign
    each reads `opens` unchanged, 0 windows, nothing shown, the row selected, and the stopped
    session's resume count on the server unchanged.
  - The open button clicked twice as fast as the helper can (`inline(OPEN, { clicks: 2 })`, both
    clicks landed): 1 window, `opens` +1, 0 dialogs, 0 quick inputs; the status bar showed
    `opening <session>` once.
  - `contextMenu("Mend: Open in New Window")`: 1 window, `opens` +1, nothing asked. In it `SSH:`,
    README, and before any terminal gesture the tab `shell · <session>` active and focused with its
    banner. VS Code also shows a `bash` tab there, listed before Mend's: VS Code's own terminal
    (below, under the rules), in every run so far. Then `Terminal: Create New Terminal`,
    `echo who-$(id -un) in $(pwd); printf 'verified\n' > VERIFY.md; ls`: the line names
    `/workspace/repo` and the listing holds `VERIFY.md`.
  - Already open. The open button in that window: the attached tab active and focused again, the
    page unchanged, `opens` and windows unchanged, nothing shown. The open button in the local
    window while the other window has the session: 0 windows, the local window did not navigate,
    `opens` unchanged, the status bar showed `opening <session>`; VS Code focused the existing
    window as far as the DOM can tell (`document.hasFocus()` reads true in both windows under Xvfb,
    so focus itself is not observable).
  - The stopped `fresh worktree` row's open button (setting on): the status bar read
    `starting fresh worktree's workspace · 0 s`, counting to `· 3 s` (`open4`) and `· 5 s`
    (`open5`), then `opening fresh worktree`; 0 dialogs, 0 quick inputs, 0 toasts; the server's
    `'/api/sessions/<id>/resume'` lines `1 → 2`; 1 window with `SSH:` and README.
  - The same row while it stops (SLNT-143): `POST /sessions/<id>/stop` (`via: "api"`, not awaited),
    and once the server reads it `stopping`, the open button, clicked the moment the view's row
    turns from `running`. A redraw that dropped the row ran Open with no row, which asked
    `Choose a session`; the step checks no quick input showed and the window's status bar names the
    session. The open waits the stop out and resumes once: resumes `2 → 3`, `opens` +1, 1 window,
    the status bar `starting fresh worktree's workspace` to `· 2 s`, then `opening fresh worktree`;
    0 dialogs, 0 quick inputs.
  - Ana: lane e's edge case below, then `Mend: Choose a session` there.
  - Two live sessions in one worktree (`via: "api"`): `second-look` created with
    `name: <add-rate-limit's worktree>` and launched in a PTY, running in the same workspace, the
    newer of the two. The open button on `add-rate-limit` (setting on): 1 window, its tabs
    `["claude · add-rate-limit"]`, active and focused, and no `claude · second-look`. In that window
    the open button on `second-look`: the tab `claude · second-look` attached, active and focused at
    `❯`, the page unchanged, `opens` and windows unchanged. Then
    `contextMenu("Mend: Open in New Window")` on `add-rate-limit` there: 0 windows, `opens`
    unchanged, `claude · add-rate-limit` active and focused again. VS Code keeps one window per
    folder: asked for a new window on a folder a window holds, it focuses that window, whatever
    `forceNewWindow` says, so the extension shows the agent instead.
  - A stopped session opened from its own workspace window. `POST /sessions/<second-look>/stop`
    (`via: "api"`) while `add-rate-limit` keeps the workspace running: `second-look` reads `stopped`
    (`failed` in `r3c`, where claude exited non-zero on the stop) and keeps the workspace id, and
    `add-rate-limit` runs in it (the stop of a session that does not hold the workspace takes about
    0.4 s). Then, in that window, the open button on `second-look`: the status bar read
    `starting second-look's workspace · 0 s` to `· 1 s`, the server's
    `'/api/sessions/<second-look>/resume'` lines `0 → 1`, `second-look` running in the same
    workspace, the tab `shell · second-look` active and focused, 0 windows, the page unchanged,
    `opens` unchanged, nothing shown (`r3b`, `r3d`, `r3e`).
  - Setup: the setting removed (VS Code's default).
  - Setup for the claude lanes (`via: "api"`, the calls story a's New session makes, since that flow
    is not built): `add-rate-limit` created and launched as a terminal agent
    (`POST /sessions/:id/launch {permissionMode:"ask"}`), running with a live `agent-pty`; and
    `from-phone` launched as a conversation (`{mode:"protocol", prompt:"say hi"}`), its first turn
    `completed` with the item
    `Failed to authenticate. API Error: 401 OAuth access token is invalid.`. The recipe then waits
    until the view lists both rows: in run `r1c` an inline Open clicked while they were arriving ran
    `mend.open` with no row, and the palette's session pick showed instead (not yet explained; see
    the open question below).
  - Last, because it turns the local window into the workspace and nothing can follow: Open on
    `add-rate-limit` in the local window. The same page navigated: windows `1 → 1`, `opens` +1, the
    title `[Extension Development Host] repo [SSH: <alias>] - Visual Studio Code` (the story wants
    `<session> — <project>`; the redesign leaves VS Code's own title), no dialog and no quick input
    open after it (the watch went with the page). Before any gesture the tab
    `claude · add-rate-limit` is active and focused with claude's `❯` prompt, though the newer
    `second-look` shares its workspace: the session the Open meant survives the window's reload (a
    file per workspace in the extension's global storage, `open-intent.ts`; the window takes it
    about 17 s after it appears, once Remote-SSH has connected);
    `keyboard.type("add a test for the limit")` reads back `❯ add a test for the limit` (claude
    draws a no-break space after `❯`: match it with `\s`). The Explorer lists README;
    `Terminal: Create New Terminal` there runs in `/workspace/repo` and lists the file it wrote.
  - Verified-unreachable (`via: "api"`, last): a workspace window asked for a session its running
    workspace no longer holds. `second-look` stopped, then `DELETE /sessions/<id>` answers
    `{"removed":false,"leftover":"workspace stopping · removed once its workspace has stopped"}` and
    the session stays listed, stopped, in the same workspace. A session leaves its workspace only
    when that workspace stops, and a workspace window closes about 1 s after its workspace starts
    stopping (observed: the `[SSH:` window gone 0.9 s after `POST /stop`), so no live window can
    take such an intent. `window-role.test.ts` covers it: nothing attaches, and the status bar says
    `<session> is <status> and not in this workspace · no agent attached`.
  - Open question: the `r1c` click above. VS Code keys an id-less tree item by its label, so a row's
    handle survives an insert; the click may have landed while the view re-fetched its rows. A
    person who clicks Open just as the list changes would get the session pick. Not reproduced since
    the recipe waits.
  - The workspace window's Mend view (`recipes/vscode-view.mjs`): `Open in New Window` on a running
    session; the view's first row reads `view-rate-limit · running`, then `<n> other sessions`, the
    status bar `● view-rate-limit · running`; clicking it opens the picker `Mend sessions`. While it
    waits (`PermissionRequest`), the first row reads
    `view-rate-limit · waiting · claude needs your permission to use Bash`, offers `Mend: Answer`,
    and no `Needs you` group shows.
  - First open on a machine without Remote-SSH: `recipes/vscode-open-first.mjs` from
    `up --no-remote-ssh`. `contextMenu("Mend: Open in New Window")` on the stopped `fresh worktree`
    row (the inline button is Open). Observed (run `first2`): the status bar
    `installing Remote-SSH · 0 s` to `· 3 s`, then `starting fresh worktree's workspace · 0 s` to
    `· 3 s`, then `opening fresh worktree`; VS Code's own toast
    `Installing 'Remote - SSH' extension...`; 0 dialogs, 0 quick inputs; 1 window, `opens 0 → 1`,
    `SSH:` and README. The gallery install completed inside the Extension Development Host.
  - Offline (`Mend is offline`) is not driven: the world has no way to take the server away from the
    editor alone. `not run`.
- **d. Dana reviews what the agent changed, entirely in VS Code.** `recipes/vscode-review-diff.mjs`
  (steps 1, 2 and 5), from the default `up`. It shares `recipes/vscode-review.lib.mjs` with the
  other review recipes: a claude terminal agent under the fake token in its own worktree
  (`name: <label>`), and a shell beside it that writes the change in two rounds, each followed by
  `POST /sessions/:id/checkpoints {"trigger":"user-mark"}` (`via: "setup"`). The world's base is
  Hello-World's `master`, so the slice reads `master → now`.
  - Read the section with `changeRows(h)` (the lib): the `Change` pane's rows with the letter its
    file decoration draws (`::after` on `.monaco-icon-label`; it lands a beat after the row, so wait
    for every file row to carry one). `viewRows("Sessions")` and
    `treeItem(<text>, { pane: "Sessions" | "Change" })` scope to one view: the container now has
    two. With two views each view's buttons sit in its own pane header, drawn only under the pointer
    (New session and `Mend is offline` included), so `viewAction` and `viewActions` rest the pointer
    on a header first.
  - Observed (runs `rdiffa`, `rdiffb`): `master → now ▾ · 4 files · +26 −1 · observed · 0 s ago`,
    `README [D]`, `rate-limit.md · docs [A]`, `limit.test.ts · src/auth [A]`,
    `limit.ts · src/auth [A]`, `Comments · none`, `Checkpoints · 5`; the newest checkpoint is
    `review-open`, the one the section pinned. `limit.ts` opens the tab
    `limit.ts (master ↔ checkpoint 4)`, its left side empty (`diffSides(h)`); **Open all changes**
    opens `Changes · <label> (4 files)` (VS Code adds the count). The picker
    `Review which slice? · <label>` lists `master → now · base → checkpoint 4 · 4 files · current`,
    `last turn`, and `between two checkpoints… · pick two of 5 checkpoints`; `since my last review`
    shows only once a review was sent. Between the two marks the files read `limit.ts [M]`,
    `throttle.ts [D]`, and the row `viewing · comments go on master → now`. The `...` menu offers
    `Open in Mend (web)`; no title button opens the browser. A stopped session shows the same
    change; its workspace window shows it with nothing selected.
  - Since review round 2, `last turn` runs from the boundary before the newest `turn-boundary`
    checkpoint to it, and the engine takes one only when a turn ends. The recipe's agent ends no
    turn, so expect the picker without `last turn`. Spans name both checkpoints
    (`checkpoint 1 → checkpoint 3`), never `→ now`: a chosen slice keeps its two checkpoints, and a
    newer one shows as the row `newer checkpoints · read checkpoint 1 → checkpoint 5`.
  - The worktree moving on (edge step, run `r2d1`): a third round of two files after the pin, then
    `Mend: Read the change again`, shows `worktree changed since this review · 2 new files` and
    `Review the newer change` above the pinned slice's files, which still read `4 files`. Clicking
    it pins a new `review-open` checkpoint and the header reads `6 files`. A header over a listing
    Mend cut reads `listing cut at N files · … in those · read N s ago`, never `observed`.
  - Wait for a quick pick's own title before each pick (`Between two checkpoints · from which?`):
    the second pick reuses the widget, and a pick made early lands in the first list.
  - Steps 3 and 4: `recipes/vscode-review-comments.mjs`. The `+` is `commentGlyph(h, line)`: rest
    the pointer on the line number of the diff's new side until `.comment-range-glyph.line-hover`
    shows there, then click it; `writeComment(h, text, "Add comment")` types into the thread's
    Monaco form. Observed (runs `rcomma`, `rcommb`): the thread `src/auth/limit.ts · line 12` with
    `pending`, Edit and Delete; `Comments · 1 pending`; the Comments panel `… [Ln 12]`; after
    `Developer: Reload Window` the same thread and row. Between two checkpoints, line 8 shows no
    `+`. A comment Mend holds, marked addressed over the API, shows `addressed` with no Edit or
    Delete. **Show record** (the `...` menu) opens `record · <label>.md`, read-only. Pending
    comments are files under the extension's global storage,
    `reviews/<server account>/<session>.json`, one per person and session, written under a `.lock`
    file; a draft about the whole change hangs on `mend-change-note://<change>/the whole change`.
  - **Read this change** asks Mend to read; the section reads `Mend is reading · <time>`, then one
    toast:
    `Mend could not read this change: The connected account was rejected by the provider — reconnect it. (Inference failed: authentication_failed)`.
    The world's logins are fake, so drafts, Accept, Dismiss and Show record from a draft are
    `verified-unreachable · inference`.
  - Steps 6 and 7 and the edge cases: `recipes/vscode-review-send.mjs`. Two comments, **Send
    review** opens `review · <label>.md` (`## 1 · src/auth/limit.ts:12`, `## 2 · …:13`), a typed
    line, **Send to session** (`clickEditorTitle`): the panel attaches `claude · <label>` and
    `terminal().read()` shows `❯ [Pasted text #1 +12 lines]` (claude folds a long paste), no 401;
    `follow_ups` holds one row, `vscode-follow-up:<change>:<uuid>|pending` (`followUpRows`, psql in
    the world's Postgres); the threads read `follow-up pending · pasted into claude's terminal`. The
    next round (the shell, a mark) adds `worktree changed since this review · 2 new files` and
    `since my last review · 2 files`; there the sent threads sit on the left of
    `limit.ts (checkpoint 4 ↔ checkpoint 6)`, and Addressed then Reopen reach Mend. Offline: the
    disabled `Mend is offline; your comments are kept`.
  - A second review before Enter (runs `r2s1`, `r2s2`): a third comment (line 9), **Send review**
    again. The editor holds the first review as she sent it, her typed line included, then
    `## More comments` and `## 3 · src/auth/limit.ts:9`. **Send to session** leaves claude's input
    at `❯ [Pasted text #1 +12 lines][Pasted text #2 +7 lines]`: the first review once, then only the
    new part (the whole review again would fold to more lines than the first). `follow_ups` reads
    the first row `superseded` and a second `pending`, whose instruction holds the first review
    once, as edited, then `## More comments` and the third comment; the section reads
    `3 sent · follow-up pending · pasted into claude's terminal`.
  - Ana's stopped claude session: shared control off, no **Send review**; on, the disabled button
    `Only the session's owner sends it a review: Mend types it into a terminal agent, live or started for the stopped session`,
    the same words in its tooltip, and no **Send review**. Mend starts a stopped terminal agent only
    for its owner.
  - Delivery fails on a stopped session after `mend connect claude --remove`:
    `1 delivery failed · retryable`, one toast
    `Mend could not deliver the review: Connect Claude to start a session here. …` with **Retry
    delivery**, one `delivery_failed` row. Retry after reconnecting moves the same row on (same
    key), to `delivering`, the thread `sending`. Mend then starts the session with the review as its
    first prompt: a new `agent-pty`, running, whose argv carries the review base64-encoded
    (`sh -c <decode> sh <chunks…>`, decoded by the recipe's `promptOf`) and reads
    `# Review for <label>-stopped …`; the row reads `delivered`, the thread `sent`, the section
    `1 sent`. The transcript read no events in `r2s1`. Before #1095 the deliver never answered (a
    notify inside the transaction waited for a second pooled connection); if the step times out
    again, its error carries the rows and what Mend's Postgres connections are doing
    (`serverActivity()`).
- **e. Dana wants to drive by hand.** `recipes/vscode-open.mjs`, from the default `up`.
  - The gesture is Open; typing into the attached `claude · add-rate-limit` is story c's last lane.
  - **Continue here.** `contextMenu("Mend: Open in New Window")` on `from-phone`: the tab
    `claude · from-phone`, active and focused, reads
    `claude is running as a conversation (from your phone or the web) · Continue here to type to it`.
    The pointer on `Continue here` shows VS Code's hover
    `Continue this conversation in a terminal here (ctrl + click)`; Ctrl+click it. The server's
    `'/api/sessions/<id>/handoff'` lines `0 → 1`; the session's processes read
    `agent-protocol stopped`, `agent-pty running`; the same tab name now draws claude's TUI with the
    conversation (`❯ say hi`, then the 401 answer) and its prompt, and `go on` typed reads back
    `❯ go on`. A conversation with no completed turn cannot be continued: the mode switch answers
    422 `StoreFailure`
    `No saved harness state to reopen as a terminal — resume the session instead.` (the tab says
    that sentence), after it has already stopped the conversation. In `r2a` a conversation whose
    first turn had completed got the same 422 once: the server's log shows the mode switch answered
    at `05:43:07.299` and the harness state captured at `07.630`, after it, where the passing runs
    (`v1084a`, `r2b`) capture inside the mode switch's own request first. `r3a` hit it again: the
    mode switch answered 422 at `07:06:52.738`, the harness state observed at `53.122`. A
    server-side race, not the editor's; rerun the lane. The take-over command is gone from the
    manifest.
  - Not her session. Ana is a second account, set up `via: "api"`: an invitation, her sign-up with
    `x-mend-invitation`, the project shared, her session resumed as a shell, shared control on. Her
    row (`treeItem("ana")`) offers inline `Mend: Watch terminal` and `Mend: Review change`, no Open;
    its menu `Mend: Watch terminal`, `Mend: Review change`, `Mend: Stop session`,
    `Mend: Copy worktree path`, `Mend: Open in Mend`, no Open and no Open in New Window; its tooltip
    `<project> · mend/wt/<worktree> · running` and
    `Ana launched this workspace · Remote-SSH opens it only for them`.
    `inline("Mend: Watch terminal")`: the tab `shell · ana`, its banner `read-only · Ana's session`.
  - The palette, shared control on. `Terminal: Kill All Terminals`, then `palette("Mend: Open")` in
    the local window: the pick `Choose a session · <project>` lists Ana's item as
    `ana running · Watch terminal` with the detail
    `Ana launched this workspace · Remote-SSH opens it only for them`, every other session by its
    status. Picking it attaches `shell · ana` read-only (tabs `0 → 1`); `opens` and windows
    unchanged, 0 dialogs.
  - A deep link, shared control on. `openUrl("vscode://sealant-sh.mend/open?session=<Ana's>")`. VS
    Code asks first, its own dialog `Allow 'Mend by Sealant' extension to open this URI?`; click
    Open. Mend then toasts once `Ana launched this workspace · Remote-SSH opens it only for them`
    with the one button `Watch terminal` (no Open); its click attaches `shell · ana`, read-only.
    `opens` and windows unchanged. Click the button at once: the toast hides itself after a few
    seconds.
  - Shared control off (`via: "api"`): the watching tab closed and VS Code toasted
    `The terminal process terminated with exit code: 1.`; after `Mend: Refresh` the row offers
    inline `Mend: Review change` only. The same deep link toasts the same line with `Review`; its
    click shows VS Code's `Do you want Code to open the external website? <web>/changes/<changeId>`
    (dismissed). The palette's pick lists `ana running · Review`.
  - `Mend: Show project sessions`, shared control off: its pick `Mend · <project>` lists
    `ana running · Review` with the reason, no Open; `opens` and windows unchanged.
- **f. Dana comes back the next morning.** `recipes/vscode-view.mjs`, from a default `up` on a
  server with G4 (`--build`, or `--image` of one built from a checkout that has #1082). Runs `nsv2`
  (#1088 at `74e70040c`) and `nsr4` (flow 3 rebased onto it) passed all 28 steps; in both, S9's
  watch caught one toast `Signed out — sign in again.` with [Connect to server], and no second in 30
  s. Run `ns3r3` (#1092 rebased onto #1088's round 3, server `0.0.0-dev.shad6ba271e66a9`) passed all
  29 steps, then `recipes/vscode-open.mjs` passed its 53 in the same world.
  - Setup over the API: three claude terminal agents; `migrate-orders` waits (the G4 stand-in fires
    `PermissionRequest` in a shell beside it, with the agent's `--session-id`), `docs-typos` is told
    `/exit` (`completed`, `exited with code 0`), `flaky-auth-test` gets SIGTERM (`failed`,
    `exited with code 143`; SIGKILL records no code and reads `completed`). Close a shell opened
    beside an agent (`exit`) before the session should settle: a live shell holds it `idle`.
  - `palette("Developer: Reload Window")` stands in for VS Code starting, then `view("Mend")`;
    `viewRows()`, `badge("Mend")` and `statusBarItems()` read the view. Observed (run `view4`):
    badge `1`, status bar `Mend · 1 needs you · 2 finished`, `Needs you`
    `migrate-orders · waiting · claude needs your permission to use Bash · since 09:01`,
    `Since you last looked` `flaky-auth-test · failed · exited with code 143` and
    `docs-typos · completed · observed · exited with code 0`, `Projects` collapsed.
  - f2 since #1088's round 2: `Needs you 1`, `Since you last looked 2`, `Running nothing`,
    `Projects`.
  - f3: `treeItem(<row>).click()` takes each out of `Since you last looked`, which then reads
    `nothing`; after `Developer: Reload Window` they stay out.
  - S9, near the end: `POST /me/devices` mints a device token as Settings does (`via: "api"`),
    written to the run's `cli.json` as `mend login` writes it, and the window reloads; then
    `DELETE /me/devices/<id>` revokes it as Settings does. The recipe waits 30 s for the view to
    empty by itself and, if it has not, makes a frame by creating a session row over the API
    (observed, runs `r2v6`, `r3v1` and `r3v2`: it emptied by itself within a second). The view shows
    one row, `Signed out — sign in again.` · `Run Mend: Connect to server`; one error toast reads
    `Signed out — sign in again.` [Connect to server], and no second one shows over the next 30 s,
    another frame in between. Last, the recipe writes back the `cli.json` that `up` wrote and
    reloads, so the editor is signed in again. Its sessions are named `view-…` where
    `recipes/vscode-open.mjs` uses the same name, so open can follow view in one world.
  - A landing (`landed · pull request #412 · open · observed`) is `not run`: the world's origin is a
    public GitHub repository nobody can push to. The model's unit tests cover the words.
- **g. mend handoff: Dana's local branch becomes a session.** `not run · G6`. The command **Hand off
  to Mend…** is not in today's manifest either.
- **h. First run.** `recipes/vscode-first-run.mjs` with flow 4, on two worlds.
  - From `up --signed-out --no-ssh-setup --no-remote-ssh`:
    - h1: `welcome()` reads `["Connect VS Code to your Mend server."]` with the button `Connect`; no
      `Mend` item in the status bar.
    - h2a: `welcomeAction("Connect").click()`. One input, titled `Connect to your Mend server`,
      empty with no CLI. `quickInput.validation()` reads null for `http://localhost:3105` and
      `{ message: "Plain http: the token travels unencrypted", severity: "warning" }` for the
      world's `http://<dind ip>:3105`.
    - The approve page. Enter shows one notification, `Approve in the browser if it shows <code>`,
      and the status bar `Mend sign-in · <code>`. VS Code asks
      `Do you want Code to open the external website? <url>/authorize?code=…`;
      `dialog("external website").click("Open")`. The editor's external browser is `up`'s recorder,
      so `browserOpened()` holds the URL, and `browser()` (Playwright's chromium) opens it: the web
      sends it through its sign-in page, `signIn()` signs in as the run's account, and the page
      reads `Authorize VS Code?` with the same code. A screenshot of the dialog is withheld (it
      shows the approve link), so the shot is taken after it.
    - Edge, denied: `click("Deny")` in the browser. One error toast,
      `Sign-in denied in the browser.` [Try again]; the progress is gone.
    - h2b and h2c: `[Try again]` asks the URL again with hers in it; the second walk, `Authorize` in
      the browser, ends in exactly one toast `Signed in to <host> as <email>` (the watch catches no
      `Connected to`), and the status bar's code is gone. `accounts()` lists
      `<email> @ <host> (Mend)`.
    - h3: `welcome()` reads `Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend`
      [Set up] and the link `Skip for now`. `welcomeAction("Set up").click()`: the notification
      `Setting up: Remote-SSH · an SSH key for Mend · one Host block in ~/.ssh/config`, then the
      sessions tree. Remote-SSH is in the extensions directory, `~/.ssh/config` in the scratch HOME
      holds one `Host mend-ws-…` block, `remote.SSH.remotePlatform` maps it to `linux`, and
      `GET /workspace-ssh` lists one more key.
    - Then `treeItem("fresh worktree").contextMenu("Mend: Open in New Window")`: one window,
      `opens()` +1, no dialog and no quick input (no platform question, no consent).
    - h4: the project's sessions stopped and the project removed (`via: "api"`), so the server has
      none. No project matches the window's origin (New session's origin matcher; a folder name
      never counts), so the view's message reads
      `Adopt hello-world from github.com/octocat/Hello-World` over one row, `Adopt`; one click
      adopts it (no input) and the sessions tree shows. With the project removed again, a new window
      (`palette("New Window")`) has no folder: `welcome()` reads `Nothing adopted yet.` [Adopt a
      repository…], one input titled `Adopt a repository`.
    - Edge, the token refused: the editor's device revoked with `DELETE /me/devices/<id>`
      (`via: "api"`, as Settings → Devices does). Revoking a device does not end the open event
      stream, so the editor learns it at its next read: `palette("Mend: Refresh")`. One toast,
      `Signed out — sign in again.` [Connect to server]; the welcome reads Connect, and the Accounts
      menu holds no Mend account. Its `Connect to server` opens the URL input with her server in it,
      and one walk through the approve page ends in one success toast and one `VS Code on …` device.
    - h2, Connect again while connected: `palette("Mend: Connect to server")`, the same walk, one
      success toast; `GET /me/devices` then lists one `VS Code on …` device, not the one before it,
      and no `earlier device` warning shows.
    - `accounts({ signOut: <email> })`: VS Code asks `Sign out of '<email> @ <host>'?`;
      `dialog("Sign out of").click("Sign Out")`. `GET /me/devices` lists no `VS Code on …` device
      after it, the Accounts menu holds no Mend account, and the welcome reads Connect again. The
      one toast is the sign-out's own,
      `Signed out of Mend at <url>, and revoked this editor's device.`: no
      `Signed out — sign in again.` after it.
  - From `up --cli-only --no-ssh-setup --no-remote-ssh`:
    - h1 variant: the view's message reads
      `Mend at <host:port> · signed in as <email> (from the Mend CLI)` over one row, `Use it`.
      `treeItem("Use it").click()`: no input, no dialog, no toast, `browserOpened()` unchanged,
      `mend.serverUrl` written; the next step is Set up, and the account is in the Accounts menu.
    - Edge, skipped: `welcomeAction("Skip for now").click()` shows the sessions tree; no Host block.
      `Running` reads `nothing` and is drawn expanded.
    - Edge, Connect cancelled while its request is out: a loopback proxy in the recipe holds
      `POST /api/cli/auth` until the recipe releases it. `palette("Mend: Connect to server")` with
      the proxy's URL, then `Cancel` on `Asking <proxy host> for a sign-in code` while the request
      is held; then the proxy answers. No toast but that `Asking` one and no dialog from the Connect
      on, no `Mend sign-in` status item, no browser page, no `Approve in the browser` progress, and
      `mend.serverUrl` still the server's.
    - Edge, Open's consent cancelled: Open in New Window on `fresh worktree`, then `Cancel` on the
      modal `Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)`. Remote-SSH is
      not in the extensions directory before the open, while it asks, or after Cancel; no window
      opens and `~/.ssh/config` holds no Mend `Host` block.
    - Then Open in New Window on `fresh worktree`: the modal
      `Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)` [Set up] shows once;
      `Set up` opens one window, and `~/.ssh/config` holds one Mend `Host` block.
    - Back in the first window, `Running` (drawn empty when the welcome gave way) reads `1`, still
      expanded, its first row `fresh worktree · running`.
  - Runs (2026-10-19, flow 4 at `547a8be6a`, server `0.0.0-dev.sha7a79816ce884`), each world from a
    cold `up`: `fr2a` and `fr3a` passed all 14 steps of the signed-out half, `fr2b` and `fr3b` all 5
    of the CLI half. On the same head, `vscode-open.mjs` (`rgopen`) and `vscode-view.mjs` (`rgview`,
    S9 included) passed from a default `up`.
  - Runs after the rebase onto #1092's `c4a47cf70` (2026-10-19, server `0.0.0-dev.shaa48dfa2beb00`),
    each world from a cold `up`: `frr1` and `frr2` passed all 15 step lines of the signed-out half;
    `frrb` passed the CLI half, and `frrb2` passed it again with the `Running` steps (7 lines). On
    the same head, `vscode-new-session.mjs` (`frns`, 37 lines) passed from a default `up`, and
    `vscode-view.mjs` (29, S9 included) then `vscode-open.mjs` (53) passed in one world (`frvo`).
  - Runs for review round 2, on #1092's round 4 `d6b81b6cf` (2026-10-19, server
    `0.0.0-dev.sha39cd0ecf8bc4`: round 4's server change is the store's base check, which no step
    reads), each world from a cold `up`: `fr5a1` and `fr5a2` passed all 22 step lines of the
    signed-out half, the refused token, Connect again and the quiet sign-out included; `fr5b2`
    passed the CLI half (9). `vscode-view.mjs` (32, S9 and its teardown on the CLI's own token
    included) then `vscode-open.mjs` (54) passed in one world (`fr5vo`), and
    `vscode-new-session.mjs` (`fr5ns`, 45) passed in its own. Before the recipe's last two fixes,
    `fr4a1` failed dismissing a toast that had hidden, `fr4a2` read an offer's row before its
    message, and `fr4a4` counted Connect again's toast in a watch that names a text once; `fr4a3`
    failed in setup, its sessions not settled in 300 s after their stop.
  - Why some steps are not a welcome: VS Code fixes a welcome's words in the manifest, and a view
    container with one view merges its title (`Mend: Sessions`) and drops the view's description.
    The two steps whose words carry facts (the CLI's server and account; the window's repository)
    are the view's message and one row instead.

Commands outside the stories, one gesture each:

- **New session in this worktree.**
  `treeItem(<label>).contextMenu("Mend: New session in this worktree…")` opens New session's quick
  input titled `New session · <project> · in <worktree>`, its dim line ending `in <worktree>`;
  Enter, then `api("/projects/<id>")` (`via: "api"`) lists two sessions in one worktree. No recipe
  drives it yet.
- **Stop.** `treeItem(<label>).contextMenu("Mend: Stop session")`. The modal `Stop <label>?`
  (`The worktree and reviewable change remain.`); `dialog("Stop").click("Stop session")`. The row's
  description turns to its settled word, and `api("/projects/<id>")` (`via: "api"`) agrees.
- **Open in Mend.** `treeItem(<label>).contextMenu("Mend: Open in Mend")`. Record `dialogs()`; when
  VS Code asks before opening the external link, its dialog names `<web>/sessions/<id>`. Dismiss it.
- **Copy worktree path.** `treeItem(<label>).contextMenu("Mend: Copy worktree path")`. The status
  bar shows `Mend worktree path copied` for two seconds.
- **Sign out.** `palette("Mend: Sign out")`. Record the toast; with the CLI's connection it reads
  `Signed out of Mend at <url> in this editor. The Mend CLI on this machine keeps its own sign-in; mend logout ends it.`.
- **URI.** `not drivable yet · a vscode:// URL arrives from the OS, not the workbench DOM`.
- **Bring my editor.** No recipe drives it yet.
- **Package.** `pnpm --filter ./apps/vscode run package` exits `0` and writes
  `apps/vscode/mend-<version>.vsix`. The driver runs the built extension with
  `--extensionDevelopmentPath`, not the `.vsix`.

## Gotchas

- VS Code draws its modals and context menus in the DOM only with `window.dialogStyle` and
  `window.titleBarStyle` set to `custom`. The driver writes both into the run's settings. With the
  native style they are GTK windows outside the page, and no helper reaches them.
- The terminal is read from the DOM renderer (`terminal.integrated.gpuAcceleration: off`, also
  written by the driver). The canvas renderer leaves no text to read.
- A tree row's accessible name is its tooltip, not its label. Match a row by its visible text (its
  label, then its status), as `treeItem(label)` does; never by `aria-label`.
- A Remote-SSH open either reloads a window (the same page navigates) or opens a new one (a new
  page). Re-read `windows()` after every open, and count with `newWindows(known)`, which waits until
  no window has appeared for a while.
- A Remote-SSH connect installs VS Code's server inside the workspace the first time. In the proof
  runs (2026-10-18) the first connect took 3 to 8 s and later ones 3 to 4 s; wait for
  `statusBar(/SSH:/)` with a budget of minutes all the same.
- `up` seeds `remote.SSH.remotePlatform` for the alias when it set SSH up. After `--no-ssh-setup`,
  Remote-SSH asks the platform in a quick pick; the recipe answers it with
  `quickInput.pick("Linux")`.
- The package is named `mend`, and so is the repository's root package. Filter it by path, as in
  `pnpm --filter ./apps/vscode run build` (the driver's own build) and
  `pnpm --filter ./apps/vscode run package`.
- The video (`display.mp4`) is unredacted pixels. A recipe that shows a credential on screen runs
  with `--no-video`. Screenshots are withheld by the helper when the window's text shows one; the
  video is not.
- Signed out, the extension falls back to the CLI's configuration, then `http://localhost:3105` (the
  manifest's `mend.serverUrl` description). On a machine where a Mend answers there, the view reads
  that server. Never run `--signed-out` on a machine whose own Mend listens on 3105.
- An input's placeholder is not in the window's text (`text()`, `waitForText`); read it with
  `quickInput.placeholder()`. The Connect quick pick's plain-http warning is its placeholder.
- On main's extension a Workbench session is created with the `claude` harness and resumed as a
  shell, so its row reads `claude · <id8>` until it has a label.
- Opening an external link (`Mend: Open in Mend`, `Mend: Review change`, the browser sign-in) goes
  through VS Code's `openExternal`. When VS Code asks first, its prompt is a DOM dialog under the
  custom style; read the URL from it and dismiss it. When it does not ask, the host's opener runs in
  the scratch HOME; record that in the step.
- The extension does not use the web app's terminal embed (`/tty-embed`). `Mend: Open terminal`
  reaches `/api/tty` directly; every other terminal is VS Code's integrated terminal inside the SSH
  workspace.
- The extension never opens the worktree's path on the Mend host. `Mend: Copy worktree path` copies
  the server-side path; nothing else uses it.
- In a per-person workspace the editor connects as the workspace's launcher. A workspace someone
  else launched is theirs to open: no entry point opens it. The row offers no Open; the palette's
  and the status bar's session picks list it with Watch terminal or Review; a deep link or a command
  aimed at it opens nothing and toasts why once, with that one action.
- The last-window rule. Open with VS Code's default `window.openFoldersInNewWindow` turns the window
  it runs in into the workspace, and the driver's local window with it. A recipe that needs the
  local window afterwards sets the setting to `on` first (`userSettings`, `via: "setup"`), uses
  `Mend: Open in New Window`, and drives the default-setting Open last.
- VS Code's context menu ignores a click that lands right after it opens. `contextMenu(item)` rests
  the pointer on the item for 300 ms before clicking and checks the menu closed.
- A tree row's tooltip is bound to its label, not the whole row: `tooltip()` hovers `.label-name`
  and moves away and back until VS Code's hover shows.
- A workspace window can show a `bash` tab beside Mend's attached tab: VS Code's own terminal in its
  default profile, not Mend's (Mend names every tab it makes `<what runs> · <session>`). VS Code's
  terminal view makes one when it shows with no terminal in it once the remote terminal backend
  connects. Seen: listed before Mend's tab in the Workbench session's Open in New Window window
  (`r2a`, `r2b`, `r2c`, the verifier's `v1084a`), and after Mend's tab once in the last lane
  (`r2c`). Not seen: the start's window (the folder's first open, its panel hidden), and the probes
  in `r2a` (`bash-probe`, `bash-probe2`), which reopened two folders whose last window closed with
  the panel shown: the panel showed from 0.0 s, Mend's tab came at 1.0 and 1.5 s, and no `bash`. So
  it is not a terminal restored every time; which order of startup events makes it is not pinned.
  The extension leaves it: dropping it would mean disposing a terminal VS Code started for her.
  `terminal().tabs()` reads every tab's name, the active one's and whether the keyboard is in a
  terminal.
- The CLI's token is used only while `mend.serverUrl` is empty or equals the CLI's URL. A token
  saved through `Mend: Connect to server` lives in VS Code's secret storage, not in `cli.json`.
