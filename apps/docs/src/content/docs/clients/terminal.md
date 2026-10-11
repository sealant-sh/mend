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
that acts. Moving the selection never attaches, resumes or starts anything. A session you start or
resume there attaches once it runs, if you are still waiting on it.

```sh
mend
mend ui --no-tunnel
```

The dashboard needs Node 26 or newer, because its renderer loads through `node:ffi`. The CLI re-runs
itself with the flag Node needs, so you never pass it yourself. On an older Node the dashboard
refuses to open and says which version it found; every other `mend` command works on Node 22.13.
When standard output is not a terminal, bare `mend` prints the command index instead.

## Layout

The session pane takes three quarters of the screen. It shows a read-only detail of the selected
session with the conversation record it has written so far. The remaining quarter is a sidebar of
three stacked sections, **Projects**, **Worktrees** and **Sessions**. The section you are in stands
open, and the other two fold to one line that says what is selected there.

Every pane carries its number in its title, the way lazygit numbers its panels: `[1] projects`,
`[2] worktrees`, `[3] sessions`, and `[0]` for the session pane. Press the number to jump there. The
pane the keyboard is in has a yellow border and title.

`+` and `_` cycle the screen mode. Normal gives the sidebar a quarter of the width. Half gives it
half, for long names. Full gives the whole screen to the side you are on, and the breadcrumb states
the rest.

The layout never squeezes a pane. A terminal too narrow for both sides gives the whole width to the
side you are on. A terminal too short for three sections shows the open section alone. A one-line
breadcrumb states whatever did not fit.

The footer lists the keys for the section you are in, most important first, and drops hints from the
end when the terminal is narrow. It always ends with `? keys`: `?` opens every key the dashboard
answers to, read from the same table the dashboard runs on, with the keys this pane's footer names
drawn brighter. `mend help ui` prints the full description.

When you run `mend` inside a checkout whose origin matches no project, the dashboard offers to adopt
it. Enter or `y` adopts it, the left and right arrows (or Tab) pick its Git access (`mend-key` or
`bridge`; it starts on your own mode), and Esc or `q` declines. If the server refuses the clone, the
offer stays open with the server's reason in it, so you can pick another mode and press Enter again.
See [Git access](/guides/git-access/) for what each mode means.

## Keys

| Key                          | What it does                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `↑` `↓` or `k` `j`           | Move inside the open section, or scroll the session pane                                    |
| `PageUp` `PageDown`          | Move ten rows                                                                               |
| `1` `2` `3` `0`              | Jump to projects, worktrees, sessions, or the session pane                                  |
| `Tab`, `⇧Tab`                | Next or previous pane, coming back round at either end                                      |
| `Enter`, `→` or `l`          | Move one column right: projects, worktrees, sessions, then the session pane                 |
| `←`, `h`, `-` or `Backspace` | Move one column left                                                                        |
| `Esc`                        | Clear this list's filter, else go back to the pane you came from                            |
| `/`                          | Filter the focused list; Enter keeps the filter, Esc clears it                              |
| `?`                          | List every key                                                                              |
| `+` `_`                      | Cycle the screen mode: normal, half, full                                                   |
| `a`                          | Attach this terminal to the selected live session                                           |
| `r`                          | Resume the selected settled session, on a harness you pick                                  |
| `n`                          | Start another session in the selected worktree; in Projects, or with no worktree, a new one |
| `w`                          | Start a new worktree                                                                        |
| `e`                          | Rename the selected session; an empty name clears the label                                 |
| `v`                          | Review the session's change in the terminal                                                 |
| `o`                          | Open the session in the browser                                                             |
| `⇧K` or `x`                  | Stop the selected session, or every live session of the selected worktree (press twice)     |
| `⇧D`                         | Remove the selected session, or the selected worktree in Worktrees (press twice)            |
| `⇧R`                         | Refresh                                                                                     |
| `q`                          | Quit                                                                                        |

A starting session's pane shows a game of snake. Starting or resuming a session from the dashboard
hands the game the keyboard once the pane shows it, and so does a digit, Tab, Enter, `l` or `→` into
that pane, when the terminal can show the board whole; a terminal too small for it says
`make the terminal taller to play snake` (or `wider`), and the game does not take the keyboard. With
the keyboard the board's border takes the accent colour, and the game counts down 3, 2, 1, go before
the snake moves. The arrows or `h` `j` `k` `l` steer, and Space or `p` pauses, with the countdown
again before it resumes. While the game has the keyboard, there or under `mend snake`, every
dashboard key is the game's, the digits, Tab, `?` and `/` included. Esc or `q` hands it back to the
pane you came from. A dialog that opens over the game, such as the adopt offer at the start of
`mend snake`, keeps the keyboard until it closes, and then the countdown starts.

In the Projects section, the verbs that act on a session (`a`, `r`, `e`, `v`, `o`, `⇧K`, `⇧D`) do
nothing and the dashboard asks you to select a session first. Ctrl chords belong to the terminal and
never trigger a verb.

`⇧K` and `⇧D` arm on the first press and act on a second press within five seconds. The status line
says what the second press will do, for example
`press ⇧D again to remove session · … · its record goes, the worktree stays`. The dashboard refuses
to remove a session whose agent is still working, or a worktree with live sessions; stop them first.

A stopped agent can leave its Services running, and a running Service keeps the workspace up. On
such a row `⇧K` stops those Services instead, and the status line names what holds the workspace.

### Starting sessions

`n` and `r` open a harness picker: `codex`, `claude`, `opencode`, `pi`, or `shell` (a plain bash
session). For a new session, each row says whether it starts a new worktree or joins the selected
one (`joins <worktree>`). When you resume, the first entry is the session's own harness, which
resumes natively with the conversation intact. Picking another harness carries the conversation over
as a distilled prompt. A `mend run` session has no agent to resume, so its own harness is not
offered; a shell or another harness is. Enter picks, Esc or `q` closes the picker.

`w`, and `n` where there is no worktree to join, open the worktree form. It asks for a name, then a
base branch from a filtered list, then a harness. Tab moves forward through the steps, `⇧Tab` moves
back, and Esc steps back or cancels from the name. When you started `mend` inside a checkout of the
same project, the base starts on that checkout's branch.

A session you start or resume from the dashboard attaches by itself once its row reads running, if
you are still waiting on it. The status line reads `ready · <name> · attaching` for a moment, with
the snake's score when you played meanwhile, and then the terminal is the session's. You are still
waiting while you stay on that session: playing snake in its pane or leaving the game with Esc
counts. Moving to another session, column or project, or starting something newer, means you are
not, and so does a dialog such as `?`, `/` or the rename that is open at the moment it runs. Then
the status line says `started · <name> · a attaches` (or `resumed · …`) when it runs, and `a`
attaches it. Only the newest start attaches by itself, so with several in flight, the older ones
wait for `a`.

A start that fails shows its error and attaches nothing. A session that ends before it runs says so,
for example `failed · <name> · it did not reach running`. A shell session attaches the same way as
an agent session. After you detach with `Ctrl+]` the dashboard comes back with the session selected,
and it never attaches that start again by itself.

Set `MEND_AUTO_ATTACH=off` to leave every attach to `a`; `off` is the only value it reads.

### What the panes say

A session row leads with what the session is doing. A starting session names its launch phase:
`launching`, `queued`, `building the image`, `preparing the workspace`, `booting`, or
`waiting for the previous save` when the worktree's previous session is still saving. A live session
reads `up 4m` from its agent's own start (`shell up 4m` for a shell session), `agent ended 5m ago`
when only shells or Services keep it live, and a settled one `ended 5m ago`. A stopping session
reads what its save has left, for example `saving · no uploads pending`, or
`workspace end not confirmed` while Mend has not yet observed the workspace end. A session whose
agent stopped while its Services run reads, for example,
`agent stopped · 3 services keep the workspace up`. A worktree reads its most pressing session's
word, so `starting` or `stopping` while one of its sessions does and none is waiting or running.

The session pane lists the session's name and harness, its status with the words above, its branch
against its base, then its running Services: each one's name, its workspace port, the host port and
its state, or where its tunnel opens on this machine, and `no services running` when there are none.
Then how many review comments are open, the session's summary, and the conversation record.

### Reviewing in the terminal

`v` opens the change review in the terminal. Inside it:

| Key                       | What it does                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab`                     | Move focus between files, the diff and comments                                                                                         |
| `j` `k`, `n` `p`, `]` `[` | Move by line, by file, by hunk                                                                                                          |
| `c`, `⇧C`                 | Comment on the line or range, or on the whole change                                                                                    |
| `v`                       | Start or clear a line range                                                                                                             |
| `d` `w` `z`               | Toggle split diff (wide terminals), wrap, and whitespace                                                                                |
| `s`                       | Assemble the open comments into a follow-up for the same session; a `mend run` or shell session has no agent to send it to, and says so |
| `y`                       | Deliver the pending follow-up and relaunch the session                                                                                  |
| `m`                       | Mend reads the change                                                                                                                   |
| `g`                       | Draft concrete suggestions                                                                                                              |
| `a` `x` `u`               | In the comments list: accept a draft or mark an open comment addressed, dismiss, reopen                                                 |
| `t`, `,` `.`              | Compose the tour, and step through it                                                                                                   |
| `r`                       | Refresh the live change                                                                                                                 |
| `o`                       | Continue the review in the web app                                                                                                      |
| `Esc` or `h`, `q`         | Back to the dashboard, quit                                                                                                             |

[Review a change](/guides/review-a-change/) describes what these produce.

## Attach from the command line

These commands take a session id prefix. With no id and one live session, that session is taken;
with several, a picker opens.

| Command                                               | What it does                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `mend attach [session] [--no-tunnel]`                 | Reattach this terminal to a running session                               |
| `mend rejoin [session] [--harness <h>] [--no-tunnel]` | Attach when the session is live, otherwise resume it                      |
| `mend resume [session] [--with <h>]`                  | Start a new agent process from the saved harness state                    |
| `mend continue [session]`                             | Resume the session with its pending review follow-up as the first message |
| `mend shell [session]`                                | Open a second terminal into the same workspace, beside the agent          |
| `mend stop [session]`                                 | End the agent; the worktree, record and review remain                     |
| `mend stop --all [--project <p>]`                     | Stop every live session, optionally in one project                        |
| `mend stop --services [session]`                      | Stop the session's Services instead of its agent                          |

A `claude`, `codex` or `pi` you start by hand in `mend shell` is observed, not run, by Mend: it
appears as an observed process within about half a minute, ends after five quiet minutes, and cannot
be steered or stopped from Mend. See
[Agents you run yourself](/clients/vscode/#agents-you-run-yourself).

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

### Someone else's session

Only a session's owner types in its terminal. When you attach to a session someone else owns and
shares control of, the CLI prints
`This session runs in a terminal. Only <owner> types here; they can continue it as a conversation.`,
then streams the terminal without sending your keys or your terminal's size. `Ctrl+]` or `Ctrl+C`
detaches. `mend shell` in their session is refused: a shell is the owner's alone, and so is
`mend service run`. See [Organizations](/organizations/overview/#terminals-stay-with-the-owner).

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
