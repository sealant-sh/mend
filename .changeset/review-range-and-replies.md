---
"@sealant/mend": minor
---

A review can now cover a chosen range of checkpoints, start where you last sent comments, and a
person can reply to a comment. The agent's answer to comments you sent shows under each of them.

- `POST /api/changes/:id/reviews/open` takes an optional `range: { from, to? }`. `from` is `base`
  (the whole change), `last-review` (the checkpoint where you last sent comments on this change,
  else the base) or a checkpoint of the change's worktree; `to` is a later checkpoint, or left out
  for the change as it stands now. A range Mend can't open answers 422 `ReviewRangeRefused` with a
  `reason`. The answer adds `range.kind` (`whole`, `since-last-review` or `custom`) and
  `lastReview`. With no range, a review opens exactly as before.
- A review that starts after the base lists the whole change's files it doesn't touch as
  `unchangedInRange`.
- `POST /api/changes/:id/comments/:commentId/replies` keeps a reply one level under a comment. A
  reply goes to the agent with the next comments you send, like any comment.
- `GET /api/changes/:id/comments` lists each comment with its `replies`, the agent's `answers` (the
  turn a send started, its last message, and whether the code the comment points at changed, at
  which checkpoint), and `sentInTurn`. Replies are never listed as comments, so older clients see
  only comments, as before. With `?sliceId=`, each comment also says where it now sits on that
  review (`placement`): the same lines, moved lines, the lines that replaced its own, or no longer
  placed.
