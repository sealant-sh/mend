---
"@sealant/mend": minor
---

Keep removed projects indefinitely and Restore them in Projects → Removed projects or with
`mend projects restore <id>`. Add `mend projects rm`, `removed`, and explicitly confirmed `purge`;
report retained local disk in `mend doctor`. Restore preserves identity and history and starts
nothing. A restored project reappears in T3 Code. Purge deletes exclusive content while keeping
shared assets, instance audit and backups.
