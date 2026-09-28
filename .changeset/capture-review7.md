---
"@sealant/mend": patch
---

An executor's capture evidence is fenced in the database (migration 0088). A row is written before
Mend asks the executor anything and deleted in the one transaction that publishes the answer: the
session's reading, its saved or unsaved word, and the executor's evidence. An answer that arrived
and could not be published keeps the executor's evidence unknown across restarts and engine
processes, so an older seal no longer reads saved after a Mend restart. The session's queue reading
keeps the executor's stamp, so a seal that covers it stands. Evidence that nothing orders against a
save, or an answer not yet published, reads `completion unknown`, never
`changes after that were not saved`.

`upload.urls` answers `present` only to an executor whose `plan.get` listed it in `upload_answers`.
An older daemon gets a write-once URL for a stored key whose bytes were verified, as before.

On a bucket that ignores `If-None-Match` (Garage), a seal no longer stands while an upload URL of
its epoch could still replace what it names (migration 0089 records each URL's expiry before it is
handed out). Once none can, every object the seal names is read back first, and one that reads back
as other bytes voids the seal. On such a bucket a seal stands up to twenty minutes after the last
upload URL of its epoch.

Register checks the worktree metadata against the tree the restore checks out (the raw tree when
there is one) and the classes restored over it. A final seal also needs every inode the metadata
links (hardlinks, shared, cross-class) to be promised one mode and one nanosecond mtime.
