# Sessions inbox and the session lists

Sessions (`/`) is the web app's home. On the left, the inbox lists every session the person can see
in three groups: `Needs you` (an agent waiting for input), `Running`, and `Ready to review` (a
completed change nobody has commented on, or a review follow-up not yet sent). `Snoozed` and
`Settled` fold at the bottom. Hovering or focusing a row shows Snooze and Settle; both are the
person's own and never move anyone else's inbox. One filter line narrows it: a project picker, a
removable chip per active filter (`Mine` by default), and `Filter` (started by, agent, branch). With
no session open, the page shows `What should an agent work on?` over the composer. An icon rail on
every page links Sessions, Projects, Skills and Settings, with an amber dot on Sessions while
something needs you; it expands to show labels and projects. The same facts reach the terminal as
`mend sessions` (also `mend status`) and `mend projects`, with stable JSON for integrations; the
phone's Now tab and the desktop's inbox rail are the same list on those devices. Everything updates
live, without a reload.

## Sub-features

- `inbox-groups` lists sessions under `Needs you`, `Running` and `Ready to review`, each row with
  its title, project, status word and, for a review, its diff stats.
- `inbox-snooze-settle` snoozes a row until a chosen time or settles it, from the row's hover
  actions; a folded row's `Back to the inbox` returns it.
- `inbox-folds` opens `Snoozed` (each row says when it returns) and `Settled`.
- `inbox-filters` narrows the inbox by project, by who started it, by agent and by branch.
- `home-composer` starts a session from `What should an agent work on?`.
- `rail` shows the icon rail, its needs-you dot, and the expanded rail with projects.
- `now-menus` opens the session right-click menu on an inbox row.
- `sessions-cli` lists sessions with `mend sessions` / `mend status`, `--all`, `--project`, `--json`
  and `--json=v2`.
- `projects-cli` lists projects with their live sessions (`mend projects`).
- `now-mobile` shows the phone's Now tab.
- `now-desktop` shows the desktop's inbox rail.

## How to get to it (user POV)

- Web: `/`, the app's home; the rail's Sessions icon and the `m` mark link back to it. A first visit
  with no project shows the first-run steps instead of the composer.
- CLI: `mend sessions [--all] [--project <p>] [--json | --json=v2]` (alias `mend status`) and
  `mend projects`.
- TUI: the dashboard (`mend ui`, or bare `mend`) is the terminal's live list; see the TUI feature.
- Mobile: the `Now` tab (`/`) of the Expo app.
- Desktop: the sidebar's `inbox` face (`Ctrl+Shift+B` toggles it with `tree`).
- VS Code: the Mend view lists sessions. Not drivable yet: this map has no VS Code driver.
- Slack: `@mend list` lists the person's sessions started from Slack in that workspace, newest
  first, with their state, channel and links to Mend. Not drivable yet: this map has no Slack
  driver.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in, and `<project>` adopted.
- A completed session with a change and no comments:
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its `<harness>`
  word from `mend sessions --project <project> --all`.
- Two live sessions, each in its own PTY: `mend run --project <project> -- sleep 1800`, twice. Note
  `<idA8>` and `<idB8>`.

- **Inbox.** Go to `<web>/`. The inbox is `page.getByRole("complementary", { name: "Sessions" })`;
  its groups are regions named `Needs you`, `Running` and `Ready to review` (only those with rows).
  Under `Running` (`page.getByRole("region", { name: "Running" })`), each live session is a link to
  `/sessions/<id>` whose name starts with its title (the label, else the worktree's shown name, else
  `session <id8>`) and carries `<project>` and `running · <n> min`.
- **Ready to review.** Under `Ready to review`, the completed session's link carries `completed` and
  the stats `+1 −0` (`no file changes` when there are none). Clicking it opens its session.
- **Settle.** Hover the review row (or Tab to its link). Click
  `page.getByRole("button", { name: "Settle: <title>" })`. The row leaves `Ready to review` at once;
  `page.getByRole("button", { name: /^Settled/ })` now counts one more. Open it: the row is there
  with `settled just now`. `Back to the inbox: <title>` returns it to `Ready to review`.
- **Snooze.** On a running row, click `Snooze: <title>`; a menu lists `In an hour`, `This evening`
  (while more than an hour away), `Tomorrow morning` and `Next week`, each with its time. Pick
  `In an hour`: the row leaves `Running`; under `Snoozed` it reads `until <hh:mm>`. Reload: it stays
  snoozed (the mark is on the server, `GET /api/session-inbox-marks`).
- **Filters.** The filter line is `page.getByRole("group", { name: "Filter sessions" })`. With
  `Mine` on, only sessions this account started are listed; `Remove the filter Mine` lists
  everyone's. `Projects: All projects` opens a combobox with `Find a project`; typing narrows it,
  picking a project checks it and the inbox shows only that project. `Filter` opens a menu with
  `Started by`, `Agent` and `Branch` submenus.
- **Composer.** With no session open, the heading `What should an agent work on?` sits over the form
  `New session`, whose prompt has the cursor on first paint. Type a prompt and press `Control+Enter`
  (`Meta+Enter` on a Mac): the session starts and the page opens it. Enter alone makes a new line.
  `New session (c)` in the inbox header, or `c` anywhere outside a field, puts the cursor back in
  the prompt.
- **Rail.** `page.getByRole("navigation", { name: "Primary" })` holds `Sessions`, `Projects`,
  `Skills` and `Settings`; the current one has `aria-current="page"`. While a session waits, the
  Sessions link is named `Sessions, 1 needs you` and shows an amber dot. `Expand sidebar` shows the
  labels, the waiting count, and every project with a dot (green while one of its sessions is live)
  and its live count; `Collapse sidebar` folds it, and the choice survives a reload. The avatar at
  the foot opens `Account and machine` with the machine, the exposure line and `Sign out`.
- **Session menu.** Right-click an inbox row. The menu titled `<harness>` (with ` — <label>` when
  labelled) lists `Open session`, `Open review` (with a change), `Resume session` (for the owner)
  and `Delete session…` on a settled row; on a live row it lists `Mark checkpoint` and
  `Stop session` instead, and `Stop services` while Services run.
- **CLI list.** Run `mend sessions --project <project> --all`. One line per session:
  `<harness>  <id8>  <status>  <project>  <branch> · base <base>`, then the facts in this order: a
  hold line, `handed off from <machine>` (a handed-off worktree's sessions), the label, `<n> open`,
  `follow-up pending`. Exit code `0`. `mend status --project <project> --all` prints the same.
- **CLI JSON.** Run `mend sessions --project <project> --all --json`. The JSON is
  `{ "version": 1, "sessions": [ … ] }`; each entry has `id`, `projectName`, `harness`, `label`,
  `worktree`, `branch`, `baseSha`, `baseRef`, `status`, `summary`, `createdAt`, `reviewUrl`
  (`<web>/sessions/<id>`), `review` and `capture`. Run
  `mend sessions --project <project> --json=v2`: `{ "version": 2, "worktrees": [ … ] }`, each
  worktree with its `sessions`, the same shape as `mend worktrees --json`.
- **Unknown project.** Run `mend sessions --project no-such-project`. Stderr reads
  `mend: no adopted project named "no-such-project"`; exit code `1`.
- **Projects CLI.** Run `mend projects`. One line per project:
  `<project>  <default branch>  <n live | —>  <store path>`. Run inside a clone of `<repo-url>`, the
  project's line is marked `▸`, followed by `  ▸ <project> is the cwd's project`.
- **Mobile.** On the Expo web build at 390x844, signed in by pairing, the `Now` screen shows the
  header `Now` with `nothing waiting on you · <n> live`, and the labels `Needs you`, `Live` and
  `Recently settled` for the groups that have rows. A row is found by its title
  (`page.getByText("session <id8>")`, or its label); clicking it opens `/session/<id>`.
- **Desktop.** Attached over CDP, press `Control+Shift+B` (or click
  `page.getByRole("group", { name: "Sidebar face" }).getByRole("button", { name: "inbox" })`).
  Inside `page.getByRole("navigation", { name: "Projects and sessions" })` the header reads
  `<n> live · <n> settled`, live rows come first, and the shelf buttons fold the rest
  (`aria-expanded`). Match their names by prefix, `page.getByRole("button", { name: /^settled/ })`
  and `page.getByRole("button", { name: /^snoozed/ })`: a collapsed shelf includes its count, for
  example `settled 3`. A row is a button named by its text, starting `<harness> · `; clicking it
  opens the session's tab. With no live session the rail reads `no live sessions`.
- **Slack list.** Not drivable yet: this map has no Slack driver. A linked person sends
  `@mend list`; the private reply reads `Your sessions started from Slack, newest first:` with
  state, channel and Mend links, or `No sessions you started from Slack in this workspace.`
- **Proof.** Capture the inbox with its groups (`ariaSnapshot()` and a screenshot with the heading
  visible) before and after Settle and Snooze, with Snoozed and Settled open, and the mobile and
  desktop lists. Keep the `mend sessions` (human, `--json`, `--json=v2`) and `mend projects`
  transcripts with exit codes.

## Gotchas

- `Needs you` needs a session whose status is `waiting` (an agent waiting for input). A disposable
  run without one reports that group as not reached.
- `Ready to review` shows one row per change, only once the session `completed` and nobody
  commented, or while a review follow-up is not sent (see
  [Send review back](./send-review-back.md)). A stopped session settles on its own and appears under
  `Settled`.
- Snooze and Settle are per account: a second account still sees the session where its status puts
  it.
- Link names concatenate the row's texts: the title, the project and the status word. Match them
  with a prefix regex, not an exact name.
- The hover actions are hidden until the row is hovered or something inside it has focus; Tab to the
  row's link first when driving by keyboard.
- `mend sessions` without `--all` and without `--project` lists live sessions plus settled ones
  whose Services or save still hold the workspace. `--project` includes settled sessions. `--json`
  without `--all` or `--project` reads the server's live list, with `review` null.
- `--json=v2` must be written with `=`; `--json v2` is the v1 list.
- Right-click menus have no accessible name (`role="menu"`); their header is a plain line, and items
  are `menuitem`s named by their labels. `Remove project…` and `Delete session…` confirm on a second
  click with new names.
- Mobile rows are role-less elements named by their whole text; there is no `Ready to review` group
  on the phone, and rename and delete sit behind a swipe. The phone shows the harness's display name
  (`Claude Code`, `Codex`, `OpenCode`) on a row. At a viewport at least 600 in both dimensions the
  phone app switches to a two-pane layout where a row selects instead of navigating.
- The desktop's inbox rows run their texts together with no separator; match with a regex.
- Pending button labels such as `Stopping…` can finish between reads. Report each transient state
  not observed, then capture the resulting list and statuses.
- Never wait for `networkidle`: every page holds the `/api/events` stream open.
