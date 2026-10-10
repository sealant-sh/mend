---
"@sealant/mend": patch
---

Removing a workspace SSH key (`mend ssh keys remove`, Settings → Workspace SSH) says what happens to
the connections already open with it. On a platform that ends them, they end within a minute. On one
that cannot, they stay open until you stop your running sessions. The removal then lists those
sessions: the CLI prints `mend stop` for each, and Settings offers to stop them all. The docs now
say that the published SSH port has no limits before login on the platform this release runs.
