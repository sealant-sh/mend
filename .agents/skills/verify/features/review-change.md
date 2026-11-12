# Review the change

The change is the worktree against its base, and the review page is where a user reads it: the diff
first, the changed files beside it, comments on a line, a range or the whole change, and the
checkpoints that pin what was reviewed. Opening a review pins a slice between two checkpoints, so
the patch and every comment on it stay anchored even when the worktree moves on. Mend can read the
change and draft comments or suggestions on request; those are drafts with evidence, never verdicts.
The same review opens in the dashboard's review screen, in the desktop's Pinned Review, and on the
phone's Review and Diff screens.

## Sub-features

- `review-open` opens the review from a session, a worktree, or the Now page, and pins a slice
  (checkpoint → checkpoint).
- `review-diff` shows every changed file as a collapsible section with its additions and deletions.
- `review-files` jumps to a file from the sidebar's file list.
- `review-inline-comment` comments on one line or a dragged range of lines.
- `review-change-comment` comments on the change as a whole.
- `review-comment-state` accepts, dismisses, marks addressed or reopens a comment.
- `review-checkpoint-mark` takes a checkpoint by hand from the session page.
- `review-pinned` keeps the patch pinned and says so when the worktree changed after the review
  opened.
- `review-machine-pass` asks Mend to read the change (`Read this change`), draft suggestions
  (`Suggest fixes`) or compose the description and tour. Mend uses inference for these.
- `review-tui` reviews the same change in the dashboard's review screen: files, diff, comments,
  comment state and Mend's passes.
- `review-desktop` reviews it in the desktop's Pinned Review: file navigator, unified or split,
  whitespace, context, search, comments, evidence beside the file, and `New snapshot`.
- `review-mobile` reviews it on the phone's Review screen, and reads it on the Diff screen.

## How to get to it (user POV)

- Web: on a session page (`/sessions/<id>`), the `Review the change` link.
- Web: on a project's Worktrees tab, the `Review` link on a worktree that holds a change.
- Web: on the Now page, a card under `Ready to review`, or the `Review` link on a project's session
  row.
- Web: the review lives at `/changes/<change id>`.
- TUI: in the dashboard (`mend ui`, or bare `mend`), select a session (or a worktree) and press `v`.
  In the review screen, `o` opens the web review; in the dashboard, `o` opens the session's page.
- CLI: `mend sessions` prints each session's review facts; `mend sessions --all --json` (or
  `--project <p> --json`) carries `review.openComments` and `review.pendingFollowUp`. Bare `--json`
  lists live sessions with `review` null.
- Desktop: a session tab's header button `review the change` opens the Pinned Review at
  `#/review/<change id>/<slice id>`; `← Workbench` returns. The header's `mark checkpoint` takes a
  checkpoint while the agent is live.
- Mobile: the session screen's header button `Review the change` opens `/review/<change id>`, and
  `Diff` opens `/diff/<change id>`.
- VS Code: no review. `Mend: Open in Mend` on a session opens its web page.
- Slack: the end-of-session reply's `Review in Mend` button (ADR 0006).

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and the browser is signed in.
- A settled session in `<project>` changed one file: run
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'` (see
  [Start a session](./start-session.md)) and note its session URL `<web>/sessions/<id>`.
- The change has no comments yet.
- TUI, desktop and mobile steps: the harnesses from [Start a session](./start-session.md). Each
  surface's comment steps add to the same change; the counts below assume the web steps ran first.

- **Open from the session.** Go to the session page and choose `Review the change`. Run
  `await page.goto("<web>/sessions/<id>")` and
  `await page.getByRole("link", { name: "Review the change" }).click()`. The URL becomes
  `/changes/<change id>`, and the line under the heading starts
  `<sha A> → <sha B> · 1 file · +1 −0 · 0 open comments`, followed by the base when there is one,
  the `session` link and where the bytes were observed.
- **Diff.** The diff header reads `1 file changed` and a button whose name starts with `▶ VERIFY.md`
  heads the file's section (`page.getByRole("button", { name: /^▶\s*VERIFY\.md/ })`). The sidebar's
  file button is the one whose name starts with `VERIFY.md`. The added line `verified` is visible.
- **Collapse and expand.** Run `await page.getByRole("button", { name: "Collapse all" }).click()`.
  The file body hides and the button reads `Expand all`. Run
  `await page.getByRole("button", { name: "Expand all" }).click()` to restore it.
- **Change-level comment.** Run
  `await page.getByRole("textbox", { name: "Comment on the change as a whole…" }).fill("Say why VERIFY.md exists.")`,
  then press `Comment` in the sidebar:
  `await page.getByRole("button", { name: "Comment", exact: true }).click()`. A card under
  `Change-level comments` shows `<your name> · open` and the text, and the heading line now reads
  `1 open comment`.
- **Inline comment.** Click the line number of the added line in the diff. There is no stable handle
  for it (see Gotchas). An inline composer opens under the line, headed `comment · VERIFY.md:1`. Its
  textarea has no label and takes focus as it shows, with nothing clicked: the active element is
  `page.locator("textarea:not([placeholder])")`, the only textarea without a placeholder. Run
  `await page.keyboard.type("Add a trailing newline check.")` and press that composer's `Comment`
  button, the last one on the page. The comment renders under line 1 and the file header shows
  `1 comment`.
- **Comment state.** On the change-level card, run
  `await page.getByRole("button", { name: "Dismiss" }).first().click()`. The card's state reads
  `dismissed` and a `Reopen` button replaces the actions. Run
  `await page.getByRole("button", { name: "Reopen" }).click()`. It reads `open` again.
- **Mark a checkpoint.** Go back to the session and mark one. Run
  `await page.goto("<web>/sessions/<id>")`, then
  `await page.getByRole("button", { name: "Mark checkpoint" }).click()`. The button reads
  `Marking…`, then the `Checkpoints` list gains a line `<n> · user-mark`.
- **Pinned slice.** Reload the review. Run `await page.goto("<web>/changes/<change id>")`. The same
  tab reuses the slice it opened: the `<sha A> → <sha B>` line is unchanged. When the worktree has
  moved since, the page says
  `Worktree changed since this review snapshot. This patch remains pinned.`
- **Second view.** Run `mend sessions --project <project> --all --json`. The session's `review`
  object reads `"openComments": 2` and `"pendingFollowUp": false`.
- **TUI: open the review.** Run `tmux new-session -d -s mend-review -x 200 -y 50 'mend ui'`, select
  the session (`h`/`l` between panes, `j`/`k` within one), and run
  `tmux send-keys -t mend-review v`. `tmux capture-pane -p -t mend-review` shows
  ` mend / <project> / review · <harness> <id8> · checkpoint recorded`, then
  ` <branch> · worktree vs <base sha, 12 characters> · 1 files +1 −0 · 2 open`; a box
  `change description` (`No description yet — t composes one from the diff and session record.`
  until there is one, and `Mend has not read this change.` until a pass ran); the panes `files · 1`,
  `comments · 2 open` and `VERIFY.md · unified`; the line
  ` m read · g suggest · t tour · ,/. tour stops · s draft review · o web · r refresh`; and the
  footer
  ` diff · ↑↓/jk lines · n/p files · [/ ] hunks · v range · c inline · C change · d layout · w wrap · z whitespace`.
  The two web comments are listed.
- **TUI: inline comment.** In the diff pane, run `tmux send-keys -t mend-review c`. An editor titled
  `comment · VERIFY.md:1` opens with the placeholder `What should change, and why?` and
  ` ctrl+enter save · esc cancel`. Run
  `tmux send-keys -t mend-review -l 'Check the trailing newline.'`, then save with Ctrl+Enter (see
  Gotchas). The status line reads ` Inline comment added` and the comments pane reads
  `comments · 3 open`. `v` before `c` starts a range (` Range starts at line <n>`).
- **TUI: change comment.** Run `tmux send-keys -t mend-review C`. The editor is titled
  `comment · change`. Type and save as above. The status line reads ` Change comment added`.
- **TUI: comment state.** Run `tmux send-keys -t mend-review Tab` to reach the comments pane. Its
  footer reads
  ` comments · ↑↓/jk move · enter anchor · a accept/address · x dismiss · u reopen · tab pane`, and
  each row reads `<state> · <anchor>` over `You · <body>` or `Mend · <body>`. On a row, `x` sets
  ` dismissed · <anchor>` and moves that comment to the end of the list, leaving the cursor on the
  row that took its place; move to the dismissed row (`j`) before `u` sets ` open · <anchor>`; `a`
  accepts a draft or marks an open comment addressed.
- **TUI: Mend's passes.** Needs inference. Run `tmux send-keys -t mend-review m`. The status line
  reads ` Mend reads the change…`, then ` Mend reads the change · requested`, and the description
  box's last line reads `read queued`, `read running`, then `read observed · <n> drafts`. `g` asks
  for suggestions (`Draft concrete suggestions · requested`) and `t` composes the description and
  tour (`Compose description and tour · requested`).
- **TUI: leave.** `esc` returns to the dashboard; `q` quits the whole dashboard.
- **Desktop: open the Pinned Review.** Click the session's sidebar row (named
  `<harness> · <label or branch>`; see [Start a session](./start-session.md)), then run
  `await page.getByRole("button", { name: "review the change" }).click()`. It reads
  `opening Review…`, then the window's URL hash becomes `#/review/<change id>/<slice id>`, the
  heading is the branch (`page.getByRole("heading", { level: 1 })`), and the line beside it reads
  `<sha A> → <sha B> · <digest, 8 characters>`.
- **Desktop: toolbar.** The toolbar has `Unified`, `Split`, `Whitespace included` (it toggles to
  `Whitespace ignored`), the select labelled `Context` (`page.getByLabel("Context")`, options `3`,
  `10`, `25`), `← file` and `file →` with a `1/1` count, `← hunk` and `hunk →`, `← comment` and
  `comment → <n open>`, and the textbox `Search Review`. Run
  `await page.getByRole("textbox", { name: "Search Review" }).fill("nomatch")`. The diff reads
  `No matching files`. Clear it to restore `VERIFY.md`.
- **Desktop: change and file comments.** Run
  `await page.getByRole("button", { name: "Comment on change" }).click()`. A composer opens under
  `Comments & evidence`, headed `Whole change`. Run
  `await page.getByRole("textbox", { name: "Describe what you observed or want changed." }).fill("Desktop: say where VERIFY.md is read.")`
  and `await page.getByRole("button", { name: "Add comment" }).click()`. It reads `Saving…`, then
  the composer closes and `comment → <n>` counts one more. `Comment on file` opens the same composer
  headed `VERIFY.md`. A line number click opens it headed `VERIFY.md · new 1` (no handle; see
  Gotchas).
- **Desktop: comment state.** On a comment card under `Review comments`, run
  `await page.getByRole("button", { name: "Dismiss" }).first().click()`. The card's actions become
  `Reopen`. Run `await page.getByRole("button", { name: "Reopen" }).first().click()` to open it
  again.
- **Desktop: evidence.** The section `Evidence beside this file` reads `Checkpoint pair observed`,
  `VERIFY.md · +1 −0`, and the rows `From`, `To` (`<sha> · seq <n>`), `Run`, `Process` and
  `Attribution` (`unknown`). `Open terminal record at To sequence` returns to the workbench with the
  session's record replaying from that sequence.
- **Desktop: new snapshot.** Run `await page.getByRole("button", { name: "New snapshot" }).click()`.
  It reads `Creating snapshot…`, then the hash's slice id changes when the worktree moved, and the
  `<sha A> → <sha B>` line follows. Before that, a moved worktree shows
  `Worktree changed since this Review snapshot. The pinned patch below has not moved.`
- **Desktop: checkpoints.** Back on the workbench (`← Workbench`), a live session's header has
  `mark checkpoint`; it reads `marking…`. A settled PTY session with recorded output, showing
  terminal replay, lists its checkpoints under the record as buttons named
  `Replay from checkpoint <i>, seq <seq>` in the group `Replay checkpoints`. Conversation sessions
  have no checkpoint scrubber.
- **Mobile: open the review.** Run `await page.goto("<mobile-web>/session/<id>")`, then
  `await page.getByRole("button", { name: "Review the change" }).click()`. The URL becomes
  `/review/<change id>`. The screen reads `review`, the branch, and
  `checkpoint <a> → <b> · 1 file · +1 −0 · <n> open comments`. The file header reads `VERIFY.md`
  with `+1 −0` and the comment count.
- **Mobile: inline comment.** Tap the added line's text in the diff (no role or name; see Gotchas).
  A composer opens under it, labelled `VERIFY.md:1`. Run
  `await page.getByRole("textbox", { name: "Comment on this line…" }).fill("Mobile: one line is enough.")`
  and tap the `Comment` under it, the first on the screen; the change-level composer's comes later
  (`page.getByText("Comment", { exact: true }).first()`). The card under the line reads
  `<your name> · open` and the meta line counts one more open comment.
- **Mobile: change comment.** Fill
  `page.getByRole("textbox", { name: "Comment on the change as a whole…" })` under
  `change-level comments` and tap its `Comment`. A card is added above the composer.
- **Mobile: comment state.** On a card, tap `Dismiss` (`page.getByText("Dismiss").first()`). The
  card reads `<author> · dismissed` and offers `Reopen`. A draft offers `Accept` and `Dismiss`.
- **Mobile: Mend's passes.** Needs inference. Tap `Read this change` or `Suggest fixes`. The button
  reads `Queued`, then `Running…`, and an outcome line appears: `findings · queued <time>`, then
  `findings · completed <time> · <n> drafts below` (or `none`). `Compose description & tour`
  composes the description; `Tour this change →` walks it with `← Prev`, `Next →` and `End tour`.
- **Mobile: Diff.** On the session screen, tap the header button `Diff`
  (`page.getByRole("button", { name: "Diff" })`). The URL becomes `/diff/<change id>`, the heading
  `Diff` is visible, and the meta line reads
  `checkpoint <a> → <b> · <sha, 7 characters> · 1 file · +1 −0`.
- **VS Code.** `not drivable yet`: no VS Code driver in the verify stack. `Mend: Open in Mend` on
  the session opens `<web>/sessions/<id>` in a browser, where `Review the change` leads to
  `/changes/<change id>`.
- **Slack.** `not drivable yet`: no Slack driver in the verify stack. The end-of-session reply's
  `Review in Mend` button opens `<web>/changes/<change id>` in a browser.
- **Proof.** Capture the review with both comments: `await page.locator("body").ariaSnapshot()` and
  `await page.screenshot({ path })` with the heading and the `<sha A> → <sha B>` line visible. Keep
  the `mend sessions --json` output, `tmux capture-pane -p` of the TUI review screen after each key,
  the desktop Pinned Review's ARIA snapshot, and the phone's Review and Diff screens.

## Gotchas

- Diff line numbers have no accessible name and no Mend-owned handle. The diff renders inside an
  open shadow root from `@pierre/diffs`, and its line numbers carry only the library's own
  `data-column-number` attribute. Clicking a line number, or dragging across several, is the only
  way to open the inline composer. That is a finding; until it has a name, a drive has to use the
  library attribute and say so in its report. The desktop's diff uses the same library and has the
  same finding.
- The inline composer's textarea has no label (`page.locator("textarea:not([placeholder])")` finds
  it). Its `Comment` button shares its name with the sidebar's change-level `Comment` button. Scope
  by the composer's `comment · <file>:<line>` header, or take the button that appears after the
  composer opens.
- The change-level textarea has no label either; its accessible name falls back to the placeholder
  `Comment on the change as a whole…` (with a single ellipsis character).
- Sidebar file buttons are named by the path followed by its counts (`VERIFY.md +1 −0`). Diff file
  headers start with the collapse glyph `▶`, then the path, an optional `<n> comment(s)` and the
  counts. Match each with its own anchored regular expression.
- Section titles (`Files`, `Change-level comments`) are plain paragraphs, not headings or regions.
- Two links are named `session` on the review page: the breadcrumb's and the one in the line under
  the heading. Navigate to the session by URL, or scope the locator.
- `Dismiss`, `Mark addressed` and `Reopen` repeat on every comment card. In page order the sidebar's
  change-level cards come before the inline cards in the diff; scope by the comment text when there
  is more than one.
- The review page reads "nothing to review" when no session has ever been in the worktree. A
  worktree created from `New worktree` with no session has no review.
- Each browser tab pins its own slice (the key lives in `sessionStorage`). A new tab or a new
  browser context opens a new slice and may take a new `review-open` checkpoint; reuse one page to
  compare.
- No surface lets a user pick two arbitrary checkpoints as a slice, though the product model says
  any two checkpoints define one. The web and the TUI open the slice Mend pins (`review-open`) and
  `Mark checkpoint` adds a `user-mark`. The desktop routes by slice and offers `New snapshot` (a new
  slice at the worktree's current state) and replay of the record from a checkpoint, nothing else.
  The phone moves to a newer slice by itself when the session checkpoints, unless the reviewer is
  writing, and pull-to-refresh opens one at the current state. That is a product gap.
- `Read this change`, `Suggest fixes` and the description's compose action use inference on the
  requester's own login. Their results are queued passes; wait for the pass state, not a fixed
  sleep. Their findings are draft comments with evidence lines (`seq <n> · <excerpt>`), never a
  verdict.
- The dashboard needs Node 26 or newer; every other command works on Node 22.
- In the TUI review screen, `q` quits the whole dashboard; `esc`, `h` or backspace return to it. `v`
  on a session with no change answers `this session has no reviewable change yet`.
- The TUI editor saves on Ctrl+Enter only. A terminal sends a plain Enter for it unless it reports
  modified keys, and tmux forwards a modified Enter only with its `extended-keys` option on. With
  `extended-keys` off (tmux's default) `tmux send-keys C-Enter` arrives as a plain Enter and the
  editor stays open. Run `tmux set -s extended-keys on` before starting the dashboard (a tmux server
  of the run's own, so no other session is affected); then `C-Enter` saves
  (` Inline comment added`).
- The TUI's comments pane labels every person's comment `You · ` (`apps/cli/src/review.tsx:320`);
  only Mend's are told apart. That is a finding.
- `mend help ui` names `v` but none of the review screen's keys (`apps/cli/src/help.ts:282`); the
  screen's own status line and footer are the only help. That is a finding.
- The TUI review screen draws its files and comments panes at 100 columns or more. Narrower, `Tab`
  cycles only the diff and the comments.
- The TUI header counts files without a plural rule: ` 1 files`. Match it as written.
- The desktop routes with a hash: the review is `#/review/<change id>/<slice id>`, not a path.
- The desktop toolbar buttons are named by their text: `file →`, `hunk →`, `comment → <n>`. Their
  titles (`Next file (])`, `Next hunk (J)`, `Next open comment (C)`) are descriptions, not names.
  Without focus in a field, `[`/`]` move files, `j`/`k` hunks and `c` the next open comment.
- The desktop's `Comments & evidence` column hides below a 1200 px window and the file list below
  1024 px; the toolbar's `Comments & evidence` and `Files` buttons show them. The window opens at
  1512x982.
- The desktop keeps one open key per change in `localStorage`, so reopening `review the change`
  returns to the same slice until `New snapshot`.
- The desktop's comment composer has no label; its name falls back to
  `Describe what you observed or want changed.`. The instruction field has no label either; its name
  falls back to `Select comments, then assemble an editable instruction.`. Those are findings.
- The desktop Pinned Review offers no `Read this change`, `Suggest fixes` or description compose,
  and lists only people's comments written on a slice with its own diff digest: Mend's drafts are
  filtered out, so they cannot be accepted there (`commentsForComparison`,
  `apps/desktop/src/renderer/src/lib/review.ts:135`). That is a product gap. Comments the web wrote
  on a slice with another digest do not show either; compare counts with that in mind.
- The `Context` select is named by its wrapping label; use `getByLabel("Context")`.
- On the phone, the Review screen's actions (`Read this change`, `Suggest fixes`, `Send review`,
  `Compose description & tour`, `Comment`, `Cancel`, `Accept`, `Dismiss`, `Mark addressed`,
  `Reopen`), the file headers and the diff lines are pressables with no role and no label
  (`apps/mobile/src/app/review/[id].tsx`, `apps/mobile/src/components/review-comment.tsx`,
  `apps/mobile/src/components/diff.tsx`). Drive them by text. Those are findings.
- The phone's Review screen has no heading: its stack header is hidden and its title is plain text.
  The Diff screen keeps the stack header `Diff`.
- Pull-to-refresh does nothing on the phone's web build. A new slice there comes only from a newer
  checkpoint.
- A phone comment written on another slice shows `checkpoint <n> · ` before its author, below its
  file instead of on its line.
