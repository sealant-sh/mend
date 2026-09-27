---
"@sealant/mend": patch
---

Two retention passes that overlapped no longer delete a capture registered between them. A pass that
condemned objects now holds a claim on them until it has deleted them and settled their tombstones
(migration 0080); while any pass holds one, a register naming those objects is refused with
`missing-objects`, and it registers once that pass is done and the executor has uploaded them again.
A pass whose claim lapsed stops deleting and leaves the rest for the next pass.

Mend's capture reader writes a file name or symlink text that is not UTF-8 as its bytes, as sealantd
carries them in `raw_name` / `raw_target`, instead of the escaped name, and register refuses an
entry whose raw bytes disagree with its name.

Register validates the manifest as it is stored — a request carrying a different copy is refused —
and refuses a capture whose worktree metadata document would not restore: an unread format, packs
outside the workspace section, chunks that do not add up to its size and digest, or a document
sealantd would reject.

A capture whose manifest carries sealantd's `final_seal` (a completed final flush) records it on the
chain for that executor and epoch (migration 0080), when it is complete and names the executor and
epoch that registered it. It is what Mend reads as "saved".

`plan.get` refuses a head holding `worktree_meta`, `symrefs`, `other_bulk`, raw names or a
`final_seal` to an executor that does not list the feature in `manifest_features`, before it claims
the lease (409 `manifest-features`), and answers the features Mend reads.
