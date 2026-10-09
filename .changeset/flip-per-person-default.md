---
"@sealant/mend": minor
---

Per-person workspaces are on by default: `MEND_HARNESS_LAYOUT` is `person` unless set, so each
person who runs anything in a new worktree's workspace gets their own Linux user and home, and
everything they run runs as them, on their own logins. An operator who wants new worktrees on one
shared home sets `MEND_HARNESS_LAYOUT=shared`; a worktree that has run per person stays per person
whatever the setting. A new worktree whose image cannot run per person (nix, no `sudo`) still runs
with one shared home, and the session says why. While the setting is `person`, Hot sessions keep no
standby workspace, since a standby starts as one person and never serves a per-person launch; every
launch starts cold and the server log says `warm skipped`.
