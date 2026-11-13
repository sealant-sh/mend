# Standby workspaces: mount the parent, bind the worktree at claim

Status: accepted 2026-09-02; built in #195 and #196. Since captures became the default (ADR 0002,
#235), the mount and bind apply only to the deprecated co-located store, and captured workspaces get
no linked projects (ADR 0011). Cross-repo: sealantd (bind operation, boot), sealant (standby source,
bindable mounts, `workspace.bind`), Mend (hot pool, linked projects).

## Context

Mend keeps a per-project pool of ready workspaces so a session attaches instantly. Neither Docker
nor Kubernetes can add a mount to a running container, and Sealant fixes every mount at
`workspaces.create`, so a pooled workspace had to be a complete session skeleton: a pre-generated
session id, a git worktree created ahead of time, and a workspace with that worktree mounted at
`/workspace/repo`. A claim could only become a brand-new worktree. Joining an existing worktree,
resuming, and rejoining always went cold, every skeleton spent a worktree and a worktree row, and
every settings change drained and rebuilt containers. The platform feedback of 2026-08-20 asked for
either a standby shape or a re-pointable mount; this decides both.

## Decision

A **standby workspace** mounts a caller-owned **root** directory (the project's worktrees directory)
at a hidden path instead of one worktree at `/workspace/repo`. The working directory does not exist
until Mend **binds** it: at claim, Mend creates or picks the worktree on the host and asks sealantd
to point `/workspace/repo` at the matching subdirectory of the root. The bind is a symlink inside
the container plus a git `safe.directory` entry for the real path; sealantd records it and
re-applies it on restart, and sealant records it on the workspace so a relaunch passes it at boot.

The same shape generalises to any extra mount: a mount declared **bindable** mounts its host path as
a root at a hidden path, and its declared `mountPath` becomes a symlink bound later. Mend uses this
for **linked projects**: a per-project setting that mounts another adopted project's worktrees root
read-write and binds one of its worktrees at `/workspace/repos/<name>`, so a session in one
repository can work in a sibling repository. Linked projects are distinct from references, which are
read-only clones of external repositories meant for reading, and from project mounts, which are
arbitrary host folders and so cannot exist on a cluster.

Pool entries keep a pre-generated session id: the harness home and session socket directory stay
keyed by it and are mounted at provision, exactly as before. Only the worktree, and any linked
project's worktree, moves from provision to claim.

## Considered options

- **Pre-mounted empty slots.** kubelet creates a missing subPath and git populates an existing empty
  directory, so a skeleton could pre-mount a not-yet-existing worktree directory. Cheaper to build,
  but it still cannot serve joins or resumes, which are the cases that hurt.
- **A re-point operation on the runtime.** Impossible: a running container's mount set is fixed on
  both Docker and Kubernetes. Every "re-point" is really "mount the parent, switch a link inside".
- **Mount the whole store.** One root would serve every project, but a standby container would then
  see every project's worktrees and every session's harness home, which holds credentials and
  transcripts. The root is the project's worktrees directory, nothing above it.

## Consequences

- A standby container sees every worktree of its project, including other sessions' uncommitted work
  in that repository. Accepted: a project is one team's repository and already shares environment
  and secrets across its sessions. Harness homes stay outside the root and private.
- The pool serves new worktrees and named joins hot. No skeleton creates a worktree ahead of time,
  and nothing worktree-shaped enters the pool fingerprint. Resumes and rejoins still go cold: a
  session's harness home is keyed by its id and mounted at provision, so a pooled workspace holds
  the pre-generated id's home, not the resumed session's. Serving those hot needs the harness home
  to follow the session rather than the id, a separate change.
- The reviewable change is unchanged: it is still the session's worktree versus its base. Writes to
  a linked project land in that project's worktree and are its own change, not this session's.
- git's `safe.directory` must name the real path behind the symlink; the image's fixed entry for
  `/workspace/repo` is no longer sufficient on its own.
