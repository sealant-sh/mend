---
"@sealant/mend": patch
---

Workspaces set `PAGER=cat`: the images carry no `less`, so `git log` in a terminal failed with
`unable to execute pager 'less'`. Each person's processes inherit it too. A project variable named
`PAGER`, a shell profile's, or `core.pager` in a person's git config wins; `GIT_PAGER` stays unset
so that last one keeps working.
