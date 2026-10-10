# Worktrees

A worktree is the durable container for a change: a git worktree of a project in Mend's store, on a
branch of its own (`mend/<name>`), holding every session started in it over time and the one change
they make together. A project's Worktrees tab shows each worktree as a parent of its sessions, in a
list or as cards, with its branch, base, sessions and review link. A user creates one, opens its
menu to start a session in it or copy its path, and removes it. Removal takes the worktree's
sessions, change, checkpoints and review with it, never touches origin, and is refused in words
while a session in it is live, while its change is not on origin (until forced), or while its
workspace is saving. `mend worktrees` lists the same tree in a terminal, and `mend refresh` brings
origin's branches into the store so new worktrees base on current tips.

## Sub-features

- `worktrees-tab` shows the Worktrees tab: the region `Worktrees`, its count, and each worktree with
  its sessions.
- `worktrees-view` switches between `List` and `Cards`, remembered in the browser.
- `worktrees-toggle` hides or shows one worktree's sessions.
- `worktrees-new` creates a worktree from `New worktree` (or `Create your first worktree`).
- `worktrees-menu` opens a worktree's right-click menu: open its newest session or review, start a
  session here, copy its path, branch or base, remove it.
- `worktrees-remove` removes one, through a refusal dialog with `Remove anyway` when force lifts the
  refusal.
- `worktrees-clear-settled` removes every settled worktree in two clicks, and says how many were
  kept.
- `worktrees-hidden-ended` says how many ended sessions are hidden for lack of a transcript.
- `worktrees-cli` lists worktrees with `mend worktrees [--project] [--json]` and removes one with
  `mend worktrees rm <name> [--force]`.
- `worktrees-refresh` fetches origin's branches into the store with `mend refresh [project]`.
- `worktrees-tui` creates (`w`) and removes (`Shift+D`) worktrees in the dashboard.

## How to get to it (user POV)

- Web: a project's Worktrees tab, `/projects/<id>`, reached from the Projects list or the Now page's
  project name. The tab holds the `Worktree view` group (`List`, `Cards`), `New worktree`, the tree,
  and `Clear settled` once a worktree is settled. Each worktree header has a show/hide toggle, its
  sessions count, `Review`, and `New session in <worktree>`; right-clicking the header opens its
  menu.
- CLI: `mend worktrees [--project <p>] [--json]`,
  `mend worktrees rm <name> [--force] [--project <p>]`, `mend refresh [project]`, and
  `mend sessions --json=v2` (the same grouped shape).
- TUI: the dashboard's `worktrees` section; `w` opens the new worktree form (from the projects or
  worktrees section), `Shift+D` removes the selected worktree, `Shift+K` stops all its live
  sessions.
- VS Code: `Mend: New worktree without an agent…` and `Mend: Copy worktree path`. Not drivable yet:
  this map has no VS Code driver; the end states are a new worktree in `mend worktrees` and the path
  on the clipboard (`Mend worktree path copied` in the status bar).
- Desktop and mobile: no worktree list; their session views name the worktree. Mobile's
  `Clear settled` on the Now tab removes settled sessions, not worktrees. Not driven by this map.
- Slack: none.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI signed in as the person who adopted
  `<project>`. `<projectId>` is its id (from its `/projects/<projectId>` URL).
- No worktree named `verify-wt` or `verify-tui` exists in `<project>`
  (`mend worktrees --project <project>`).

- **Open the tab.** Go to `<web>/projects/<projectId>`. The region
  `page.getByRole("region", { name: "Worktrees" })` holds the heading `Worktrees` and the count.
  With no worktree it shows the heading `No worktrees yet` and the button
  `Create your first worktree`.
- **Create.** Run `await page.getByRole("button", { name: "New worktree" }).click()`. The dialog
  `New worktree` opens. Run `await page.getByRole("textbox", { name: "Name" }).fill("verify-wt")`;
  the line under it reads `branch mend/verify-wt`. Run
  `await page.getByRole("button", { name: "Create worktree" }).click()`. The button reads
  `Creating…`, the dialog closes, and the tree shows `verify-wt` with `mend/verify-wt · base <base>`
  and `0 sessions`, and the line `No visible sessions` under it.
- **CLI view.** Run `mend worktrees --project <project>`. A line starts `verify-wt` and reads
  `<project>  mend/verify-wt · base <base>  0 sessions`. Run
  `mend worktrees --project <project> --json`. The JSON has `"version": 2` and a worktree with
  `"name": "verify-wt"`, `"branch": "mend/verify-wt"` and `"sessions": []`.
- **Switch the view.** Run `await page.getByRole("button", { name: "Cards" }).click()`. `Cards` has
  `aria-pressed="true"` and `List` `false`; each worktree becomes its own card. Reload the page:
  `Cards` is still pressed. Switch back with `List`.
- **Worktree menu.** Right-click the worktree's name
  (`await page.getByText("verify-wt", { exact: true }).first().click({ button: "right" })`). A menu
  (`role="menu"`, titled `verify-wt`) lists `Start claude session here`, `Start codex session here`,
  `Start opencode session here`, `Start pi session here`, `Copy directory name`, `Copy branch name`
  and, with no live session, `Remove worktree…`; `Open newest live session` when a member is live,
  else `Open newest session` when it has members; `Open review` when it has a change;
  `Copy base ref` when a base ref was named. Choose
  `page.getByRole("menuitem", { name: "Copy directory name" })`: the item reads `Copied`, then the
  menu closes. Read the clipboard, not the item
  (`page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: web })`, then
  `navigator.clipboard.readText()`): it holds the worktree's directory name (`verify-wt`), not a
  path: a captured worktree has no directory on the server.
- **Remove an empty worktree.** Open the menu again and choose
  `page.getByRole("menuitem", { name: "Remove worktree…" })`. The item now reads
  `Really remove worktree verify-wt? The change and checkpoints go with it.`; choose it again
  (`page.getByRole("menuitem", { name: /^Really remove worktree verify-wt\?/ })`). The worktree
  leaves the tree, and `mend worktrees --project <project>` no longer lists it.
- **Refused: never landed.** Make a worktree with a change:
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`, and note its worktree
  name `<wt>` from the `✓ worktree` line. Wait until
  `mend sessions --project <project> --all --json` shows its `capture` null or with a null `line` (a
  workspace still saving is refused with other words). Run
  `mend worktrees rm <wt> --project <project>`. Stderr reads
  `mend: This worktree holds a change that was never landed · 1 file · +1 −0 · VERIFY.md +1 −0. Land it or discard it before removal, or pass force=true to remove it anyway.`
  and `  mend worktrees rm <wt> --project <project> --force removes it anyway`; exit code `1`.
- **Hide and show sessions.** On the tab, `<wt>`'s header has the toggle named
  `Hide sessions in <shown name>` with `aria-expanded="true"`. Run
  `await page.getByRole("button", { name: "Hide sessions in <shown name>" }).click()`. Its
  `aria-expanded` becomes `false`, the session line is hidden, and the button is now named
  `Show sessions in <shown name>`. Click it again to show them.
- **Refused on the web, then removed anyway.** On the tab, open that worktree's menu (right-click
  its shown name; see Gotchas) and choose `Remove worktree…` twice. A dialog named `Not removed`
  opens, stating `<shown name> stays in the store.`; its alert holds the same words, the list
  `page.getByRole("list", { name: "Not on origin" })` reads `1 file` with `+1 −0`, then `VERIFY.md`
  with `+1 −0`, and the text says `Remove anyway discards this change.` Run
  `await page.getByRole("button", { name: "Remove anyway" }).click()`. It reads `Removing…`, the
  dialog closes, and the worktree leaves the tree.
- **Refused: live.** Start `mend run --project <project> -- sleep 600` in its own PTY, note `<wt2>`
  and `<id8>`, then run `mend worktrees rm <wt2> --project <project>`. Stderr reads
  `mend: 1 session live in <wt2> · stop it first: mend stop <id8>`; exit code `1`. On the web, that
  worktree's menu has no `Remove worktree…`. Stop it with `mend stop <id8>` and let it settle.
- **Remove with --force.** Run `mend worktrees rm <wt2> --project <project> --force`. Stdout reads
  `removed · <wt2> · its sessions, change, checkpoints and review went with it`; exit code `0`.
- **Seed Clear settled.** After the earlier removals, create a clean worktree with
  `mend run --project <project> -- true`, then one with an unlanded change with
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Record both worktree
  names. Wait until both sessions are settled and their capture lines are null in
  `mend sessions --project <project> --all --json`. The project must have exactly one worktree whose
  removal will be refused, the new unlanded change; no saving workspace or other refusal.
- **Clear settled.** With those two settled worktrees on the tab, run
  `await page.getByRole("button", { name: "Clear settled" }).click()`. The button reads
  `Really remove <n> settled worktree(s)? Sessions and changes go with them.` Click it again
  (`page.getByRole("button", { name: /^Really remove \d+ settled worktree/ })`). It reads
  `Clearing…`; settled worktrees without unlanded work go, and a worktree the store refused stays,
  with a status (`page.getByRole("status")`) reading
  `1 kept · removal refused · remove it from its menu to see why`.
  `mend worktrees --project <project> --json` no longer lists the clean worktree and still lists the
  worktree with the unlanded change. After capturing proof, remove the latter with
  `mend worktrees rm <kept-worktree> --project <project> --force`.
- **Refresh.** Run `mend refresh <project>`. Stdout reads `✓ refreshed <project> · <n> branches`,
  then up to twelve lines `<name>  <sha12>  <YYYY-MM-DD>`, the default branch marked `▸`, and
  `  … <k> more` past twelve. Exit code `0`.
- **TUI create.** Run `tmux new-session -d -s wt -x 200 -y 50 'mend ui'`. Select `<project>` in the
  projects section and press `w`. A form titled `new worktree · <project>` shows `name` with the
  placeholder `e.g. fix-auth (empty = auto · an existing name joins it)`. Type `verify-tui`
  (`tmux send-keys -t wt 'verify-tui' Enter`); the base step shows
  `type to filter · enter takes the highlighted branch, or the default when empty`. Press `Enter`
  for the default. In the harness list (`codex`, `claude`, `opencode`, `pi`, `shell`), pick `shell`
  (`tmux send-keys -t wt Down` four times, a moment apart, then `tmux send-keys -t wt Enter`: sent
  as one `send-keys`, the keys arrive together and launch the first harness, `codex`). The status
  line reads `provisioning shell workspace ·`, then `started · <session display name> · a attaches`
  or `still starting · <session display name> · a attaches once the row reads running`. The new
  shell session has no label, so its display name is `shell <id8>`, not `verify-tui`.
- **TUI remove.** Stop the new session first (select it in the sessions section, `Shift+K` twice:
  `press ⇧K again to stop · …`, then `stopped · … · the record and review remain`). In the worktrees
  section select `verify-tui` and press `Shift+D` (`tmux send-keys -t wt D`). The status line reads
  `press ⇧D again to remove worktree · verify-tui · its session and change go with it`. Press `D`
  again within five seconds: `removing worktree · verify-tui`, then `removed · verify-tui`, or the
  server's refusal words.
- **Proof.** Capture the Worktrees tab
  (`page.getByRole("region", { name: "Worktrees" }).ariaSnapshot()` and a screenshot) after create,
  in Cards view, with the `Not removed` dialog open, and after Clear settled. Keep every
  `mend worktrees`, `mend worktrees rm`, `mend refresh` transcript with exit codes, and the tmux
  captures.

## Gotchas

- A worktree created without a name is `wt-<id>` (branch `mend/wt/<id>`) in `mend worktrees`, but
  the web shows it by the first member with a non-null label, else `session <id8>` using the first
  member's id. With no members it keeps the worktree name. Right-click the shown name; `.first()`
  picks the worktree header over a session line with the same text.
- The worktree and session menus take focus as they open: `Escape` closes them, as does a click
  outside (see [Now and sessions](./now-and-sessions.md)).
- The worktree header has no role, and its menu (`role="menu"`) has no accessible name; only its
  `menuitem`s are named. A confirm item renames itself to its confirmation on the first click, and a
  copy item to `Copied`.
- `Remove worktree…` is absent while any session in the worktree is live; the CLI refuses the same
  case itself, before asking the server.
- `mend run --name <n>` names its worktree; without it the name is automatic (`wt-<id>`). Read it
  from the `✓ worktree` line, or from `worktree` in `mend run --detach --json`.
- The web has no worktree rename, and neither has any other surface: the dashboard's `e` renames the
  selected session's label, which can change what an unnamed worktree is shown as, and the desktop's
  `rename` names a shell. A worktree's name is set only when it is created.
- The dashboard sends no `force`: a worktree whose change is not on origin is refused there with the
  server's words, and removing it takes the web's `Remove anyway` or `mend worktrees rm --force`.
- `Clear settled` never forces. A worktree with unlanded work stays; its own menu shows why. Zero
  refusals show no kept note; several show
  `<n> kept · removal refused · remove one from its menu to see why`. The seeded recipe expects
  exactly one refusal.
- Provisioning and pending button labels can finish between reads. Report each transient state not
  observed and capture the resulting worktree and session list.
- A removal while a workspace is still saving is refused on every surface, `--force` included (see
  [Capture and save](./capture-and-save.md)).
- A server-side live refusal (a shell or Service of a settled session still holding the workspace)
  carries no message in its body; the CLI then prints `mend: DELETE /worktrees/<id> → 409`. That
  reading is from source, not observed.
- `mend refresh` takes the project as a positional word; the code also reads `--project`, which
  `help.ts` does not document for it.
- `New session in <worktree>` carries the worktree name only for screen readers; use the full name.
- The `Not on origin` list's first row is the total (`<n> files` and `+<a> −<d>`), then one row per
  named file.
