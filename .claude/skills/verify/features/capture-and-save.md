# Capture and save on stop

A workspace holds the only copy of whatever it has not shipped to Mend's store yet (ADR 0002). Mend
never lets that compute go while anything is pending: a stop drains first, saving what is left, and
the workspace ends only once the executor reports nothing pending. While it drains, the session
reads `stopping` with a capture line (`saving · 3 left`, `saving · 12 MB left`,
`saving · no uploads pending`) on the web, in the CLI, on the phone and in the dashboard. A drain
that stops moving reads `not saved · … · workspace kept`, and the workspace stays. Only the
session's owner can end it with captures pending, with `Discard unsaved and stop…`, and the session
then says who discarded it and when. A worktree whose workspace is still saving refuses removal,
`--force` included.

## Sub-features

- `capture-stop-line` shows what a stop is still saving: the session page status, `mend stop`'s
  capture line, the dashboard row and the phone's status line.
- `capture-sessions` lists a saving session in `mend sessions` (it stays listed while it saves) and
  carries the facts in `mend sessions --json` as `capture`.
- `capture-not-saved` reads `not saved · … · workspace kept` once a drain stalls, and keeps the
  workspace.
- `capture-discard` lets the owner end the workspace with captures pending, in two clicks, and
  records who did it.
- `capture-removal-hold` refuses worktree removal while a workspace is saving, on the web and in the
  CLI, and force does not lift it.

## How to get to it (user POV)

- Web: the session page (`/sessions/<id>`), beside the status word in the header: a second status
  word with the capture line, and for the owner the button `Discard unsaved and stop…` while a drain
  runs or was kept.
- Web: a project's Worktrees tab, where a saving session's line shows the capture line in place of
  its status; `Remove worktree…` in the worktree's context menu, and `Clear settled`.
- CLI: `mend stop <session>` prints the capture line after the stop; `mend sessions`,
  `mend sessions --all --json` (`capture`); `mend worktrees rm <name>` prints the saving refusal.
- TUI: the session row's state words, `a` on a stopping session, and `Shift+K` on one.
- Mobile: the session screen's status line (`stopping · saving · 3 left`). Not driven by this map.
- Slack: a session's thread status message includes the capture line while saving or when the
  workspace is kept. Not drivable yet: this map has no Slack driver.
- Desktop, VS Code: no capture line or discard in this map.

## Driving it with verify

Preconditions:

- The server runs the capture store (the default; not `MEND_SESSION_STORE=colocated`). A co-located
  store has no drain, and every step below reports the precondition unmet.
- Mend is healthy at `<web>`, the browser and the CLI signed in as the session's owner.
- A live session with enough unsaved bytes that a drain takes long enough to read. For example, in
  its own PTY:
  `mend run --project <project> -- sh -c 'mkdir -p node_modules/verify && head -c 500000000 /dev/urandom > node_modules/verify/blob && sleep 1800'`.
  Note `<id>`, `<id8>` and `<worktree>`. How long the drain takes depends on the store's throughput;
  a fast store may finish before a read. Launch must size the bytes for its store.

- **Capture-line forms.** `<capture line>` below is `saving`, `saving · <n> left`,
  `saving · <size> <unit> left` or `saving · no uploads pending`. Bytes take precedence over the
  count when available, with units `B`, `KB`, `MB`, `GB` or `TB`. Each form may append
  `· capture step overdue · <step>` with `· running <duration>` and `· bound <duration>` when those
  durations are reported. Capture the form observed on each read; the line can change between reads.
- **Stop and read the line.** Run `mend stop <id8>`. Stdout reads
  `✓ stopped · <harness> · <id8> · <branch>`, then, while the drain runs,
  `  <capture line> · the workspace stops once nothing is pending`, then
  `  review · <web>/sessions/<id>`. Exit code `0`.
- **Session page while saving.** Go to `<web>/sessions/<id>`. The header shows the status word
  `Stopping` and beside it `<capture line>` in one of the forms above, as plain text. For the owner,
  `page.getByRole("button", { name: "Discard unsaved and stop…" })` is present.
- **Listed while saving.** Run `mend sessions`. The session is listed although it is no longer live:
  `<harness>  <id8>  stopping   <project>  <branch> · base <base>  <capture line>`. Run
  `mend sessions --project <project> --all --json`. The session's entry has `"status": "stopping"`
  and `"capture"` with `"drain": "stop"`, `"notSaved": false` and `"line": "<capture line>"`
  (`pending` and `pendingBytes` as the server reports them).
- **Removal refused while saving.** Run `mend worktrees rm <worktree> --project <project> --force`.
  Stderr reads
  `mend: not removed · saving · 1 session · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved`,
  with no `--force removes it anyway` line; exit code `1`.
- **Removal refused on the web.** Open `<web>/projects/<projectId>`, right-click the worktree's
  shown name
  (`await page.getByText("<shown name>", { exact: true }).first().click({ button: "right" })`; see
  Gotchas for the name), choose `page.getByRole("menuitem", { name: "Remove worktree…" })`, then the
  same item again, now named `Really remove worktree <shown name>? …`. A dialog named `Not removed`
  opens; its alert (`page.getByRole("alert")`) holds the same `not removed · saving · …` words, and
  its buttons are `Keep worktree` and the dialog's `Close`: no `Remove anyway`. Choose
  `Keep worktree`.
- **Dashboard.** In `tmux new-session -d -s cap -x 200 -y 50 'mend ui'`, select the session. Its
  row's state words read `<capture line>` in one of the forms above. Press `a`: the status line
  reads `stopping · <session display name> · <capture line>`.
- **Saved.** Wait until the capture line goes. The session page shows a settled status word
  (`Stopped`) with no capture line, `Discard unsaved and stop…` is gone, and
  `mend sessions --project <project> --all --json` shows the entry settled with `"line": null` in
  `capture` (or `capture` null).
- **Discard (separate session).** Start a second session the same way, stop it, and on its page
  while it reads `saving`: run
  `await page.getByRole("button", { name: "Discard unsaved and stop…" }).click()`. The same button
  now reads `Really discard what is not saved? It is gone once the workspace stops.` Click it again
  (`page.getByRole("button", { name: /^Really discard what is not saved\?/ })`). It reads
  `Discarding…`, then the capture line reads `unsaved work discarded by <name> at <HH:MM:SS> UTC`.
- **Slack capture.** Not drivable yet: this map has no Slack driver. A Slack-started session with a
  drain shows `<capture line>` in the thread's status message beside its state and branch.
- **Proof.** Capture the session page while saving, after it saved, and after the discard
  (`ariaSnapshot()` and screenshots with the header visible), and the `Not removed` dialog. Keep the
  `mend stop`, `mend sessions`, `mend sessions --json` and `mend worktrees rm` transcripts with exit
  codes, and the tmux capture.

## Gotchas

- A drain on a small worktree can finish between two reads. A run that never sees `saving` reports
  the line as not observed, with the bytes it used; it does not report the feature broken. Report
  each drain state, discard action or pending button label not observed when it finishes between
  reads. A completed drain does not prove the mid-drain removal or discard steps.
- Status words and the capture line are plain text, not `role="status"`. Assert with `getByText`.
- `Discard unsaved and stop…` is a two-click button: the first click arms it and changes its name,
  and moving focus away disarms it. Ask for the armed name in the second click. Only the session's
  owner sees it, and only while a drain runs or was kept; the CLI, TUI, desktop and phone have no
  discard.
- `not saved · <reason> · <n> pending · workspace kept` appears only after a drain moved nothing for
  `MEND_CAPTURE_DRAIN_STALL_SECONDS` (600 s by default) or cannot move. A disposable run reaches it
  only with a lowered stall setting or a broken store.
- `--force` lifts an unlanded-change refusal, never a saving one. The web dialog shows no
  `Remove anyway` for it, and the CLI prints no force hint.
- `mend sessions --json` without `--all` or `--project` reads the server's live list; use
  `--all --json` to read a stopping session's `capture` reliably.
- The worktree's context menu has no accessible name (`role="menu"`); its items are `menuitem`s
  named by their labels. A confirm item renames itself to its confirmation text on the first click.
  The right-click target is the worktree header, which has no role; the name text is the stable
  target.
- A session whose stop is still saving is not settled (`stopping`), although its agent has ended:
  the page may already offer `resume with:` and `Delete…`. A delete asked mid-drain waits for the
  workspace and says what it waits on under the header.
- A worktree started without a name (`mend run` without `--name`) is called `wt-<id>` by
  `mend worktrees`, and the web shows it by the first member with a non-null label, else
  `session <id8>` using the first member's id. With no members it keeps the worktree name.
  Right-click the name the web shows.
