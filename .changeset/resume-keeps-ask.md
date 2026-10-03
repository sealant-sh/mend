---
"@sealant/mend": patch
---

A conversation session started with approvals on (`ask`) keeps them when it comes back. Resuming it,
a follow-up to it after a stop or an idle stop, and a Slack reply that relaunches it now run with
`ask` again, where they ran with approvals off. A relaunch that names a permission mode still runs
on the one it names.
