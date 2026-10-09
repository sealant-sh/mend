---
"@sealant/mend": patch
---

With `MEND_HARNESS_LAYOUT=shared` and no harness layout recorded, the per-person layout work costs
nothing. The server no longer asks the database every 10 s whether a layout was recorded (it learns
of one through its own write path), and a steered turn no longer reads its session a second time to
check the layout.
