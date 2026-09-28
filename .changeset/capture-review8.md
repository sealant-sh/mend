---
"@sealant/mend": patch
---

`capture.register` now says whether the final seal it carried stands:
`seal: {state: "recorded" | "withheld" | "refused", reason?}`. sealantd answers a final flush
complete only on `recorded`. `plan.get` hands a head's `final_seal` on only while that seal stands.
An upload URL handed out while a seal's objects are being read back leaves the seal withheld.

Register checks worktree metadata against what the restore actually lays down: the workspace class
over the raw tree, the bulk class where neither holds the path, and every ancestor of a named path.
Every class entry a hardlink names promises its inode a mode and an mtime, so two different promises
for one inode are never sealed.

A SHA-256 repository's git section (`object_format: "sha256"`) is verified in a SHA-256 repository.
Object ids of another width are `unverified`, where before they read `verified` without a walk.

A capture answer that arrives is kept as evidence even when the log line after it fails.
