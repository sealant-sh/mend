---
"@sealant/mend": minor
---

Hot sessions keep standby workspaces with per-person workspaces on. A standby starts in the layout
its owner's new worktrees would run in. Where they run per person, it starts as its owner: their own
Linux user, their logins written into their own home, no dotfiles at start, and its restore giving
the worktree to them and the `mend` group. Their next session in a new worktree of theirs claims it,
and the workspace's per-person preparation runs then, as a cold per-person launch's does; their
dotfiles are fetched while the standby moves onto the worktree. Where new worktrees run with one
shared home, standbys start with one shared home, as before.

A standby serves only a launch decided in the layout it started in, for its owner, in a worktree
they started: another person's session, the operator's `harnessLayout` asking for the other layout,
or a worktree that has already run per person starts cold, and is never handed a standby that would
then be stopped. Once claimed, a standby's layout stands: if Mend learns between the claim and the
launch that the image cannot run per person, the launch runs with one shared home in that standby
and says why. While the Sealant control plane cannot be asked, the pool keeps the standbys it has.
The Hot sessions card no longer says `no standby · per-person workspaces launch cold`. A database
migration records each standby's layout; standbys from before it start with one shared home, as they
did.
