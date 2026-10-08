---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, shared control now runs each turn on
its sender's own login: when Bob sends a turn to Alice's Claude or Codex conversation, Mend waits
until Alice's agent has finished its own work (a running turn, background tasks, sub-agents, a goal,
a background terminal, a monitor, a wakeup), stops nothing, and then continues the same conversation
in a process of Bob's, on his login. While the turn waits, both people can read why; the person
whose agent runs the work, or the session's owner, can end a task, a monitor, a terminal or a goal;
a scheduled prompt is waited for at most 10 minutes and then ends with Alice's agent, which the
session line says. Alice's agent is never stopped on a guess: if Codex will not say what it runs,
Bob's turn fails after a minute and Alice's agent goes on, and a Codex started before this release
takes only Alice's turns until it restarts. Right before the stop Mend looks once more: if Alice's
agent started something of its own, or Bob withdrew his turn, nothing is stopped. If Bob's process
cannot be started after Alice's stopped, Alice's is started again on her login, Bob's turn fails
with the reason, and the next try waits a minute. Only the person an agent runs as answers its
questions; anyone else is asked to send a turn instead. A steerer who has not connected the
harness's provider is told to connect it before anything is sent, follow-ups and launches that open
with their words included. Taking a shared conversation over into a terminal continues it in the
same place. In a worktree that runs per person, only the person who made the worktree keeps Claude's
scheduled prompts.

With the flag off, sessions run as before, except for four rules that hold either way: shared
control cannot be turned on for an opencode session, which is one person's, and another person's
turn to one is refused; turning shared control off cancels the turns other people queued instead of
sending them; removing a person from the organization cancels the turns they queued; and a queued
turn is withdrawn only by the person who sent it or the session's owner.
