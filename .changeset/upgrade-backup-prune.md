---
"@sealant/mend": patch
---

`mend server upgrade` no longer keeps every database backup it writes. Each one is a full dump under
`backups/upgrade-UUID/` and can run to gigabytes. After the new version answers health, the upgrade
records its backup as completed, keeps the newest two completed backups in the order Mend wrote them
(its own included), removes the older ones and prints each with the space it freed.
`--keep-backups N` changes the count and `--keep-backups 0` keeps them all. A failed upgrade removes
nothing. A backup recorded as pending, or whose dump is incomplete, is always kept. Nothing is ever
removed but an `upgrade-UUID` directory holding exactly `recovery.json` and `database.sql`, or what
a removal cut short by a crash left behind: an `upgrade-UUID.removing` directory, an empty
`upgrade-UUID` directory, or a completed record whose dump is gone.

Backups written by releases before 0.36 carry no outcome. The first upgrade on 0.36 or later treats
each one whose dump is whole as completed and keeps only the newest N, including the backup of an
old upgrade that failed after its target started. Copy any you want to keep out of
`~/.config/mend/backups/` before upgrading. Their removals end in
`· from before 0.36, no recorded outcome`.
