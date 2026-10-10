# Send review back to the session

Review comments go back to the session that made the change. On the review page the user picks the
open comments to send, reads and edits the instruction Mend assembles from them, and delivers it:
the session resumes in the same worktree with that instruction as its first message. A session that
is running when the review is sent keeps the bundle pending, and the user delivers it later from the
web, with `mend continue`, from the dashboard, or from the phone. The desktop's Pinned Review sends
the same way; the dashboard and the phone send every open comment at once.

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
- `send-tui` sends from the dashboard's review screen (`s`) and delivers a pending bundle (`y`).
- `send-desktop` selects, assembles and delivers from the Pinned Review's `Follow-up instruction`.
- `send-mobile` sends from the phone's Review screen (`Send review`) and delivers a pending bundle
  (`Deliver & relaunch`, `Deliver follow-up`).

## How to get to it (user POV)

- Web: on the review page (`/changes/<id>`), the `Send review to session` button beside the heading.
- Web: on the session page and the review page, the pending follow-up line (`follow-up pending`)
  with its `Deliver` button once the session is no longer live.
- Web: the Now page and the Worktrees tab append `· follow-up pending` to a session's facts.
- CLI: `mend continue [session-id]`. With no id, the newest session with a pending follow-up in the
  current directory's project is taken.
- TUI: in the dashboard's review screen (`mend ui`, `v`), `s` opens the send editor with the
  assembled instruction and Ctrl+Enter delivers it; `y` delivers a pending bundle again. The
  dashboard's session pane says `follow-up pending`.
- Desktop: in the Pinned Review (`review the change` on a session tab), the `Follow-up instruction`
  section of `Comments & evidence`.
- Mobile: the Review screen's `Send review`, and its follow-up panel's `Deliver & relaunch`; the
  session screen's header button `Deliver follow-up` while a bundle waits.
- VS Code: none.
- Slack: none. `@mend <prompt>` in a session's thread is a follow-up turn, not a review send.

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
- TUI, desktop and mobile steps: the harnesses from [Start a session](./start-session.md). Each
  surface's delivery needs open, unsent comments of its own and a settled session again: add
  comments on that surface and `mend stop <id8>` between surfaces.

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
- **TUI: send.** In the dashboard's review screen for the change (see
  [Review the change](./review-change.md)), with open, unsent comments, run
  `tmux send-keys -t mend-review s`. An editor titled `send review to session · edit before sending`
  opens, holding the instruction assembled from every open, unsent comment, over
  ` ctrl+enter save · esc cancel`. Edit it, then press Ctrl+Enter (see Gotchas). The status line
  reads ` Follow-up delivery requested · retry keeps the same run`. With nothing to send, `s`
  answers ` No unsent open comments — accept a draft or write a comment first`.
- **TUI: deliver a pending bundle.** While a bundle is pending, the description box ends with
  ` · follow-up pending` and the status line adds ` · y deliver & relaunch`. Stop the agent
  (`mend stop <id8>`), then run `tmux send-keys -t mend-review y`. The status line reads
  ` Delivering the persisted Review bundle…`, then
  ` Delivery reconciled · the same idempotency key names one run`. With nothing pending, `y` answers
  ` No retryable follow-up — s assembles the open Review comments first`. Back in the dashboard
  (`esc`), the session pane's comment line reads
  `<n> open comments · follow-up pending · v reviews the change` while one waits.
- **Desktop: select and assemble.** In the Pinned Review, the section `Follow-up instruction` lists
  one checkbox per open comment, none checked, and reads `0 selected`. Run
  `await page.getByRole("checkbox", { name: /<comment text>/ }).check()`. It reads `1 selected`. Run
  `await page.getByRole("button", { name: "Assemble selected comments" }).click()`. The textarea
  (named by its placeholder `Select comments, then assemble an editable instruction.`) fills with
  the instruction; edit it there.
- **Desktop: deliver.** Run
  `await page.getByRole("button", { name: "Deliver to session" }).click()`. It reads `Delivering…`,
  then a line reads `delivered · run <run id>`, or `bundle pending · the session is active` while
  the agent runs. A failure reads the server's words or `delivery failed · retryable`, and the
  button then reads `Retry delivery` (`Check delivery` while one is in progress). `Copy` copies the
  instruction.
- **Mobile: send.** On the phone's Review screen (`<mobile-web>/review/<change id>`), tap
  `Send review` (`page.getByText("Send review", { exact: true })`). A dialog opens
  (`page.getByRole("dialog")`) reading `Send review to the session`,
  `assembled from <n> comments · resumes <branch>`, `Instruction — edit before sending`, the
  instruction in a textarea, and
  `assembled mechanically from your comments; edit freely — what you send is verbatim what the session receives`.
  Edit the textarea (the only one in the dialog), then tap `Send to session`. It reads `Sending…`,
  then `Review delivered` with
  `The session accepted the instruction. The comments stay open until the work addresses them.`, or,
  while the agent runs, `Follow-up saved for the session` with
  `The instruction is pinned to this Review. Deliver it from the session once the current agent stops.`
  Tap `Done`.
- **Mobile: deliver later.** With a bundle pending, the Review screen shows a panel
  `follow-up · pending` with the instruction's first lines, and `Deliver & relaunch` once the
  session has stopped (`the session is live — deliver after it stops` before then). The session
  screen's header has the button `Deliver follow-up`
  (`page.getByRole("button", { name: "Deliver follow-up" })`). Tap either. The button reads
  `delivering…` or `Delivering the follow-up…`, and the panel's status moves on.
- **VS Code and Slack.** Not a surface for this feature.
- **Proof.** Capture the overlay before delivery (selection count and instruction visible), the
  delivered state, and the session page after it resumed:
  `await page.locator("body").ariaSnapshot()` and `await page.screenshot({ path })` for each. Keep
  the `mend sessions --json`, `mend continue` and `mend stop` transcripts, the TUI review screen
  after `s` and after `y`, the desktop `Follow-up instruction` section before and after delivery,
  and the phone's dialog and follow-up panel.

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
  `codex` session. Delivering to a `mend run` session fails: the web overlay reads
  `delivery failed · retryable`, `Retry delivery` and
  `Harness "run" has no known follow-up command.`, the desktop reads the same words, and no comment
  is marked sent.
- `mend continue` attaches the terminal after delivery. Run it in its own PTY, and stop the session
  afterwards by its id.
- A bundle edited after a failed delivery gets a new idempotency key; retrying an unedited one
  reuses the key (`Retry delivery`, `Check delivery`). Do not count a retry as a second delivery.
- The dashboard and the phone send every open, unsent comment; neither lets the user choose
  (`openSendEditor`, `apps/cli/src/review.tsx:886`; `SendReviewModal`,
  `apps/mobile/src/app/review/[id].tsx:421`). Only the web and the desktop select. That is a product
  gap.
- The TUI editor saves on Ctrl+Enter only; see [Review the change](./review-change.md) for the tmux
  caveat. Unlike the web overlay, `s` and Ctrl+Enter deliver at once; there is no separate `Deliver`
  step.
- The desktop starts with nothing selected; the web overlay starts with every open comment checked.
  Each desktop checkbox is named by its wrapping label: the comment's location (`VERIFY.md · new 1`,
  `Whole change`) followed by its body. Match the body with a regular expression.
- The desktop's instruction textarea is named only by its placeholder
  (`Select comments, then assemble an editable instruction.`). That is a finding. Without steering,
  `Deliver to session` is absent and the section reads
  `Only this session's owner delivers to it, unless they share control. Copy the instruction to hand it over.`
- The phone's send dialog has the `dialog` role but no name, and its instruction textarea has no
  label and no placeholder, so no name at all (`apps/mobile/src/app/review/[id].tsx:443`, `:483`).
  `Send review`, `Send to session`, `Cancel`, `Done` and `Deliver & relaunch` are pressables with no
  role. Those are findings.
- The phone's follow-up panel reads `deliver with mend continue from a terminal` for a bundle it
  cannot deliver itself (one from before pinned Review).
