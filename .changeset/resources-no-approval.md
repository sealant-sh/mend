---
"@sealant/mend": minor
---

A resource a member adds is the project's, with no proposal or approval. `mend resource add` adds a
preset or an image and prints the image pinned to the digest its registry serves.
`mend resource add <name> --from-file --worktree <w>` adds that worktree's `[resource.<name>]` table
from `mend.toml`. The person who added a definition, the project's creator or an organization owner
replaces or removes it. `mend resource approve`, `mend resource remove --proposal` and the
`proposed by`, `waiting for approval` and `approved by` status words are gone; a definition reads
`@db · postgres 17 · project · added by Maria · not started`. Migration
`0173_drop_resource_approvals` keeps each definition's pinned image on its own row and drops the
`resource_approvals` and `resource_proposals` tables, open proposals with them. A definition that no
manager approved, which never ran, is removed; add it again.
