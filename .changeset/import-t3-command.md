---
"@sealant/mend": minor
---

`mend import t3` brings your T3 Code threads into Mend. Run it on the machine that holds your T3
Code data: each Claude or Codex thread whose conversation is on that machine becomes a Mend session
that holds the conversation, its history shown, ready for your next message. It prints its plan
first, per project: each thread it would import with its harness and size, whether it was imported
before, which projects it would adopt, which checkouts it would hand off, and each thread it leaves
behind and why. `--dry-run` stops there. Each checkout is handed off once, the way `mend handoff`
does it, and is not written to. A thread whose checkout T3 Code removed lands in a new worktree from
origin, on its branch when origin has it. A conversation over the server's limit (64 MiB by default)
stays behind and is named. Running it again imports only new threads. `--project` and `--thread`
choose what to import, and `--archived` includes archived threads.

`mend message <session> --resume "…"` now also starts a session that never ran an agent, such as one
`mend import t3` made: the agent starts in conversation mode with your message as its first turn.
