---
title: Review a change
description:
  Read what a session changed against its base, walk the tour, let Mend read the change, and send
  your comments back to the same session.
sidebar:
  order: 1
---

A change is what a worktree holds compared with the base it started from. Every session in the
worktree contributes to the same change, so there is one change per worktree and one review for it.
Reviewing it does not require a pull request, a commit, or origin. When you want the change on
GitHub, [land it](/guides/land-a-change/).

## Open the review

In the web app, a change's review lives at `/changes/<change-id>`. You reach it from:

- the session page, through `Review the change`;
- a worktree's `Review` link on the project page;
- the `Ready to review` section on Now, which lists completed sessions whose change has no comments
  and no follow-up in flight, one row per worktree.

In the terminal dashboard (`mend`), select a session and press `v` to review its change in the
terminal, or `o` to open it in the browser. `mend sessions` prints one line per session with what
the review found, such as the number of open comments.

## What the review shows

Opening a review takes a checkpoint of the worktree and pins a review slice between two checkpoints.
A checkpoint is a commit on a hidden ref (`refs/mend/checkpoints/…`) that never moves the session's
branch, the index, or the files, and it records the session's record position when it was taken. The
web review's slice runs from the worktree's first checkpoint, its base state, to the checkpoint
taken when you opened it, so it covers every session's work in the worktree. When the worktree has
not changed since the last review, Mend reuses that slice instead of taking a new checkpoint.

The line under the title states what you are looking at:

```text
3f2a1c0d9e11 → 91bd2e4a0c77 · 4 files · +120 −18 · 2 open comments · base main · session · observed · capture 12 · 40 s ago
```

That is the two checkpoints, the file and line counts, the unsent open comments, the session's base
ref, a link back to the session, and where Mend read the bytes. On the default captured store the
last part names the capture it read and how old it is. `partial` means the capture was not atomic
across files; the next one corrects it.

The review stays pinned to its slice. If the agent keeps working, the page says
`Worktree changed since this review snapshot. This patch remains pinned.` Comments and follow-ups
refer to the slice you actually read.

The file list is on the left. The diff is on the right, with additions and deletions marked at the
edge of each line.

To take a checkpoint yourself, use `Mark checkpoint` on the session page.

## Description and tour

The description card at the top is the tour's summary of the change, followed by the approach
`from the record` when there is one. `Tour this change →` walks the stops in the order Mend chose.
Each stop is circled in the diff, narrated, and followed by the record events it cites
(`seq 214 · pnpm test --filter api`). A stop marked `inferred reading` has no record event behind
it. Use `j` or `→` for the next stop, `k` or `←` for the previous one, and `Esc` to end.

When there is no tour yet, the card says so and offers `Compose description & tour`. When the diff
changed after the tour was composed, the card says `diff changed since` and offers `Recompose`.

## Let Mend read the change

Mend uses inference to prepare two more things, and both produce draft comments rather than
verdicts.

- `Read this change` reads the diff against the session record and drafts findings. Each finding
  cites the record events it is based on, and Mend drops any finding that cites an event it did not
  read in that pass. Zero findings is a normal outcome.
- `Suggest fixes` drafts exact replacement lines for concrete defects the change introduces. Most
  changes get none. A suggestion shows `suggested replacement` with the lines, or
  `suggested: delete these lines`.

Each pass reports its state in one line under the header, so a pass that never ran and one that
found nothing never look the same:

```text
suggestions · queued 10:42:01
findings · running · started 10:42:05
suggestions · completed 10:43:10 · none
findings · completed 10:43:22 · 2 drafts below
findings · failed 10:43:30 · <the error's own words>
```

`queued` means the pass is waiting for a worker and nothing is running yet. Only one pass of each
kind runs per change at a time. A request made while one is queued or running is dropped, and the
pass reads the change as it is when it starts, so nothing is lost. A tour requested for a diff the
current tour was already composed from is skipped without an inference call. A worker runs up to
three passes at once.

### When passes run by themselves

When a session settles (its agent ends or stops), Mend can compose the tour and run the suggestion
pass so the review opens with them ready. The switches are in the project's setup under
`Review automation`: `Description & tour`, `Suggest fixes`, and `Name the session`, each `inherit`,
`on`, or `off`. `inherit` follows the defaults in Settings, where all three are on. An empty change
queues nothing. A session started from Slack always gets a tour, because the tour's summary is the
thread's end-of-session reply. `Read this change` only runs when someone asks for it.

### Whose account pays

Passes over a change run on the connected Claude or Codex subscription of the owner of the change's
session, never the operator's. Mend ships no model keys. See
[provider accounts](/guides/provider-accounts/). Every exchange and tool call is recorded on the
server.

## Comment

Comment on a line by clicking its line number in the diff, or on a range by dragging across line
numbers. Comment on the change as a whole in `Change-level comments` below the file list.

Comments have states, and Mend's drafts are comments too:

| State                    | Actions                                               |
| ------------------------ | ----------------------------------------------------- |
| `draft` (from Mend)      | `Accept` makes it an open comment, `Dismiss` hides it |
| `open`                   | `Mark addressed`, `Dismiss`                           |
| `addressed`, `dismissed` | `Reopen`                                              |

A comment that has been sent to the session reads `sent to session` and settles through the
follow-up.

## Send the review back to the session

`Send review to session` collects the open comments that have not been sent and assembles them into
one instruction for the agent: each comment's file and line, the comment, and any proposed
replacement, with a request to keep working on the same branch and to report what it did not do.
Choose which comments to include and edit the instruction before sending. What you send is exactly
what the session receives.

`Deliver to session` saves the follow-up first, then starts the agent again in the same session and
worktree, with the instruction as its first message. Only the selected comments are marked sent.

If the agent is still live, the follow-up stays pending. The session page and the review show
`follow-up pending` and `the session is live — this bundle remains pending`, with `Deliver` once the
agent has stopped. From the terminal, `mend continue` resumes the newest session with a pending
follow-up, or the one you name:

```sh
mend continue
mend continue 3f2a
```

A delivery that failed shows `delivery failed · retryable` and offers `Retry delivery`, which reuses
the same follow-up unless you edit it.

Only the session's owner can send a review to it, unless they turned on shared control. Anyone else
who can see the project can still read the review and leave comments.

A follow-up is recorded as sent by the person who sent it. That matters for
[automatic landing](/guides/land-a-change/#automatic-landing), which only lands turns the change's
owner sent.

## Review in the terminal

Pressing `v` in the dashboard opens the same review in the terminal: the files, the diff, the
comments, and the tour, with the same passes and the same follow-up.

| Key             | Action                                                               |
| --------------- | -------------------------------------------------------------------- |
| `tab`           | move between the files, diff and comments panes                      |
| `j` / `k`       | move by line, file or comment, depending on the pane                 |
| `n` / `p`       | next or previous file                                                |
| `]` / `[`       | next or previous hunk                                                |
| `c`             | comment on the selected line                                         |
| `v`             | start or clear a range, then `c` comments on it                      |
| `C`             | comment on the change as a whole                                     |
| `a` / `x` / `u` | in the comments pane: accept or mark addressed, dismiss, reopen      |
| `s`             | assemble the open comments into an instruction, edit it, and send it |
| `y`             | deliver or retry the pending follow-up                               |
| `t`             | compose or recompose the description and tour                        |
| `,` / `.`       | previous or next tour stop                                           |
| `m`             | Mend reads the change                                                |
| `g`             | draft suggestions                                                    |
| `d` / `w` / `z` | split or unified layout, wrap, show whitespace                       |
| `r`             | refresh                                                              |
| `o`             | open the review in the browser                                       |

## Other clients

The desktop app has a review view and the Land panel. It has no published release yet; see
[desktop](/clients/desktop/). The mobile app has a review screen with the tour, comments, and
sending, and it is not distributed.

## Next

[Land the change](/guides/land-a-change/) to push it to origin and open a pull request, or
[pull it](/guides/land-a-change/#pull-a-change-into-your-own-clone) into your own clone.
