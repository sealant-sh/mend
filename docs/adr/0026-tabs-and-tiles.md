# Session screens: tabs and tiles, and sessions that share a workspace

Status: accepted 2026-11-16, for the new web app; not built. Yiannis chose the layout drawn on the
Doop canvas "Mend" on the page "Session layouts · Tabs and tiles" (`3t37sX4OFo`, overview frame
`iYVU5LkII9`), and the rulings on shared workspaces the same day. The page "Sessions sharing a
workspace" (`HAGpakZ4C3`) draws those. The new app's session routes build it, in the order of the
rebuild's list of PRs (Linear document "Mend web rebuild: the list of PRs"). Read against Mend
`732269db61`. Changes [ADR 0003](0003-organizations-and-tenancy.md) (who shared control reaches).

## Context

Today a session screen is the session: a header with its status and actions, a row of tabs
(conversation, Change, Preview, Screen, Terminal, Record) and a right-hand details panel. A worktree
can already hold several sessions, and every session in it contributes to one change, but the screen
shows one session at a time. Looking at a second session in the same worktree, or at the change
beside the conversation, means leaving the page. The details panel takes width from the conversation
on every screen whether or not anyone reads it.

Stopping a session leaves its Services and workspace running until someone presses "Stop services".
Shared control, once on, lets everyone who can see the project steer.

## Decision

### 1. The sheet is the workspace

On every session screen the sheet shows one workspace. Its header names it: project / worktree, the
branch in mono, the layout button, "Open in VS Code" and the workspace's "…" menu. The header has no
status word.

### 2. Everything in the sheet is a tab in a tile

- A tab is either a session's conversation (its lump glyph and title) or a workspace view (an icon
  and its name): Change with its +/− counts, Preview with its port, Screen, Terminal, Record, Checks
  and Details.
- Opening a view adds a tab to the focused tile, from that tile's "+" menu. Dragging a tab onto a
  tile's edge splits the tile; dropping it in the middle adds it to that tile.
- One tile has focus, and its active tab has the cobalt underline.
- When a tile's last tab closes, the tile closes and its neighbour takes the space.
- Each tile has a maximise button. A maximised tile names another session in the workspace that is
  waiting on you, if there is one, and offers Restore layout.
- A new session in the same workspace opens as a tab beside the active session tab in the focused
  tile.
- Each session keeps its own question or composer card inside its conversation tile. A narrow tile
  drops the context count first, then the harness name.

### 3. Layouts

The layout button lists four layouts with shortcuts: Conversation only (⌥1), Conversation beside
change (⌥2), Change over terminal (⌥3) and Two sessions over a terminal (⌥4). Then come "Your
layouts", "Save this layout…" and "Reset to one tile". A saved layout belongs to the person and
shows in every workspace.

### 4. A session's actions are on its tab; workspace actions are on the workspace

- A session's status word, its age and its own actions (Stop session…, Snooze, Rename…, Copy link,
  Mark done) are on its conversation tab: the tab's right-click menu and the "…" of the tile that
  shows it.
- The workspace "…" holds workspace actions only: New session in this workspace, Land…, Copy branch
  name and Copy worktree path. Land… and Copy branch name never appear in a session row's menu.

### 5. Details is a view, not a panel

The session's branch, base, pull request, checks, services, owner and shared control, and the other
sessions in the workspace, are the Details view, opened as a tab like any other. There is no
right-hand panel and no details toggle.

### 6. Narrow windows and the phone

Below 1024px wide the tiles become one strip of tabs under the workspace header, as on the phone,
and the layout button hides. On the phone the strip sits under the phone header with the open
session first; labels stay whole and the strip scrolls sideways.

### 7. Several sessions share a workspace

- Anyone who can open the project can start a session in a running workspace, someone else's
  included, without asking. The workspace's owner sees that they joined: a line in the owner's
  conversation names who joined.
- **Stop session** stops that session's agent. If no other session in the workspace is running, it
  also stops the workspace and its services. If another session is running, the workspace keeps
  running and the usual inactivity rules stop it later. The Stop session dialog says which will
  happen. The stopped session moves to To review if it changed files, otherwise to Done.
- **Landing is not blocked by another session still editing.** The Land dialog names any session in
  the workspace that is still editing and says so. Landing goes ahead from a checkpoint, as ADR 0007
  already lands, and the session stays in To review with its pull request open.
- **Joining is not steering.** A session started in someone's workspace is the joiner's own session,
  run on their own login (ADR 0016). Steering another person's session still needs shared control,
  and shared control now goes to the person who asked for it, not to everyone who can see the
  project (amends ADR 0003, "Sessions and shared control").

### 8. Paths other clients open stay

The CLI, VS Code, Slack, the mobile app and pull request descriptions open paths in the web app.
Every one of them keeps working:

- `/sessions/<id>` opens the session's conversation tab. `/sessions/<id>#checkpoint-N` keeps its
  checkpoint link.
- `/sessions/<id>/terminal`, `/preview`, `/screen`, `/record` and `/change` open that view. The new
  `/sessions/<id>/checks` and `/sessions/<id>/details` do the same.
- `/changes/<id>` (and `#land`) opens the Change view of the change's workspace, with the Land
  dialog for `#land`.
- `/tty-embed` stays exactly as it is for the mobile app's terminal.

Opening a view's path focuses that view's tab in the sheet, adding the tab if it isn't open. The
full list of paths other clients depend on is in the rebuild's list of PRs.

### 9. The words

The inbox groups are Waiting on you, To review, Running, Snoozed and Done. After Stop turn a
session's status word is Idle. These words are on the canvas and in this ADR; the public glossary
changes when the new app ships them.

## Considered options

- **The session header's row of tabs with a right-hand details panel** (today's screen, and the
  first Sheet frames). Rejected: one session per screen, the change only by leaving the
  conversation, and a panel that takes width on every screen for details most people read rarely.
- **One workspace per session.** Rejected: a second session on the same change (tests beside the
  fix, a reviewer's question) needs the same files, and the change is the worktree's, not one
  session's. Two workspaces for one change would split the evidence and the landing.

## Consequences

- A person sees two sessions, or a conversation and its change, side by side without leaving the
  workspace.
- The server needs, among others: Stop session that ends the workspace when no other session runs
  there and files the session in To review or Done; a record of a join that the owner's conversation
  shows; layouts saved per person; and shared control for one person. The rebuild's list of PRs
  names each one.
- Until those land, the old web app (`apps/web-old`) keeps today's stop, shared control and details
  panel, and the server behaves as it does today.
