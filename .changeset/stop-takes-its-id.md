---
"@sealant/mend": patch
---

`mend stop <id>`, `mend rejoin <id>` and `mend service logs <name>` take the id or name they are
given. Without `--project`, `--harness` or `--from` on the line they skipped it, so `mend stop <id>`
answered "several live sessions".
