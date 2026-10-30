---
"@sealant/mend": patch
---

A protocol session's preview starts after a turn that changed the worktree, in a project whose
`mend.toml` names a `[preview]`, unless something already runs it (ADR 0017 delivery step 10a). It
runs setup when its fingerprint changed, then the recipes the Service depends on, then the Service,
only at the owner's approved digest and as the person who last started it. A question starts
nothing, a changed turn followed by a question still starts it once, a person's Stop holds (during
setup too), a running preview is left alone, and one automatic start of a preview runs at a time
across sessions and API processes. `GET /worktrees/:id/previews` now returns each preview's status
lines, such as `preview · web · answered HTTP 200 · observed 4 s ago` or
`preview not prepared · web · recipe not approved · the owner's Start runs it`, and the worktree's
own line when a turn's change was not captured. The first preview still needs the owner's Start, and
a session that ended before its turn was prepared is not started. Migration
`0165_preview_preparations` marks every turn that already ended as decided, so nothing old starts
after the upgrade.
