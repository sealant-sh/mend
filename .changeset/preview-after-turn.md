---
"@sealant/mend": patch
---

A protocol session's preview starts after a turn that changed the worktree, in a project whose
`mend.toml` names a `[preview]`, unless something already runs it (ADR 0017 delivery step 10a). It
runs setup when its fingerprint changed, then the recipes the Service depends on, then the Service,
from the file as the turn left it and as the turn's sender. A question starts nothing, a changed
turn followed by a question still starts it once, a person's Stop holds (during setup too), a
running preview is left alone unless the turn changed its command, `cwd`, `env` or `depends`, which
starts it again, and one automatic start of a preview runs at a time across sessions and API
processes. `GET /worktrees/:id/previews` now returns each preview's status lines, such as
`preview · web · answered HTTP 200 · observed 4 s ago` or
`preview not prepared · web · setup failed`, and the worktree's own line when a turn's change was
not captured. A session that ended before its turn was prepared is not started. Migration
`0165_preview_preparations` marks every turn that already ended as decided, so nothing old starts
after the upgrade.
