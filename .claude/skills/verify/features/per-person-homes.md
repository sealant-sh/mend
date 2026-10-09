# Per-person workspaces

In a remote workspace, every session of a worktree runs in one live executor. With per-person
workspaces (the default since 0.36), each person who runs anything there gets their own Linux user
and home, and what they run runs as them: their logins, Git and Mend identity, dotfiles, secret
files and memory. Mend says so wherever two people meet: before someone starts a session in a
worktree where another person's session runs, and on a session while another person's process is
live in its workspace. Everyone there has passwordless `sudo`, so this is not isolation, and the
lines say that too. An operator opts out with `MEND_HARNESS_LAYOUT=shared`, which keeps new worktrees
on one shared home; a worktree that has run per person stays per person.

## Sub-features

- `join-line` says, before a session starts in a worktree where someone else's session runs, that
  the workspace is shared and that either person can read the other's files.
- `shared-workspace-line` says on a session `Shared workspace with <name> · …` while another
  person's process is live in its workspace.
- `runs-as-yourself` runs a person's shell and agent as their own Linux user (`m` and 8
  characters, uid 40001-49999, home `/home/<name>`).
- `layout-opt-out` keeps new worktrees on one shared home with `MEND_HARNESS_LAYOUT=shared`; the
  join line then says what is started runs on the launcher's logins.
- `no-way-back` keeps a worktree that has run per person per person whatever the setting says, and
  refuses a launch that cannot run per person there.
- `layout-fallback` runs a new worktree with one shared home when the image or runtime cannot run
  per person, and says why on the session.
- `waiting-line` says, under shared control, whose work a new sender's turn waits for, with `End`
  for the person it runs as and the session's owner.
- `retirement` marks a workspace started before 0.36 to be replaced (mapped in
  [workspace-replace.md](./workspace-replace.md)).

## How to get to it (user POV)

- Web: the worktree's `New session in <worktree>` menu on the project's Worktrees tab, and the Now
  page composer once a worktree is picked: the join line sits above the harness choices or under
  the prompt.
- Web: the session page (`/sessions/<id>`): the shared-workspace line under the header facts; the
  waiting line at the top of the left pane while a turn waits.
- CLI: `mend codex|claude|opencode|pi --worktree <existing>` (or `--name` of an existing worktree)
  prints `✓ joins worktree …` and then the join line. `mend sessions` prints the shared-workspace and
  waiting lines under each live row. `mend shell <prefix>` opens a shell as the caller's own user.
- TUI: `n` on a worktree opens `new session in <worktree> · pick a harness` with the join line; the
  session pane lists the shared-workspace and waiting lines.
- Desktop: a strip above a session's terminal pane shows the shared-workspace line; a
  conversation shows the waiting line under its turns.
- Mobile: the session screen (`/session/<id>`) shows the shared-workspace line; a conversation
  shows the waiting line under its turns.
- VS Code: the session tree shows the join, shared-workspace and waiting lines (`not drivable yet`:
  no VS Code harness in the verify stack, and the extension is unpublished).
- Server: `MEND_HARNESS_LAYOUT` (`person` unless set, or `shared`), read at start.

## Driving it with verify

Preconditions:

- The stack runs with `MEND_HARNESS_LAYOUT` unset, on Docker without `"no-new-privileges": true`,
  with a Sealant Core that reports per-person routes (`0.39.0-next.706` or later) and a Sealant
  managed workspace image (not nix). Kubernetes and Cloudflare runtimes always run one shared home.
- Two accounts in one organization, as built in [organization.md](./organization.md): `<owner>`
  (browser `page`, default CLI) and `<member>` (browser `memberPage`, CLI with
  `XDG_CONFIG_HOME=/tmp/verify-member`). Both have `mend connect claude`.
- `<project>-shared` is a `shared` project. No worktree named `verify-pp` or `verify-shared` exists
  in it.

- **First person.** Run
  `mend claude "List the files and change nothing." --name verify-pp --project <project>-shared --detach`.
  Note `<a8>` from `  attach · mend attach <a8>`. Exit code `0`.
- **Join line on the web.** On `memberPage`, open the project's Worktrees tab and run
  `await memberPage.getByRole("button", { name: "New session in verify-pp" }).click()`. The open menu
  (`memberPage.getByRole("menu")`) holds the text
  `<owner>'s session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.`
  above the `claude` menu item. Press Escape.
- **Join line in the CLI.** Run
  `XDG_CONFIG_HOME=/tmp/verify-member mend claude "List the files and change nothing." --worktree verify-pp --project <project>-shared --detach`.
  Stdout shows `✓ joins worktree verify-pp · 1 session · branch <branch>`, then
  `· <owner>'s session is running in this worktree. You share its workspace: …` with the same
  words, then `✓ worktree verify-pp · branch <branch>`. Note `<b8>`. Exit code `0`.
- **Shared-workspace line on the web.** On `page`, go to `<web>/sessions/<a-id>` once `<member>`'s
  session runs. The text
  `Shared workspace with <member> · each of you runs as yourself · either of you can read the other's files.`
  is visible under the header facts.
- **Shared-workspace line in the CLI.** Run `mend sessions --project <project>-shared`. Under each
  live `verify-pp` row, an indented line reads `Shared workspace with <member> · …` for `<owner>`.
- **Each runs as themselves.** In tmux, run
  `tmux new-session -d -s verify-pp-b -x 200 -y 50 'XDG_CONFIG_HOME=/tmp/verify-member mend shell <b8>'`,
  wait for a prompt, then `tmux send-keys -t verify-pp-b 'id -un; id -u; echo $HOME' Enter`.
  `tmux capture-pane -p -t verify-pp-b` shows a login name of `m` and 8 characters, a uid from 40001
  to 49999, and `/home/<that name>`. The same in `mend shell <a8>` for `<owner>` shows a different
  name and uid. Leave the shells with `exit`.
- **Opt out.** Restart the server with `MEND_HARNESS_LAYOUT=shared` (through the stack Launch made).
  Run `mend claude "List the files and change nothing." --name verify-shared --project <project>-shared --detach`,
  then open `memberPage`'s `New session in verify-shared` menu. It reads
  `Another person's session is running in this worktree, in a workspace that shares one home: what you start there runs on the logins and Git identity of whoever started that workspace, not yours.`
- **Shared home, observed.** Start `<member>`'s session there with
  `XDG_CONFIG_HOME=/tmp/verify-member mend claude "List the files and change nothing." --worktree verify-shared --project <project>-shared --detach`.
  Stdout has `✓ joins worktree verify-shared …` and no join line. `mend sessions` prints no
  `Shared workspace` line for `verify-shared`. In `mend shell` on `<member>`'s session, `id -u`
  prints `0`.
- **No way back.** With the server still on `shared`, start another session in `verify-pp`:
  `mend claude "List the files and change nothing." --worktree verify-pp --project <project>-shared --detach`.
  Its `mend shell`, as above, prints a uid from 40001 to 49999: the worktree stays per person.
- **TUI join line.** Run
  `tmux new-session -d -s verify-pp-tui -x 200 -y 50 'XDG_CONFIG_HOME=/tmp/verify-member mend ui'`.
  Select `<project>-shared` in the projects section and `verify-pp` in the worktrees section (keys
  in [tui.md](./tui.md)), then `tmux send-keys -t verify-pp-tui n`. `tmux capture-pane -p -t verify-pp-tui`
  shows `new session in verify-pp · pick a harness` and the join line, wrapped, naming `<owner>`.
  Send `Escape` to close the picker without starting anything, and `q` to quit.
- **TUI session pane.** In the same dashboard, select `<member>`'s live `verify-pp` session. The
  session pane lists `Shared workspace with <owner> · each of you runs as yourself · …`, wrapped.
- **Desktop.** Attach the desktop app over CDP, signed in as `<owner>` (see
  [desktop.md](./desktop.md)), and open `<owner>`'s `verify-pp` session as a terminal pane. The
  strip above it reads
  `Shared workspace with <member> · each of you runs as yourself · either of you can read the other's files.`
  (`win.getByText(/^Shared workspace with /)`).
- **Mobile.** On the Expo web app (`<mobile-web>`, 390x844, paired as `<owner>`; see
  [mobile.md](./mobile.md)), go to `<mobile-web>/session/<a-id>`. The same line is visible
  (`mobile.getByText(/^Shared workspace with /)`).
- **Waiting line (conversation sessions only; partly specified).** This step needs, in a
  per-person worktree, a conversation (protocol) session with shared control on
  ([shared-control.md](./shared-control.md)), whose agent is running background work (a background
  task, a sub-agent, a goal) for one person when a second person sends a turn. This map has no exact
  procedure to make an agent start background work or to enqueue the second turn: the web cannot
  start a conversation, and a turn comes from the desktop or phone conversation, Slack or a review
  sent back. When that state exists, the session page shows
  `page.getByRole("status").filter({ hasText: /^Waits for / })`, for example
  `Waits for <owner>'s 2 background tasks to finish before <member>'s turn starts.` The list
  `Work the turn waits for`, with an `End` button per item, shows only to the session's owner or the
  person the work runs as, and only when at least one item can be ended
  (`apps/web/src/components/shared-workspace.tsx:62`); with no endable item the status shows alone.
  The desktop and mobile conversations show the same words under their turns. Report this step
  unreachable when the state cannot be made.
- **Proof.** Capture the open `New session in verify-pp` menu, `/sessions/<a-id>` with the
  shared-workspace line visible (`ariaSnapshot()` and a screenshot), the `mend claude --worktree`
  and `mend sessions` transcripts, both tmux captures of `id`, the TUI picker and session pane
  captures, and the desktop and mobile `ariaSnapshot()` with the shared-workspace line. Restart the server without
  `MEND_HARNESS_LAYOUT` and stop every session the run started (`mend stop <a8>`,
  `XDG_CONFIG_HOME=/tmp/verify-member mend stop <b8>`, and the rest by id).

## Gotchas

- The join line in the `New session` menu is a plain paragraph inside the menu, not a menu item
  (`apps/web/src/components/project-detail/new-worktree-session.tsx:89`). Assert it with
  `getByRole("menu").getByText(…)`. The composer's join line is a plain paragraph too
  (`apps/web/src/components/session-composer.tsx:196`). Both are unnamed paragraphs; assert their
  text.
- The shared-workspace line on the session page is an unnamed paragraph
  (`apps/web/src/routes/sessions.$sessionId.tsx:311`); on the desktop it is a `span` in a strip
  (`apps/desktop/src/renderer/src/components/workspace-facts.tsx:68`), and on mobile an unlabelled
  `Text`. Use `getByText`. The desktop strip truncates long lines visually; the full text is in the
  DOM and in its `title`.
- Each `End` button on the waiting line is named only `End`
  (`apps/web/src/components/shared-workspace.tsx:85`); with several items they are ambiguous. Scope
  by the item's text (`<kind> · <description>`). That is a finding.
- The CLI never prints the shared-home join line: it has no viewer id where nobody is listed live
  (`apps/cli/src/main.ts:946-951`). ADR 0016 decision 13 names "join a worktree" in the CLI as a
  place the product says where two people meet; in a shared-home workspace the CLI says nothing.
  That is a product gap. The web and the TUI say it.
- The join line names others only while their sessions are live. A settled session in the worktree
  produces no line.
- `MEND_HARNESS_LAYOUT` decides only worktrees with no layout yet. Use fresh worktree names for each
  layout; an old worktree tells you nothing about the setting.
- With `MEND_HARNESS_LAYOUT=shared`, the session says nothing about why it shares one home: the
  reason is added to the session's summary only when an image or runtime forced it, for example
  `this image cannot run per-person users (no sudo), so this workspace takes one person`.
- A per-person worktree on an image that cannot run per person is refused, not downgraded:
  `This worktree's sessions are saved per person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree.`
- When neither Core nor Mend knows yet what an image can do, its first launch runs with one shared
  home while its prepare checks the image; the next launch on that image can run per person. If
  `verify-pp` shows no join line and `id -u` prints `0`, start a fresh worktree and check again
  before reporting.
- `mend shell` is the owner's alone on a session; open each person's shell on their own session.
- Everyone in a per-person workspace has passwordless `sudo`. Do not report the uid check as
  isolation; it shows what each process runs as, not what it can read.
