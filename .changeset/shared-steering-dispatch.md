---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, shared control now runs each turn on
its sender's own login: when Bob sends a turn to Alice's Claude or Codex conversation, Mend waits
until Alice's agent has finished its own work (a running turn, background tasks, sub-agents, a goal,
a background terminal, a monitor, a wakeup), stops nothing, and then continues the same conversation
in a process of Bob's, on his login. While the turn waits, both people can read why; the person
whose agent runs the work, or the session's owner, can end a task, a terminal or a goal. A steerer
who has not connected the harness's provider is told to connect it before anything is sent. In a
worktree that runs per person, only the person who made the worktree keeps Claude's scheduled
prompts.

With the flag off, sessions run as before, except for four rules that hold either way: shared
control cannot be turned on for an opencode session, which is one person's; turning shared control
off cancels the turns other people queued instead of sending them; removing a person from the
organization cancels the turns they queued; and a queued turn is withdrawn only by the person who
sent it or the session's owner.
