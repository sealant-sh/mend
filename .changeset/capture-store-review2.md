---
"@sealant/mend": patch
---

Two retention passes that overlapped no longer delete a capture registered between them. A pass
that condemned objects now holds a claim on them until it has deleted them and settled their
tombstones (migration 0080); while any pass holds one, a register naming those objects is refused
with `missing-objects`, and it registers once that pass is done and the executor has uploaded them
again. A pass whose claim lapsed stops deleting and leaves the rest for the next pass.
