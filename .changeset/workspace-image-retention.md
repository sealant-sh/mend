---
"@sealant/mend": minor
---

`mend server setup` takes `--workspace-image-keep <n>` and `--workspace-image-min-age <hours>`: how
many workspace images the bundled worker keeps with no workspace on them, and how long it never
removes a new one. They stay across reruns and upgrades, `default` goes back to sealant's own (10
and a week), and `mend server status` prints the values in force. Unset, nothing changes.
