# The terminal dashboard

Bare `mend`, or `mend ui`, opens a full-screen dashboard of every project, worktree and session on
the server, updating live. A sidebar on the left quarter stacks three numbered panes,
`[1] projects`, `[2] worktrees` and `[3] sessions`; the one the keyboard is in stands open and the
other two fold to one line. The session pane on the right, `[0]`, shows the selected session's facts
and the conversation record it has written. The navigation is lazygit's (mend#668): a digit jumps to
its pane, `tab` and `⇧tab` cycle and wrap, `esc` goes back, `?` lists every key, `/` filters the
focused list, and `+` and `_` cycle the screen mode. Moving the selection only navigates;
single-letter verbs attach, resume, start, rename, review, open in the browser, stop, remove and
refresh. `v` opens a review of the change in the terminal. While a session starts, and with
`mend snake`, a game of snake fills the wait: it counts down `3`, `2`, `1`, `GO` once it has the
keyboard (mend#665). Run inside a checkout that no project matches, the dashboard offers to adopt
it. It needs Node 26 or newer.

## Sub-features

- `tui-open` opens with bare `mend` or `mend ui` on a terminal, and refuses on Node older than 26.
- `tui-layout` stacks projects, worktrees and sessions beside the session pane, and folds or hides
  what does not fit, saying so in a breadcrumb.
- `tui-navigate` moves with the arrows, `j` `k`, `h` `l`, Enter, PageUp and PageDown; `1` `2` `3`
  `0` jump to their pane, `tab` and `⇧tab` cycle the panes and wrap, and `esc` goes back to the pane
  the move came from.
- `tui-keys` lists every binding with `?`, grouped, in an overlay titled
  `keys · <the focused pane>`.
- `tui-filter` narrows the focused list with `/`; Enter keeps the filter, `esc` clears it.
- `tui-screen-mode` cycles normal, half and full screen with `+` (and back with `_`).
- `tui-new-worktree` starts a worktree and a session from `w` (or `n` where there is no worktree):
  name, base, harness.
- `tui-new-session` starts another session in the selected worktree from `n` and a harness picker.
- `tui-attach` takes this terminal into a live session with `a`; `Ctrl+]` gives it back.
- `tui-resume` resumes a settled session with `r` on a harness the picker offers.
- `tui-rename` labels a session with `e`.
- `tui-open-web` opens the session page in the browser with `o`.
- `tui-stop` stops a session, every live session of a worktree, or a held workspace's Services with
  `⇧K` pressed twice.
- `tui-remove` removes a settled session, or a worktree with no live session, with `⇧D` pressed
  twice.
- `tui-refresh` re-reads everything with `⇧R`.
- `tui-review` opens the change review in the terminal with `v`: files, diff, comments, tour.
- `tui-snake` floats snake over the dashboard with `mend snake`, and shows it in the session pane
  while a session starts; it counts down before the snake moves, and while it has the keyboard every
  dashboard key is its own.
- `tui-adopt` offers to adopt the current checkout's origin, with a choice of Git access.
- `tui-tunnels` tunnels the selected session's browser Services to this machine on a remote server.
- `tui-quit` leaves with `q`.

## How to get to it (user POV)

- CLI: bare `mend`, `mend ui [--no-tunnel]`, `mend snake`.
- CLI: `mend help ui` and `mend help snake` describe it; the docs page is `clients/terminal`.
- Web, desktop, mobile, VS Code and Slack: not a surface for this feature. The desktop app is its
  own GUI on the same engine, mapped in [desktop](./desktop.md).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the CLI is signed in to it, and `<project>` is adopted (see
  [Adopt a project](./adopt-project.md)).
- The `mend` on `PATH` runs on Node 26 or newer and is a built CLI (the published `dist/main.js`, or
  an esbuild bundle of `apps/cli/src/main.ts`). A wrapper that runs `node apps/cli/src/main.ts` from
  a checkout stops when the dashboard opens: `ERR_UNKNOWN_FILE_EXTENSION` for
  `apps/cli/src/dashboard.tsx`. For the Node gate step, a Node 22 or 24 binary is also available as
  `<node22>`, and `command -v mend` resolves to a JavaScript file Node can run (the published
  `dist/main.js`). How Launch installs the CLI decides that: a shell wrapper or the TypeScript
  source does not qualify. Without both, report that step unreachable.
- tmux is installed. Every dashboard runs in its own session sized like a real terminal, started in
  a directory that is not a Git checkout (so no adopt offer appears), and wrapped so its exit code
  stays on screen:
  `tmux new-session -d -s verify-tui -x 200 -y 50 'cd /tmp && mend ui; echo "exit $?"; sleep 600'`.
  Read the screen with `tmux capture-pane -p -t verify-tui` and wait for a string, never a fixed
  sleep.
- No worktree named `verify-tui` exists in `<project>` (`mend worktrees --project <project>`).
- For the review step, the base `verify-tui` forks from has no `TUI.md`, and the shell session
  changes nothing but writing that file; the file and line counts below assume exactly that diff.
- For the adopt step, a local clone of a second disposable repository whose origin (written
  `<repo-url-2>`) no project uses; Launch must supply it, or the step is reported unreachable.

- **Open.** Start the session above. The top line starts ` mend  <n> projects · <m> live` (or
  ` mend  1 project · <m> live` with a single project) and ends with `<web>`. The sidebar shows the
  `[1] projects`, `[2] worktrees · <n>` (with `· <m> live` while any session is live) and
  `[3] sessions · <n>` frames (the last reads plain `[3] sessions` while no worktree is selected),
  the session pane's frame reads `[0] session · read-only` (or `[0] session` with nothing selected),
  and the footer starts ` ↑↓ move · ←→ panes · a attach · r resume · n new session · w new worktree`
  and ends `· ? keys`. The focused pane's numbered title is drawn in the accent colour, every other
  title in the ink colour.
- **Jump between the panes.** Send `2`: the footer reads
  ` ↑↓ move · ←→ panes · a attach · r resume · n new session · w new worktree · ⇧K stop all · ⇧D remove worktree · v review · ⇧R refresh · q quit · ? keys`
  (cut with `…` on a narrower terminal, `? keys` kept). Send `0`:
  ` ↑↓ scroll · ← sessions · a attach · r resume · v review · e rename · o web · ⇧R refresh · q quit · ? keys`.
  Send `Escape`: the keyboard goes back to `[2] worktrees`, where the jump came from. Send `Tab`
  four times from `[1] projects`: the footers walk `[2]`, `[3]`, `[0]` and wrap to `[1]`; `BTab`
  walks back. A digit no pane carries (`4`) does nothing.
- **Navigate to the project.** Send `1` (or `Left` once per pane; `Left Left` in one call moved one
  section only). The projects section opens and the footer reads
  ` ↑↓ move · → worktrees · n/w new worktree · ⇧R refresh · q quit · ? keys`. Send `j` or `k` until
  the row with `<project>` carries the `▌` gutter.
- **Every key, listed.** Send `?`. An overlay whose title starts `keys · [1] projects` lists the
  bindings in three groups, `move around`, `act on the selection` and `the dashboard`, each row a
  key and what it does (`1  jump to [1] projects`,
  `tab  next pane, round to the first after the last`,
  `⇧K x  stop it, or every live session in [2] (press twice)`, `?  this list`), and ends
  `esc closes`. The keys the focused pane's footer names are drawn brighter. Send `Escape`: the
  overlay closes and the focus has not moved.
- **Filter a list.** Send `2`, then `/`. The footer reads `/ ` and takes what you type: send
  `tmux send-keys -t verify-tui -l <part of a worktree name>`. The list narrows as you type and the
  frame's title becomes `[2] worktrees /<text> · <n>` (`<n>` the matching worktrees, then
  `· <m> live` as before). Send `Enter`: the filter stays and the footer is the pane's own again.
  Send `Escape`: the filter clears and every worktree is back. Send `1` to return to the projects.
- **Screen modes.** Send `+`. The top line adds `half screen ·` before the URL, the sidebar takes
  half the width, and the status line reads `screen mode · half · + and _ cycle it`. Send `+` again:
  `full screen`, the focused side takes the whole screen (the session pane is hidden and a
  breadcrumb reads `record hidden · → opens it`), and the status line reads
  `screen mode · full · + and _ cycle it`. Send `+` again: back to normal, `screen mode · normal`.
  `_` cycles the other way.
- **Session verbs refuse at the project tier.** Send `a`. The status line reads
  `select a session first · → opens worktrees`. Nothing attaches.
- **New worktree: name.** Send `w`. A modal titled `new worktree · <project>` opens with rows
  `name`, `base` and `harness`, and the footer reads ` enter continue · esc cancel`. Send
  `tmux send-keys -t verify-tui -l verify-tui` then `Enter`.
- **New worktree: base.** The footer reads
  ` type to filter · ↑↓ move · enter choose base · esc back` and the slots list branches with a
  short sha, an age and `default` on the default branch. Wait for the list, then send `Enter`.
- **New worktree: harness.** The footer reads ` ↑↓ move · enter launch · esc back` and the harness
  rows read `codex`, `claude`, `opencode`, `pi` and `shell`. Send `Down Down Down Down`, so `shell`
  carries the gutter (it needs no provider), then `Enter`. The modal closes, the sessions section
  opens, and the status line reads `provisioning shell workspace · <n>s elapsed`, then
  `started · shell <id8> · a attaches` or
  `still starting · shell <id8> · a attaches once the row reads running`. The worktrees frame names
  `verify-tui`.
- **Snake while it starts.** While the session pane reads `starting · …`, it shows
  `play snake while you wait · score 0` above a still board (the snake and the food), with
  `enter plays` under it while the game does not have the keyboard. A start from the dashboard (the
  `w` step above) hands the game the keyboard once the pane shows it; otherwise send `Enter` (or
  `0`) from `[3] sessions`. The game takes the keyboard only when its board fits the terminal (a
  200x50 one fits). Its board border turns to the accent colour, it counts down `3`, `2`, `1`, `GO`
  in large block digits (about a second each) with the snake drawn over them, and only then does the
  snake move. The footer reads `←↑↓→/hjkl steer · space/p pause · esc/q leave`. While it plays, the
  digits, `Tab`, `?`, `/`, `+`, `_` and the verbs do nothing. Send `Space`: the heading adds
  `· paused` and the footer reads `enter/space resume · esc/q leave`. Send `Escape`: the keyboard
  goes back to `[3] sessions`, and the paused board stays in the pane with `enter plays`. A fast
  start can skip this; report it unreachable then, not failed.
- **Session pane.** Once the row's status reads `running`, the pane shows the session's name and
  `· shell`, the status with its branch and `vs <base>`, a `created … · <id8>` line,
  `no services running`, `no open review comments`, and, since a shell has no conversation record,
  `shell · no conversation record; a attaches if live`.
- **Attach and detach.** Send `a`. The dashboard gives way to
  `attaching · shell · <id8> · detach: Ctrl+]` and a bash prompt in the workspace. Send
  `tmux send-keys -t verify-tui -l "printf 'tui\n' > TUI.md"` and `Enter`. Send
  `tmux send-keys -t verify-tui C-]`. The dashboard returns and the status line reads
  `detached · <id8> keeps running`.
- **Rename.** Send `e`. A modal titled `label · shell <id8>` opens. Send
  `tmux send-keys -t verify-tui -l 'verify tui'` and `Enter`. The status line reads
  `labeled · verify tui`, and the session row now reads `verify tui`.
- **Review.** Send `v`. The screen first reads `Loading the live change…` (or `<error> · retrying`);
  wait it out. Then the first line reads ` mend / <project> / review · shell <id8>`, then
  ` · syncing` while it refetches, then ` · checkpoint recorded`. With the fixture above, the second
  line names `1 files` and `+1`, the `files · 1` frame lists `TUI.md`, and the diff frame's title
  reads `TUI.md · unified`. The footer is two lines: the first starts
  ` m read · g suggest · t tour`, the second ` diff · ↑↓/jk lines · n/p files`. Send `w`; the diff
  title ends `· wrapped`. Send `Tab`; the footer's second line starts ` comments · ↑↓/jk move`. Send
  `r`; the status line reads `Refreshing live change…`. Send `Escape`; the dashboard returns. If `v`
  instead reads `this session has no reviewable change yet`, send `R` (status `refreshing…`) and try
  again once a checkpoint exists.
- **Open in the browser.** Send `o`. The status line reads `opened · <web>/sessions/<id8>…`.
- **Stop.** Send `K`. The status line reads `press ⇧K again to stop · verify tui`. Within five
  seconds send `K` again. It reads `stopped · verify tui · the record and review remain`, and the
  row's status settles. Once the row no longer reads `stopping`, send `K` again: the status line
  reads `nothing to stop · the session is settled`.
- **Remove, armed only.** Send `D`. The status line reads
  `press ⇧D again to remove session · verify tui · its record goes, the worktree stays`. Send
  nothing for five seconds; a later `D` arms again instead of removing.
- **Second view.** Outside the dashboard run `mend sessions --project <project> --all --json`. The
  `verify-tui` session is listed with `"harness": "shell"`, the label `verify tui` and a settled
  status. Run `mend worktrees --project <project>`. `verify-tui` is listed.
- **Narrow terminal.** Run `tmux resize-window -t verify-tui -x 60 -y 50`. The sidebar takes the
  whole width and a breadcrumb row reads `record hidden · → opens it`. Send `Enter` until the
  session pane opens; it takes the whole width and the breadcrumb lists the selected project,
  worktree and session separated by `▸`. Resize back with `-x 200`.
- **Quit.** Send `q`. The screen reads `exit 0`.
- **Snake over the dashboard.** Run
  `tmux new-session -d -s verify-snake -x 200 -y 50 'cd /tmp && mend snake; echo "exit $?"; sleep 600'`.
  A frame titled `snake` floats over the dashboard with `play snake while you wait · score 0`; it
  counts down `3`, `2`, `1`, `GO`, and the footer reads
  `←↑↓→/hjkl steer · space/p pause · esc/q leave`. The dashboard's keys (`1`, `0`, `Tab`, `?`, `/`)
  do nothing under it. Send `Space`: `· paused`, and the footer reads
  `enter/space resume · esc/q leave`. Send `q`: the frame closes, the dashboard stays with
  `[3] sessions` focused, and its footer is back. Send `q` again: `exit 0`.
- **Adopt from the dashboard.** In the clone of `<repo-url-2>`, run
  `tmux new-session -d -s verify-adopt -x 200 -y 50 'cd <clone> && mend ui; echo "exit $?"; sleep 600'`.
  A modal titled `adopt this repository URL?` shows `<name> · not in the store yet`, the origin URL,
  `auth  ▸ ambient · mend-key · bridge` and ` enter adopt · ←→ auth mode · esc not now`. Send
  `Right`; the marker moves to `▸ mend-key` and its hint line changes. Send `Escape`; the status
  line reads `not adopted · use mend adopt <url> any time`. To adopt instead, restart it and send
  `Enter` with the mode the instance can clone with: the status line reads
  `adopting <name> · cloning into the store ·`, then `adopted · <name> · w starts a worktree`, and
  `mend projects` lists `<name>`.
- **Node gate.** Run
  `tmux new-session -d -s verify-node -x 200 -y 50 '<node22> "$(command -v mend)" ui; echo "exit $?"; sleep 600'`.
  The screen reads
  `mend: the dashboard needs Node >= 26 (node:ffi) — this is v<version>; every other command still works`
  and `exit 1`.
- **Proof.** Keep a `tmux capture-pane -p -t <session>` snapshot after every step, named by step,
  plus `tmux capture-pane -e -p` for the layout steps (the focused frame is drawn in the accent
  colour). Keep the second-view JSON. Clean up with
  `mend worktrees rm verify-tui --force --project <project>` and `tmux kill-session -t <session>`
  for each session this run started.

## Gotchas

- The dashboard is a terminal UI with no accessibility tree. Every handle is a key and every proof
  is text on the screen. The focused pane is marked only by colour (its numbered title in the accent
  colour) and the `▌` gutter; read the footer to know which pane has the keyboard, since each pane's
  footer differs, or send `?`, whose overlay title names the focused pane (`keys · [3] sessions`),
  then `Escape`.
- tmux key names: `Enter`, `Escape`, `Tab`, `BTab` (Shift+Tab), `Space`, `Up` `Down` `Left` `Right`,
  `NPage` `PPage`, `C-]`. Digits, `?`, `/`, `+` and `_` are sent as themselves. `⇧K`, `⇧D` and `⇧R`
  are sent as the capital letters `K`, `D`, `R`. opentui reads a capital letter from tmux as shift
  plus the letter: `K`, `D` and `R` acted as ⇧K, ⇧D and ⇧R in the live pass of 2026-10-10.
- tmux holds a lone `Escape` for its `escape-time` before passing it on. Wait for the screen to
  change before the next key, or set `tmux set -s escape-time 0`.
- In the worktree form, the base step's input appears only once the branch list has loaded; an
  `Enter` sent before that does nothing. Wait for a branch row (or the list's own notice) first.
- `⇧K` and `⇧D` act only on a second press within five seconds while their armed line is still the
  status. Any other key between the presses disarms them.
- The review header's `· checkpointing` and `· checkpoint incomplete` words never show: the header
  draws only once the change has loaded, and then it always reads `· checkpoint recorded`
  (`apps/cli/src/review.tsx:606`, `1140-1151`). Dead branches; a finding.
- `x` stops exactly like `⇧K`. The `?` overlay lists it (`⇧K x`) and `clients/terminal` documents
  it, but `mend help ui` does not. A gap between the keymap and the catalog.
- Since mend#668, `tab` cycles the panes and wraps; it no longer stops at the ends. Enter, `l` and
  `→` still drill in and stop at `[0]`, and `←`, `h`, `-` and backspace step back and stop at `[1]`.
  `esc` from `[0]` returns to the list the move came from, not always `[3]`.
- While a snake game has the keyboard (the session pane while a session starts, or `mend snake`),
  every dashboard key is swallowed; only its own keys act, and `Escape` or `q` hands the keyboard
  back. A step that sends a dashboard key then must leave the game first.
- The adopt offer starts on `ambient` (`apps/cli/src/dashboard-adoption.ts:28`,
  `apps/cli/src/dashboard.tsx:1195-1218`), while `mend adopt` defaults to the user's
  `mend keys mode` (`mend-key` unless changed). Enter without moving adopts with the server's own
  Git setup. A product inconsistency to report.
- `clients/terminal` says the harness picker offers `codex`, `claude`, `opencode` or `shell`; the
  dashboard also offers `pi` (`apps/cli/src/shared.ts:12-19`). A docs gap.
- `mend snake` reads `--no-tunnel` (`apps/cli/src/main.ts:5035-5036`), which `mend help snake` does
  not list.
- Tunnels open only when the server is not this machine: a `localhost`, `127.0.0.1` or `::1` URL
  opens none, and `--no-tunnel` turns them off. On Launch's loopback stack the `tui-tunnels`
  sub-feature is unreachable; report it so. On a remote server a tunneled Service shows in the
  session pane as `<name> → http://localhost:<port>`.
- `a` suspends the dashboard and hands the terminal to the session; the capture then shows the
  workspace shell, not the dashboard. `Ctrl+]` is the detach path that gives the terminal back and
  leaves the session running (`detached · <id8> keeps running`). The dashboard also returns when the
  attach is interrupted (the same `detached` line), when the connection drops
  (`disconnected · <id8> · refreshing session status`), when the server does not open the terminal
  (`no answer · …`), or when the terminal ends
  (`terminal ended · <id8> · refreshing session status`, for example after `exit` in the shell).
  Only the first leaves a live shell behind for certain. `MEND_DETACH_KEY=none` turns it off, which
  a harness must not set.
- `o` runs the machine's browser opener. On a headless host nothing opens, yet the status line still
  reads `opened · …`; it states the request, not a page load.
- Removing a worktree whose change was never landed is refused by the server, and the status line
  shows the refusal. Clean up with `mend worktrees rm verify-tui --force` instead of `⇧D`.
- On a stdout that is not a terminal, `mend ui` and bare `mend` print the help index and exit `0`;
  they never open the dashboard in a pipe.
- Status words in rows (`starting`, `running`, `stopping`, `completed`) are the server's
  observations. Report them as written.
