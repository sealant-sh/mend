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
Kubernetes or Cloudflare workspace runtime (ruled out before any launch, so none is refused to learn
it), and a Docker host that sets no-new-privileges, which a per-person workspace now checks before
it makes anyone. A remembered "no" is checked again by the next shared launch when a shared
workspace can see every reason (no `sudo`, no ACLs and the like), and after a day when a person
could not be made; a "no" from no-new-privileges, an owner map refused or Core is kept until the
image changes. Mend replaces an older shared workspace when its worktree already runs per person, or
once a per-person workspace has run on the image.

Hot sessions keep their standby workspaces wherever launches run with a shared home. Where a new
worktree would run per person, no standby can serve it (a standby starts as one person before any
worktree is known), so Mend keeps none for that person, drains the ready ones, and the Hot sessions
card says `no standby · per-person workspaces launch cold`.

A per-person workspace's first setup sends one short line per member of the organization instead of
a copy of its script per member, so an organization of any size stays far below Linux's limit on a
command's length (before, about 13 people passed it, and the Mend helper and Git transport were not
installed). A launch of a worktree with no layout reads its last capture once per capture to check
for per-person files, not on every launch.
