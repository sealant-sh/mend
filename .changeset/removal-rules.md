---
"@sealant/mend": minor
---

Removing a worktree or a project follows one rule set, and every client reads one refusal. A refusal
is a 409 `RemovalRefused` that lists every blocker at once: a live session, a process or Service
still running, a workspace still saving, a change not on origin, repositories nested in the
worktree, a session of another project holding it, declared resources, or another removal under
way. Only the change's owner, the person whose session started the worktree, removes it; anyone
else, an organization owner included, gets a 403 `RemovalForbidden` that names the owner. Force
lifts only work that is not on origin, never running or unsaved work. In a project with no origin,
work past the base is refused as on no remote.

Removing a project no longer stops its sessions and Services. It is refused while any worktree,
whoever started it, has a session live, a workspace saving or a change not on origin, and the
refusal names each worktree and whose work it is. There is no force for a project. The web app
shows a refused project removal instead of dropping it.

The worktree stores its change owner (migration 0164), so deleting the first session no longer
hands the change, and the right to land it, to whoever owns the next one. While a removal checks or
deletes, a session cannot start in that worktree or project (`RemovalInProgress`).

T3 Code can now delete a thread's worktree and remove a project, behind its own confirm dialogs, and
Mend's refusals apply. The gateway never passes T3 Code's force on.
