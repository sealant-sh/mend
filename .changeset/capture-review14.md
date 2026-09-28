---
"@sealant/mend": patch
---

A recovery boot or an executor's own restart no longer waits on Mend verifying a capture it never
restores. Before, a host fault on the Mend server (a full disk, a killed git) left a crashed
executor's recovery unable to ship its staged captures until the fault cleared. Only a plan that
lays the head down (a fresh launch, a resume or a claimed standby) checks it now.

If git rejects the head's content, the launch is refused and the session reads
`launch blocked · capture <n>'s git section failed verification · discard or contact the operator`.
Mend no longer plans an older capture in its place, which the executor could not restore. A commit
whose parent is missing now counts as a content rejection, and a check that keeps failing with the
same unexplained git words is recorded `failed` after five tries instead of waiting forever.

The `launch waiting · …` and `launch blocked · …` words are added beside the session's summary
instead of replacing it, so `executor lost · …` is kept until the replacement answers. Words from a
launch the session has moved on from are ignored.
