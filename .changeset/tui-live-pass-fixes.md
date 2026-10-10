---
"@sealant/mend": patch
---

The dashboard's session pane names a session's running Services again. It read `GET /services` as a
flat list of Services, while the server answers one view per Service with the Service nested inside
it, so every session said `no services running`. `mend service list` and the dashboard now read the
same view the same way. The harness picker for a new session in an existing worktree says the
session joins that worktree, where it said `new worktree`, and the new-worktree form's base hint
stays inside the form's border.
