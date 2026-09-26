---
title: Terminal dashboard
description:
  The full-screen dashboard that bare `mend` opens, its keys, and the commands that attach this
  terminal to a session.
sidebar:
  order: 2
---

Run `mend` with no command, or `mend ui`, in a terminal to open the dashboard: every project,
worktree and session on the server, updating live. The dashboard only reads until you press a key
that acts. Moving the selection never attaches, resumes or starts anything.

```sh
mend
mend ui --no-tunnel
```

The dashboard needs Node 26 or newer, because its renderer loads through `node:ffi`. The CLI re-runs
itself with the flag Node needs, so you never pass it yourself. On an older Node the dashboard
refuses to open and says which version it found; every other `mend` command works on Node 22. When
standard output is not a terminal, bare `mend` prints the command index instead.

## Layout

The session pane takes three quarters of the screen. It shows a read-only detail of the selected
session with the conversation record it has written so far. The remaining quarter is a sidebar of
three stacked sections, **Projects**, **Worktrees** and **Sessions**. The section you are in stands
open, and the other two fold to one line that says what is selected there.

The layout never squeezes a pane. A terminal too narrow for both sides gives the whole width to the
side you are on. A terminal too short for three sections shows the open section alone. A one-line
breadcrumb states whatever did not fit.

The footer lists the keys for the section you are in, most important first, and drops hints from the
end when the terminal is narrow. `mend help ui` prints the full description.

When you run `mend` inside a checkout whose origin matches no project, the dashboard offers to adopt
it. Enter or `y` adopts it, the left and right arrows (or Tab) pick its Git access (`ambient`,
`mend-key` or `bridge`), and Esc or `q` declines. See [Git access](/guides/git-access/) for what
each mode means.

## Keys

| Key                                  | What it does                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `↑` `↓` or `k` `j`                   | Move inside the open section, or scroll the session pane                                    |
| `PageUp` `PageDown`                  | Move ten rows                                                                               |
| `Enter`, `→`, `l` or `Tab`           | Move one column right: projects, worktrees, sessions, then the session pane                 |
| `←`, `h`, `-`, `Backspace` or `⇧Tab` | Move one column left                                                                        |
| `a`                                  | Attach this terminal to the selected live session                                           |
| `r`                                  | Resume the selected settled session, on a harness you pick                                  |
| `n`                                  | Start another session in the selected worktree; in Projects, or with no worktree, a new one |
| `w`                                  | Start a new worktree                                                                        |
| `e`                                  | Rename the selected session; an empty name clears the label                                 |
| `v`                                  | Review the session's change in the terminal                                                 |
| `o`                                  | Open the session in the browser                                                             |
| `⇧K` or `x`                          | Stop the selected session, or every live session of the selected worktree (press twice)     |
| `⇧D`                                 | Remove the selected session, or the selected worktree in Worktrees (press twice)            |
| `⇧R`                                 | Refresh                                                                                     |
| `q`                                  | Quit                                                                                        |

In the Projects section, the verbs that act on a session (`a`, `r`, `e`, `v`, `o`, `⇧K`, `⇧D`) do
nothing and the dashboard asks you to select a session first. Ctrl chords belong to the terminal and
never trigger a verb.

`⇧K` and `⇧D` arm on the first press and act on a second press within five seconds. The status line
says what the second press will do, for example
`press ⇧D again to remove session · … — its record goes, the worktree stays`. The dashboard refuses
to remove a session whose agent is still working, or a worktree with live sessions; stop them first.

A stopped agent can leave its Services running, and a running Service keeps the workspace up. On
such a row `⇧K` stops those Services instead, and the status line names what holds the workspace.

### Starting sessions

`n` and `r` open a harness picker: `codex`, `claude`, `opencode`, or `shell` (a plain bash session
in its own recorded worktree). When you resume, the first entry is the session's own harness, which
resumes natively with the conversation intact. Picking another harness carries the conversation over
as a distilled prompt. Enter picks, Esc or `q` closes the picker.

`w`, and `n` where there is no worktree to join, open the worktree form. It asks for a name, then a
base branch from a filtered list, then a harness. Tab moves forward through the steps, `⇧Tab` moves
back, and Esc steps back or cancels from the name. When you started `mend` inside a checkout of the
same project, the base starts on that checkout's branch.

After starting or resuming, press `a` once the row reads running to attach.

### Reviewing in the terminal

`v` opens the change review in the terminal. Inside it:

| Key                       | What it does                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `Tab`                     | Move focus between files, the diff and comments                                         |
| `j` `k`, `n` `p`, `]` `[` | Move by line, by file, by hunk                                                          |
| `c`, `⇧C`                 | Comment on the line or range, or on the whole change                                    |
| `v`                       | Start or clear a line range                                                             |
| `d` `w` `z`               | Toggle split diff (wide terminals), wrap, and whitespace                                |
| `s`                       | Assemble the open comments into a follow-up for the same session                        |
| `y`                       | Deliver the pending follow-up and relaunch the session                                  |
| `m`                       | Mend reads the change                                                                   |
| `g`                       | Draft concrete suggestions                                                              |
| `a` `x` `u`               | In the comments list: accept a draft or mark an open comment addressed, dismiss, reopen |
| `t`, `,` `.`              | Compose the tour, and step through it                                                   |
| `r`                       | Refresh the live change                                                                 |
| `o`                       | Continue the review in the web app                                                      |
| `Esc` or `h`, `q`         | Back to the dashboard, quit                                                             |

[Review a change](/guides/review-a-change/) describes what these produce.

## Attach from the command line

These commands take a session id prefix. With no id and one live session, that session is taken;
with several, a picker opens.

| Command                                 | What it does                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `mend attach [session] [--no-tunnel]`   | Reattach this terminal to a running session                               |
| `mend rejoin [session] [--harness <h>]` | Attach when the session is live, otherwise resume it                      |
| `mend resume [session] [--with <h>]`    | Start a new agent process from the saved harness state                    |
| `mend continue [session]`               | Resume the session with its pending review follow-up as the first message |
| `mend shell [session]`                  | Open a second terminal into the same workspace, beside the agent          |
| `mend stop [session]`                   | End the agent; the worktree, record and review remain                     |
| `mend stop --all [--project <p>]`       | Stop every live session, optionally in one project                        |
| `mend stop --services [session]`        | Stop the session's Services instead of its agent                          |

`mend rejoin` with no id takes the newest live session, and failing that the newest settled one.
`mend continue` with no id takes the newest session with a pending follow-up. `mend resume --with`
switches the harness between `claude` and `codex`, and the conversation carries over.

`mend stop` leaves Services running, and a running Service keeps the workspace up. The stop then
prints, for example, `agent stopped · 3 services keep the workspace up`. `mend stop --services`
stops them, and the workspace closes once nothing is live.

### Detach

Press `Ctrl+]` to detach. The session keeps running, and you can reattach from any terminal, the web
app or the phone. The CLI recognizes the key both as the plain control byte and in the kitty
keyboard encoding that Claude Code can switch a terminal into.

Set `MEND_DETACH_KEY=none` when tmux, Zellij or another outer tool owns detaching. It turns the
detach key off; `none` is the only value it reads.

### Take a session back from the phone

A session picked up on the phone runs its agent as a conversation, with no terminal behind it.
`mend attach`, or `a` in the dashboard, takes it back: the phone's agent ends and the same
conversation continues in this terminal.

When a live session has no terminal to attach to, for example because only a shell holds its
workspace open, `a` in the dashboard attaches to that shell, or opens one in the workspace when none
is live.

### Paste an image

In an attached session, `Ctrl+V` with an image on this machine's clipboard sends the image to the
session and pastes its path in the workspace. Codex and Claude read the path. Reading the clipboard
needs `wl-paste` on Wayland or `xclip` on X11; macOS needs nothing extra. With no image on the
clipboard, or no tool to read it, the keystroke goes through unchanged.

### Services while attached

When the server is not this machine, `mend attach`, `mend rejoin`, `mend codex` and the dashboard
tunnel the session's live Services declared `--http` or `--https` to this machine's loopback while
you are attached. Each tunnel uses the Service's own port when it is free here, and prints one line,
for example `web → http://localhost:5173`. In the dashboard the tunnels follow the selected session
and appear in the session pane. A Service that stops closes its tunnel, and detaching closes them
all. `--no-tunnel` turns this off. See [Development services](/guides/services/).
