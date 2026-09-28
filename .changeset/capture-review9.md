---
"@sealant/mend": patch
---

Mend now keeps every unsaved capture answer an executor gave, unless a later answer from the same
boot or a later boot replaced it. A delayed old answer no longer erases a recovery boot's failure
and makes an old seal read as saved again. A seal or a completed final flush counts as saved only
when it came after every one of those answers. Migration 0090 adds the column that holds them.

Issuing upload URLs and accepting a seal now wait on the same row (migration 0091), so a URL issued
during a seal's verification is always seen. Once a seal is recorded, the stored objects it names
never get an upload URL: `upload.urls` answers them `present`, or refuses them with `409 exists` if
the executor does not read `present`.

A tracked hardlink group, or a shared link's tracked file, has its bytes compared in the files the
restore actually writes, including the workspace overlay. A group whose members differ only after
the overlay is applied is not sealed.

The git section's `ref_format` (sealantd's `ref_format` manifest feature, `reftable`) is decoded,
handed only to executors that read it, and verified in a reftable repository. A ref backend Mend
does not read is `unverified`, as is a section whose HEAD is `refs/heads/.invalid`, the placeholder
in a reftable repository's `.git/HEAD` file.

A discard logs the request before the stop, and logs `discarded` only after the platform confirms
the end.
