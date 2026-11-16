---
"@sealant/mend": patch
---

A session that claimed a hot standby saves when you stop it. Before, if the session was read while
it was still starting (as `mend run`, `mend codex`, `mend claude` and `mend shell` do every few
seconds), the stop could stay at "saving" and then read "not saved · workspace kept", and the
container or Boat VM stayed up until you pressed "Discard unsaved and stop". Nothing was lost: the
answer that held the stop up came from the standby before your session's worktree was on it, and
Mend no longer counts such an answer as your session's unsaved work. A session already kept this way
saves without a discard: once the server runs this version, Mend tries its stop again on its own, as
it does for every kept stop, and the workspace ends.
