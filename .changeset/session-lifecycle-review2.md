---
"@sealant/mend": patch
---

A session's executor is on its row from the moment the platform accepts it, before any setup
command, relocation, install or harness runs in it. A launch that fails after that (a custom setup
command that exits non-zero, a relocation, the harness PTY) drains the executor instead of stopping
it outright, keeps holding removal and the worktree until its end is observed, and settles `failed`
with the launch's own words. A lease that still names a session with no workspace on its row (a
launch cut short around its create) holds removal and the worktree too, lapsed or not.

A restart serves the channel of every session a worktree lease names, so an owner that stopped while
a joined session still works keeps shipping. A relaunch whose opening prompt no process took after a
restart launches again, or keeps the prompt and says `opening prompt not delivered · …`; the plan
clears only once a turn with its correlation is accepted or the owner stops.

Nothing reads `saved` from a capture's kind any more: only the executor's own `complete: true` for
that executor and epoch, or the store's sealed record of it. An executor stopped outside Mend whose
final capture registered without either reads
`stopped outside Mend · last saved capture 21 at … · completion unknown`. A landing waits for a
small snapshot that read everything: a failing small snap, an unreadable path or a small refusal
hold it, however empty the queue; a failing bulk snap does not. An agent whose executor never
answered reads `executor not answering · … · completion unknown`, never the harness's `completed`.
The planned drain ahead of a platform's cap counts back from `workspace.runtimeDeadline()` once the
SDK has it, and every drained stop tells Core the completion the store sealed.

Every capture-mode executor create carries an idempotency key written on the session before the
create is asked (migration 0082). A create whose answer was lost, in the launch or across a restart,
is found by that key once the SDK can look (Core's next SDK): the executor goes on the session and
drains, or, when none was made, the worktree is free again. The executor's runtime identity comes
from the create's `launch.runtime`, else `workspace.runtime()`.
