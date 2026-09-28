---
"@sealant/mend": patch
---

Every executor is one launch: the key its create is asked under names it (migration 0083). Its
session channel token is issued for that launch alone, `plan.get` names it as the executor, the
store records a completed final flush only when the seal names it, and a stop attests the seal only
with that launch's own runtime. A new launch never rotates another's token. A claimed standby is the
session's executor before it is re-planned: when the replan answer is lost it drains like any
executor, a kept standby refuses the launch, and a cold executor starts only once the standby's end
is confirmed, under a fresh epoch.

A create whose answer was lost holds every relaunch, the owning session's too, until its key is
reconciled: an executor it made drains before anything new starts; nothing on record frees the
worktree only once Core cancels the key (`cancelCreate`), and on SDK 0.37.2 the next launch asks the
same create again under the same key.

A key retention condemned is never registered again (`missing-objects` naming it); sealantd uploads
the content under a new key generation, and Mend reads both key forms. A completion seal is recorded
only over a git section Mend verified and worktree metadata that names only what the worktree tree
holds; metadata naming a missing file is refused. A flush answer that does not report snapshot
health holds a landing (`snapshot health not reported`), and a suspend flush logs `completed` only
when the head caught up. A dir entry's nanosecond mtime is read and written back exactly.

A capture whose git section names its trees (`worktree_tree`, `index_tree`, `raw_tree`: the
`git_trees` feature) is read from `worktree_tree`, verified over all three trees, and planned only
for an executor that reads the feature; every ref in it is the user's, `refs/sealant/capture/*`
included. A final flush that answers `changed` (the disk changed after it) is not saved: the drain
asks again, and never ends an executor on a completed answer it did not ask for in that round.
