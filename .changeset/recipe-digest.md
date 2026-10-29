---
"@sealant/mend": minor
---

A recipe now has a digest: a hash of its command, `cwd`, `env`, each dependency's own digest and the
`[setup]` it runs, never its port, `ready`, `host`, `address` or `browserScheme`. The session
owner's Start of a recipe approves the digest of every recipe in its plan, for that owner only. Any
other start (Mend's own after an executor replacement, a steerer's restart, anyone but the owner)
runs only what the session's owner approved, as one graph: each command, each dependency at the
digest it was approved with, and the `[setup]` they all name. A recipe a turn changed since runs at
its approved version and says `web · recipe changed · the owner's Start runs it`. A recipe never
approved, a dependency approved again on its own, approvals that name different setups, or a running
dependency that is not the approved version is refused with words, and a running Service is never
stopped to make room. A restart is decided by what launched the attempt it replaces. The agent's own
start runs the file and approves nothing. An executor replacement starts each recipe again as the
person who last started it. `GET /sessions/:id/declarations` shows each recipe's digest and whether
it is approved, and `mend service restart` says when a restart ran the approved version. After
upgrading, an automatic start of a recipe is refused until its owner starts it once.
