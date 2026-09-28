---
"@sealant/mend": patch
---

A cold resume no longer changes the saved harness directories' modes and times while it moves the
new executor's credentials into place. Before, a restored `~/.claude` saved at 0750 came back 0700.
The move now copies only the entries the restored directory is missing. A session whose lost launch
Mend recovers reads `stopping · … · stop requested · end not observed yet` until the platform
reports its executor gone. Before, it said the executor had ended as soon as the stop was asked.
Mend no longer deletes a skill directory the library replaces or drops. It moves the directory to
`/workspace/harness-home/.mend/skills-kept/`, even when the directory is exactly as Mend wrote it.
