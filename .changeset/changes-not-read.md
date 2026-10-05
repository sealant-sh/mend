---
"@sealant/mend": patch
---

A run's changes that Core never read are no longer shown to Mend's inference as an empty change.
Core now says when it did not read a run's changes (the reading failed, none was recorded, or the
run has not ended) and why; Mend's client kept only the files and the diff, so `read_change` showed
an empty diff for something never observed. It now answers `changes not read · <reason>`. A control
plane from before sealant#313 sends no such field, and its readings are read as made, as the SDK
reads them.
