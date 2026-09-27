---
"@sealant/mend": minor
---

A session that moves between executors of different platforms, such as arm64 and amd64, keeps each
platform's dependency tree. sealantd now carries the bulk sections built on other platforms in the
capture manifest (`sections.other_bulk`). `plan.get` answers each executor the tree built for its
own platform, from `bulk` or `other_bulk`, and `"pending"` when there is none, so no executor
restores a tree built for another platform. Register checks each carried section. It does not ask
the bucket again about a section the parent capture already holds. Retention keeps every object a
carried section names, under fenced epochs as well. The engine skips the install command when the
head carries a tree for the executor's platform. The dependency cache never serves a record under
the wrong platform. Manifests without `other_bulk` read and register exactly as before.
