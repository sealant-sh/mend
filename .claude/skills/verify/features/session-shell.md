# Shell in a session

A shell is a terminal into the same workspace the agent works in: the same `/workspace/repo`, the
same dependencies, the same network. A user opens one beside a live session with `mend shell`, or a
new shell tab on the desktop, to run the tests or read a file; it holds the workspace up while it
lives, even after the agent stops. Separately, a user can start a session whose harness is the shell
itself (`shell`), in a new worktree, from the project page's `Open a shell`, a project's context
menu, the dashboard's harness list or the desktop launcher: a recorded terminal session with no
agent.

## Sub-features

- `shell-cli` opens a shell in a live session's workspace with `mend shell [prefix]`, and leaves it
  with `exit` or detaches with `Ctrl+]`.
- `shell-holds` keeps the workspace up while a shell lives, after the agent stops.
- `shell-session-web` starts a shell-harness session in a new worktree from the project page's
  `Open a shell` or the project menu's `Start shell session`.
- `shell-session-tui` starts one from the dashboard's harness list (`n`, `w`), or resumes a settled
  session as `shell`.
- `shell-tab-desktop` opens a shell tab in the focused session (`Ctrl+Shift+T` or the tab bar's
  `+`).
- `shell-mobile` opens a shell from the session screen's `Shell` action.

## How to get to it (user POV)

- CLI: `mend shell [session-id-prefix]`. An explicit id prefix selects a live or retained session.
  Without an id, the cwd's project narrows those sessions when it matches; one candidate is taken,
  and several open a numbered picker only on a TTY. A non-TTY caller with several must name one.
- Web: the project page header's `Open a shell` button (`/projects/<id>`), and `Start shell session`
  in a project's right-click menu on the Now page's Projects list and on `/projects`. Both start a
  new session with the `shell` harness in a new worktree; neither opens a shell in an existing
  session.
- TUI: `n` or `w` then `shell` in the harness list; `r` then `shell` in the resume picker; `a` on a
  live session with no agent terminal rejoins its open shell or opens one.
- Desktop: `Ctrl+Shift+T`, or the tab bar's `+` button (title
  `New shell in focused session (Ctrl+Shift+T)`), opens a shell tab in the focused session; the
  launcher's `Open a shell` starts a shell-harness session.
- Mobile: the session screen's `Shell` header action opens `/terminal/<id>?process=<processId>`.
- VS Code: `Mend: New worktree without an agent…` starts a shell-harness session in a new worktree.
  Not drivable yet: this map has no VS Code driver; the end state is a new `shell` session in
  `mend sessions`.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in, and `<project>` adopted.
- A live session in `<project>`: run `mend run --project <project> -- sleep 1800` in its own PTY and
  note `<id>`, `<id8>` and `<worktree>`.

- **Open from the CLI.** Run `tmux new-session -d -s sh -x 200 -y 50 'mend shell <id8>'`. The pane
  shows `✓ shell in <harness> session <id8> · <branch> · detach: Ctrl+]`, then a prompt in the
  workspace.
- **Same workspace.** Run
  `tmux send-keys -t sh 'pwd; git -C /workspace/repo rev-parse --abbrev-ref HEAD' Enter`. The pane
  shows `/workspace/repo` (or the shell's start directory) and `<branch>`.
- **Write a file.** Run
  `tmux send-keys -t sh 'printf "from the shell\n" > /workspace/repo/SHELL.md' Enter`.
- **Detach.** Run `tmux send-keys -t sh C-]`. The pane shows
  `detached — the shell keeps running and holds the workspace open`, and the command exits `0`.
- **Holds the workspace.** Stop the agent: `mend stop <id8>`. Run
  `mend sessions --project <project>`. The session is still listed, not settled (`idle` is the fold
  for a workspace a shell holds): the shell holds its workspace.
- **Rejoin.** In the dashboard (`tmux new-session -d -s shui -x 200 -y 50 'mend ui'`), select the
  session and press `a`. Capture the attached terminal, which prints
  `no live terminal · rejoining the open shell`, then the shell's prompt. Run
  `cat /workspace/repo/SHELL.md` there; it prints `from the shell`. Run `exit`; the dashboard
  returns with the status line `terminal ended · <id8> · refreshing session status`.
- **End.** With no shell left, the session settles; `mend sessions --project <project> --all --json`
  shows it no longer live.
- **Shell session from the web.** Go to `<web>/projects/<projectId>` and run
  `await page.getByRole("button", { name: "Open a shell" }).click()`. The button reads `Starting…`,
  then the browser lands on a new `/sessions/<id>` whose heading starts with `shell`, and the
  `Terminal` pane attaches. Click into it
  (`await page.getByRole("textbox", { name: "Terminal input" }).first().click()`) and type
  `await page.keyboard.type('printf "web shell\\n" > WEB.md\n')`.
- **Second view.** Run `await page.getByRole("button", { name: "Mark checkpoint" }).click()`, then
  follow `page.getByRole("link", { name: "Review the change" })`. The review lists `WEB.md`.
  `mend sessions --project <project>` lists a `shell` session.
- **Project menu.** On `<web>/`, right-click the project card
  (`await page.getByRole("main").getByRole("link", { name: "<project>", exact: true }).click({ button: "right" })`;
  unscoped, it also matches the sidebar's link of the same name). The menu offers
  `Start shell session` (`page.getByRole("menuitem", { name: "Start shell session" })`); choosing it
  opens another new `shell` session page.
- **Desktop.** With a session tab focused, press `Control+Shift+T`
  (`await page.keyboard.press("Control+Shift+T")`). A new tab titled `shell <n>` (`shell 1` for the
  first) opens with the strip `shell <n> · session worktree · <branch>`, and buttons `rename` and
  `detach tab`.
- **Mobile.** At 390x844 on `/session/<id>`, run
  `await page.getByRole("button", { name: "Shell" }).click()`. The app pushes
  `/terminal/<id>?process=<processId>` titled `Shell`. The web build cannot render the terminal (see
  Gotchas); the URL and title are the observable end state.
- **Proof.** Keep the tmux captures (`tmux capture-pane -p -S - -t sh`), the `mend stop` and
  `mend sessions` transcripts, the web shell session page's ARIA snapshot and screenshot, and the
  review page showing `WEB.md`.

## Gotchas

- `mend shell` and `Ctrl+Shift+T` open a shell in an existing session. The web's `Open a shell` and
  `Start shell session`, the TUI's `shell` harness and VS Code's `New worktree without an agent…`
  start a new session in a new worktree. Do not prove one with the other.
- A worktree's own right-click menu and its `New session in <worktree>` menu offer only `claude`,
  `codex`, `opencode` and `pi`; there is no shell in an existing worktree from the web.
- The web terminal has two elements named `Terminal input` with role `textbox` (the canvas host and
  its hidden textarea). Use `.first()` and type through `page.keyboard`. Its output is drawn on a
  canvas, not text: prove what a command did through a second view (the review, `mend shell`, a
  file), not by reading the pane.
- Detaching (`Ctrl+]`) leaves the shell running and the workspace up. End it with `exit` when the
  run needs the session to settle. `MEND_DETACH_KEY=none` turns the detach key off.
- With no id and several live or retained candidates after narrowing by the cwd's project,
  `mend shell` opens a numbered picker on a TTY and refuses without one:
  `mend: several live sessions — name one: mend shell <session-id-prefix>`. Always pass the id
  prefix in a scripted run.
- Only the session's owner opens a shell in it on the desktop, even while control is shared; others
  read `only this session's owner opens a shell in it, even while control is shared`.
- The desktop's `+` button is named `+` (`…` while opening); its title is not its name.
- On the mobile web build, every shell control except the `Shell` header action is a role-less
  element named only by its text (`Stop`, the key bar), `Stop` asks through a native alert that does
  nothing on the web, and the terminal itself renders only
  `React Native WebView does not support this platform.`
- `Starting…` and provisioning can finish between reads. Report each transient state not observed
  and capture the new session's URL and heading.
- `Open a shell` and `Start shell session` share their status words with every session: assert the
  heading `shell` and the `/sessions/<id>` URL, not the status word.
