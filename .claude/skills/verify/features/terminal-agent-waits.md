# Terminal agent waits

A terminal agent is `claude` or `codex` running as the TUI in a session's PTY (an `agent-pty`
process). When it stops to ask the person something, it says so through its own hooks, and the
session reads `waiting` with the reason, the way a protocol agent with a pending request already
does. Mend wires the hooks: claude gets them in the `--settings` JSON on its argv, codex in the
`[hooks]` table of `/etc/codex/config.toml`. Each hook runs `mend hook <claude|codex>`, the
in-workspace helper, which reads the hook's JSON on stdin, forwards four fields (harness, event,
notification type, tool) to `POST /session/agent-hook` on the session channel, prints nothing and
exits 0. The session id comes from the channel's grant, never from the body, so a workspace reports
only about its own session, and only while that session has a live `agent-pty`.

## Sub-features

- `wait-permission`: `PermissionRequest` (claude, codex) and claude's `Notification` of type
  `permission_prompt` set a permission wait with the tool when the hook names one:
  `waiting · claude needs your permission to use Bash`. A repeat of the same wait keeps its tool and
  its `since`.
- `wait-question`: claude's `Notification` of type `elicitation_dialog` sets a question wait.
- `wait-prompt`: `Stop` (and claude's `idle_prompt`) sets a prompt wait: the agent finished its
  turn.
- `wait-clears`: `PostToolUse` and `UserPromptSubmit` clear the wait; so does the person typing in
  the agent's terminal.
- `wait-ends-with-agent`: the agent's process ending clears the wait, and a report that arrives
  after it changes nothing.

## How to get to it (user POV)

- Every surface that shows `Needs you`, a badge or a push keys on the session's status `waiting`:
  web (the Now page), mobile, the VS Code tree, the CLI dashboard, the push notifier. A terminal
  agent's wait reaches all of them with no client change.
- The reason is `currentAgent.waiting` (`{ kind, tool, since }`) on `GET /api/sessions/<id>` and on
  the list views that carry `currentAgent`; `/api/events` sends `session-process` and `session`
  pointer frames when it changes. The words (`waiting · claude needs your permission to use Bash`)
  come from the reason; the VS Code extension prints them from a later PR on.
- Permission waits appear only in the `ask` permission mode (a default launch skips permissions);
  prompt waits appear in every mode.

## Driving it with verify

The recipe is `recipes/g4-terminal-agent-waits.mjs`, run by `drive-vscode.mjs` against a world built
from the checkout under test:

```sh
node $skill/scripts/drive-vscode.mjs up --build
export MEND_VERIFY_VSCODE_RUN=<the run up printed>
node $skill/scripts/drive-vscode.mjs run $skill/recipes/g4-terminal-agent-waits.mjs \
  --out "${XDG_STATE_HOME:-$HOME/.local/state}/mend-verify/st-verify-vscode-$MEND_VERIFY_VSCODE_RUN/terminal-agent-waits"
node $skill/scripts/drive-vscode.mjs down
```

`MEND_VERIFY_G4_PAUSE_MS` (default 8000, at least 3000) is the stand-in's pause before each event;
every state must be read within it. Each step is one line of `steps.jsonl` with the status and the
`waiting` object read, the hooks' exit codes, and the pointer frames seen. Beside it: `shell.txt`
(the shell's output), `events.json` (every `session` and `session-process` frame, timed),
`claude-settings.json` (the `hooks` of the agent's `--settings`) and `codex-config.toml`.

- **Agent.** A claude session in a fresh worktree, launched with `permissionMode: "ask"`. A launch
  needs a connected Claude, so the run connects the skill's published fake setup token first
  (`mend connect claude --from-stdin` with `FAKES.claude` from `scripts/fakes.mjs`, the run's own
  home). The provider refuses it, so the real claude sits at its sign-in screen: still a live
  `agent-pty`, and the session reads `running`.
- **Settings.** The live claude's command line, read from `/proc` inside the workspace (the process
  row's `argv` is the composed launch without Mend's own flags), carries `--settings` whose `hooks`
  run `mend hook claude` for `PermissionRequest`, `Notification`, `Stop`, `UserPromptSubmit` and
  `PostToolUse`, and the `Notification` matcher admits `permission_prompt`, `elicitation_dialog` and
  `idle_prompt` (resolved with claude's documented matcher rules).
- **Shell.** `POST /api/sessions/<id>/shell`, attached at `/api/tty?process=<id>` with an upgrade
  ticket. The recipe types `scripts/fixtures/claude-standin.mjs` and the agent's settings into it
  (base64 heredocs), then reads the shell's env: `MEND_SESSION_ID` is the session's, `mend` is on
  `PATH`, and a session token file (person layout) or token (shared layout) is set.
- **Hooks replayed.** The stand-in fires `PermissionRequest` (tool `Bash`),
  `Notification:permission_prompt`, `PostToolUse`, `Stop`, `UserPromptSubmit`, `PermissionRequest`,
  each through the real `mend hook claude`. After each: every hook exited 0 and printed nothing; the
  session reads, in order, `waiting · permission · Bash`, the same wait with the same `since`,
  `running` with `waiting` null, `waiting · prompt`, `running`, `waiting · permission · Bash`; and
  for each change `/api/events` sent a `session-process` and a `session` frame for the session.
- **Stop.** `POST /api/sessions/<id>/stop` ends the agent; the shell keeps the workspace up. The
  session reads `idle`, and no process row carries a wait.
- **Late report.** A `PermissionRequest` replayed from the shell after the stop: the hook exits 0,
  and for 6 s every read stays `idle` with no wait.
- **Settle.** A second stop closes the shell; the session settles (`stopped`, `completed` or
  `failed`) with no wait.
- **Codex.** `mend run --project <project> -- cat /etc/codex/config.toml`: its `[hooks]` table runs
  `mend hook codex` for `PermissionRequest`, `Stop`, `UserPromptSubmit` and `PostToolUse`.

A real claude raising a real permission prompt needs a provider login the world does not have:
`verified-unreachable · provider login`. The same holds for codex.

## What this does not prove

- That claude or codex fire these hooks, when, or with these fields. The stand-in replays the
  payloads documented at https://code.claude.com/docs/en/hooks; it proves Mend's side: the settings'
  shape, the helper, the channel, the status, the frames.
- That codex runs the hooks in `/etc/codex/config.toml` (the System layer it trusts without
  `--dangerously-bypass-hook-trust`); the recipe reads the file only.
- The person-typed clear: the recipe never types into the agent's terminal while a wait is set.
- That a report from another session's workspace is refused: one world, one person's sessions. The
  channel grant tests in `packages/sessions` cover it.

## Gotchas

- Typing in a session's terminal may clear the agent's wait. The recipe types everything before the
  stand-in's first pause, and types the late report only after the agent ended.
- `Stop` with a live agent ends the agent only; a shell keeps the workspace and the session reads
  `idle`. A second stop, with no agent left, closes the shells.
- The stand-in prints `MEND-G4:{…}` lines; the recipe reads its own progress from the shell's
  output, so a shell that draws nothing fails the step that waits for it.
