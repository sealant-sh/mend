---
"@sealant/mend": minor
---

Per-person workspaces are on by default: `MEND_HARNESS_LAYOUT` is `person` unless set (an empty
value counts as unset), so each person who runs anything in a new worktree's workspace gets their
own Linux user and home, and everything they run runs as them, on their own logins. This includes a
loopback server on the capture store, the default `mend server setup`. An operator who wants new
worktrees on one shared home sets `MEND_HARNESS_LAYOUT=shared`; a worktree that has run per person
stays per person whatever the setting.

Where a workspace cannot run per person, a new worktree runs with one shared home and the session
says why: a nix image, an image without `sudo`, an image Core reports it cannot run that way, a
Kubernetes workspace runtime (no one's `sudo` works under `allowPrivilegeEscalation: false`), and a
Docker host that sets no-new-privileges, which a per-person workspace now checks before it makes
anyone. Mend no longer probes over an answer it already has: a shared workspace's check of an image
fills in only what nobody knew, and Mend replaces an older shared workspace only on an answer a
per-person workspace gave.

Hot sessions keep their standby workspaces wherever launches run with a shared home. Where a new
worktree would run per person, no standby can serve it (a standby starts as one person before any
worktree is known), so Mend keeps none for that person, drains the ready ones, and the Hot sessions
card says `no standby · per-person workspaces launch cold`.

A per-person workspace's first setup sends one short line per member of the organization instead of
a copy of its script per member, so an organization of any size stays far below Linux's limit on a
command's length (before, about 13 people passed it, and the Mend helper and Git transport were not
installed). A launch of a worktree with no layout reads its last capture once per capture to check
for per-person files, not on every launch.
