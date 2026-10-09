# Now and the session lists

The Now page (`/`) answers, in order: what waits on me, what has a delivery pending, which changes
nobody has reviewed yet, what runs, and what settled in each project. Each row carries its review
facts (open comments, a pending follow-up, the pull request) and opens its session or its review.
Live sessions can be selected and stopped together, and every row and project card has a right-click
menu. The same facts reach the terminal as `mend sessions` (also `mend status`) and `mend projects`,
with stable JSON for integrations; the phone's Now tab and the desktop's inbox rail are the same list
on those devices. Everything updates live, without a reload.

## Sub-features

- `now-summary` shows the heading `What needs you` and the line
  `<waiting> · <n> live · <n> to review · <n> projects`.
- `now-needs-you` lists sessions waiting for input.
- `now-needs-delivery` lists settled sessions with a review follow-up not yet delivered.
- `now-ready-to-review` lists one row per settled change nobody has commented on, with its diff
  stats, straight to the review.
- `now-live` lists live sessions, each with a `select <harness> session` checkbox, and stops the
  selected ones with `Stop <n> selected`.
- `now-projects` lists each project with up to four recent settled sessions, each with `Review` and
  `Resume`, plus `Adopt a repository` and the pairing hint.
- `now-menus` opens the project and session right-click menus.
- `sessions-cli` lists sessions with `mend sessions` / `mend status`, `--all`, `--project`,
  `--json` and `--json=v2`.
- `projects-cli` lists projects with their live sessions (`mend projects`).
- `now-mobile` shows the phone's Now tab.
- `now-desktop` shows the desktop's inbox rail.

## How to get to it (user POV)

- Web: `/`, the app's home; every page's shell links back to it. A first visit with no project shows
  the first-run steps instead of the Projects list.
- CLI: `mend sessions [--all] [--project <p>] [--json | --json=v2]` (alias `mend status`) and
  `mend projects`.
- TUI: the dashboard (`mend ui`, or bare `mend`) is the terminal's live list; see the TUI feature.
- Mobile: the `Now` tab (`/`) of the Expo app.
- Desktop: the sidebar's `inbox` face (`Ctrl+Shift+B` toggles it with `tree`).
- VS Code: the Mend view lists sessions. Not drivable yet: this map has no VS Code driver.
- Slack: `@mend list` lists the person's sessions started from Slack in that workspace, newest
  first, with their state, channel and links to Mend. Not drivable yet: this map has no Slack driver.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in, and `<project>` adopted.
- No device is paired yet (for the pairing hint), or the step is skipped.
- A completed session with a change and no comments:
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its `<harness>`
  word from `mend sessions --project <project> --all`.
- Two live sessions, each in its own PTY: `mend run --project <project> -- sleep 1800`, twice. Note
  `<idA8>` and `<idB8>`.

- **Summary.** Go to `<web>/`. The heading `What needs you` is present
  (`page.getByRole("heading", { name: "What needs you" })`). The line under it reads
  `Nothing waiting on you · 2 live · 1 to review · 1 project`.
- **Ready to review.** Under the label `Ready to review`, one row links to the review:
  `page.getByRole("link", { name: new RegExp("^<harness> · <project>") })`. Its text contains
  `Review →`, then `settled <time>`, then the stats `· 1 file · +1 −0`. Assert each fragment
  separately. Clicking it lands on `/changes/<changeId>`.
- **Live.** Under `Live`, each live session is a card linking to `/sessions/<id>`, named from
  `<shown name> · <project>` (an unnamed worktree is shown by its session's label, else
  `session <id8>`) followed by its status word (`Running · recording`) and its line
  (`<harness> · <branch> · base <base>`, or the latest progress line). Each has a checkbox
  `page.getByRole("checkbox", { name: "select <harness> session" })`; with two sessions of the same
  harness there are two, so take `.nth(0)` and `.nth(1)`.
- **Stop selected.** Check both. A button `Stop 2 selected` appears beside `Live`. Run
  `await page.getByRole("button", { name: "Stop 2 selected" }).click()`. It reads `Stopping…`; the
  cards leave `Live` and the summary line reads `0 live`. Unscoped `mend sessions` prints
  `no active sessions — mend sessions --all includes settled ones` (unless a Service or a save keeps
  one listed).
- **Projects.** Under `Projects`, the card's link `page.getByRole("link", { name: "<project>", exact: true })`
  opens `/projects/<projectId>`. Its recent rows show each settled session's harness, `settled <time>`,
  status word, `Review` (to the change) and `Resume`. `page.getByRole("link", { name: "Adopt a repository" })`
  opens `/projects`. With no paired device,
  `page.getByRole("link", { name: "Pair your phone · Settings → Devices" })` opens
  `/settings#devices`.
- **Project menu.** Right-click the project link
  (`await page.getByRole("link", { name: "<project>", exact: true }).click({ button: "right" })`).
  A menu titled `<project>` lists `Open project`, `Start claude session`, `Start codex session`,
  `Start opencode session`, `Start pi session`, `Start shell session`, `Copy store path`,
  `Copy origin URL`, and for someone who may remove it `Remove project…`. Press `Escape` to close it.
- **Session menu.** Right-click a settled row's link. The menu titled `<harness>` (with ` — <label>`
  when labelled) lists `Open session`, `Open review` (with a change), `Resume session` (for the
  owner) and `Delete session…`. On a live card it lists `Mark checkpoint` and `Stop session`
  instead, and `Stop services` while Services run.
- **CLI list.** Run `mend sessions --project <project> --all`. One line per session:
  `<harness>  <id8>  <status>  <project>  <branch> · base <base>`, then the facts (label,
  `<n> open`, `follow-up pending`, a hold line). Exit code `0`. `mend status --project <project> --all`
  prints the same.
- **CLI JSON.** Run `mend sessions --project <project> --all --json`. The JSON is
  `{ "version": 1, "sessions": [ … ] }`; each entry has `id`, `projectName`, `harness`, `label`,
  `worktree`, `branch`, `baseSha`, `baseRef`, `status`, `summary`, `createdAt`,
  `reviewUrl` (`<web>/sessions/<id>`), `review` and `capture`. Run
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
  `page.getByRole("group", { name: "Sidebar face" }).getByRole("button", { name: "inbox" })`). Inside
  `page.getByRole("navigation", { name: "Projects and sessions" })` the header reads
  `<n> live · <n> settled`, live rows come first, and the shelf buttons fold the rest
  (`aria-expanded`). Match their names by prefix,
  `page.getByRole("button", { name: /^settled/ })` and
  `page.getByRole("button", { name: /^snoozed/ })`: a collapsed shelf includes its count,
  for example `settled 3`. A row is a button named by its text, starting `<harness> · `;
  clicking it opens the session's tab. With no live session the rail reads `no live sessions`.
- **Slack list.** Not drivable yet: this map has no Slack driver. A linked person sends
  `@mend list`; the private reply reads `Your sessions started from Slack, newest first:` with
  state, channel and Mend links, or `No sessions you started from Slack in this workspace.`
- **Proof.** Capture the Now page with all sections (`ariaSnapshot()` and a screenshot with the
  heading visible) before and after `Stop 2 selected`, and the mobile and desktop lists. Keep the
  `mend sessions` (human, `--json`, `--json=v2`) and `mend projects` transcripts with exit codes.

## Gotchas

- Section labels (`Needs you`, `Needs delivery`, `Ready to review`, `Live`, `Projects`) are plain
  paragraphs, not headings or regions, and rows have no list role. Find rows by their link names.
- The Live checkboxes are named by harness only (`select claude session`): two sessions of the same
  harness share a name. A name that identified the session is missing; that is a finding.
- In each project card's recent rows, `Review` and `Resume` repeat with no name tying them to their
  session; scope them to the row (see [Attach and resume](./attach-resume.md)).
- `Needs you` needs a session whose status is `waiting` (an agent waiting for input), and
  `Needs delivery` a settled session with an undelivered follow-up (see
  [Send review back](./send-review-back.md)). A disposable run without them reports those sections
  as not reached.
- `Ready to review` shows one row per change, only once the session `completed`, nobody commented
  and no follow-up is pending. A stopped session does not appear there.
- Link names concatenate everything inside the card: the place, the status word and the facts. Match
  them with a prefix regex, not an exact name.
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
- Pending button labels such as `Stopping…` can finish between reads. Report each transient
  state not observed, then capture the resulting list and statuses.
- Never wait for `networkidle`: the Now page holds the `/api/events` stream open.
