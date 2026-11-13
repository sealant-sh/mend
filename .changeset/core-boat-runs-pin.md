---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.863. A Boat session now stops on the same
stop and recover path as every other runtime, and its VM is deleted as soon as Boat reports it gone,
about a second after the final capture where it could take 40 seconds. A stop interrupted by a
server restart, a kept VM, or a slow deletion is finished within a tick or two, however long the
server's history is. A "discard unsaved and stop" that meets another stop reads `discarded`, never
`stopped`.

This release runs a forward-only sealant migration: Boat's three per-run ledgers become one row per
Boat run, existing runs are carried over, and the old tables are frozen until a later release drops
them. A server that never ran a Boat session is unaffected. An older sealant cannot write Boat state
against a migrated database, so rolling the server back past this release needs a database restore.
