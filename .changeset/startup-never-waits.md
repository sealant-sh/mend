---
"@sealant/mend": patch
---

Startup never waits on an executor. The session engine's boot pass folds each unsettled row whose
processes had all ended and that no drain holds, then stands; the workspace such a session left
behind is drained after the boot, forked and as the session's owner, with the late harvest the
restart cut short. Before, a session whose stop or resume was under way when Mend was replaced (its
agent ended, its old executor still up) had its drain run inside startup, with no principal, so
every lookup read `unknown` and the drain idled for up to its ten-minute stall window while nothing
listened on the API port; the bundle restarted Mend at four minutes. Protocol pipes are rehydrated
and Service forwards re-bound forked too, and the watchers of processes that were live across the
restart run as their session's owner, so a process that ends after a restart is recorded as ended (a
watcher with no principal was refused its first lookup and retried forever).
