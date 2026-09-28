---
"@sealant/mend": patch
---

Retention no longer deletes packs a capture registered during its pass still needs. A final capture
that reused packs from a capture being thinned registered, and the pass then deleted those packs:
the head could not be read. Register and retention now meet on a per-chain guard (migration 0076),
so one of the two always sees the other; a capture naming objects retention is deleting is refused
with `missing-objects`, and registers again once the executor has uploaded them again.

Register refuses a capture Mend could not restore: a root no listed dir pack holds, a dir object
that is not in the bucket, a chunk in no listed pack, a file whose chunks do not add up to its size,
or a hardlink whose canonical member is missing (422 `unrestorable` or `missing-objects`). Sections
carried unchanged from the parent are not walked again.

Reading one file of a capture follows a hardlink member to its canonical member instead of returning
an empty file, and fails when the bytes read are not the size the entry says. Transcript harvesting
reads files this way.

`plan.get` hands a head holding dir packs (format 2) only to an executor that says it reads them
(`manifest_format` on the request), refusing any other with `manifest-format` before it claims the
lease, and never tells an executor to write a format it did not say it reads. Rolling sealantd back
is in ADR 0002 decision 30 and the server environment reference.
