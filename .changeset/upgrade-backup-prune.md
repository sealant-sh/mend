---
"@sealant/mend": patch
---

`mend server upgrade` no longer keeps every database backup it writes. Each one is a full dump under
`backups/upgrade-UUID/` and can run to gigabytes. After the new version answers health, the upgrade
records its backup as completed, keeps the newest two completed backups (its own included), removes
the older ones and prints each with the space it freed. `--keep-backups N` changes the count and
`--keep-backups 0` keeps them all. A failed upgrade removes nothing, a backup whose upgrade never
recorded a healthy target or whose dump is incomplete is always kept, and nothing but an
`upgrade-UUID` directory holding exactly `recovery.json` and `database.sql` is ever removed.
