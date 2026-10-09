# Review the change

The change is the worktree against its base, and the review page is where a user reads it: the diff
first, the changed files beside it, comments on a line, a range or the whole change, and the
checkpoints that pin what was reviewed. Opening a review pins a slice between two checkpoints, so
the patch and every comment on it stay anchored even when the worktree moves on. Mend can read the
change and draft comments or suggestions on request; those are drafts with evidence, never verdicts.

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
- `review-cli` reviews the same change in the terminal from the dashboard.

## How to get to it (user POV)

- Web: on a session page (`/sessions/<id>`), the `Review the change` link.
- Web: on a project's Worktrees tab, the `Review` link on a worktree that holds a change.
- Web: on the Now page, a card under `Ready to review`, or the `Review` link on a project's session
  row.
- Web: the review lives at `/changes/<change id>`.
- CLI: in the dashboard (`mend ui`, or bare `mend`), select a session and press `v` to review its
  change; `o` opens it in the browser.
- CLI: `mend sessions` prints each session's review facts; `mend sessions --all --json` (or
  `--project <p> --json`) carries `review.openComments` and `review.pendingFollowUp`. Bare `--json`
  lists live sessions with `review` null.
- Mobile: the Review and Diff screens. Desktop: the review beside each session (`Search Review`,
  `Next file (])`, `Next hunk (J)`). Not driven by this map.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and the browser is signed in.
- A settled session in `<project>` changed one file: run
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'` (see
  [Start a session](./start-session.md)) and note its session URL `<web>/sessions/<id>`.
- The change has no comments yet.

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
  for it (see Gotchas). An inline composer opens under the line, headed `comment · VERIFY.md:1`,
  with focus in its textarea. Run `await page.keyboard.type("Add a trailing newline check.")` and
  press that composer's `Comment` button. The comment renders under line 1 and the file header shows
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
- **CLI review.** Run `mend ui` in its own PTY, select the session, and press `v`. The review screen
  opens with the footer
  ` diff · ↑↓/jk lines · n/p files · [/ ] hunks · v range · c inline · C change · d layout · w wrap · z whitespace`,
  and the two open comments are listed. Press `q` to quit.
- **Proof.** Capture the review with both comments: `await page.locator("body").ariaSnapshot()` and
  `await page.screenshot({ path })` with the heading and the `<sha A> → <sha B>` line visible. Keep
  the `mend sessions --json` output and a capture of the CLI review screen.

## Gotchas

- Diff line numbers have no accessible name and no Mend-owned handle. The diff renders inside an
  open shadow root from `@pierre/diffs`, and its line numbers carry only the library's own
  `data-column-number` attribute. Clicking a line number, or dragging across several, is the only
  way to open the inline composer. That is a finding; until it has a name, a drive has to use the
  library attribute and say so in its report.
- The inline composer's textarea has no label; it takes focus when it opens, so type into the
  focused element. Its `Comment` button shares its name with the sidebar's change-level `Comment`
  button. Scope by the composer's `comment · <file>:<line>` header, or take the button that appears
  after the composer opens.
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
- There is no control, web or CLI, for picking two arbitrary checkpoints as a slice. The review
  opens the slice Mend pins (`review-open`); `Mark checkpoint` adds a `user-mark`. The product model
  says any two checkpoints define a slice; the web and CLI surfaces do not offer that choice yet.
  The desktop app routes its review by slice (`/review/<change>/<slice>`) and replays the record
  from a checkpoint; this map does not drive it.
- `Read this change`, `Suggest fixes` and the description's compose action use inference on the
  requester's own login. Their results are queued passes; wait for the pass state, not a fixed
  sleep. Their findings are draft comments with evidence lines (`seq <n> · <excerpt>`), never a
  verdict.
- The CLI dashboard needs Node 26 or newer; every other command works on Node 22.
