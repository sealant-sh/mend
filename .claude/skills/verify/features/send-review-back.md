# Send review back to the session

Review comments go back to the session that made the change. On the review page the user picks the
open comments to send, reads and edits the instruction Mend assembles from them, and delivers it:
the session resumes in the same worktree with that instruction as its first message. A session that
is running when the review is sent keeps the bundle pending, and the user delivers it later from the
web or with `mend continue`.

## Sub-features

- `send-open` opens `Send review to session` once the change has open comments that were not sent.
- `send-select` picks which open comments go; the instruction is reassembled from the selection.
- `send-edit` edits the instruction before sending; what is sent is what the session receives.
- `send-deliver` delivers to a settled session, which resumes with the instruction.
- `send-pending` keeps the bundle pending when the session is live, and says so on the session and
  review pages.
- `send-continue-cli` delivers the pending bundle from the terminal with `mend continue` and
  attaches.
- `send-sent-state` marks delivered comments `sent to session`.

## How to get to it (user POV)

- Web: on the review page (`/changes/<id>`), the `Send review to session` button beside the heading.
- Web: on the session page and the review page, the pending follow-up line (`follow-up pending`)
  with its `Deliver` button once the session is no longer live.
- Web: the Now page and the Worktrees tab append `· follow-up pending` to a session's facts.
- CLI: `mend continue [session-id]`. With no id, the newest session with a pending follow-up in the
  current directory's project is taken.
- CLI: in the dashboard's review screen (`mend ui`, `v`), `s` opens the send editor and `y` delivers
  and relaunches.
- Mobile: the Review screen's comments and follow-up. Desktop: the review beside each session. Not
  driven by this map.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser is signed in as the session's owner, and
  `mend connect claude` has been run.
- A claude session in `<project>` made a change and has settled. Start it with
  `mend claude "Create NOTES.md with one line: hello." --name verify-send --project <project> --detach`
  and note its id `<id>`. Watch its page until the agent has answered, then run `mend stop <id8>`
  and wait until `mend sessions --project <project> --all --json` shows it `stopped`. An interactive
  harness session settles only when its process exits, not when the agent finishes answering.
- Its change has at least two open, unsent comments, so one can be unchecked and one still sent (see
  [Review the change](./review-change.md)).

- **Open the send dialog.** On the review page, choose `Send review to session`. Run
  `await page.getByRole("button", { name: "Send review to session" }).click()`. An overlay titled
  `Send review to the session` opens, with `<n> of <n> comments selected · resumes <branch>` under
  the title and one checked checkbox per open comment.
- **Narrow the selection.** Uncheck one comment. Run
  `await page.getByRole("checkbox", { name: /<comment text>/ }).uncheck()`. The count reads
  `<n-1> of <n> comments selected` and the instruction no longer lists that comment.
- **Edit the instruction.** The instruction textarea follows the paragraph
  `Instruction — edit before sending`. Append a line to it (see Gotchas for the handle). The text
  under it reads `persisted before launch; what you send is verbatim what the session receives`.
- **Deliver to a settled session.** Run
  `await page.getByRole("button", { name: "Deliver to session" }).click()`. The button reads
  `Delivering…`, then the overlay says `Follow-up delivered` and
  `Mend persisted the new run and marked only the selected comments sent.` Choose `Done`.
- **Sent state.** The delivered comments' cards read `<author> · sent to session`; the unchecked one
  still reads `open`, and the heading line's open-comment count drops.
- **Session resumed.** Go to `<web>/sessions/<id>`. The status reads `Running · recording` again,
  and the terminal or record shows the delivered instruction as the new first message.
- **Pending while live.** While that session runs, add a comment on the review and send it again
  with `Send review to session` and `Deliver to session`. The overlay says
  `Follow-up saved pending`. The review page and the session page show `follow-up pending` and
  `the session is live — this bundle remains pending`.
- **Second view.** Run `mend sessions --project <project> --json`. The session's
  `review.pendingFollowUp` is `true`.
- **Continue from the CLI.** Stop the agent, then deliver the pending bundle. Run `mend stop <id8>`,
  then `mend continue <id>` in its own PTY. Stdout shows `✓ follow-up for session <id8> · <branch>`,
  `  instruction:` followed by the instruction's first lines, each prefixed with two spaces, `│` and
  a space, then `✓ recording · delivered to run <run id>` and `  watch · <web>/sessions/<id>`, and
  the terminal attaches. Detach with `Ctrl+]`.
- **Nothing pending.** Run `mend continue <id>` again after delivery. Exit code `1` and stderr reads
  `mend: session <id> has no pending follow-up`.
- **Proof.** Capture the overlay before delivery (selection count and instruction visible), the
  delivered state, and the session page after it resumed:
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` for each. Keep
  the `mend sessions --json`, `mend continue` and `mend stop` transcripts.

## Gotchas

- The send overlay is a plain `div`: it has no `role="dialog"` and no accessible name. Wait for the
  text `Send review to the session`, not for a dialog role. That is a finding.
- The instruction textarea has no label; the paragraph `Instruction — edit before sending` above it
  is not associated with it. It is the only textarea inside the overlay. That is a finding.
- Errors inside the overlay are plain text
  (`delivery failed before membership finalized · retry uses the same key unless you edit`), not
  `role="alert"`.
- Each comment checkbox is named by its whole row: `<file>:<line> · <body>`, or
  `whole change · <body>` for a change-level comment. Match on the comment text with a regular
  expression.
- `Send review to session` is disabled with no open, unsent comments, and absent for a viewer who
  cannot steer. For a session whose agent runs in a terminal, only its owner sends: everyone else
  reads `Comments stay here.` and an owner-only line.
- Delivery resumes the agent with the instruction as its first message. Drive it with a `claude` or
  `codex` session; this map has not established what delivery does for a `mend run` session.
- `mend continue` attaches the terminal after delivery. Run it in its own PTY, and stop the session
  afterwards by its id.
- A bundle edited after a failed delivery gets a new idempotency key; retrying an unedited one
  reuses the key (`Retry delivery`, `Check delivery`). Do not count a retry as a second delivery.
