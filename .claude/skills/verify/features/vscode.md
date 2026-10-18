# VS Code extension

The Mend extension for VS Code (`apps/vscode`) lists a person's projects and sessions in a
`Projects and sessions` view and opens a session inside its workspace over Remote-SSH. The editor's
files are then the session's worktree, and its integrated terminal runs in the workspace, where Mend
observes a `claude` or `codex` started there. From the view a person starts a session (a Workbench
shell, a Claude or Codex agent, or an agent with options), starts another session in the same
worktree, makes a worktree without an agent, attaches a session's terminal in the current window,
watches another person's session read-only, stops a session, and opens it or its change in Mend's
web app. The extension is published as `sealant-sh.mend`. A verify run drives it live in a real VS
Code with `scripts/drive-vscode.mjs`. The driver builds the extension from a checkout, runs it with
Microsoft's Remote-SSH on an Xvfb display, and clicks the workbench DOM over CDP against a packaged
Mend server in Docker-in-Docker. Its evidence is numbered screenshots, a step log (`steps.jsonl`),
the editor's and the server's logs, and a video of the display. The flows below follow the stories
in `docs/specs/vscode-stories.md` (a to h) and say, per story, where today's extension differs.

## Sub-features

- `vscode-install` builds the extension from source (`dist/extension.js`) and packages
  `mend-<version>.vsix` (`<version>` is `apps/vscode/package.json`'s).
- `vscode-connect` reads the CLI's connection, or `Mend: Connect to server` signs in through the
  browser, with a pasted device token, or with none. `Mend: Sign out` ends it.
- `vscode-view` shows `Needs you` and the projects with their sessions, scoped to the open folder's
  project unless toggled; the status bar names the project and what waits.
- `vscode-adopt` adopts a project from a clone URL and a name.
- `vscode-new-session` starts a Workbench shell, a Claude or Codex agent, or an agent with options.
- `vscode-new-in-worktree` starts another session in a session's worktree.
- `vscode-manual-worktree` creates a worktree without an agent and opens it.
- `vscode-open` is the session row's **Open** button (`Mend: Open`). It opens the session's
  workspace over Remote-SSH and follows VS Code's `window.openFoldersInNewWindow`: the default turns
  the current window into the workspace, `on` opens a new one. It never asks: a stopped session
  resumes as a shell, a missing Remote-SSH installs, as steps of the open's status bar progress. One
  open runs per session at a time; a second gesture joins it. A click or a double-click on the row
  only selects it.
- `vscode-open-new-window` is `Mend: Open in New Window` in the row's context menu: the same open,
  always in a new window.
- `vscode-attached-tab`: a session's workspace window attaches the session's live terminal as a tab
  named `<harness> · <session>` (`shell · <session>` for a Workbench session's shell), active and
  focused, with the banner
  `Mend · <session> · closing this tab detaches; the process keeps running`. Open in a window that
  already is the workspace focuses that tab and does nothing else.
- `vscode-continue-here`: a conversation's tab reads
  `<harness> is running as a conversation (from <where>) · Continue here to type to it`; its link
  moves the conversation into a terminal (`POST /sessions/:id/handoff {to:"pty"}`).
- `vscode-terminal` attaches a live session's terminal in the current window over `/api/tty`,
  without SSH.
- `vscode-watch-terminal` is `Mend: Watch terminal` on a session whose workspace another person
  launched, offered while they have shared control on. The tab is read-only and its banner reads
  `read-only · <owner>'s session`.
- `vscode-ssh-setup` registers this machine's key and writes the `Host` block (see
  [Workspace SSH](./workspace-ssh.md)).
- `vscode-review` opens the session's change in Mend's web review.
- `vscode-stop` stops a live session; the worktree and change remain.
- `vscode-uri` opens a session from `vscode://sealant-sh.mend/open?session=<id>`.
- `vscode-bring-my-editor` installs the person's local extensions into a Mend workspace window
  (`mend.workspaces.bringMyEditor`).

## How to get to it (user POV)

- VS Code: the Mend icon in the Activity Bar opens the view `Projects and sessions`. Its title bar
  holds `Mend: New Session…`, `Mend: Refresh`, `Mend: Adopt a project…` and, when the open folder
  belongs to a project, `Mend: Toggle current project scope`. With nothing adopted it shows
  `Nothing adopted yet.` and the link `Adopt a project…`. When the view cannot read Mend, it shows
  one row naming the error, with the description `Run Mend: Connect to server`.
- VS Code: on a project row, inline `Mend: New Session…`. Its context menu holds
  `Mend: New Session…` and `Mend: New worktree without an agent…`.
- VS Code: on a session row whose workspace this person may open, inline `Mend: Open` and
  `Mend: Open in Mend`. Its context menu holds `Mend: Open`, `Mend: Open in New Window`,
  `Mend: New session in this worktree…`, `Mend: Review change` and `Mend: Copy worktree path`, and
  on a live session also `Mend: Open terminal` and `Mend: Stop session`.
- VS Code: on a session row whose workspace another person launched, no Open: inline
  `Mend: Review change` and `Mend: Open in Mend`, plus `Mend: Watch terminal` while that person has
  shared control on. The row's tooltip ends
  `<launcher> launched this workspace · Remote-SSH opens it only for them`. Its context menu holds
  `Mend: Watch terminal` (shared control on), `Mend: Review change`, `Mend: Stop session` and
  `Mend: Copy worktree path`.
- VS Code: a click or a double-click on a session row selects it and runs nothing.
- VS Code: while an open runs, the status bar item `Mend: opening a session` reads
  `installing Remote-SSH · <n> s`, `setting up workspace SSH · <n> s`,
  `starting <session>'s workspace · <n> s` or `opening <session>`.
- VS Code: the Command Palette lists every command, titles verbatim: `Mend: Refresh`,
  `Mend: Toggle current project scope`, `Mend: Connect to server`, `Mend: Sign out`,
  `Mend: Adopt a project…`, `Mend: Open`, `Mend: Open in New Window`, `Mend: Open terminal`,
  `Mend: Watch terminal`, `Mend: Review change`, `Mend: New session in this worktree…`,
  `Mend: Open in Mend`, `Mend: Copy worktree path`, `Mend: Set up workspace SSH`,
  `Mend: Stop session`, `Mend: New Session…`, `Mend: New worktree without an agent…`,
  `Mend: Show project sessions`, `Mend: Bring my editor into this workspace`,
  `Mend: Show workspace editor log`.
- VS Code: the status bar item `$(pulse) Mend: <project> · <n> sessions[ · <n> waiting]`, or
  `Mend: <project> › <session>` when the window's folder is a session's worktree. It runs
  `Mend: Show project sessions`, a quick pick titled `Mend · <project>`.
- VS Code settings: `mend.serverUrl`, `mend.workspaceSshHost` and `mend.workspaces.bringMyEditor`.
- URI: `vscode://sealant-sh.mend/open?session=<session-id>`; without `session` it shows the Mend
  view.
- CLI: `mend login` writes the connection the extension reads; `mend ssh setup` is the terminal's
  `Mend: Set up workspace SSH`.
- Docs: `apps/docs/src/content/docs/clients/vscode.md`.

## Driving it with verify

The driver's contract is the header of `scripts/drive-vscode.mjs`, and the helpers a recipe receives
are the object `workbenchHelpers` returns in `scripts/drive-vscode.workbench.mjs`. A recipe is a
module whose default export is `async (helpers) => {}`. The recipes:

- `recipes/vscode-open.mjs` drives stories c and e against either build of the extension: the row's
  open button is found by `inline(/^Mend: Open( in VS Code)?$/)`. It calibrates `opens()` (two opens
  with a gap: +1, then +2), then asserts the story at every step. Today's extension fails it at the
  double-click; the redesign passes.
- `recipes/vscode-open-first.mjs` drives the first open on a machine without Remote-SSH, from
  `up --no-remote-ssh`.
- `recipes/vscode-open-as-built.mjs` drives #1080's extension as built: a session started from the
  palette, its row double-clicked with what that shows and opens counted, one open through to the
  workspace window's files and terminal. It needs the `Mend: Open in VS Code` manifest. Run `trunk2`
  (2026-10-19, `1a7196046`): the start's window `opens 0 → 1`; the double-click `opens 1 → 1`, 0
  windows, the pick `<session> is running` shown once and left open, while the server's `ssh-target`
  lines read `4 → 5` from the start window's teardown; its answer `opens 1 → 2`.

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
  `--extension <checkout>` runs another checkout's `apps/vscode`. `--signed-out` leaves no CLI
  connection; `--no-ssh-setup` leaves workspace SSH and Remote-SSH's platform unset;
  `--no-remote-ssh` leaves Microsoft Remote-SSH uninstalled, so the first open installs it from the
  gallery (the ledger's `remoteSsh` is `false`); `--no-video` records no video. `up` prints
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
label or `<harness> · <id8>` when it has none (the as-built recipe reads it with `api`).

- **a. Start a session and keep working.** From the default `up`.
  - `view("Mend")`, `treeItem(<project>).waitFor()`, `shot("mend-view")`. The row reads
    `<project> <default branch>`; `statusBar("Mend:").text()` reads
    `Mend: <project> · <n> sessions`.
  - `api("/projects/<id>")` (`via: "api"`) records the session ids, and `windows()` the windows.
  - `palette("Mend: New Session…")`, `quickInput.waitFor()`. When `quickInput.title()` is
    `Choose a Mend project`, `quickInput.pick(<project>)`. Record `quickInput.title()` and
    `quickInput.items()`, then `shot("new-session-kinds")`. The story expects one input titled
    `New session · <project>` with a dim line `claude · default model · from main` and a **Change…**
    button. Today it is a quick pick titled `New session · <project>` offering `Workbench`,
    `Claude agent`, `Codex agent` and `Agent with options…`.
  - `quickInput.pick("Workbench")`. Record `notification("Preparing workbench").text()` and
    `shot("preparing-workbench")`. Today's source shows `Preparing workbench · <project>…`; the
    story expects no toast.
  - `waitUntil` the new session in `api("/projects/<id>")` (`via: "api"`), then the row
    `treeItem(<label>)` until `.description()` reads `running`, and `shot("row-running")`. The
    story's row reads `<word> · <fact>` (`running · reading src/auth`); today the description is the
    status word alone.
  - `newWindows(<the windows recorded before the start>)`. Record
    `<n> window(s) opened by the start`. The story expects 0 (the person keeps working in her
    window); today's source opens the workspace in a new window right after the start (observed: 1
    window, no quick pick, no toast beyond `Preparing workbench`).
  - `Claude agent` and `Codex agent` ask
    `What should the agent do? Empty opens the harness without a prompt.`, then show
    `Starting <harness>…`. The world's server has no provider login, so a run reports both
    `verified-unreachable · provider login`.
  - `Agent with options…` asks
    `What should the session do? Leave empty to open the harness without a prompt.`, then the
    harness (`quickInput.items()` reads `Claude`, `Codex`, `opencode`, `pi`), `Model` only when the
    catalog offers models, `Thinking` only when the model offers more than one effort, `Permissions`
    (`Skip permission prompts`, `Ask before acting`) and `Base branch or commit`. Walk each with
    `quickInput.pick(...)` and `quickInput.accept()`, record each step's `quickInput.title()`
    (`New <harness> session` after the first), and `quickInput.cancel()` at the base. The start
    itself is `verified-unreachable · provider login`. The story's **Change…** keeps these in one
    input with a step counter and Back; today each is its own prompt.
- **b. The agent needs Dana; she answers without leaving VS Code.** From the default `up`, with the
  Workbench session of story a live.
  - The story's signal (the row in `Needs you`, the badge `1`, the toast with [Answer]) needs a
    terminal agent that reports it waits. `not run · G4`. Today a terminal agent that asks still
    reads `running`.
  - A conversation's question in a toast with [Allow] [Deny] needs a conversation session, which
    needs a provider login. Report `verified-unreachable · provider login`.
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
  toast, dialog or quick input that shows and goes is counted too. The world has no provider login,
  so the agent is a Workbench session's shell: its tab is `shell · <session>` where the story shows
  `claude · <session>`. The lanes, in order, with what runs `open4` and `open5` (2026-10-19, the
  redesign at this branch) and `trunk3` (main's `apps/vscode`, #1080's head `1a7196046`) observed:
  - The start. `palette("Mend: New Session…")`, `Workbench`; the row reads `running`. The start
    opens one window on both builds (story a is not built): `opens 0 → 1`, the signal's first check.
    Its terminal is recorded, not asserted: the redesign attached `shell · <session>`, focused,
    banner shown; main's attached nothing.
  - Setup (`via: "setup"`): `userSettings({ "window.openFoldersInNewWindow": "on" })`, so every open
    keeps the local window until the last lane.
  - Calibration. The open button twice with a gap, each window connected and closed: `opens` +1,
    then +2 (`1 → 2 → 3` on all three runs). Main's button `Mend: Open in VS Code` asked
    `<session> is running` each time (answered `Open alongside`); the redesign's `Mend: Open` asked
    nothing.
  - Double-click the running row: the story expects it to select only. The redesign: `opens 3 → 3`,
    0 windows, 0 dialogs, 0 quick inputs, 0 toasts, the row selected. Main fails here (`trunk3`, the
    recipe exits 1): the quick pick `claude · <id8> is running` shown and left open, `opens 3 → 3`,
    0 windows, 0 dialogs.
  - Click the running row once, then double-click the stopped `fresh worktree` row: on the redesign
    each reads `opens` unchanged, 0 windows, nothing shown, the row selected, and the stopped
    session's resume count on the server unchanged.
  - The open button clicked twice as fast as the helper can (`inline(OPEN, { clicks: 2 })`, both
    clicks landed): 1 window, `opens` +1, 0 dialogs, 0 quick inputs; the status bar showed
    `opening <session>` once.
  - `contextMenu("Mend: Open in New Window")`: 1 window, `opens` +1, nothing asked. In it `SSH:`,
    README, and before any terminal gesture the tab `shell · <session>` active and focused with its
    banner. VS Code also shows a `bash` tab there: VS Code's own terminal, not Mend's (where it
    comes from is not established; the start's window and the last lane's showed none). Then
    `Terminal: Create New Terminal`,
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
  - Ana: lane e's edge case below.
  - Setup: the setting removed (VS Code's default).
  - Last, because it turns the local window into the workspace and nothing can follow: the open
    button in the local window. The same page navigated: windows `1 → 1`, `opens` +1, the title
    `[Extension Development Host] repo [SSH: <alias>] - Visual Studio Code` (the story wants
    `<session> — <project>`; the redesign leaves VS Code's own title), no dialog and no quick input
    open after it (the watch went with the page), the attached tab active and focused, the Explorer
    listing README and VERIFY.md.
  - The story's workspace-window Mend view (this session only, `<n> other sessions · <n> needs you`)
    and status bar `● <session> · <status>` are not built. Report `not run · not built`.
  - First open on a machine without Remote-SSH: `recipes/vscode-open-first.mjs` from
    `up --no-remote-ssh`. `contextMenu("Mend: Open in New Window")` on the stopped `fresh worktree`
    row (the inline button is Open). Observed (run `first2`): the status bar
    `installing Remote-SSH · 0 s` to `· 3 s`, then `starting fresh worktree's workspace · 0 s` to
    `· 3 s`, then `opening fresh worktree`; VS Code's own toast
    `Installing 'Remote - SSH' extension...`; 0 dialogs, 0 quick inputs; 1 window, `opens 0 → 1`,
    `SSH:` and README. The gallery install completed inside the Extension Development Host.
  - Offline (`Mend is offline`) is not driven: the world has no way to take the server away from the
    editor alone. `not run`.
- **d. Dana reviews what the agent changed, entirely in VS Code.** From the default `up`, after
  story c's workspace window wrote a file with
  `terminal().type("printf 'verified\\n' > VERIFY.md")`.
  - The story's **Change** section, diff editors, Mend's draft comments, pending comments and the
    Comments panel are not in today's manifest. Report `not run · not built`.
  - Commenting on a slice other than `base → now` (since my last review, last turn, between two
    checkpoints) is `not run · G10`.
  - **Send review** into a live terminal agent is `not run · G12`.
  - Today's review is `Mend: Review change`, which opens Mend's web review.
    `treeItem(<label>).contextMenu("Mend: Review change")`. Record `dialogs()` and
    `shot("review-link")`. When VS Code asks before opening the external link, its dialog names
    `<web>/changes/<changeId>`; compare the id with `api("/sessions/<id>")`'s `changeId`
    (`via: "api"`), then dismiss the dialog with its cancel button. A session without a change shows
    the toast `<label> has no change to review yet.`.
- **e. Dana wants to drive by hand.** `recipes/vscode-open.mjs`, from the default `up`.
  - The gesture is Open; the attached tab is story c's. Typing into the agent's TUI needs a terminal
    agent, which needs a provider login: the recipe types into the attached shell's window instead.
    The `claude · <session>` tab is `verified-unreachable · provider login`.
  - **Continue here** needs a conversation session, which needs a provider login (`handoff` answers
    422 `Connect Claude to start a session here…` in the world). Report
    `verified-unreachable · provider login`. The take-over command is gone from the manifest.
  - Not her session. Ana is a second account, set up `via: "api"`: an invitation, her sign-up with
    `x-mend-invitation`, the project shared, her session resumed as a shell, shared control on. Her
    row (`treeItem("ana")`) offers inline `Mend: Watch terminal`, `Mend: Review change` and
    `Mend: Open in Mend`, no Open; its menu `Mend: Watch terminal`, `Mend: Review change`,
    `Mend: Stop session`, `Mend: Copy worktree path`, no Open and no Open in New Window; its tooltip
    `<project> · mend/wt/<worktree> · running` and
    `Ana launched this workspace · Remote-SSH opens it only for them`.
    `inline("Mend: Watch terminal")`: the tab `shell · ana`, its banner `read-only · Ana's session`.
  - Shared control off (`via: "api"`): the watching tab closed and VS Code toasted
    `The terminal process failed to launch (exit code: 1).`; after `Mend: Refresh` the row offers
    `Mend: Review change` and `Mend: Open in Mend` only.
- **f. Dana comes back the next morning.** From the default `up`, after stories a and c.
  - `palette("Developer: Reload Window")`, then `view("Mend")`. Record
    `treeItem("Projects").text()`, `treeItem(<project>).text()`, each session row's
    `treeItem(<label>).text()` and `statusBar("Mend:").text()`, then `shot("next-morning")`. Today's
    order is `Needs you` (only while a session reads `waiting`), then `Projects`.
  - The story's `Needs you` row for a terminal agent, and its badge, are `not run · G4`.
  - **Since you last looked**, **Running** and the status bar `Mend · 1 needs you · 2 finished` are
    not in today's extension. Report `not run · not built`.
- **g. mend handoff: Dana's local branch becomes a session.** `not run · G6`. The command **Hand off
  to Mend…** is not in today's manifest either.
- **h. First run.** From `up --signed-out --no-ssh-setup`.
  - `view("Mend")`, `treeItem("Run Mend: Connect to server").waitFor()`, `shot("signed-out")`.
    Record the row's `text()`. The story expects the welcome `Connect VS Code to your Mend server.`
    with [Connect]. Today the view shows one row naming the error.
  - `palette("Mend: Connect to server")`. The input titled `Connect Mend` asks
    `Mend server URL, as this machine reaches it (http://mend-mini.local:3105)`.
    `quickInput.type(state.server.origin)`, `quickInput.accept()`.
  - The quick pick titled `Connect Mend · <url>` offers `Sign in with the browser`,
    `Paste a device token` and `No token`. `quickInput.pick("Sign in with the browser")`.
  - When VS Code asks before opening `<url>/authorize`, record `dialogs()` and dismiss it. Read the
    code from `statusBar("Mend sign-in").text()` (`Mend sign-in · <code>`). The progress
    notification reads `approve in the browser if it shows <code>`, beside the toast
    `Mend sign-in: open <page> and approve if it shows <code>. …` with `Copy link` and
    `Paste a device token instead`. `shot("sign-in-code")`.
  - Approve as the web's approve page does, `api("/me/cli-auth/<code>/approve", { method: "POST" })`
    (`via: "api"`). The approval is the browser's half; the editor's half is under test.
  - `notifications()` after the walk. Today's source shows
    `Signed in to Mend at <url> as <email>. Revoke this editor under Settings → Devices.` and
    `Connected to Mend at <url>.` (two success toasts, Divergences item 6). The story expects one.
  - `treeItem(<project>).waitFor()`, `shot("signed-in")`. The story's Accounts menu entry is not
    built. Report `not run · not built`.
  - SSH setup. The story's welcome step [Set up] is not built. The first open asks once, the modal
    `Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)` with [Set up], only
    when this machine never set workspace SSH up; then the open seeds Remote-SSH's platform and
    resumes a stopped session as steps of its progress, with no further question. Not driven since
    the redesign; record `dialogs()` and `newWindows(<recorded>)` when it is.
  - Adopting. `palette("Mend: Adopt a project…")`; the input titled `Adopt a project` asks
    `Git clone URL`, then `Project name`. Type the world's source URL and `<project>-h`. Record
    `notification("Adopting").text()`, then `notification("Adopted").text()` (`Adopted <name>.`),
    and `treeItem("<project>-h").waitFor()`. The story's one-click `Adopt <name> from <origin>`
    [Adopt] is not built. `Nothing adopted yet.` is not reachable here, since `up` adopts a project.

Commands outside the stories, one gesture each:

- **New session in this worktree.**
  `treeItem(<label>).contextMenu("Mend: New session in this worktree…")`, then
  `quickInput.pick("Workbench")`. The quick pick is titled `New session · <project> › <worktree>`.
  `api("/projects/<id>")` (`via: "api"`) lists two sessions in one worktree.
- **New worktree without an agent.**
  `treeItem(<project>).contextMenu("Mend: New worktree without an agent…")`. The inputs titled
  `New worktree · <project>` ask `Name this manual change`, then `Base branch or commit`. The
  worktree opens as story c's stopped session does.
- **Stop.** `treeItem(<label>).contextMenu("Mend: Stop session")`. The modal `Stop <label>?`
  (`The worktree and reviewable change remain.`); `dialog("Stop").click("Stop session")`. The row's
  description turns to its settled word, and `api("/projects/<id>")` (`via: "api"`) agrees.
- **Open in Mend.** `treeItem(<label>).inline("Mend: Open in Mend")`. Record `dialogs()`; when VS
  Code asks before opening the external link, its dialog names `<web>/sessions/<id>`. Dismiss it.
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
- An input's placeholder is not in the text the helpers read. The Connect quick pick's plain-http
  warning is its placeholder, so no step can observe it.
- A Workbench session is created with the `claude` harness and resumed as a shell, so its row reads
  `claude · <id8>` until it has a label.
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
  else launched is theirs to open: their row offers no Open, and the palette's `Mend: Open` skips
  that check.
- The last-window rule. Open with VS Code's default `window.openFoldersInNewWindow` turns the window
  it runs in into the workspace, and the driver's local window with it. A recipe that needs the
  local window afterwards sets the setting to `on` first (`userSettings`, `via: "setup"`), uses
  `Mend: Open in New Window`, and drives the default-setting Open last.
- VS Code's context menu ignores a click that lands right after it opens. `contextMenu(item)` rests
  the pointer on the item for 300 ms before clicking and checks the menu closed.
- A tree row's tooltip is bound to its label, not the whole row: `tooltip()` hovers `.label-name`
  and moves away and back until VS Code's hover shows.
- A workspace window can show a `bash` tab beside Mend's attached tab: VS Code's own terminal, not
  Mend's; where it comes from is not established. `terminal().tabs()` reads every tab's name, the
  active one's and whether the keyboard is in a terminal.
- The CLI's token is used only while `mend.serverUrl` is empty or equals the CLI's URL. A token
  saved through `Mend: Connect to server` lives in VS Code's secret storage, not in `cli.json`.
