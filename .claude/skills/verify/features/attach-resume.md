# Attach, detach, stop and resume

A session outlives the terminal that started it. A user reattaches a terminal to a live session with
`mend attach` (the whole scrollback replays, then it follows live), detaches with `Ctrl+]` while the
agent keeps running, and stops the agent with `mend stop`, leaving the worktree, the record and the
review. A settled session comes back with `mend resume`: a fresh workspace with the saved harness
state restored, in the same harness or another one. `mend rejoin` attaches if the session is live and
resumes it otherwise. The web session page offers `resume with:` per harness, a `rename` of the
session's label and `Delete…`; the dashboard has `a` and `r`. A session picked up on the phone runs as
a conversation with no terminal, and `mend attach` takes it back into the terminal. While attached
to a remote server, the session's browser Services are tunneled to this machine, and `Ctrl+V` pastes
an image from this machine's clipboard into the agent.

## Sub-features

- `attach-cli` reattaches a terminal with `mend attach [prefix]`, following a still-starting session
  until its agent runs.
- `detach` leaves with `Ctrl+]`; the session keeps running.
- `stop-cli` stops one session, every live session, or every live session of a project
  (`mend stop`, `--all`, `--project`).
- `resume-cli` resumes a settled session (`mend resume [id] [--with <harness>]`).
- `rejoin-cli` attaches if live, otherwise resumes (`mend rejoin [id] [--harness <h>]`).
- `resume-web` resumes from the session page's `resume with:` buttons and the Now page's `Resume`.
- `rename-web` sets or clears the session's label from the session page's `rename`.
- `delete-web` deletes a settled session from `Delete…`, two clicks; the worktree and change remain.
- `attach-tui` attaches (`a`) and resumes (`r`, with a harness picker) from the dashboard, and comes
  back to it on detach.
- `pickup-takeover` takes a session picked up on the phone back into a terminal.
- `attach-tunnels` tunnels the session's `--http`/`--https` Services while attached to a remote
  server (`--no-tunnel` opts out).
- `attach-image-paste` sends an image from this machine's clipboard with `Ctrl+V`.

## How to get to it (user POV)

- CLI: `mend attach [session-id-prefix] [--no-tunnel]`, `mend stop [session-id-prefix]`,
  `mend stop --all [--project <p>]`, `mend resume [session-id] [--with <harness>]`,
  `mend rejoin [session-id] [--harness <h>] [--no-tunnel]`. `mend codex|claude …` attach on launch
  unless `--detach`.
- Web: the session page (`/sessions/<id>`): `Stop` while the agent runs, `resume with:` and one
  button per harness once it has stopped, `rename` beside the heading for the owner, `Delete…` once
  stopped. The Now page's Projects list has `Resume` on each recent settled session; right-click menus
  on session rows offer `Stop session`, `Resume session` and `Delete session…`.
- TUI: `a` attaches the selected live session, `r` resumes a settled one through a harness picker,
  `Shift+K` stops, `e` renames the session's label.
- Desktop: the session tab's strip buttons `resume`, `stop`, `delete`, `continue as conversation` /
  `continue in terminal`; the inbox row menu's `Stop`.
- Mobile: the session screen's `Resume` action and `Stop session` in `More actions`; the message box
  under a terminal session picks it up as a conversation (`Message the session — continues here in
  structured mode`).
- VS Code: `Mend: Stop session`, `Mend: Take over session in the editor`. Not drivable yet: this map
  has no VS Code driver.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in as the session's owner.
  `mend connect claude` has been run (the resume, rename and pickup steps use a `claude` session).
- A clone of `<repo-url>` or a directory named `<project>` to run `mend resume` and `mend rejoin`
  from (`<project-dir>`): both find the project from the working directory only.
- For the pickup step: the mobile web build paired with this instance (its `mend-config` in
  browser storage holds the URL and a device token), at a 390x844 viewport.
- A live, detached session:
  `mend claude "Reply with one word and change nothing." --name verify-attach --project <project> --detach`.
  Note `<id>` and `<id8>` from `  attach · mend attach <id8>`.

- **Attach.** Run `tmux new-session -d -s att -x 200 -y 50 'mend attach <id8>'`. The pane shows
  `✓ attaching to verify-attach · claude <id8> · detach: Ctrl+]`, then the agent's terminal with its
  scrollback replayed.
- **Detach.** Run `tmux send-keys -t att C-]`. The pane shows
  `detached — the session keeps running; reattach: mend attach <id8>` and the command exits `0`.
  `mend sessions --project <project> --json` still shows the session live.
- **No match.** Run `mend attach zzzzzzzz`. Stderr reads
  `mend: no active session matches "zzzzzzzz"`; exit code `1`.
- **Stop.** Run `mend stop <id8>`. Stdout reads `✓ stopped · claude · <id8> · mend/verify-attach`
  and `  review · <web>/sessions/<id>`; exit code `0`. `mend sessions --project <project> --all --json`
  shows it no longer live.
- **Resume from the CLI.** From `<project-dir>`, run
  `tmux new-session -d -s res -x 200 -y 50 -c <project-dir> 'mend resume <id8>'`. The pane shows
  `✓ resuming claude · <id8>`, `  watch · <web>/sessions/<id>`, a spinner
  `resuming — a fresh workspace restores the saved session state…`, then
  `✓ recording · same worktree, conversation restored · detach: Ctrl+]` and the agent's terminal
  with the earlier conversation. Detach with `tmux send-keys -t res C-]`.
- **Resume a live session refused.** From `<project-dir>`, run `mend resume <id8>`. Stderr reads
  `mend: session <id8> is live — attach: mend attach <id8>`; exit code `1`.
- **Rejoin.** From `<project-dir>`, run `tmux new-session -d -s rej -x 200 -y 50 -c <project-dir> 'mend rejoin <id8>'`.
  The pane shows `✓ rejoining verify-attach · claude <id8> · already live`, the watch line, then
  `✓ recording · attached to the live session · detach: Ctrl+]`. Detach, run `mend stop <id8>`,
  and rejoin again: the first line ends `· restoring`, and the third reads
  `✓ recording · same worktree, conversation restored · …`. Detach, then `mend stop <id8>`.
- **Stop all in a project.** Start two detached sessions as in the preconditions (`--name verify-a`,
  `--name verify-b`), then run `mend stop --all --project <project>`. Stdout has one
  `✓ stopped · …` and `  review · …` pair per session, then `✓ stopped 2 sessions`. Run it again:
  `no active sessions`.
- **Rename on the web.** Go to `<web>/sessions/<id>`. Run
  `await page.getByRole("button", { name: "rename" }).click()`. A textbox replaces the heading's
  label, with focus. Run
  `await page.getByRole("textbox", { name: "what this session is about" }).fill("verify label")`
  and `await page.keyboard.press("Enter")`. The heading reads `claude — verify label`, followed by
  the `rename` button. `mend sessions --project <project> --all --json` shows
  `"label": "verify label"`.
- **Resume on the web.** With the session stopped, the page shows `resume with:` and buttons
  `claude`, `codex`, `opencode`, `pi`. Run
  `await page.getByRole("button", { name: "claude", exact: true }).click()`. The buttons read `…`,
  then the status reads `Starting`, then `Running · recording`, and the `Terminal` pane attaches.
  Stop it with `await page.getByRole("button", { name: "Stop", exact: true }).click()`.
- **Resume from the Now page.** Go to `<web>/`. In the `Projects` list, the session's row has a
  `Resume` button (scope it to the row; see Gotchas). Click it: it reads `resuming…` and the browser
  lands on `/sessions/<id>`.
- **Delete on the web.** Stop the session again, then run
  `await page.getByRole("button", { name: "Delete…" }).click()`. It now reads
  `Really delete this session? The worktree, its change, and checkpoints remain.` Run
  `await page.getByRole("button", { name: /^Really delete this session\?/ }).click()`. It reads
  `Deleting…`, then the browser lands on `/projects/<projectId>`. `mend sessions --all --json` no
  longer lists `<id>`; `mend worktrees --project <project>` still lists `verify-attach`.
- **Dashboard attach and resume.** Start another detached session (`--name verify-tui-attach`). Run
  `tmux new-session -d -s ui -x 200 -y 50 'mend ui'`, select the session and press `a`. The screen
  prints `attaching · claude · <id8> · detach: Ctrl+]` and the agent's terminal. Press `C-]`; the
  dashboard returns with `detached · <id8> keeps running`. Press `Shift+K` twice
  (`press ⇧K again to stop · verify-tui-attach`, then
  `stopped · verify-tui-attach · the record and review remain`). Press `r`: a picker titled
  `resume verify-tui-attach · pick a harness` lists `claude` first
  (`same harness · native resume, conversation intact`). Press `Enter`: the status line reads
  `resuming verify-tui-attach · a fresh workspace restores the saved state ·`, then
  `resumed · verify-tui-attach · a attaches` (or `still resuming · …`). Press `a` on a settled row
  instead and the status line reads `settled · <name> · r resumes it, ⇧D removes it`.
- **Pickup takeover.** On the mobile web build at 390x844, open `/session/<id>` for a live `claude`
  session the signed-in device owns. Fill the message box
  (`page.getByRole("textbox", { name: "Message the session — continues here in structured mode" })`)
  with `Reply with one word.` and click the text `Send`. The screen reads
  `picking up the session…`, then the conversation continues there. Then run
  `tmux new-session -d -s take -x 200 -y 50 'mend attach <id8>'`. The pane shows the attaching
  line, then `taking over from the protocol session`, a spinner
  `reopening as a terminal — same conversation…`, and the agent's terminal with the phone's turns
  in its scrollback.
- **Proof.** Keep the tmux captures of every attach, detach, resume, rejoin and takeover
  (`tmux capture-pane -p -S - -t <name>`), each `mend stop` and `mend sessions --json` transcript
  with its exit code, and the session page's ARIA snapshot and screenshot after rename, after resume
  and after delete.

## Gotchas

- `mend resume` and `mend rejoin` take no `--project`: they resolve the project from the working
  directory (a clone with the same origin, or a directory with the project's name). Elsewhere they
  fail with `no adopted project matches <cwd> — run "mend adopt" here first, or name one with --project`,
  which names a flag these two commands do not read. That message is a finding.
- `mend resume --with` is documented as `claude or codex`; the web offers `opencode` and `pi` too.
  Drive `--with` with the documented values.
- `mend attach`, `mend resume` and `mend rejoin` hold the terminal. Run them in their own tmux
  session; never in a pipe.
- Detaching never stops the agent. Once attached, `Ctrl+C` goes to the agent like any key; only
  while the terminal is still connecting does it cancel. A session launched `--foreground` (or under
  a project that runs in the foreground) is stopped when its launching terminal exits any other way
  than `Ctrl+]`.
- `MEND_DETACH_KEY=none` turns `Ctrl+]` off (for an outer multiplexer that owns detaching); the
  banner then omits `· detach: Ctrl+]`.
- The heading's accessible name includes the `rename` button's text, and the rename textbox is named
  only by its placeholder `what this session is about`: a finding, it needs a label. `Escape`
  cancels the rename; leaving the field saves it.
- `Delete…` and `Discard unsaved and stop…` are two-click buttons that rename themselves when armed;
  moving focus away disarms them.
- `resume with:` buttons are named by harness only (`claude`, `codex`, `opencode`, `pi`); pass
  `exact: true`. Only harnesses this viewer may relaunch are shown; someone who steers under shared
  control reads that only the owner resumes in a terminal.
- On the Now page, each project card's recent rows repeat `Review` and `Resume` with no accessible
  name tying them to their session. Scope to the row:
  `page.locator("div", { has: page.getByRole("link", { name: /^claude — verify label/ }) }).last().getByRole("button", { name: "Resume" })`
  (`.last()` is the innermost container, the row).
  The rows have no list or row role: a finding.
- Service tunnels on attach apply only to a server that is not this machine, and only to Services
  declared `--http` or `--https`. Each opens with a line
  `● <service> → http://localhost:<port> · tunnel, closes on detach`; `--no-tunnel` opens none.
  A local server tunnels nothing, and that is not a failure.
- `Ctrl+V` image paste needs `wl-paste` (Wayland) or `xclip` (X11) on the CLI's machine and an image
  on its clipboard; with none, the keystroke goes through unchanged. The pasted text is a path inside
  the workspace; a failed upload rings the terminal bell. In a headless harness, load the clipboard
  first (for example `xclip -selection clipboard -t image/png -i <png>` under an X server).
- The phone's message box offers the pickup only to the session's owner and only for `claude` and
  `codex`. On the web build every mobile button but the icon actions is a role-less element named by
  its text: click `Send` with `getByText`. `Stop session` asks through a native alert that does
  nothing on the web build; stop from the CLI.
- Mobile rename and delete live behind a swipe on the Now tab's rows (`Rename`, `Delete`), which the
  web build cannot reliably drive. Not driven by this map.
- The desktop's `delete` and closing a shell tab ask with `window.confirm`; accept it with
  `page.once("dialog", (d) => d.accept())` before the click.
