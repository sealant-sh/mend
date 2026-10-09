# Observed agents

A coding agent the user runs by hand inside a session's workspace, in a `mend shell`, an SSH session
or an editor terminal, is not launched by Mend, but Mend sees it: the agent writes its conversation
through the session's harness home, and fresh writes become an observed process row labelled
`<harness> (observed)`, for example `claude (observed)` (plan §17, decided 2026-08-28). The session
then reads running everywhere, the workspace stays up, and the conversation is captured when it goes
quiet, like an agent Mend started. Mend observes and does not own the process: it cannot steer or stop
it, and the row ends after five minutes without writes. The next write opens a fresh row.

## Sub-features

- `observe-start` turns a hand-run agent's first writes into a live `<harness> (observed)` process
  row, within about 20 seconds.
- `observe-running` makes the session read running: `Running · recording` on the web, `running` in
  `mend sessions`, `activity seen …` in the dashboard.
- `observe-quiet` ends the row after five minutes without writes, without stopping the workspace.
- `observe-revive` opens a fresh row when the agent writes again, a quiet-settled session included.
- `observe-yield` sees nothing while Mend's own agent in the session is live: its writes are presumed
  to be Mend's agent.

## How to get to it (user POV)

- CLI: `mend shell <session>` opens a shell in the workspace; running `claude` or `codex` there is
  the observed agent.
- Web and desktop: the session's terminal pane (a shell tab on the desktop) is another place to run
  it. The session page and the Now page show the status the observed agent produces.
- VS Code: `Mend: Take over session in the editor` (and `Take over in the editor` when opening a
  session) ends Mend's agent and resumes the same conversation by hand in the workspace terminal,
  where Mend observes it. Not drivable yet: this map has no VS Code driver. The observable end state
  is the session reading running with a `claude (observed)` row.
- Mobile: the session screen's header shows the resulting session status beside its harness and
  model; an observed agent makes it read running.
- Slack: the session's thread status message updates to the resulting state. Not drivable yet:
  this map has no Slack driver.
- TUI: the session row's state words read `activity seen <ago>` while an observed agent is current.
- No surface lists the `(observed)` label itself; the session's processes endpoint
  (`GET /api/sessions/<id>/processes`) carries it.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in as the session's owner, and
  `mend connect claude` has been run, so `claude` can sign in inside the workspace.
- The server reads harness homes it can see. Observation reads the session's harness home on the
  server (`/workspace/harness-home` in the workspace is its mount). Whether a capture-store workspace
  (the default, which mounts nothing) feeds the observer could not be confirmed from source; Launch
  must state which store it runs.
- A live session whose own agent is not running, held by a shell. Start
  `mend claude "Reply with one word and change nothing." --name verify-observed --project <project> --detach`
  and note `<id>` and `<id8>`. Open a shell in its workspace in tmux:
  `tmux new-session -d -s obs -x 200 -y 50 'mend shell <id8>'`. Then stop Mend's own agent:
  `mend stop <id8>`. The shell keeps the workspace up, and `mend sessions --project <project>`
  still lists the session (`idle` is the fold for a workspace a shell holds), not `running`.
  Read the latest Mend-launched agent's `exitedAt` from the processes endpoint, and start the
  hand-run agent more than two seconds after it. If the session settled, also wait more than
  two seconds after its settle time.
- `<token>` is `MEND_TOKEN` when set; otherwise use the CLI token from
  `$XDG_CONFIG_HOME/mend/cli.json`, default `~/.config/mend/cli.json`. When the preferred Mend
  directory is absent and `~/.mend` exists, legacy `~/.mend/cli.json` stays authoritative. Use
  that token for the processes read.

- **Before.** Run
  `curl -sS -H "authorization: Bearer <token>" <web>/api/sessions/<id>/processes`. No row has
  `"kind": "agent-external"` with `"exitedAt": null`.
- **Run an agent by hand.** After the exit-time window above, in the shell run
  `tmux send-keys -t obs 'claude -p "Reply with the word observed."' Enter`. The pane shows the
  agent's answer.
- **Observed row.** Within about 20 seconds, repeat the processes read. One row has
  `"kind": "agent-external"`, `"label": "claude (observed)"`, `"harness": "claude"`,
  `"status": "running"` and `"exitedAt": null`.
- **The session reads running.** Run `mend sessions --project <project>`. The session's status is
  `running`. Go to `<web>/sessions/<id>`: the header's status word reads `Running · recording`. Go
  to `<web>/`: the session is under `Live`.
- **Dashboard.** In `tmux new-session -d -s obsui -x 200 -y 50 'mend ui'`, select the session. Its
  state words read `activity seen just now` (then `activity seen <n>m ago`).
- **Quiet.** Wait five minutes without running the agent again. The processes read shows the row
  with `exitedAt` set, the session no longer reads `running` (the shell still holds the workspace), and the
  dashboard row reads `agent ended <ago>`.
- **Revive.** Run the same `claude -p …` in the shell again. Within about 20 seconds a new
  `claude (observed)` row with `"exitedAt": null` appears, and the session reads `running`.
- **Mobile status.** On the paired Expo web build at 390x844, open `/session/<id>`. The header
  shows the harness and the running status while the observed row is current. Capture its ARIA
  snapshot and screenshot.
- **Slack status.** Not drivable yet: this map has no Slack driver. For a session started from
  Slack, its thread's status message shows the resulting running state.
- **Proof.** Keep every processes read (command, body, time), the `mend sessions` transcripts, the
  tmux captures of the shell and the dashboard, and the session page's ARIA snapshot and screenshot
  while running. Report the status words as observed: `running` means writes were seen, not that the
  agent is healthy.

## Gotchas

- While Mend's own agent in the session is live, the observer looks away: a `claude` run beside it
  produces no row. Stop Mend's agent first, with a shell holding the workspace. Writes within two
  seconds of the latest Mend-launched agent's exit, or of the session settling, are ignored as tail
  writes; start the hand-run agent after that window.
- Observation is a 20-second heartbeat over file writes. Wait for the row; do not assert it the
  moment the agent starts.
- Five minutes of quiet ends the row. That is an inference, not an exit: the agent may still be
  open, waiting for input. Do not report the end as the agent exiting.
- Mend cannot steer or stop the hand-run process. The session page still shows `Stop` while the
  observed row is current. That action records the row as stopped but does not close the hand-run
  agent's terminal. This is partly verifiable: a stopped row does not prove the process ended.
  Stop the hand-run agent in the terminal that started it; do not use `Stop` as process-exit proof.
- What the session page's Terminal or Record pane shows while an observed agent is current was not
  confirmed from source. Assert the status word, not the pane.
- No web, CLI, TUI, desktop or phone surface prints the `(observed)` label. The processes endpoint is
  the only read of it; that is a gap for a user who wants to see what Mend observed.
- A harness home the server cannot read (codex can write one `0700`) makes the agent invisible; the
  server logs `session engine: harness home unreadable — external agents in it are invisible` once
  per session and harness.
- A settled session revives only on writes that postdate its settle, and only while its workspace
  pointer survives.
