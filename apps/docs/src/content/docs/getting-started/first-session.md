---
title: Start a session
description: Launch an agent in a project worktree, detach, reattach, and resume later.
sidebar:
  order: 5
---

A session is one supervised coding-agent conversation and its durable record, running inside a
worktree: a durable named checkout in the project store. A worktree holds many sessions over its
life, several live at once, and owns the one reviewable change they all contribute to. A session can
contain several agent processes over time plus supporting shells and Services.

## Before you start

You need:

- a working Mend login;
- an adopted project;
- the provider CLI installed in the selected workspace image;
- for `mend claude` or `mend codex`, that provider connected
  ([Connect provider accounts](/guides/provider-accounts/)): in a
  [per-person workspace](/operate/per-person-workspaces/), the default, a launch without it is
  refused before it starts. pi and opencode run on your connected Codex (ChatGPT) login, or on a
  login made inside the session.

Check the local setup:

```sh
mend doctor
```

## Launch from a checkout

Move into a checkout whose remote matches the adopted project:

```sh
cd ~/Developer/my-project
mend codex
```

Use another harness or command:

```sh
mend claude
mend opencode
mend pi
mend run -- pnpm test
```

`mend run` runs any command as a session, prints its output and exits with its exit code. A shell
with no script and no `-c` is refused there, since an attached `mend run` sends no keys; open one
with `mend shell` instead.

If no adopted project matches but the current directory is a Git checkout with a network `origin`, a
harness launch adopts that origin URL first; the server clones it and never receives your local
files. Run `mend adopt` yourself when you want to choose the project name or Git authentication
mode.

Select a project explicitly from another directory:

```sh
mend codex --project my-project
```

## Send the first prompt

Pass one quoted argument:

```sh
mend codex "Trace the session startup path and explain it before changing code"
```

The prompt becomes the first message and supplies the initial session name. Interactive launches ask
for the worktree's name first (enter accepts an automatic one); `--name` answers it up front.

Common options:

```sh
mend codex "Fix the failing test" --model gpt-6-astra --effort high --base main
mend claude "Inspect the API boundary" --ask
```

The server owns the model list. `mend models` prints it per harness, with the model a launch runs
when `--model` is not given marked `default`, and the efforts each model takes. The phone, the web
app and VS Code offer the same list and preselect the same default, so a session started from any of
them runs on the model you see. Every session records the model and effort it was started with;
`mend sessions`, the session page and the phone's session header show them.

```sh
mend models
```

`--effort` takes `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` where the model takes it; a
level the model does not take becomes the highest it does. Without `--effort` the harness uses its
own default.

Mend normally disables the harness's approval prompts because the workspace is the execution
boundary. `--ask` restores provider prompts. A conversation session started with approvals on keeps
them when it is resumed or followed up. `--fast` requests Codex priority processing. opencode takes
`--model` and `--ask`, and ignores effort and speed. pi takes `--model`, and `--effort` as its
thinking level; it has no approval prompts, so `--ask` changes nothing there.

Press `Ctrl+V` with an image on your clipboard to send the image to the session and paste its path;
Codex and Claude read it. This needs `wl-paste` on Wayland or `xclip` on X11, and nothing extra on
macOS.

## Join an existing worktree

Naming a worktree that already exists joins it. The launch becomes a second conversation in the same
checkout, alongside anything already running there:

```sh
mend claude "Review the auth changes so far" --name fix-auth
```

`--worktree` joins only, and fails with the candidate names when nothing matches. Use it in scripts
where creating a new worktree by typo would be worse than failing:

```sh
mend codex "Run the test suite and fix what breaks" --worktree fix-auth
```

Requesting a different `--base` for an existing worktree is refused rather than silently re-basing
it. In the dashboard, `n` starts another session inside the selected worktree and `w` starts a new
worktree. Read [Terminal dashboard and attach](/clients/terminal/).

List worktrees and the sessions inside them:

```sh
mend worktrees
```

## What Mend creates

```mermaid
flowchart LR
  project[Adopted project]
  worktree[Worktree]
  workspace[Sealant workspace]
  agent[Agent process]
  record[Durable record]

  project --> worktree
  worktree -->|latest capture laid down at /workspace/repo| workspace
  workspace --> agent
  agent --> record
  workspace -->|captures| worktree
```

Before the process starts, Mend resolves the workspace image, project environment, secrets,
references, folders, skills, connected accounts, Git author, and dotfiles. It then opens a PTY or
provider protocol process in the worktree at `/workspace/repo`.

## Detach without stopping

Press:

```text
Ctrl+]
```

The CLI closes its attachment and leaves the agent running. The web app or VS Code can attach to the
same session while the terminal is detached.

Sessions run in the background by default: closing the terminal window or losing the connection also
leaves the session running. Launch with `--detach` to skip attaching entirely, and stop explicitly
with:

```sh
mend stop 01MEND
```

The record and review remain. Services keep running after a stop, and a running Service keeps the
workspace up; the stop then says so, for example `agent stopped · 3 services keep the workspace up`.
Stop the Services too with:

```sh
mend stop --services 01MEND
```

Once nothing is live, the workspace closes.

`--foreground` gives one launch foreground semantics: the session stops when the launching `mend`
exits. The default is the "Run sessions in the background" switch. The operator sets the instance's
default in Settings, an organization owner sets the organization's default over it, and a project's
setup page can override both.

## Reattach

List active sessions:

```sh
mend sessions
```

Attach with a full ID or unique prefix:

```sh
mend attach 01MEND
```

Mend replays recorded terminal output before following live frames. A session that was picked up on
the phone is taken back into this terminal: the phone's agent ends and the same conversation
continues here.

On a remote server, attaching tunnels the session's live Services declared `--http` or `--https` to
this machine's loopback, one line per tunnel, for example `web → http://localhost:5173`.
`--no-tunnel` turns this off. Read [Development services](/guides/services/).

## Open a supporting shell

```sh
mend shell 01MEND
```

The shell runs in the session's current workspace and sees the same worktree, installed packages,
environment, and Services. Shell changes contribute to the same session change.

Closing a shell tab can stop that shell process. A detached shell can keep the workspace retained
after the agent settles.

## Resume settled work

Resume with the previous harness:

```sh
mend resume 01MEND
```

Switch harnesses while keeping the worktree and restored provider state:

```sh
mend resume 01MEND --with claude
```

`mend rejoin` chooses attach when the session is live and resume when it is settled:

```sh
mend rejoin 01MEND
```

`mend continue` resumes a session with the review comments you sent to it as its first message:

```sh
mend continue 01MEND
```

A resumed agent is another process in the same Mend session. Its Sealant run has its own record
sequence, while Mend preserves the ordered process and run membership.

A conversation session (started from Slack, or from the web or phone composer) waits between turns
with its workspace up. After 15 idle minutes (no turn running, no workflow or background task the
agent reported still running, nothing waiting on you, no Service or open shell) Mend stops it the
way Stop does, and it reads `idle · stopped after 15 min · reply to resume`. Send the next message,
or resume it, to go on in the same conversation. The operator sets the minutes with
`MEND_PROTOCOL_IDLE_STOP_MINUTES` (`0` turns the stop off).

## What happens to your files

The workspace works on its own disk, and `sealantd` captures the worktree's files, uncommitted ones
included, to the Mend store every few seconds while they change. When the agent settles, the
workspace stops, or you resume days later, the next workspace starts from the latest capture.
Nothing is committed, stashed, or cleaned automatically, and the reviewable change is the worktree
against its base, committed or not.

What does not survive a workspace replacement is what the capture leaves out: system packages
installed by hand, `/tmp`, and writes inside organization folders, which arrive as copies. Deleting
a session removes only the conversation record; the worktree, its change, and its checkpoints
remain. Removing the worktree is its own explicit act, and it deletes uncommitted changes with it.
It is refused while any session is live, and refused again while the change is not on origin, naming
the files and line counts that are not landed, or while a session in it holds a
[repository added with `mend repo add`](/guides/repositories-in-a-session/). Land the change, or
remove it anyway: **Remove anyway** in the web app, `mend worktrees rm <name> --force` in the
terminal.

Read [How Mend works](/concepts/how-mend-works/#where-uncommitted-files-live) for the full boundary.

## Review and land

The dashboard's `v`, the web app and the phone show the worktree's change against its base with the
record beside it; VS Code's **Mend: Review change** opens it in the web app. Comments you send go
back to the same session. Read [Review a change](/guides/review-a-change/).

Landing pushes the change to origin and opens its pull request. Run `mend land <session>`, or launch
with `--land` so Mend lands after each turn that asked for a change; `--no-land` keeps one session
from landing when the project's "Land when a turn completes" setting is on. Mend lands after turns
it runs itself, so a session attached to your terminal lands on its own only once it is picked up on
the phone. Read [Land a change](/guides/land-a-change/).

## See sessions from any client

The CLI, the web app, VS Code and the phone connect to the same Mend server. They do not create
separate copies of the session.

Read [Work from another device](/guides/remote-access/) for pairing and reattachment.
